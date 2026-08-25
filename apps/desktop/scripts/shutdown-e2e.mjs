import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import initSqlJs from "sql.js";

const desktopDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(desktopDirectory, "..", "..");
const artifactDirectory = join(repositoryRoot, "artifacts", "shutdown");
const electronExecutable = process.env.ELECTRON_EXECUTABLE ?? join(repositoryRoot, "node_modules", "electron", "dist", "electron.exe");
const audioSidecar = join(desktopDirectory, "src", "main", "test-audio-sidecar.mjs");
const marker = "SHUTDOWN_PARTIAL_QUESTION";
const partialAnswer = "这是已经生成的部分答案";

if (!existsSync(electronExecutable)) throw new Error(`Electron executable is missing: ${electronExecutable}`);
if (!existsSync(audioSidecar)) throw new Error(`Mock audio sidecar is missing: ${audioSidecar}`);
await mkdir(artifactDirectory, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let answerRequestSeen = false;
let chatRequestSeen = false;
let pcmPackets = 0;

function sseChunk(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const mockServer = createServer(async (request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += String(chunk); });
  await new Promise((resolve) => request.on("end", resolve));
  let payload = {};
  try { payload = JSON.parse(body || "{}"); } catch { /* provider will report a normal failure */ }
  const messages = payload.messages ?? [];
  const contents = messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");

  if (request.url?.endsWith("/v1/embeddings")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    return;
  }
  if (payload.stream === false) {
    if (contents.includes(marker)) {
      answerRequestSeen = true;
      // Direct-display interview answers wait for the complete response. Keep
      // this request open so shutdown can verify that the in-flight request is
      // cancelled and persisted without exposing partial text.
      response.writeHead(200, { "content-type": "application/json" });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    return;
  }

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  if (contents.includes(marker)) {
    answerRequestSeen = true;
    response.write(sseChunk(partialAnswer));
    // Deliberately leave the stream open. Shutdown must abort it and wait for
    // the provider promise before closing the database.
    return;
  }
  if (contents.includes("SHUTDOWN_ACTIVE_CHAT")) {
    chatRequestSeen = true;
    response.write(sseChunk("聊天已经生成的部分内容"));
    return;
  }
  response.end(`${sseChunk("OK")}data: [DONE]\n\n`);
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const mockPort = mockServer.address().port;

const asrServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
asrServer.on("connection", (socket) => {
  socket.on("message", (_value, isBinary) => {
    if (!isBinary) return;
    pcmPackets += 1;
  });
});
await new Promise((resolve) => asrServer.once("listening", resolve));
const asrPort = asrServer.address().port;

async function getTargets(port) {
  try { return await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { return []; }
}

async function waitForTarget(port, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const target = (await getTargets(port)).find((item) => item.type === "page" && item.url.includes("index.html"));
    if (target) return target;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for Electron renderer on port ${port}`);
}

function connectTarget(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let commandId = 0;
  const pending = new Map();
  socket.on("message", (value) => {
    const message = JSON.parse(String(value));
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message.result); }
  });
  const command = (method, params = {}) => new Promise((resolve) => {
    const id = ++commandId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer evaluation failed");
    return result?.result?.value;
  };
  return { socket, command, evaluate };
}

function waitForExit(child, timeout = 20_000) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: null });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Electron did not exit after the true app quit path")), timeout);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

async function waitForNode(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(message);
}

function launch(name, port, userDataDirectory) {
  const child = spawn(electronExecutable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDirectory}`, desktopDirectory], {
    cwd: desktopDirectory,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      INTERVIEW_COPILOT_TEST_DATA_PATH: userDataDirectory,
      INTERVIEW_COPILOT_AUDIO_SIDECAR: audioSidecar,
      INTERVIEW_COPILOT_NODE_EXECUTABLE: process.execPath,
      INTERVIEW_COPILOT_LLM_BASE_URL: `http://127.0.0.1:${mockPort}`,
      INTERVIEW_COPILOT_LLM_API_KEY: "mock-key",
      INTERVIEW_COPILOT_LLM_MODEL: "mock-model"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  child.on("error", (error) => { output += String(error); });
  return { name, port, child, get output() { return output; } };
}

async function openRenderer(processInfo, port) {
  const target = await waitForTarget(port);
  const renderer = connectTarget(target);
  await new Promise((resolve, reject) => { renderer.socket.once("open", resolve); renderer.socket.once("error", reject); });
  await renderer.command("Runtime.enable");
  await renderer.evaluate("new Promise((resolve) => { const check = () => document.documentElement?.dataset.appReady === 'true' ? resolve(true) : setTimeout(check, 100); check(); })");
  return renderer;
}

async function closeThroughElectron(renderer, duplicate = false) {
  const expression = duplicate
    ? "setTimeout(() => { window.close(); window.close(); }, 0); true"
    : "setTimeout(() => window.close(), 0); true";
  await renderer.evaluate(expression);
}

async function closeAllRendererWindows(port) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pages = (await getTargets(port)).filter((item) => item.type === "page");
    if (pages.length === 0) return;
    for (const page of pages) {
      let client;
      try {
        client = connectTarget(page);
        await new Promise((resolve, reject) => { client.socket.once("open", resolve); client.socket.once("error", reject); });
        await client.evaluate("setTimeout(() => window.close(), 0); true");
      } catch {
        // The target may disappear as the previous window-close reaches main.
      } finally {
        client?.socket.close();
      }
    }
    await sleep(250);
  }
  throw new Error(`Renderer windows did not all close on port ${port}`);
}

async function reopenInterviewDatabase(userDataDirectory) {
  const database = await openIndependentSqlite(userDataDirectory);
  const interviews = rows(database, "SELECT id, profile_id AS profileId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews ORDER BY created_at DESC");
  const latest = interviews[0];
  const snapshot = latest ? {
    interview: latest,
    transcripts: rows(database, "SELECT id, interview_id AS interviewId, source, text, start_ms AS startMs, end_ms AS endMs, final, confidence, created_at AS createdAt FROM transcripts WHERE interview_id = ? ORDER BY start_ms", [latest.id]),
    questions: rows(database, "SELECT id, interview_id AS interviewId, text, confidence, source, detected_at AS detectedAt, status FROM questions WHERE interview_id = ? ORDER BY detected_at", [latest.id]),
    answers: rows(database, "SELECT a.id, a.question_id AS questionId, a.text, a.model, a.mode, a.latency_first_token AS latencyFirstToken, a.latency_total AS latencyTotal, a.cancel_reason AS cancelReason, a.started_at AS startedAt, a.first_token_at AS firstTokenAt, a.finished_at AS finishedAt, a.created_at AS createdAt FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.interview_id = ? ORDER BY a.created_at", [latest.id])
  } : undefined;
  database.close();
  return { interviews, latest, snapshot };
}

async function reopenChatDatabase(userDataDirectory) {
  const database = await openIndependentSqlite(userDataDirectory);
  const conversations = rows(database, "SELECT id, project_id AS projectId, profile_id AS profileId, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC");
  const latest = conversations[0];
  const detail = latest ? {
    conversation: latest,
    messages: rows(database, "SELECT id, conversation_id AS conversationId, role, content, status, model, created_at AS createdAt FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id", [latest.id])
  } : undefined;
  database.close();
  return { conversations, detail };
}

async function openIndependentSqlite(userDataDirectory) {
  const filePath = join(userDataDirectory, "InterviewCopilot", "interview-copilot.sqlite");
  if (!existsSync(filePath)) throw new Error(`SQLite file was not written: ${filePath}`);
  const SQL = await initSqlJs({ locateFile: () => join(repositoryRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm") });
  return new SQL.Database(readFileSync(filePath));
}

function rows(database, sql, params = []) {
  const statement = database.prepare(sql);
  statement.bind(params);
  const result = [];
  while (statement.step()) result.push(statement.getAsObject());
  statement.free();
  return result;
}

async function runScenario(name, callback, options = {}) {
  const userDataDirectory = join(repositoryRoot, `.shutdown-e2e-${name}`);
  const port = 9560 + scenarios.length;
  await rm(userDataDirectory, { recursive: true, force: true });
  await mkdir(userDataDirectory, { recursive: true });
  const processInfo = launch(name, port, userDataDirectory);
  let renderer;
  try {
    renderer = await openRenderer(processInfo, port);
    const evidence = await callback(renderer, userDataDirectory, processInfo);
    await waitForExit(processInfo.child);
    const output = processInfo.output;
    if (processInfo.child.exitCode !== 0) throw new Error(`${name}: Electron exit code ${processInfo.child.exitCode}\n${output.slice(-4_000)}`);
    if (/(SQLITE_MISUSE|database is closed|unhandled rejection|UnhandledPromiseRejection)/i.test(output)) throw new Error(`${name}: shutdown output contains a database or promise error\n${output.slice(-4_000)}`);
    return { name, status: "PASS", evidence, outputTail: output.slice(-1_000) };
  } catch (error) {
    if (processInfo.child.exitCode === null) processInfo.child.kill();
    await sleep(300);
    return { name, status: "FAIL", evidence: [], error: String(error), outputTail: processInfo.output.slice(-2_000) };
  } finally {
    renderer?.socket.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

const scenarios = [];
const results = [];

scenarios.push("no-active");
results.push(await runScenario("no-active", async (renderer, userDataDirectory, processInfo) => {
  await closeThroughElectron(renderer);
  await waitForExit(processInfo.child);
  const database = await reopenInterviewDatabase(userDataDirectory);
  if (database.interviews.length !== 0) throw new Error("no-active: unexpected interview persisted");
  return { processExit: "PASS", sqliteReopen: "PASS", interviews: database.interviews.length };
}));

scenarios.push("active-interview");
results.push(await runScenario("active-interview", async (renderer, userDataDirectory, processInfo) => {
  answerRequestSeen = false;
  pcmPackets = 0;
  const profileId = await renderer.evaluate("(async () => { const current = await window.interviewCopilot.profiles.active(); const profile = current ?? await window.interviewCopilot.profiles.save({ name: 'Shutdown E2E', language: 'zh-CN', skills: [], knowledgeBaseIds: [] }); return profile?.id; })()");
  if (!profileId) throw new Error("active-interview: profile setup failed");
  await renderer.evaluate(`window.interviewCopilot.settings.update('llm', ${JSON.stringify({ providerName: "Shutdown Mock LLM", baseUrl: `http://127.0.0.1:${mockPort}`, model: "mock-model", apiKey: "mock-key", timeoutMs: 10_000, maxRetries: 0 })})`);
  await renderer.evaluate(`window.interviewCopilot.settings.update('asr', ${JSON.stringify({ providerName: "Shutdown Mock ASR", providerType: "custom-gateway", baseUrl: `ws://127.0.0.1:${asrPort}/realtime`, model: "mock-asr", language: "zh-CN", apiKey: "", timeoutMs: 10_000, maxRetries: 0 })})`);
  await renderer.evaluate("window.interviewCopilot.audio.probe({ inputDeviceId: 'mock-mic', outputDeviceId: 'mock-system' })");
  const interviewId = await renderer.evaluate(`window.interviewCopilot.interview.start(${JSON.stringify({ profileId, url: `ws://127.0.0.1:${asrPort}/realtime`, inputDeviceId: "mock-mic", outputDeviceId: "mock-system", automationMode: "MANUAL", answerMode: "NORMAL", providerType: "custom-gateway" })})`);
  if (!interviewId) throw new Error("active-interview: interview did not start");
  await waitForNode(() => pcmPackets > 0, "active-interview: mock ASR did not receive PCM");
  await renderer.evaluate(`void window.interviewCopilot.interview.answerQuestion(${JSON.stringify(marker)}); true`);
  await waitForNode(() => answerRequestSeen, "active-interview: direct-display LLM request was not observed");
  await closeThroughElectron(renderer);
  await closeAllRendererWindows(processInfo.port);
  await waitForExit(processInfo.child);
  const database = await reopenInterviewDatabase(userDataDirectory);
  const latest = database.latest;
  const answer = database.snapshot?.answers.find((item) => item.cancelReason === "user");
  if (!latest || latest.status !== "ended" || !latest.endedAt) throw new Error("active-interview: reopened interview is not ended");
  if (!answer || answer.cancelReason !== "user") throw new Error(`active-interview: in-flight answer or user cancel reason was not persisted; snapshot=${JSON.stringify({ latest, questions: database.snapshot?.questions ?? [], answers: database.snapshot?.answers ?? [] })}`);
  return { processExit: "PASS", sqliteReopen: "PASS", endedAt: latest.endedAt, status: latest.status, answerText: answer.text, cancelReason: answer.cancelReason };
}));

scenarios.push("active-chat");
results.push(await runScenario("active-chat", async (renderer, userDataDirectory, processInfo) => {
  chatRequestSeen = false;
  const profileId = await renderer.evaluate("(async () => { const current = await window.interviewCopilot.profiles.active(); const profile = current ?? await window.interviewCopilot.profiles.save({ name: 'Shutdown Chat E2E', language: 'zh-CN', skills: [], knowledgeBaseIds: [] }); return profile?.id; })()");
  await renderer.evaluate(`window.interviewCopilot.settings.update('llm', ${JSON.stringify({ providerName: "Shutdown Chat Mock LLM", baseUrl: `http://127.0.0.1:${mockPort}`, model: "mock-model", apiKey: "mock-key", timeoutMs: 10_000, maxRetries: 0 })})`);
  const conversationId = await renderer.evaluate(`(async () => { const conversation = await window.interviewCopilot.chat.createConversation({ profileId: ${JSON.stringify(profileId)}, title: 'Shutdown active chat' }); void window.interviewCopilot.chat.sendMessage(conversation.id, 'SHUTDOWN_ACTIVE_CHAT'); return conversation.id; })()`);
  if (!conversationId) throw new Error("active-chat: conversation did not start");
  await waitForNode(() => chatRequestSeen, "active-chat: mock LLM did not receive the chat stream");
  await closeThroughElectron(renderer);
  await waitForExit(processInfo.child);
  const database = await reopenChatDatabase(userDataDirectory);
  const statuses = database.detail?.messages.map((message) => message.status) ?? [];
  if (!statuses.includes("cancelled")) throw new Error(`active-chat: reopened messages were not cancelled: ${statuses.join(",")}`);
  return { processExit: "PASS", sqliteReopen: "PASS", messageStatuses: statuses };
}));

scenarios.push("idempotent-process");
results.push(await runScenario("idempotent-process", async (renderer, userDataDirectory, processInfo) => {
  await closeThroughElectron(renderer, true);
  await waitForExit(processInfo.child);
  const database = await reopenInterviewDatabase(userDataDirectory);
  return { processExit: "PASS", sqliteReopen: "PASS", interviews: database.interviews.length, duplicateClose: "PASS" };
}));

const failures = results.filter((result) => result.status !== "PASS");
const report = [
  "# SHUTDOWN PROCESS E2E REPORT",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  ...results.map((result) => `- ${result.name}: ${result.status}${result.evidence ? ` ${JSON.stringify(result.evidence)}` : ""}${result.error ? ` — ${result.error}` : ""}${result.status !== "PASS" && result.outputTail ? `\n  output-tail: ${JSON.stringify(result.outputTail)}` : ""}`),
  "",
  `- True Electron window-close -> window-all-closed -> app.quit: ${failures.length === 0 ? "PASS" : "FAIL"}`,
  `- Independent SQLite reopen after process exit: ${failures.length === 0 ? "PASS" : "FAIL"}`,
  `- SQLite misuse/unhandled rejection scan: ${failures.length === 0 ? "PASS" : "FAIL"}`,
  ""
].join("\n");
await writeFile(join(artifactDirectory, "SHUTDOWN_PROCESS_E2E_REPORT.md"), report, "utf8");

asrServer.close();
mockServer.close();
if (failures.length > 0) {
  console.error(report);
  process.exitCode = 1;
} else {
  console.log(report);
}
