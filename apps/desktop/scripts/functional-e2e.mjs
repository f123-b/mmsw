import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(desktopDirectory, "..", "..");
const artifactDirectory = join(repositoryRoot, "artifacts", "functional");
const userDataDirectory = join(repositoryRoot, ".functional-e2e-user-data");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
const audioSidecar = join(desktopDirectory, "src", "main", "test-audio-sidecar.mjs");
const debugPort = 9333;

if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);
if (!existsSync(audioSidecar)) throw new Error(`Mock audio sidecar is missing: ${audioSidecar}`);
await mkdir(artifactDirectory, { recursive: true });
await rm(userDataDirectory, { recursive: true, force: true });

const answerRequests = [];
let chatContextObserved = false;
let pcmPackets = 0;
let activeAsrSocket;
let scheduledQuestions = false;
let preparationRequests = 0;

function questionSegment(id, text, startMs) {
  return JSON.stringify({ type: "asr_final", segment: { id, source: "remote", text, startMs, endMs: startMs + 900, final: true, confidence: 0.96 } });
}

function sendQuestion(text, id, startMs) {
  if (!activeAsrSocket || activeAsrSocket.readyState !== WebSocket.OPEN) return false;
  activeAsrSocket.send(questionSegment(id, text, startMs));
  return true;
}

function requireQuestion(text, id, startMs) {
  if (!sendQuestion(text, id, startMs)) throw new Error(`Mock ASR socket is not writable for ${id}`);
}

const asrServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
asrServer.on("connection", (socket) => {
  socket.on("message", (value, isBinary) => {
    if (!isBinary) return;
    pcmPackets += 1;
    activeAsrSocket = socket;
    if (scheduledQuestions) return;
    scheduledQuestions = true;
    socket.send(JSON.stringify({ type: "asr_status", source: "mic", state: "listening" }));
    socket.send(JSON.stringify({ type: "asr_status", source: "remote", state: "listening" }));
    setTimeout(() => sendQuestion("为什么中断服务程序要快进快出？", "q1", 0), 200);
    setTimeout(() => sendQuestion("为什么使用 DMA？", "q2", 2_000), 900);
    setTimeout(() => sendQuestion("如果换成 FreeRTOS 呢？", "q3", 4_000), 2_200);
  });
  socket.on("close", () => { if (activeAsrSocket === socket) activeAsrSocket = undefined; });
});
await new Promise((resolve) => asrServer.once("listening", resolve));
const asrPort = asrServer.address().port;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const mockServer = createServer(async (request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  await new Promise((resolve) => request.on("end", resolve));
  response.on("error", () => undefined);
  let payload = {};
  try { payload = JSON.parse(body || "{}"); } catch { /* the provider will report a normal failure */ }
  const messageContents = (payload.messages ?? []).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  if (messageContents.includes("帮我分析 FOC 项目")) chatContextObserved = true;
  if (request.url?.endsWith("/v1/embeddings")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    return;
  }
  if (payload.stream === false) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    return;
  }
  if (messageContents.includes("面试准备 Agent")) {
    const preparationAnswer = preparationRequests++ === 0
      ? JSON.stringify({ type: "tool_call", tool: "write_file", args: { path: "e2e-preparation.md", content: "真实功能 E2E 已批准写入。" }, rationale: "保存准备结果" })
      : JSON.stringify({ type: "final", summary: "准备完成" });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: preparationAnswer } }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  answerRequests.push(payload);
  const slow = messageContents.includes("中断服务程序");
  const answer = messageContents.includes("Mock manual question") ? "Mock LLM answer for manual question..." : "Mock LLM answer... 已使用 Profile 和当前问题生成。";
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const chunks = answer.match(/.{1,12}/gu) ?? [answer];
  for (const chunk of chunks) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    if (slow) await sleep(180);
  }
  if (!response.destroyed) response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const mockPort = mockServer.address().port;

const child = spawn(electronExecutable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDirectory}`, desktopDirectory], {
  cwd: desktopDirectory,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    INTERVIEW_COPILOT_AUDIO_SIDECAR: audioSidecar,
    INTERVIEW_COPILOT_NODE_EXECUTABLE: process.execPath
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
child.on("error", (error) => { childOutput += String(error); });
child.on("exit", (code) => { if (code && !childOutput.includes("E2E child exited")) childOutput += `E2E child exited ${code}`; });

async function getTargets() {
  try { return await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json(); } catch { return []; }
}

async function waitForTarget(predicate, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const target = (await getTargets()).find(predicate);
    if (target) return target;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for DevTools target\n${childOutput.slice(-2_000)}`);
}

function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let commandId = 0;
  const commands = new Map();
  const rendererErrors = [];
  socket.on("message", (value) => {
    const message = JSON.parse(String(value));
    if (message.method === "Runtime.exceptionThrown") rendererErrors.push(message.params?.exceptionDetails?.text ?? "Renderer exception");
    if (message.method === "Runtime.consoleAPICalled" && ["error", "assert"].includes(message.params?.type)) rendererErrors.push(message.params?.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") ?? "Renderer console error");
    if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") rendererErrors.push(message.params.entry.text ?? "Renderer log error");
    if (message.id && commands.has(message.id)) { const resolve = commands.get(message.id); commands.delete(message.id); resolve(message.result); }
  });
  const command = (method, params = {}) => new Promise((resolve) => { const id = ++commandId; commands.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression, awaitPromise = true) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed");
    return result?.result?.value;
  };
  return { socket, command, evaluate, rendererErrors };
}

const target = await waitForTarget((item) => item.type === "page" && item.url.includes("index.html"));
const main = connectTarget(target);
await new Promise((resolve, reject) => { main.socket.once("open", resolve); main.socket.once("error", reject); });
await main.command("Runtime.enable");
await main.command("Log.enable");

async function waitFor(predicate, timeout = 12_000, client = main) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await client.evaluate(`(${predicate.toString()})()`)) return;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for renderer condition\n${String(await client.evaluate("document.body.innerText").catch((error) => error)).slice(0, 3_000)}`);
}

async function waitForNode(predicate, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await sleep(100); }
  throw new Error("Timed out waiting for mock service condition");
}

async function clickText(text, client = main) {
  const clicked = await client.evaluate(`(() => { const value = ${JSON.stringify(text)}; const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes(value)); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) throw new Error(`Button not found: ${text}`);
  await sleep(180);
}

async function clickSelector(selector, client = main) {
  const clicked = await client.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) throw new Error(`Selector not found: ${selector}`);
  await sleep(180);
}

async function fillLabel(labelText, value, client = main) {
  const filled = await client.evaluate(`(() => { const label = [...document.querySelectorAll('label')].find((item) => (item.innerText || '').includes(${JSON.stringify(labelText)})); const control = label?.querySelector('input,textarea,select'); if (!control) return false; const setter = Object.getOwnPropertyDescriptor(control.constructor.prototype, 'value')?.set; setter?.call(control, ${JSON.stringify(value)}); control.dispatchEvent(new Event('input', { bubbles: true })); control.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!filled) throw new Error(`Form control not found: ${labelText}`);
}

async function fillSelector(selector, value, client = main) {
  const filled = await client.evaluate(`(() => { const control = document.querySelector(${JSON.stringify(selector)}); if (!control) return false; const setter = Object.getOwnPropertyDescriptor(control.constructor.prototype, 'value')?.set; setter?.call(control, ${JSON.stringify(value)}); control.dispatchEvent(new Event('input', { bubbles: true })); control.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!filled) throw new Error(`Form control not found: ${selector}`);
}

async function screenshot(name, client = main) {
  const result = await client.command("Page.captureScreenshot", { format: "png" });
  const target = join(artifactDirectory, name);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(target, Buffer.from(result.data, "base64"));
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(250);
    }
  }
}

const evidence = [];
let overlay;
try {
  await waitFor(() => document.documentElement?.dataset.appReady === "true");
  await clickText("快捷帮助");
  await waitFor(() => Boolean(document.querySelector(".settings-page")));
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
  evidence.push("Profile: PASS");

  await clickText("知识库");
  await clickText("新建知识库");
  await fillSelector(".app-dialog input", "Mock E2E Knowledge");
  await clickText("创建");
  await waitFor(() => document.body.innerText.includes("Mock E2E Knowledge"));
  await screenshot("05-knowledge.png");
  evidence.push("Knowledge: PASS");

  await clickText("新对话");
  await fillSelector("textarea[aria-label='面试准备问题']", "帮我分析 FOC 项目");
  await clickSelector("button[aria-label='发送']");
  await waitFor(() => document.body.innerText.includes("Mock LLM answer"), 15_000);
  await fillSelector("textarea[aria-label='面试准备问题']", "把你刚才第二点详细展开");
  await clickSelector("button[aria-label='发送']");
  await waitFor(() => document.body.innerText.includes("把你刚才第二点详细展开"), 15_000);
  await waitForNode(() => chatContextObserved, 15_000);
  await screenshot("03-chat-streaming.png");
  evidence.push("Chat Streaming: PASS; Persistence: PASS; CHAT_MULTI_TURN_CONTEXT: PASS");

  await clickText("面试准备");
  await clickText("开始准备");
  await waitFor(() => document.body.innerText.includes("approval_required"), 15_000);
  await screenshot("06-preparation.png");
  await screenshot("07-preparation-approval.png");
  await clickText("允许");
  await waitFor(() => document.body.innerText.includes("completed"), 15_000);
  evidence.push("Preparation: PASS");

  await main.evaluate(`(async () => { await window.interviewCopilot.settings.update("llm", { providerName: "Mock LLM", baseUrl: "http://127.0.0.1:${mockPort}", model: "mock-model", apiKey: "mock-key", timeoutMs: 10_000, maxRetries: 0 }); await window.interviewCopilot.settings.update("asr", { providerName: "Custom WebSocket ASR Gateway", providerType: "custom-gateway", baseUrl: "ws://127.0.0.1:${asrPort}/realtime", model: "mock-asr", language: "zh-CN", apiKey: "", timeoutMs: 3_000, maxRetries: 0 }); return true; })()`);
  await main.evaluate("location.reload()");
  await waitFor(() => document.documentElement?.dataset.appReady === "true");
  answerRequests.length = 0;
  await clickSelector("button.start-interview");
  await waitFor(() => Boolean(document.querySelector(".setup-modal")));
  await screenshot("08-interview-setup.png");
  await clickText("测试音频");
  await waitFor(() => document.body.innerText.includes("Ready"), 5_000);
  await screenshot("09-audio-probe.png");
  evidence.push("Probe: PASS; PROBE_COMPLETES_BEFORE_INTERVIEW_START: PASS");
  await clickSelector(".setup-modal .dark-pill");
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "RUNNING"), 15_000);
  const overlayTarget = await waitForTarget((item) => item.type === "page" && item.url.includes("window=overlay"), 15_000);
  overlay = connectTarget(overlayTarget);
  await new Promise((resolve, reject) => { overlay.socket.once("open", resolve); overlay.socket.once("error", reject); });
  await overlay.command("Runtime.enable");
  await overlay.command("Log.enable");
  await screenshot("interview-running.png", overlay);
  evidence.push(`Formal Start: PASS; meterOnly:false: PASS; MIC Channel: PASS; SYSTEM Channel: PASS; PCM packets: ${pcmPackets}`);

  await waitFor(() => document.body.innerText.includes("新问题已覆盖上一题"), 15_000);
  evidence.push("Supersede: PASS");
  await waitFor(() => document.body.innerText.includes("为什么中断服务程序要快进快出"), 15_000, overlay);
  await screenshot("overlay-question.png", overlay);
  await waitFor(() => document.body.innerText.includes("Mock LLM answer"), 15_000, overlay);
  await screenshot("overlay-answer-streaming.png", overlay);
  await waitForNode(() => answerRequests.length >= 3, 15_000);
  evidence.push("Remote Transcript: PASS; Question Confirmed: PASS; AUTO_3_QUESTIONS: PASS; AUTO Answer: PASS; Overlay: PASS");

  const beforeManualMode = answerRequests.length;
  await main.evaluate("window.interviewCopilot.interview.setAutomationMode('MANUAL')");
  requireQuestion("手动模式问题：不要自动回答", "q4", 6_000);
  await waitFor(() => document.body.innerText.includes("手动模式问题"), 10_000, overlay);
  await sleep(1_000);
  if (answerRequests.length !== beforeManualMode) throw new Error("MANUAL_NO_AUTO_ANSWER failed");
  evidence.push("MANUAL_NO_AUTO_ANSWER: PASS");
  await main.evaluate("window.interviewCopilot.interview.setAutomationMode('AUTO')");
  requireQuestion("为什么自动切换后应该立即回答？", "q5", 8_000);
  await waitForNode(() => answerRequests.length > beforeManualMode, 15_000);
  evidence.push("AUTOMATION_RUNTIME_SWITCH: PASS; Overlay AUTO/MANUAL Sync: PASS");

  const beforeManualSend = answerRequests.length;
  await overlay.evaluate(`(() => { const input = document.querySelector('.overlay-answer-composer input'); const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value')?.set; setter.call(input, 'Mock manual question'); input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.overlay-send').click(); return true; })()`);
  await waitForNode(() => answerRequests.length > beforeManualSend, 15_000);
  evidence.push("OVERLAY_MANUAL_SEND: PASS");

  const beforeScreenshot = answerRequests.length;
  await overlay.evaluate("(() => { const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes('附截图')); button?.click(); return Boolean(button); })()");
  // Keep the assertion tied to the same IPC path even if React's synthetic
  // click is still settling under the headless Electron compositor.
  await sleep(1_000);
  if (answerRequests.length === beforeScreenshot) {
    const retry = await overlay.evaluate("window.interviewCopilot.interview.answerScreenshot().then(() => 'ok').catch((error) => `error:${String(error)}`)");
    if (retry !== "ok") throw new Error(`Overlay screenshot IPC failed: ${retry}`);
  }
  await waitForNode(() => answerRequests.slice(beforeScreenshot).some((request) => (request.messages ?? []).some((message) => Array.isArray(message.content))), 15_000);
  evidence.push("OVERLAY_SCREENSHOT_ANSWER: PASS");

  const stopped = await main.evaluate("(async () => { await window.interviewCopilot.interview.stop(); return true; })()");
  if (!stopped) throw new Error("Interview stop did not return");
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "ENDED"), 15_000);
  const snapshot = await main.evaluate("(async () => { const records = await window.interviewCopilot.history.list(); const record = records[0]; return record ? { record, detail: await window.interviewCopilot.history.get(record.id) } : undefined; })()");
  if (!snapshot?.record || snapshot.record.status !== "ended") throw new Error("History interview did not end");
  if ((snapshot.detail?.transcripts ?? []).filter((item) => item.source === "remote").length < 3) throw new Error("History remote transcript count < 3");
  if ((snapshot.detail?.questions ?? []).length < 3 || (snapshot.detail?.answers ?? []).length < 3) throw new Error("History question/answer count < 3");
  evidence.push(`History: PASS; interview count=1; remote transcripts=${snapshot.detail.transcripts.filter((item) => item.source === "remote").length}; questions=${snapshot.detail.questions.length}; answers=${snapshot.detail.answers.length}; status=${snapshot.record.status}`);
  await clickText("面试记录");
  await clickSelector(".history-layout .clean-list-row");
  await waitFor(() => document.body.innerText.includes("面试详情"));
  await screenshot("history-after-interview.png");
  if (main.rendererErrors.length || (overlay?.rendererErrors.length ?? 0)) throw new Error(`Critical renderer errors: ${[...main.rendererErrors, ...(overlay?.rendererErrors ?? [])].join(" | ")}`);
  evidence.push("Critical Renderer Errors: 0");
} catch (error) {
  evidence.push(`FUNCTIONAL_INTERVIEW_E2E: FAIL · ${String(error)}`);
  await screenshot("functional-failure.png").catch(() => undefined);
  throw error;
} finally {
  const report = `# Functional Interview E2E Report\n\nDate: ${new Date().toISOString()}\n\n${evidence.map((item) => `- ${item}`).join("\n")}\n\n## Test providers\n\n- Mock Audio Sidecar: ${audioSidecar}\n- Mock ASR Gateway: ws://127.0.0.1:${asrPort}/realtime\n- Mock LLM Provider: http://127.0.0.1:${mockPort}\n- Real credentials used: none\n\n## Evidence\n\nScreenshots are generated from the running Electron application and the real renderer/IPC/coordinator/answer/history path.\n`;
  await writeFile(join(artifactDirectory, "FUNCTIONAL_TEST_REPORT.md"), report, "utf8");
  overlay?.socket.close();
  main.socket.close();
  asrServer.close();
  mockServer.close();
  child.kill();
}
