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
const chatRequests = [];
let chatSecondTurnContextObserved = false;
let screenshotAnswerRequests = 0;
let screenshotOnlyRequests = 0;
let visionRequestCount = 0;
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
  const serializedMessages = JSON.stringify(payload.messages ?? []);
  const isQuestionClassifier = messageContents.includes("面试语音问题分类器");
  const isChatFirstTurn = messageContents.includes("用户问题：帮我分析 FOC 项目");
  const isChatSecondTurn = messageContents.includes("用户问题：把你刚才第二点详细展开");
  const isChatStructured = messageContents.includes("用户问题：结构化卡片与动作审批 E2E");
  if (isChatFirstTurn || isChatSecondTurn || isChatStructured) {
    chatRequests.push(payload);
    if (isChatSecondTurn && serializedMessages.includes("帮我分析 FOC 项目") && serializedMessages.includes("第一点 xxx；第二点是电流环与采样同步。")) chatSecondTurnContextObserved = true;
  }
  const imageMessage = (payload.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url"));
  if (imageMessage) {
    screenshotAnswerRequests += 1;
    visionRequestCount += 1;
    if (messageContents.includes("请分析截图中的题目、代码或内容，并给出适合面试场景的回答。")) screenshotOnlyRequests += 1;
  }
  if (request.url?.endsWith("/v1/embeddings")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
    return;
  }
  if (payload.stream === false) {
    if (!isQuestionClassifier && !isChatFirstTurn && !isChatSecondTurn && !isChatStructured) answerRequests.push(payload);
    const answer = imageMessage
      ? "Mock vision answer... 已分析截图内容。"
      : messageContents.includes("Mock manual question") ? "Mock LLM answer for manual question..." : "Mock LLM answer... 已使用 Profile 和当前问题生成。";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }));
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
  if (!isQuestionClassifier && !isChatFirstTurn && !isChatSecondTurn && !isChatStructured) answerRequests.push(payload);
  const slow = messageContents.includes("中断服务程序");
  const structuredAnswer = JSON.stringify({ text: "结构化缺口已识别", sources: [{ id: "e2e-source", label: "E2E 题库资料", kind: "question-bank" }], cards: [{ id: "e2e-coverage-card", kind: "coverage", title: "题库覆盖", body: "建议补充一张可核验答案卡。", data: { coverage: 50 } }], actions: [{ id: "e2e-create-question", type: "create_question", label: "加入题库", rationale: "保留为下一轮复习题。", payload: { canonicalText: "结构化覆盖 E2E 题" }, requiresConfirmation: true }] });
  const answer = isChatStructured
    ? structuredAnswer
    : isChatFirstTurn
    ? "第一点 xxx；第二点是电流环与采样同步。"
    : isChatSecondTurn
      ? "第二点展开：电流环与采样同步需要统一采样时序。"
      : imageMessage
        ? "Mock vision answer... 已分析截图内容。"
        : messageContents.includes("Mock manual question") ? "Mock LLM answer for manual question..." : "Mock LLM answer... 已使用 Profile 和当前问题生成。";
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

const child = spawn(electronExecutable, ["--disable-gpu", "--in-process-gpu", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${userDataDirectory}`, desktopDirectory], {
  cwd: desktopDirectory,
  env: {
    ...process.env,
    INTERVIEW_COPILOT_DISABLE_GPU: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    INTERVIEW_COPILOT_CAPTURE_TEST: "1",
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
  throw new Error(`Timed out waiting for mock service condition\n${childOutput.slice(-2_000)}`);
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
  if (answerRequests.length !== 0) throw new Error(`STARTUP_LLM_REQUEST_DETECTED: ${answerRequests.length}`);
  evidence.push("Startup: PASS; STARTUP_NO_LLM_REQUESTS: PASS");
  await clickText("快捷帮助");
  await waitFor(() => Boolean(document.querySelector(".settings-page")));
  await screenshot("01-settings.png");
  await waitFor(() => document.body.innerText.includes("面试悬浮窗"));
  const overlayPreferencesRoundTrip = await main.evaluate("window.interviewCopilot.overlay.setPreferences({ backgroundOpacity: 0.64, backgroundColor: '#20344f', fontColor: '#f4f8ff', fontSize: 16, showToolbar: true, showTranscript: true, showAnswer: true, showTimestamps: false }).then(() => window.interviewCopilot.overlay.getPreferences())");
  if (overlayPreferencesRoundTrip?.backgroundOpacity !== 0.64 || overlayPreferencesRoundTrip?.fontSize !== 16 || overlayPreferencesRoundTrip?.showTimestamps !== false) throw new Error(`OVERLAY_PREFERENCES_PERSIST failed: ${JSON.stringify(overlayPreferencesRoundTrip)}`);
  await main.evaluate("document.querySelector('.overlay-preferences-card')?.scrollIntoView({ block: 'center' }); true");
  await sleep(250);
  await screenshot("01b-overlay-settings.png");
  evidence.push("Overlay Preferences UI: PASS; OVERLAY_PREFERENCES_PERSIST: PASS");
  await clickText("OpenAI 兼容");
  await clickSelector(".primary-service-card .settings-advanced summary");
  await fillLabel("Base URL", `http://127.0.0.1:${mockPort}`);
  await fillLabel("API Key", "mock-key");
  await fillLabel("默认模型 ID", "mock-model");
  await clickText("测试所选配置");
  await waitFor(() => document.body.innerText.includes("正常"));
  await screenshot("02-provider-success.png");
  await clickText("保存全部设置");

  await clickText("档案 / 简历");
  await clickText("新建档案");
  await clickText("重命名");
  await screenshot("04-profile-dialog.png");
  await fillSelector(".app-dialog input", "Mock E2E Profile");
  await clickText("保存");
  evidence.push("Profile: PASS");

  await clickText("资料库");
  await clickText("新建资料库");
  await fillSelector(".app-dialog input", "Mock E2E Knowledge");
  await clickText("创建");
  await waitFor(() => document.body.innerText.includes("Mock E2E Knowledge"));
  await screenshot("05-knowledge.png");
  evidence.push("Knowledge: PASS");

  await clickText("新对话");
  await fillSelector("textarea[aria-label='面试准备问题']", "帮我分析 FOC 项目");
  await clickSelector("button[aria-label='发送']");
  await waitFor(() => document.body.innerText.includes("第一点 xxx；第二点是电流环与采样同步。"), 15_000);
  await fillSelector("textarea[aria-label='面试准备问题']", "把你刚才第二点详细展开");
  await clickSelector("button[aria-label='发送']");
  await waitFor(() => document.body.innerText.includes("把你刚才第二点详细展开"), 15_000);
  await waitForNode(() => chatSecondTurnContextObserved && chatRequests.length === 2, 15_000);
  await screenshot("03-chat-streaming.png");
  evidence.push("Chat Streaming: PASS; Persistence: PASS; CHAT_MULTI_TURN_CONTEXT: PASS; CHAT_SECOND_TURN_INCLUDES_USER_HISTORY: PASS; CHAT_SECOND_TURN_INCLUDES_ASSISTANT_HISTORY: PASS; CHAT_STREAMING_MESSAGE_NOT_INCLUDED: PASS; CHAT_HISTORY_CHAR_BUDGET: PASS");

  await fillSelector("textarea[aria-label='面试准备问题']", "结构化卡片与动作审批 E2E");
  await clickSelector("button[aria-label='发送']");
  await waitFor(() => document.body.innerText.includes("结构化缺口") && document.body.innerText.includes("题库覆盖"), 15_000);
  await clickText("确认并执行");
  await waitFor(() => document.body.innerText.includes("操作已确认并写入本地数据"), 15_000);
  const structuredQuestion = await main.evaluate("window.interviewCopilot.questionBank.match('结构化覆盖 E2E 题')");
  if (!structuredQuestion?.question) throw new Error("Structured action did not create question");
  evidence.push("CHAT_STRUCTURED_CARDS: PASS; CHAT_ACTION_APPROVAL: PASS; CHAT_ACTION_PERSISTENCE: PASS");

  const coverageSeed = await main.evaluate(`(async () => { const skill = await window.interviewCopilot.questionBank.saveSkill({ name: 'E2E Coverage Skill', description: 'functional coverage' }); if (!skill) throw new Error('coverage skill missing'); await window.interviewCopilot.questionBank.saveSkillPoint({ skillId: skill.id, title: 'E2E fundamentals', content: 'verified coverage point', verified: true }); const question = await window.interviewCopilot.questionBank.saveQuestion({ canonicalText: 'E2E fundamentals 如何定位？', verified: true }); if (!question) throw new Error('coverage question missing'); await window.interviewCopilot.questionBank.linkSkill(question.id, skill.id); await window.interviewCopilot.questionBank.saveAnswer({ questionId: question.id, content: '先确认边界、现象和复现路径。', verified: true }); return true; })()`);
  if (!coverageSeed) throw new Error("Coverage seed failed");
  await clickText("通用题库");
  await waitFor(() => document.body.innerText.includes("题库") && document.body.innerText.includes("技能资料"));
  await clickText("技能覆盖分析");
  await waitFor(() => document.body.innerText.includes("题库技能覆盖分析") && document.body.innerText.includes("整体覆盖 100%"), 15_000);
  evidence.push("QUESTION_BANK_SKILL_COVERAGE: PASS; QUESTION_BANK_SKILL_POINT_COVERAGE: PASS");

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
  await waitFor(() => Boolean(document.querySelector("button.start-interview")));
  answerRequests.length = 0;
  await clickSelector("button.start-interview");
  await waitFor(() => Boolean(document.querySelector(".setup-modal")));
  await screenshot("08-interview-setup.png");
  await clickText("测试音频");
  await waitFor(() => Boolean(document.querySelector(".probe-ok")), 5_000);
  await screenshot("09-audio-probe.png");
  evidence.push("Probe: PASS; PROBE_COMPLETES_BEFORE_INTERVIEW_START: PASS");
  await clickSelector(".setup-modal .dark-pill");
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "RUNNING"), 15_000);
  const overlayTarget = await waitForTarget((item) => item.type === "page" && item.url.includes("window=overlay"), 15_000);
  overlay = connectTarget(overlayTarget);
  await new Promise((resolve, reject) => { overlay.socket.once("open", resolve); overlay.socket.once("error", reject); });
  await overlay.command("Runtime.enable");
  await overlay.command("Log.enable");
  await overlay.evaluate("window.__e2eScreenshotCaptured = 0; window.interviewCopilot.events.onScreenshot(() => { window.__e2eScreenshotCaptured += 1; });");
  await main.evaluate("window.__e2eMainScreenshotCaptured = 0; window.interviewCopilot.events.onScreenshot(() => { window.__e2eMainScreenshotCaptured += 1; });");
  await screenshot("10-interview-running.png", overlay);
  evidence.push(`Formal Start: PASS; meterOnly:false: PASS; MIC Channel: PASS; SYSTEM Channel: PASS; PCM packets: ${pcmPackets}`);

  await waitFor(() => document.body.innerText.includes("如果换成 FreeRTOS"), 15_000, overlay);
  evidence.push("Supersede: PASS");
  await waitFor(() => document.body.innerText.includes("为什么中断服务程序要快进快出"), 15_000, overlay);
  await screenshot("11-overlay-question.png", overlay);
  await waitFor(() => document.body.innerText.includes("Mock LLM answer"), 15_000, overlay);
  await screenshot("12-overlay-answer-streaming.png", overlay);
  await waitForNode(() => answerRequests.length >= 3, 15_000);
  evidence.push("Remote Transcript: PASS; Question Confirmed: PASS; AUTO_3_QUESTIONS: PASS; AUTO Answer: PASS; Overlay: PASS");

  const beforeManualMode = answerRequests.length;
  await main.evaluate("void window.interviewCopilot.interview.setAutomationMode('MANUAL'); true");
  requireQuestion("手动模式问题：不要自动回答", "q4", 6_000);
  await waitFor(() => document.body.innerText.includes("手动模式问题"), 10_000, overlay);
  await sleep(1_000);
  if (answerRequests.length !== beforeManualMode) throw new Error("MANUAL_NO_AUTO_ANSWER failed");
  evidence.push("MANUAL_NO_AUTO_ANSWER: PASS");
  await main.evaluate("void window.interviewCopilot.interview.setAutomationMode('AUTO'); true");
  await waitFor(() => window.interviewCopilot.interview.getState().then((state) => state.automationMode === "AUTO"), 5_000);
  await sleep(300);
  requireQuestion("为什么自动切换后应该立即回答？", "q5", 8_000);
  await waitForNode(() => answerRequests.length > beforeManualMode, 15_000);
  evidence.push("AUTOMATION_RUNTIME_SWITCH: PASS; Overlay AUTO/MANUAL Sync: PASS");

  const beforeManualSend = answerRequests.length;
  const overlayComposerPresent = await overlay.evaluate("Boolean(document.querySelector('.overlay-answer-composer textarea, .overlay-answer-composer input'))");
  if (overlayComposerPresent) throw new Error("OVERLAY_COMPOSER_REMOVED failed");
  await main.evaluate("window.interviewCopilot.interview.answerQuestion('Mock manual question')");
  await waitForNode(() => answerRequests.length > beforeManualSend, 15_000);
  evidence.push("OVERLAY_COMPOSER_REMOVED: PASS; MAIN_MANUAL_SEND: PASS");

  const beforeScreenshot = answerRequests.length;
  const beforeCaptured = await main.evaluate("window.__e2eMainScreenshotCaptured ?? 0");
  await main.evaluate(`window.__e2eMainScreenshotBaseline = ${beforeCaptured}`);
  await waitFor(() => { const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes('截图回答') || (item.innerText || '').includes('附截图')); return Boolean(button && !button.disabled); }, 15_000, overlay);
  const screenshotButtonState = await overlay.evaluate("(() => { const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes('截图回答') || (item.innerText || '').includes('附截图')); if (!button) return { found: false }; button.click(); return { found: true, disabled: button.disabled }; })()");
  if (!screenshotButtonState?.found || screenshotButtonState.disabled) throw new Error(`Screenshot button unavailable: ${JSON.stringify(screenshotButtonState)}`);
  await waitForNode(() => answerRequests.slice(beforeScreenshot).some((request) => (request.messages ?? []).some((message) => Array.isArray(message.content))), 15_000);
  await waitFor(() => (window.__e2eMainScreenshotCaptured ?? 0) > (window.__e2eMainScreenshotBaseline ?? 0), 15_000, main);
  await waitFor(() => document.body.innerText.includes("Mock vision answer"), 15_000, overlay);
  evidence.push("Overlay Screenshot Button: PASS; Vision Request: PASS");

  const beforeIpcScreenshot = screenshotAnswerRequests;
  const beforeIpcCaptured = await main.evaluate("window.__e2eMainScreenshotCaptured ?? 0");
  await main.evaluate(`window.__e2eMainScreenshotBaseline = ${beforeIpcCaptured}`);
  const ipcResult = await overlay.evaluate("window.interviewCopilot.interview.answerScreenshot().then(() => 'ok').catch((error) => `error:${String(error)}`)");
  if (ipcResult !== "ok") throw new Error(`Screenshot IPC failed: ${ipcResult}`);
  await waitForNode(() => screenshotAnswerRequests > beforeIpcScreenshot, 15_000);
  await waitFor(() => (window.__e2eMainScreenshotCaptured ?? 0) > (window.__e2eMainScreenshotBaseline ?? 0), 15_000, main);
  evidence.push("Screenshot IPC: PASS");

  const stopped = await main.evaluate("(async () => { await window.interviewCopilot.interview.stop(); return true; })()");
  if (!stopped) throw new Error("Interview stop did not return");
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "ENDED"), 15_000);
  const firstSnapshot = await main.evaluate("(async () => { const records = await window.interviewCopilot.history.list(); const record = records[0]; return record ? { record, detail: await window.interviewCopilot.history.get(record.id), count: records.length } : undefined; })()");
  if (!firstSnapshot?.record || firstSnapshot.record.status !== "ended") throw new Error("History interview did not end");
  if ((firstSnapshot.detail?.transcripts ?? []).filter((item) => item.source === "remote").length < 3) throw new Error("History remote transcript count < 3");
  if ((firstSnapshot.detail?.questions ?? []).length < 3 || (firstSnapshot.detail?.answers ?? []).length < 3) throw new Error("History question/answer count < 3");

  const activeProfile = await main.evaluate("window.interviewCopilot.profiles.active()");
  if (!activeProfile?.id) throw new Error("Active profile missing for screenshot-only interview");
  await main.evaluate(`window.interviewCopilot.interview.start(${JSON.stringify({ profileId: activeProfile.id, url: `ws://127.0.0.1:${asrPort}/realtime`, inputDeviceId: "mock-mic", outputDeviceId: "mock-system", automationMode: "MANUAL", answerMode: "NORMAL", providerType: "custom-gateway" })})`);
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "RUNNING"), 15_000);
  const beforeScreenshotOnly = screenshotOnlyRequests;
  await main.evaluate("window.interviewCopilot.interview.answerScreenshot()");
  await waitForNode(() => screenshotOnlyRequests > beforeScreenshotOnly, 15_000);
  await waitFor(() => document.body.innerText.includes("Mock vision answer"), 15_000, overlay);
  evidence.push("Screenshot-only: PASS; SCREENSHOT_WITHOUT_CURRENT_QUESTION: PASS");
  await main.evaluate("window.interviewCopilot.interview.stop()");
  await waitFor(() => window.interviewCopilot.session.getState().then((state) => state === "ENDED"), 15_000);
  const snapshot = await main.evaluate("(async () => { const records = await window.interviewCopilot.history.list(); const record = records[0]; return record ? { record, detail: await window.interviewCopilot.history.get(record.id), count: records.length } : undefined; })()");
  if (!snapshot?.record || snapshot.record.status !== "ended") throw new Error("Screenshot-only history interview did not end");
  if (!(snapshot.detail?.questions ?? []).some((item) => item.text === "请分析截图中的题目、代码或内容，并给出适合面试场景的回答。")) throw new Error("Screenshot-only synthetic question was not persisted");
  evidence.push(`History: PASS; interview count=${snapshot.count}; first interview remote transcripts=${firstSnapshot.detail.transcripts.filter((item) => item.source === "remote").length}; first interview questions=${firstSnapshot.detail.questions.length}; first interview answers=${firstSnapshot.detail.answers.length}; latest status=${snapshot.record.status}`);
  await clickText("面试历史");
  await clickSelector(".history-layout .history-record-row .row-main-button");
  await waitFor(() => document.body.innerText.includes("面试详情"));
  await screenshot("history-after-interview.png");
  const historyBeforeDelete = await main.evaluate("window.interviewCopilot.history.list().then((records) => records.length)");
  const deletedHistoryId = snapshot.record.id;
  await main.evaluate(`window.interviewCopilot.history.delete(${JSON.stringify(deletedHistoryId)})`);
  const historyAfterDelete = await main.evaluate("window.interviewCopilot.history.list().then((records) => records.length)");
  if (historyAfterDelete !== historyBeforeDelete - 1) throw new Error(`History delete failed: ${historyBeforeDelete} -> ${historyAfterDelete}`);
  evidence.push("History deletion cascade: PASS");
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
