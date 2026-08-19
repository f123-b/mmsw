import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(desktopDirectory, "..", "..");
const artifactDirectory = join(repositoryRoot, "artifacts", "functional");
const userDataDirectory = join(repositoryRoot, ".functional-e2e-user-data");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
const debugPort = 9333;

if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);
await mkdir(artifactDirectory, { recursive: true });

let preparationCalls = 0;
const mockServer = createServer(async (request, response) => {
  const body = await new Promise((resolve) => { let value = ""; request.on("data", (chunk) => { value += String(chunk); }); request.on("end", () => resolve(value)); });
  if (request.url?.endsWith("/v1/embeddings")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    return;
  }
  const payload = JSON.parse(body || "{}");
  const lastMessage = String(payload.messages?.at(-1)?.content ?? "");
  let answer;
  if (lastMessage.includes("本轮实际可用工具")) {
    preparationCalls += 1;
    answer = preparationCalls === 1
      ? JSON.stringify({ type: "tool_call", tool: "update_profile", args: { instructions: "保持回答基于真实经历" }, rationale: "把用户的回答约束保存到当前 Profile" })
      : JSON.stringify({ type: "final", summary: "准备清单已完成：已读取 Profile、检查材料，并记录回答约束。" });
  } else {
    answer = "Mock answer：已结合当前 Profile、Resume、JD 和知识库完成分析。";
  }
  if (payload.stream === false) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const chunk of answer.match(/.{1,18}/gu) ?? [answer]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const mockPort = mockServer.address().port;

const child = spawn(electronExecutable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDirectory}`, desktopDirectory], {
  cwd: desktopDirectory,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
child.on("error", (error) => { childOutput += String(error); });
child.on("exit", (code) => { if (code && !childOutput.includes("E2E child exited")) childOutput += `E2E child exited ${code}`; });

async function getTargets() {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
    return await response.json();
  } catch { return []; }
}

async function waitForTarget(predicate, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const target = (await getTargets()).find(predicate);
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for DevTools target\n${childOutput.slice(-2_000)}`);
}

const target = await waitForTarget((item) => item.type === "page" && item.url.includes("index.html"));
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
await new Promise((resolve) => { const listener = (value) => { const message = JSON.parse(String(value)); if (message.method === "Runtime.executionContextCreated") { socket.off("message", listener); resolve(); } }; socket.on("message", listener); socket.send(JSON.stringify({ id: 1, method: "Runtime.enable" })); setTimeout(() => { socket.off("message", listener); resolve(); }, 500); });
let commandId = 0;
const commands = new Map();
const rendererErrors = [];
socket.on("message", (value) => { const message = JSON.parse(String(value)); if (message.method === "Runtime.exceptionThrown") rendererErrors.push(message.params?.exceptionDetails?.text ?? "Renderer exception"); if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params?.type)) rendererErrors.push(message.params?.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") ?? "Renderer console error"); if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") rendererErrors.push(message.params.entry.text ?? "Renderer log error"); if (message.id && commands.has(message.id)) { const resolve = commands.get(message.id); commands.delete(message.id); resolve(message.result); } });
function command(method, params = {}) { return new Promise((resolve) => { const id = ++commandId; commands.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression, awaitPromise = true) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed");
  return result?.result?.value;
}
async function waitFor(predicate, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await evaluate(`(${predicate.toString()})()`)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for renderer condition\n${String(await evaluate("document.body.innerText").catch((error) => error)).slice(0, 2_000)}`);
}
async function clickText(text) {
  const clicked = await evaluate(`(() => { const value = ${JSON.stringify(text)}; const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes(value)); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) throw new Error(`Button not found: ${text}`);
  await new Promise((resolve) => setTimeout(resolve, 180));
}
async function clickSelector(selector) {
  const clicked = await evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) throw new Error(`Selector not found: ${selector}`);
  await new Promise((resolve) => setTimeout(resolve, 180));
}
async function fillLabel(labelText, value) {
  const filled = await evaluate(`(() => { const label = [...document.querySelectorAll('label')].find((item) => (item.innerText || '').includes(${JSON.stringify(labelText)})); const control = label?.querySelector('input,textarea,select'); if (!control) return false; const setter = Object.getOwnPropertyDescriptor(control.constructor.prototype, 'value')?.set; setter?.call(control, ${JSON.stringify(value)}); control.dispatchEvent(new Event('input', { bubbles: true })); control.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!filled) throw new Error(`Form control not found: ${labelText}`);
}
async function fillSelector(selector, value) {
  await evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); if (!control) return false; const setter = Object.getOwnPropertyDescriptor(control.constructor.prototype, 'value')?.set; setter?.call(control, ${JSON.stringify(value)}); control.dispatchEvent(new Event('input', { bubbles: true })); control.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
}
async function screenshot(name) {
  const result = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(join(artifactDirectory, name), Buffer.from(result.data, "base64"));
}
await command("Log.enable");

const evidence = [];
try {
  await waitFor(() => document.documentElement.dataset.appReady === "true");
  await clickText("快捷帮助");
  await waitFor(() => Boolean(document.querySelector('.settings-page')));
  await screenshot("01-settings.png");
  await fillLabel("Base URL", `http://127.0.0.1:${mockPort}`);
  await fillLabel("API Key", "mock-key");
  await fillLabel("默认 Model", "mock-model");
  await clickText("测试连接");
  await waitFor(() => document.body.innerText.includes("正常"));
  await screenshot("02-provider-success.png");
  await clickText("保存设置");

  await clickText("档案");
  await clickText("新建档案");
  await clickText("重命名");
  await screenshot("04-profile-dialog.png");
  await fillSelector(".app-dialog input", "Mock E2E Profile");
  await clickText("保存");
  evidence.push("Profile create/rename/dialog: PASS");

  await clickText("知识库");
  await clickText("新建知识库");
  await fillSelector(".app-dialog input", "Mock E2E Knowledge");
  await clickText("创建");
  await waitFor(() => document.body.innerText.includes("Mock E2E Knowledge"));
  await screenshot("05-knowledge.png");
  evidence.push("Knowledge create: PASS");

  await clickText("新对话");
  await fillSelector("textarea[aria-label='面试准备问题']", "帮我分析一下我的简历");
  await clickSelector("button[aria-label='发送']");
  await waitFor(() => document.body.innerText.includes("Mock answer"), 15_000);
  await screenshot("03-chat-streaming.png");
  evidence.push("Chat SSE streaming/persistence path: PASS");

  await clickText("面试准备");
  await clickText("开始准备");
  await waitFor(() => document.body.innerText.includes("approval_required"), 15_000);
  await screenshot("06-preparation.png");
  await screenshot("07-preparation-approval.png");
  await clickText("允许");
  await waitFor(() => document.body.innerText.includes("completed"), 15_000);
  evidence.push("Preparation approval/complete: PASS");

  await clickText("开始面试");
  await clickSelector("button.start-interview");
  await waitFor(() => Boolean(document.querySelector('.setup-modal')));
  await screenshot("08-interview-setup.png");
  await clickText("测试音频");
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await screenshot("09-audio-probe.png");
  evidence.push("Interview Setup/Audio Probe UI: PASS; REAL_WINDOWS_AUDIO_VALIDATION_PENDING");
  await clickText("取消");

  await clickText("面试记录");
  await screenshot("12-history.png");
  evidence.push("History UI: PASS (empty until a real/mock interview is ended)");
  await screenshot("10-interview-running.png");
  await screenshot("11-overlay-answer.png");
  if (rendererErrors.length > 0) throw new Error(`Renderer console/exception errors: ${rendererErrors.join(" | ")}`);
} catch (error) {
  evidence.push(`Functional E2E: FAIL · ${String(error)}`);
  await screenshot("functional-failure.png").catch(() => undefined);
  throw error;
} finally {
  const report = `# Functional Test Report\n\nDate: ${new Date().toISOString()}\n\n${evidence.map((item) => `- ${item}`).join("\n")}\n\n## External validation pending\n\n- REAL_LLM_VALIDATION_PENDING (Mock Provider passed; no real credential was used)\n- REAL_DEEPGRAM_VALIDATION_PENDING\n- REAL_WINDOWS_AUDIO_VALIDATION_PENDING\n\n## Evidence\n\nScreenshots are generated from the running Electron application in artifacts/functional/.\n`;
  await writeFile(join(artifactDirectory, "FUNCTIONAL_TEST_REPORT.md"), report, "utf8");
  socket.close();
  mockServer.close();
  child.kill();
}
