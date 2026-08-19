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
  ["mic-fail", "AUDIO_PROBE_MIC_FAILED"],
  ["system-fail", "AUDIO_PROBE_SYSTEM_FAILED"],
  ["both-fail", "AUDIO_PROBE_FAILED"],
  ["nonzero-after-result", "AUDIO_PROBE_PROCESS_FAILED"],
  ["exit-without-result", "AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT"]
];

if (!existsSync(electronExecutable) || !existsSync(audioSidecar)) throw new Error("Probe E2E dependencies are missing");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
for (const [index, [behavior, expectedCode]] of behaviors.entries()) {
  const port = 9450 + index;
  const userData = join(repositoryRoot, `.probe-failure-e2e-${behavior}`);
  await rm(userData, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  const child = spawn(electronExecutable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, desktopDirectory], {
    cwd: desktopDirectory,
    env: { ...process.env, INTERVIEW_COPILOT_AUDIO_SIDECAR: audioSidecar, INTERVIEW_COPILOT_NODE_EXECUTABLE: process.execPath, INTERVIEW_COPILOT_TEST_PROBE_BEHAVIOR: behavior, INTERVIEW_COPILOT_TEST_DATA_PATH: userData, INTERVIEW_COPILOT_LLM_BASE_URL: `http://127.0.0.1:${llmPort}`, INTERVIEW_COPILOT_LLM_API_KEY: "mock-key", INTERVIEW_COPILOT_LLM_MODEL: "mock-model" },
    stdio: "ignore",
    windowsHide: true
  });
  try {
    const page = await target(port);
    const renderer = connect(page);
    await new Promise((resolve, reject) => { renderer.socket.once("open", resolve); renderer.socket.once("error", reject); });
    await renderer.command("Runtime.enable");
    await renderer.evaluate("new Promise((resolve) => { const check = () => document.documentElement?.dataset.appReady === 'true' ? resolve(true) : setTimeout(check, 100); check(); })");
    const probeError = await renderer.evaluate("window.interviewCopilot.audio.probe({ inputDeviceId: 'mock-mic', outputDeviceId: 'mock-system' }).then(() => '').catch((error) => String(error))");
    if (!probeError.includes(expectedCode)) throw new Error(`${behavior}: expected ${expectedCode}, got ${probeError}`);
    const profileId = await renderer.evaluate("(async () => { const profiles = await window.interviewCopilot.profiles.list(); const profile = profiles[0] ?? await window.interviewCopilot.profiles.save({ name: 'Probe E2E', language: 'zh-CN', skills: [], knowledgeBaseIds: [] }); return profile?.id; })()");
    if (!profileId) throw new Error(`${behavior}: profile setup failed`);
    await renderer.evaluate(`window.interviewCopilot.settings.update('llm', ${JSON.stringify({ providerName: "Mock LLM", baseUrl: `http://127.0.0.1:${llmPort}`, model: "mock-model", apiKey: "mock-key", timeoutMs: 2_000, maxRetries: 0 })})`);
    await renderer.evaluate(`window.interviewCopilot.settings.update('asr', ${JSON.stringify({ providerName: "Custom WebSocket ASR Gateway", providerType: "custom-gateway", baseUrl: `ws://127.0.0.1:${asrPort}/realtime`, model: "mock-asr", language: "zh-CN", apiKey: "", timeoutMs: 2_000, maxRetries: 0 })})`);
    const formalError = await renderer.evaluate(`window.interviewCopilot.interview.start(${JSON.stringify({ profileId, url: `ws://127.0.0.1:${asrPort}/realtime`, inputDeviceId: "mock-mic", outputDeviceId: "mock-system", automationMode: "MANUAL", answerMode: "NORMAL", providerType: "custom-gateway" })}).then(() => '').catch((error) => String(error))`);
    if (!formalError.includes("AUDIO_PROBE_REQUIRED")) throw new Error(`${behavior}: formal capture was not blocked: ${formalError}`);
    const state = await renderer.evaluate("window.interviewCopilot.interview.getState()");
    if (state?.running) throw new Error(`${behavior}: interview became running after failed probe`);
    evidence.push(`PROBE_${behavior.toUpperCase().replaceAll("-", "_")}: PASS; FORMAL_CAPTURE_BLOCKED: PASS`);
    renderer.socket.close();
  } finally {
    child.kill();
    await sleep(250);
    await rm(userData, { recursive: true, force: true });
  }
}

asrServer.close();
llmServer.close();
console.log(evidence.join("\n"));
