import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";

const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(desktopDirectory, "..", "..");
const userDataDirectory = join(repositoryRoot, ".screenshot-smoke-user-data");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
const audioSidecar = join(desktopDirectory, "src", "main", "test-audio-sidecar.mjs");
const debugPort = 9355;

if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);
if (!existsSync(audioSidecar)) throw new Error(`Mock audio sidecar is missing: ${audioSidecar}`);
await rm(userDataDirectory, { recursive: true, force: true });

const visionRequests = [];
const asrServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
asrServer.on("connection", (socket) => socket.on("message", (_value, isBinary) => {
  if (isBinary) socket.send(JSON.stringify({ type: "asr_status", source: "remote", state: "listening" }));
}));
await new Promise((resolve) => asrServer.once("listening", resolve));
const asrPort = asrServer.address().port;

const llmServer = createServer(async (request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  await new Promise((resolve) => request.on("end", resolve));
  let payload = {};
  try { payload = JSON.parse(body || "{}"); } catch { /* bounded mock response below */ }
  const messages = payload.messages ?? [];
  const imageParts = messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part?.type === "image_url") : []);
  const imageUrls = imageParts.map((part) => part?.image_url?.url).filter((value) => typeof value === "string");
  if (imageUrls.length > 0) {
    visionRequests.push({ requestType: "vision", hasImage: true, imageCount: imageUrls.length, imageMimeType: imageUrls[0]?.match(/^data:([^;]+);/)?.[1], imageBytes: imageUrls.reduce((total, value) => total + Buffer.from(value.split(",", 2)[1] ?? "", "base64").byteLength, 0) });
  }
  response.setHeader("content-type", payload.stream === false ? "application/json" : "text/event-stream");
  if (payload.stream === false) {
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Screenshot smoke vision answer" } }] }));
    return;
  }
  const answer = imageUrls.length > 0 ? "Screenshot smoke vision answer：图片已进入 Vision Provider。" : "text request";
  for (const chunk of answer.match(/.{1,12}/gu) ?? [answer]) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  if (!response.destroyed) response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
const llmPort = llmServer.address().port;

const child = spawn(electronExecutable, ["--disable-gpu", "--in-process-gpu", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDirectory}`, desktopDirectory], {
  cwd: desktopDirectory,
  env: { ...process.env, INTERVIEW_COPILOT_DISABLE_GPU: "1", ELECTRON_DISABLE_SECURITY_WARNINGS: "true", INTERVIEW_COPILOT_SCREENSHOT_FIXTURE: "1", INTERVIEW_COPILOT_TEST_DATA_PATH: userDataDirectory, INTERVIEW_COPILOT_AUDIO_SIDECAR: audioSidecar, INTERVIEW_COPILOT_NODE_EXECUTABLE: process.execPath },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
child.stderr.on("data", (chunk) => { childOutput += String(chunk); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(2_000) })).json(); } catch { return []; }
}
async function waitForTarget(predicate, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const target = (await targets()).find(predicate);
    if (target) return target;
    await sleep(100);
  }
  throw new Error(`RUNTIME_E2E_TIMEOUT waiting for target\n${childOutput.slice(-3_000)}`);
}
function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const commands = new Map();
  let commandId = 0;
  socket.on("message", (value) => {
    const message = JSON.parse(String(value));
    if (!message.id || !commands.has(message.id)) return;
    const command = commands.get(message.id);
    commands.delete(message.id);
    clearTimeout(command.timer);
    if (message.error) command.reject(new Error(`CDP ${command.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
    else command.resolve(message.result);
  });
  socket.on("close", () => {
    for (const command of commands.values()) { clearTimeout(command.timer); command.reject(new Error(`RUNTIME_E2E_TIMEOUT target closed while waiting for ${command.method}`)); }
    commands.clear();
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    const timer = setTimeout(() => { commands.delete(id); reject(new Error(`RUNTIME_E2E_TIMEOUT CDP command ${method} exceeded 5s`)); }, 5_000);
    commands.set(id, { resolve, reject, timer, method });
    try { socket.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); commands.delete(id); reject(error); }
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed");
    return result?.result?.value;
  };
  return { socket, command, evaluate };
}
async function waitFor(predicate, client, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await client.evaluate(`(${predicate.toString()})()`)) return; }
    catch (error) { throw new Error(`RUNTIME_E2E_TIMEOUT condition failed: ${String(error)}`); }
    await sleep(100);
  }
  const runtime = await client.evaluate(`(async () => ({ screenshotDiagnostics: await window.interviewCopilot.screenshot.getDiagnostics(), screenshotTrace: await window.interviewCopilot.screenshot.getTrace(30), runtime: await window.interviewCopilot.interview.getRuntimeDiagnostics() }))()`).catch((error) => ({ error: String(error) }));
  throw new Error(`RUNTIME_E2E_TIMEOUT condition\n${JSON.stringify(runtime)}\n${childOutput.slice(-3_000)}`);
}
async function waitForNode(predicate, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(100);
  }
  const runtime = main ? await main.evaluate(`(async () => ({ screenshotDiagnostics: await window.interviewCopilot.screenshot.getDiagnostics(), screenshotTrace: await window.interviewCopilot.screenshot.getTrace(30) }))()`).catch((error) => ({ error: String(error) })) : { error: "main unavailable" };
  throw new Error(`RUNTIME_E2E_TIMEOUT mock service condition\n${JSON.stringify(runtime)}\n${childOutput.slice(-3_000)}`);
}

let main;
let overlay;
try {
  const mainTarget = await waitForTarget((item) => item.type === "page" && item.url.includes("index.html"));
  main = connectTarget(mainTarget);
  await new Promise((resolve, reject) => { main.socket.once("open", resolve); main.socket.once("error", reject); });
  await main.command("Runtime.enable");
  await waitFor(() => document.documentElement?.dataset.appReady === "true", main);
  const profileId = await main.evaluate(`(async () => {
    await window.interviewCopilot.settings.update('llm', { providerName: 'Mock Vision', baseUrl: 'http://127.0.0.1:${llmPort}', model: 'mock-text', visionModel: 'mock-vision', apiKey: 'mock-key', timeoutMs: 5_000, maxRetries: 0 });
    await window.interviewCopilot.settings.update('asr', { providerName: 'Custom WebSocket ASR Gateway', providerType: 'custom-gateway', baseUrl: 'ws://127.0.0.1:${asrPort}/realtime', model: 'mock-asr', language: 'zh-CN', apiKey: '', timeoutMs: 2_000, maxRetries: 0 });
    const profile = await window.interviewCopilot.profiles.save({ name: 'Screenshot smoke profile' });
    return profile?.id;
  })()`);
  if (!profileId) throw new Error("Screenshot smoke profile setup failed");
  await main.evaluate("window.interviewCopilot.audio.probe({ inputDeviceId: 'mock-mic', outputDeviceId: 'mock-system' })");
  await main.evaluate(`window.interviewCopilot.interview.start(${JSON.stringify({ profileId, url: `ws://127.0.0.1:${asrPort}/realtime`, providerType: "custom-gateway", model: "mock-asr", inputDeviceId: "mock-mic", outputDeviceId: "mock-system", automationMode: "MANUAL", answerMode: "NORMAL" })})`);
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "RUNNING"), main);
  const overlayTarget = await waitForTarget((item) => { try { return item.type === "page" && new URL(item.url).searchParams.get("window") === "overlay"; } catch { return false; } });
  overlay = connectTarget(overlayTarget);
  await new Promise((resolve, reject) => { overlay.socket.once("open", resolve); overlay.socket.once("error", reject); });
  await overlay.command("Runtime.enable");
  await waitFor(() => [...document.querySelectorAll("button")].some((button) => (button.innerText || "").includes("截图回答") && !button.disabled), overlay);
  const clicked = await overlay.evaluate("(() => { const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes('截图回答') && !item.disabled); if (!button) return false; button.click(); return true; })()");
  if (!clicked) throw new Error("Screenshot smoke button was not clickable");
  await waitForNode(() => visionRequests.some((request) => request.requestType === "vision" && request.hasImage && request.imageBytes > 0 && request.imageMimeType === "image/png"));
  await waitFor(() => document.body.innerText.includes("Screenshot smoke vision answer"), overlay);
  await waitFor(() => window.interviewCopilot.screenshot.getTrace(300).then((events) => events.some((event) => event.name === "SCREENSHOT_PIPELINE_COMPLETED")), main);
  const screenshotTrace = await main.evaluate("window.interviewCopilot.screenshot.getTrace(300)");
  const screenshotDiagnostics = await main.evaluate("window.interviewCopilot.screenshot.getDiagnostics()");
  const requiredTrace = ["SCREENSHOT_ACTION_REQUESTED", "SCREENSHOT_RENDERER_HANDLER_ENTERED", "SCREENSHOT_IPC_SENT", "SCREENSHOT_IPC_RECEIVED", "SCREENSHOT_CAPTURE_STARTED", "SCREENSHOT_CAPTURE_COMPLETED", "SCREENSHOT_IMAGE_NORMALIZED", "VISION_REQUEST_BUILT", "VISION_PROVIDER_REQUEST_STARTED", "VISION_PROVIDER_REQUEST_RECEIVED", "VISION_FIRST_TOKEN", "VISION_RESPONSE_COMPLETED", "VISION_OVERLAY_UPDATED", "SCREENSHOT_PIPELINE_COMPLETED"];
  if (!requiredTrace.every((name) => screenshotTrace.some((event) => event.name === name))) throw new Error(`Screenshot trace incomplete: ${JSON.stringify(screenshotTrace)}`);
  if (screenshotDiagnostics.activeScreenshotOperations !== 0 || screenshotDiagnostics.activeAbortControllers !== 0) throw new Error(`Screenshot operation leaked: ${JSON.stringify(screenshotDiagnostics)}`);
  await main.evaluate("window.interviewCopilot.interview.stop()");
  await waitFor(() => window.interviewCopilot.interview.getRuntimeDiagnostics().then((diagnostics) => diagnostics.sessionState === "stopped" && diagnostics.activeTimers === 0 && diagnostics.activeAbortControllers === 0), main);
  const finalDiagnostics = await main.evaluate("window.interviewCopilot.screenshot.getDiagnostics()");
  overlay.socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "window.close()", awaitPromise: false, returnByValue: false } }));
  main.socket.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "window.close()", awaitPromise: false, returnByValue: false } }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RUNTIME_E2E_TIMEOUT Electron did not exit after screenshot idle")), 10_000);
    child.once("exit", (code) => { clearTimeout(timer); if (code && code !== 0) reject(new Error(`Electron exited with ${code}`)); else resolve(); });
  });
  console.log(`SCREENSHOT_SMOKE_E2E_RESULT ${JSON.stringify({ visionRequests, requiredTrace: true, finalDiagnostics, processExited: true })}`);
} finally {
  overlay?.socket.close();
  main?.socket.close();
  asrServer.close();
  llmServer.close();
  if (child.exitCode === null) child.kill();
  await rm(userDataDirectory, { recursive: true, force: true }).catch(() => undefined);
}
