import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const desktopDirectory = join(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = join(desktopDirectory, "..", "..");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
const audioSidecar = join(desktopDirectory, "src", "main", "test-audio-sidecar.mjs");
const behaviors = [
  ["mic-fail", "partial", "system_only"],
  ["system-fail", "partial", "mic_only"],
  ["both-fail", "blocked", "NO_AUDIO_CHANNEL_AVAILABLE"],
  ["timeout", "probe-failed", "AUDIO_PROBE_TIMEOUT"],
  ["nonzero-after-result", "probe-failed", "AUDIO_PROBE_PROCESS_FAILED"],
  ["exit-without-result", "probe-failed", "AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT"],
  ["crash", "probe-failed", "AUDIO_PROBE_PROCESS_CRASHED"]
];

if (!existsSync(electronExecutable) || !existsSync(audioSidecar)) throw new Error("Probe E2E dependencies are missing");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function removeUserData(path) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await sleep(250 + attempt * 100);
    }
  }
  throw new Error(`Unable to remove E2E user data after retries: ${path}`);
}
async function targets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { return []; }
}
async function target(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = (await targets(port)).find((item) => item.type === "page" && item.url.includes("index.html"));
    if (page) return page;
    await sleep(100);
  }
  throw new Error(`Probe E2E renderer did not start on ${port}`);
}
function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.on("message", (value) => {
    const message = JSON.parse(String(value));
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message.result); }
  });
  const command = (method, params = {}) => new Promise((resolve) => { const next = ++id; pending.set(next, resolve); socket.send(JSON.stringify({ id: next, method, params })); });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "renderer evaluation failed");
    return result?.result?.value;
  };
  return { socket, command, evaluate };
}

const evidence = [];
const llmServer = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
  });
});
await new Promise((resolve) => llmServer.listen(0, "127.0.0.1", resolve));
const llmPort = llmServer.address().port;
const asrServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
asrServer.on("connection", () => undefined);
await new Promise((resolve) => asrServer.once("listening", resolve));
const asrPort = asrServer.address().port;
for (const [index, [behavior, formalExpectation, expectedCode]] of behaviors.entries()) {
  const port = 9450 + index;
  const userData = join(repositoryRoot, `.probe-failure-e2e-${behavior}`);
  await removeUserData(userData);
  await mkdir(userData, { recursive: true });
  const child = spawn(electronExecutable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, desktopDirectory], {
    cwd: desktopDirectory,
    env: { ...process.env, INTERVIEW_COPILOT_AUDIO_SIDECAR: audioSidecar, INTERVIEW_COPILOT_NODE_EXECUTABLE: process.execPath, INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR: behavior, ...(behavior === "timeout" ? { INTERVIEW_COPILOT_AUDIO_PROBE_TIMEOUT_MS: "300" } : {}), INTERVIEW_COPILOT_TEST_DATA_PATH: userData, INTERVIEW_COPILOT_LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, INTERVIEW_COPILOT_LLM_API_KEY: "mock-key", INTERVIEW_COPILOT_LLM_MODEL: "mock-model" },
    stdio: "ignore",
    windowsHide: true
  });
  try {
    const page = await target(port);
    const renderer = connect(page);
    await new Promise((resolve, reject) => { renderer.socket.once("open", resolve); renderer.socket.once("error", reject); });
    await renderer.command("Runtime.enable");
    await renderer.evaluate("new Promise((resolve) => { const check = () => document.documentElement?.dataset.appReady === 'true' ? resolve(true) : setTimeout(check, 100); check(); })");
    const probeResult = await renderer.evaluate("window.interviewCopilot.audio.probe({ inputDeviceId: 'mock-mic', outputDeviceId: 'mock-system' }).then((result) => ({ ok: true, result })).catch((error) => ({ ok: false, error: String(error) }))");
    if (formalExpectation === "partial") {
      if (!probeResult.ok || probeResult.result?.captureMode !== expectedCode) throw new Error(`${behavior}: expected structured ${expectedCode} probe result, got ${JSON.stringify(probeResult)}`);
    } else if (formalExpectation === "probe-failed" && (probeResult.ok || !probeResult.error.includes(expectedCode))) {
      throw new Error(`${behavior}: expected ${expectedCode}, got ${JSON.stringify(probeResult)}`);
    }
    const profileId = await renderer.evaluate("(async () => { const profiles = await window.interviewCopilot.profiles.list(); const profile = profiles[0] ?? await window.interviewCopilot.profiles.save({ name: 'Probe E2E', language: 'zh-CN', skills: [], knowledgeBaseIds: [] }); return profile?.id; })()");
    if (!profileId) throw new Error(`${behavior}: profile setup failed`);
    await renderer.evaluate(`window.interviewCopilot.settings.update('llm', ${JSON.stringify({ providerName: "Mock LLM", baseUrl: `http://127.0.0.1:${llmPort}`, model: "mock-model", apiKey: "mock-key", timeoutMs: 2_000, maxRetries: 0 })})`);
    await renderer.evaluate(`window.interviewCopilot.settings.update('asr', ${JSON.stringify({ providerName: "Custom WebSocket ASR Gateway", providerType: "custom-gateway", baseUrl: `ws://127.0.0.1:${asrPort}/realtime`, model: "mock-asr", language: "zh-CN", apiKey: "", timeoutMs: 2_000, maxRetries: 0 })})`);
    const formalResult = await renderer.evaluate(`window.interviewCopilot.interview.start(${JSON.stringify({ profileId, url: `ws://127.0.0.1:${asrPort}/realtime`, inputDeviceId: "mock-mic", outputDeviceId: "mock-system", automationMode: "MANUAL", answerMode: "NORMAL", providerType: "custom-gateway" })}).then((id) => ({ ok: true, id })).catch((error) => ({ ok: false, error: String(error) }))`);
    if (formalExpectation === "blocked") {
      if (formalResult.ok || !formalResult.error.includes(expectedCode)) throw new Error(`${behavior}: expected formal block ${expectedCode}, got ${JSON.stringify(formalResult)}`);
    } else if (!formalResult.ok) {
      throw new Error(`${behavior}: formal capture unexpectedly failed: ${JSON.stringify(formalResult)}`);
    }
    if (formalExpectation !== "blocked") {
      await renderer.evaluate("new Promise((resolve) => { const deadline = Date.now() + 5_000; const check = () => window.interviewCopilot.interview.getState().then((state) => state?.running ? resolve(true) : Date.now() >= deadline ? resolve(false) : setTimeout(check, 100)); check(); })");
    }
    const state = await renderer.evaluate("window.interviewCopilot.interview.getState()");
    if (formalExpectation === "blocked" && state?.running) throw new Error(`${behavior}: interview became running after both channels failed`);
    if (formalExpectation !== "blocked" && !state?.running) throw new Error(`${behavior}: interview did not start after optional probe result`);
    if (state?.running) await renderer.evaluate("window.interviewCopilot.interview.stop()");
    evidence.push(`PROBE_${behavior.toUpperCase().replaceAll("-", "_")}: PASS; FORMAL_${formalExpectation.toUpperCase()}: PASS`);
    renderer.socket.close();
  } finally {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(2_000)]);
    await removeUserData(userData);
  }
}

asrServer.close();
llmServer.close();
console.log(evidence.join("\n"));
