import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";

const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(desktopDirectory, "..", "..");
const artifactDirectory = join(repositoryRoot, "artifacts", "realtime-smoke");
const userDataDirectory = join(repositoryRoot, ".realtime-smoke-user-data");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
const audioSidecar = join(desktopDirectory, "src", "main", "test-audio-sidecar.mjs");
const debugPort = 9344;

if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);
if (!existsSync(audioSidecar)) throw new Error(`Mock audio sidecar is missing: ${audioSidecar}`);
await mkdir(artifactDirectory, { recursive: true });
await rm(userDataDirectory, { recursive: true, force: true });

let questionSent = false;
const asrServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
asrServer.on("connection", (socket) => {
  socket.on("message", (_value, isBinary) => {
    if (!isBinary || questionSent) return;
    questionSent = true;
    socket.send(JSON.stringify({ type: "asr_status", source: "remote", state: "listening" }));
    setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "asr_final", segment: { id: "smoke-q1", source: "remote", text: "请解释 DMA 的作用？", startMs: 0, endMs: 600, final: true, confidence: 0.98 } }));
    }, 120);
  });
});
await new Promise((resolve) => asrServer.once("listening", resolve));
const asrPort = asrServer.address().port;

const llmServer = createServer(async (request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  await new Promise((resolve) => request.on("end", resolve));
  let payload = {};
  try { payload = JSON.parse(body || "{}"); } catch { /* invalid input gets a bounded mock response */ }
  response.setHeader("content-type", payload.stream === false ? "application/json" : "text/event-stream");
  if (payload.stream === false) {
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    return;
  }
  const answer = "Mock smoke answer：DMA 可以降低 CPU 搬运开销，并通过缓冲区和中断完成数据处理。";
  for (const chunk of answer.match(/.{1,10}/gu) ?? [answer]) {
    if (response.destroyed) return;
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  if (!response.destroyed) response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
const llmPort = llmServer.address().port;

const child = spawn(electronExecutable, ["--disable-gpu", "--in-process-gpu", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDirectory}`, desktopDirectory], {
  cwd: desktopDirectory,
  env: {
    ...process.env,
    INTERVIEW_COPILOT_DISABLE_GPU: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    INTERVIEW_COPILOT_TEST_DATA_PATH: userDataDirectory,
    INTERVIEW_COPILOT_AUDIO_SIDECAR: audioSidecar,
    INTERVIEW_COPILOT_NODE_EXECUTABLE: process.execPath
  },
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
  const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++commandId, method, params }));
  return { socket, command, evaluate, send };
}
async function waitFor(predicate, client, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await client.evaluate(`(${predicate.toString()})()`)) return; }
    catch (error) { throw new Error(`RUNTIME_E2E_TIMEOUT condition failed: ${String(error)}`); }
    await sleep(100);
  }
  const runtime = await client.evaluate(`(async () => ({ diagnostics: await window.interviewCopilot.interview.getRuntimeDiagnostics(), trace: await window.interviewCopilot.interview.getRuntimeTrace(30) }))()`).catch((error) => ({ error: String(error) }));
  throw new Error(`RUNTIME_E2E_TIMEOUT condition\n${JSON.stringify(runtime)}\n${childOutput.slice(-3_000)}`);
}

let main;
let overlay;
let overlayControl;
let lifecycleResult;
try {
  const mainTarget = await waitForTarget((item) => item.type === "page" && item.url.includes("index.html"));
  main = connectTarget(mainTarget);
  await new Promise((resolve, reject) => { main.socket.once("open", resolve); main.socket.once("error", reject); });
  await main.command("Runtime.enable");
  await main.evaluate("window.__runtimeSmokeReady = document.documentElement?.dataset.appReady === 'true'; window.__runtimeSmokeReady");
  await waitFor(() => document.documentElement?.dataset.appReady === "true", main);
  const configured = await main.evaluate(`(async () => {
    await window.interviewCopilot.settings.update('llm', { providerName: 'Mock LLM', baseUrl: 'http://127.0.0.1:${llmPort}', model: 'mock-model', apiKey: 'mock-key', timeoutMs: 5_000, maxRetries: 0 });
    await window.interviewCopilot.settings.update('asr', { providerName: 'Custom WebSocket ASR Gateway', providerType: 'custom-gateway', baseUrl: 'ws://127.0.0.1:${asrPort}/realtime', model: 'mock-asr', language: 'zh-CN', apiKey: '', timeoutMs: 2_000, maxRetries: 0 });
    const profile = await window.interviewCopilot.profiles.save({ name: 'Realtime smoke profile' });
    if (!profile?.id) throw new Error('smoke profile was not saved');
    return profile.id;
  })()`);
  if (!configured) throw new Error("Realtime smoke setup failed");
  await main.evaluate(`window.interviewCopilot.audio.probe({ inputDeviceId: 'mock-mic', outputDeviceId: 'mock-system' })`);
  const startedAt = Date.now();
  await main.evaluate(`window.interviewCopilot.interview.start(${JSON.stringify({ profileId: configured, url: `ws://127.0.0.1:${asrPort}/realtime`, providerType: "custom-gateway", model: "mock-asr", inputDeviceId: "mock-mic", outputDeviceId: "mock-system", automationMode: "AUTO", answerMode: "NORMAL" })})`);
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "RUNNING"), main);
  const overlayTarget = await waitForTarget((item) => { try { return item.type === "page" && new URL(item.url).searchParams.get("window") === "overlay"; } catch { return false; } });
  overlay = connectTarget(overlayTarget);
  await new Promise((resolve, reject) => { overlay.socket.once("open", resolve); overlay.socket.once("error", reject); });
  await overlay.command("Runtime.enable");
  const overlayControlTarget = await waitForTarget((item) => { try { return item.type === "page" && new URL(item.url).searchParams.get("window") === "overlay-control"; } catch { return false; } });
  overlayControl = connectTarget(overlayControlTarget);
  await new Promise((resolve, reject) => { overlayControl.socket.once("open", resolve); overlayControl.socket.once("error", reject); });
  await waitFor(() => document.body.innerText.includes("Mock smoke answer"), overlay);
  await waitFor(() => window.interviewCopilot.interview.getRuntimeTrace(300).then((events) => events.some((event) => event.name === "QUESTION_FINISHED")), main);
  const stopStartedAt = Date.now();
  await main.evaluate("window.interviewCopilot.interview.stop()");
  await waitFor(() => window.interviewCopilot.interview.getRuntimeDiagnostics().then((diagnostics) => diagnostics.sessionState === "stopped" && diagnostics.activeTimers === 0 && diagnostics.activeAbortControllers === 0), main);
  const finalTrace = await main.evaluate("window.interviewCopilot.interview.getRuntimeTrace(300)");
  const event = (name) => finalTrace.find((item) => item.name === name);
  const diagnostics = await main.evaluate("window.interviewCopilot.interview.getRuntimeDiagnostics()");
  lifecycleResult = {
    startLatencyMs: Math.max(0, (event("INTERVIEW_SESSION_STARTED")?.timestamp ?? startedAt) - startedAt),
    questionToAnswerStartMs: Math.max(0, (event("PROVIDER_STREAM_STARTED")?.timestamp ?? startedAt) - (event("QUESTION_CONFIRMED")?.timestamp ?? startedAt)),
    firstTokenLatencyMs: Math.max(0, (event("PROVIDER_FIRST_TOKEN")?.timestamp ?? startedAt) - (event("PROVIDER_STREAM_STARTED")?.timestamp ?? startedAt)),
    answerCompletionMs: Math.max(0, (event("QUESTION_FINISHED")?.timestamp ?? startedAt) - (event("PROVIDER_STREAM_STARTED")?.timestamp ?? startedAt)),
    stopLatencyMs: Math.max(0, (event("RUNTIME_CLEANUP_COMPLETED")?.timestamp ?? stopStartedAt) - stopStartedAt),
    requiredEvents: ["QUESTION_FINISHED", "INTERVIEW_SESSION_STOPPED", "RUNTIME_IDLE"].every((name) => Boolean(event(name))),
    finalRuntimeIdle: diagnostics.sessionState === "stopped" && diagnostics.activeTimers === 0 && diagnostics.activeAbortControllers === 0 && diagnostics.activeProviderRequests === 0 && diagnostics.transcriptQueueDepth === 0,
    diagnostics
  };
  if (!lifecycleResult.requiredEvents || !lifecycleResult.finalRuntimeIdle) throw new Error(`Realtime smoke lifecycle incomplete: ${JSON.stringify(lifecycleResult)}`);
  // Close both renderer windows without waiting for a response from a target
  // that is intentionally being destroyed. Electron's before-quit handler
  // then runs the normal application shutdown controller.
  overlay.send("Runtime.evaluate", { expression: "window.close()", awaitPromise: false, returnByValue: false });
  overlayControl.socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "window.close()", awaitPromise: false, returnByValue: false } }));
  main.send("Runtime.evaluate", { expression: "window.close()", awaitPromise: false, returnByValue: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RUNTIME_E2E_TIMEOUT Electron did not exit after successful idle")), 10_000);
    child.once("exit", (code) => { clearTimeout(timer); if (code && code !== 0) reject(new Error(`Electron exited with ${code}`)); else resolve(); });
  });
  console.log(`REALTIME_SMOKE_E2E_RESULT ${JSON.stringify({ ...lifecycleResult, processExited: true })}`);
} finally {
  overlay?.socket.close();
  overlayControl?.socket.close();
  main?.socket.close();
  asrServer.close();
  llmServer.close();
  if (child.exitCode === null) child.kill();
  await rm(userDataDirectory, { recursive: true, force: true }).catch(() => undefined);
}
