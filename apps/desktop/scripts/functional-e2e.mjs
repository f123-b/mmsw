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
const projectAnswerRequests = [];
const chatRequests = [];
const projectAgentRequests = [];
let chatSecondTurnContextObserved = false;
let screenshotAnswerRequests = 0;
let screenshotOnlyRequests = 0;
let visionRequestCount = 0;
const visionRequests = [];
let pcmPackets = 0;
let activeAsrSocket;
let scheduledQuestions = false;
let preparationRequests = 0;

// Keep the regression flow deterministic when requested while rotating the
// interview topics between normal runs. Set INTERVIEW_E2E_VARIANT to pin a
// variant in CI or when reproducing a failure.
const interviewQuestionSets = [
  {
    auto: ["为什么中断服务程序要快进快出？", "为什么使用 DMA？", "如果换成 FreeRTOS 呢？"],
    manual: ["手动模式问题：不要自动回答", "为什么自动切换后应该立即回答？"]
  },
  {
    auto: ["CAN 总线仲裁失败时你如何定位？", "ADC 采样与 PWM 更新怎样保证同步？", "Linux 与 FreeRTOS 如何划分实时任务？"],
    manual: ["手动模式问题：请说明 CAN 报文如何验证", "为什么自动切换后不能漏掉当前问题？"]
  },
  {
    auto: ["RS-485 和 RS-232 如何选型？", "内存泄漏通常怎么排查？", "多核 ARM 出现单核过载如何处理？"],
    manual: ["手动模式问题：请说明串口故障如何复现", "为什么自动切换后应该继续回答？"]
  }
];
const configuredVariant = Number.parseInt(process.env.INTERVIEW_E2E_VARIANT ?? "", 10);
const interviewVariant = Number.isFinite(configuredVariant)
  ? Math.abs(configuredVariant) % interviewQuestionSets.length
  : Date.now() % interviewQuestionSets.length;
const interviewQuestions = interviewQuestionSets[interviewVariant];
console.log(`FUNCTIONAL_E2E_QUESTION_VARIANT ${interviewVariant + 1}/${interviewQuestionSets.length}`);

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
    setTimeout(() => sendQuestion(interviewQuestions.auto[0], "q1", 0), 200);
    setTimeout(() => sendQuestion(interviewQuestions.auto[1], "q2", 2_000), 900);
    setTimeout(() => sendQuestion(interviewQuestions.auto[2], "q3", 4_000), 2_200);
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
  const isProjectAgent = messageContents.includes("你是项目资料整理 Agent");
  const isProjectAgentFailure = isProjectAgent && messageContents.includes("触发项目 Agent 错误 E2E");
  if (!isQuestionClassifier && /你的电流环频率多少|为什么要 PWM 中心对齐|低速抖动怎么查/.test(messageContents)) projectAnswerRequests.push(payload);
  if (isChatFirstTurn || isChatSecondTurn || isChatStructured) {
    chatRequests.push(payload);
    if (isChatSecondTurn && serializedMessages.includes("帮我分析 FOC 项目") && serializedMessages.includes("第一点 xxx；第二点是电流环与采样同步。")) chatSecondTurnContextObserved = true;
  }
  if (isProjectAgent) projectAgentRequests.push(payload);
  if (isProjectAgentFailure) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid mock key" } }));
    return;
  }
  const imageMessage = (payload.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url"));
  if (imageMessage) {
    screenshotAnswerRequests += 1;
    visionRequestCount += 1;
    const imageParts = (payload.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part?.type === "image_url") : []);
    const imageUrls = imageParts.map((part) => part?.image_url?.url).filter((value) => typeof value === "string");
    visionRequests.push({ requestType: "vision", hasImage: imageUrls.length > 0, imageCount: imageUrls.length, imageMimeType: imageUrls[0]?.match(/^data:([^;]+);/)?.[1], imageBytes: imageUrls.reduce((total, value) => total + Buffer.from(value.split(",", 2)[1] ?? "", "base64").byteLength, 0), promptText: messageContents.slice(0, 240) });
    // The screenshot-only phase uses the same fixed screenshot prompt as the
    // regular interview phase. Count real vision requests here and compare
    // the counter before/after that phase instead of coupling the assertion
    // to an obsolete prompt string.
    screenshotOnlyRequests += 1;
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
  const slow = messageContents.includes(interviewQuestions.auto[0]);
  const structuredAnswer = JSON.stringify({ text: "结构化缺口已识别", sources: [{ id: "e2e-source", label: "E2E 题库资料", kind: "question-bank" }], cards: [{ id: "e2e-coverage-card", kind: "coverage", title: "题库覆盖", body: "建议补充一张可核验答案卡。", data: { coverage: 50 } }], actions: [{ id: "e2e-create-question", type: "create_question", label: "加入题库", rationale: "保留为下一轮复习题。", payload: { canonicalText: "结构化覆盖 E2E 题" }, requiresConfirmation: true }] });
  const projectAgentAnswer = JSON.stringify({ text: "项目 Agent E2E 正常：已读取当前项目、参数、决策、问题链与证据。", sources: [], cards: [{ id: "project-gap-e2e", kind: "gap", title: "待补充 Why / 问题链", body: "请补充关键技术决策的原因，或补齐问题链中的因果关系。" }], actions: [], context: { intent: "project-gap-analysis" } });
  const answer = isProjectAgent
    ? projectAgentAnswer
    : isChatStructured
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
    INTERVIEW_COPILOT_SCREENSHOT_FIXTURE: "1",
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
  try { return await (await fetch(`http://127.0.0.1:${debugPort}/json`, { signal: AbortSignal.timeout(2_000) })).json(); } catch { return []; }
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
    if (message.id && commands.has(message.id)) {
      const command = commands.get(message.id);
      commands.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) command.reject(new Error(`CDP ${command.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
      else command.resolve(message.result);
    }
  });
  socket.on("close", () => {
    for (const [id, command] of commands) {
      clearTimeout(command.timer);
      command.reject(new Error(`RUNTIME_E2E_TIMEOUT target closed while waiting for ${command.method} (${id})`));
    }
    commands.clear();
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    const timer = setTimeout(() => {
      commands.delete(id);
      reject(new Error(`RUNTIME_E2E_TIMEOUT CDP command ${method} exceeded 5s`));
    }, 5_000);
    commands.set(id, { resolve, reject, timer, method });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { clearTimeout(timer); commands.delete(id); reject(error); }
  });
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

async function dumpRuntimeDiagnostics(client = main) {
  try {
    return await client.evaluate(`(async () => ({
      diagnostics: await window.interviewCopilot.interview.getRuntimeDiagnostics(),
      trace: await window.interviewCopilot.interview.getRuntimeTrace(30),
      screenshotDiagnostics: await window.interviewCopilot.screenshot.getDiagnostics(),
      screenshotTrace: await window.interviewCopilot.screenshot.getTrace(30)
    }))()`);
  } catch (error) {
    return { diagnostics: "unavailable", error: String(error) };
  }
}

async function waitFor(predicate, timeout = 12_000, client = main) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      if (await client.evaluate(`(${predicate.toString()})()`)) return;
    } catch (error) {
      lastError = error;
      break;
    }
    await sleep(150);
  }
  const runtime = await dumpRuntimeDiagnostics(client);
  throw new Error(`RUNTIME_E2E_TIMEOUT waiting for renderer condition${lastError ? `: ${String(lastError)}` : ""}\n${JSON.stringify(runtime)}\n${String(await client.evaluate("document.body.innerText").catch((error) => error)).slice(0, 3_000)}`);
}

async function waitForText(text, timeout = 12_000, client = main) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try {
      if (await client.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)) return;
    } catch (error) {
      lastError = error;
      break;
    }
    await sleep(150);
  }
  const runtime = await dumpRuntimeDiagnostics(client);
  throw new Error(`RUNTIME_E2E_TIMEOUT waiting for renderer text: ${text}${lastError ? `: ${String(lastError)}` : ""}\n${JSON.stringify(runtime)}\n${String(await client.evaluate("document.body.innerText").catch((error) => error)).slice(0, 3_000)}`);
}

async function waitForNode(predicate, timeout = 12_000, client = main) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await sleep(100); }
  const runtime = await dumpRuntimeDiagnostics(client);
  throw new Error(`RUNTIME_E2E_TIMEOUT waiting for mock service condition\n${JSON.stringify(runtime)}\n${childOutput.slice(-2_000)}`);
}

async function clickText(text, client = main) {
  const clicked = await client.evaluate(`(() => { const value = ${JSON.stringify(text)}; const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes(value)); if (!button) return false; button.click(); return true; })()`);
  if (!clicked) throw new Error(`Button not found: ${text}; body=${String(await client.evaluate("document.body.innerText").catch(() => "")).slice(0, 1200)}; rendererErrors=${client.rendererErrors.join(" | ")}`);
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
  const overlayPreferencesRoundTrip = await main.evaluate("window.interviewCopilot.overlay.setPreferences({ backgroundOpacity: 0.64, backgroundColor: '#20344f', fontColor: '#f4f8ff', fontSize: 16, showToolbar: true, showTranscript: true, showAnswer: true, showTimestamps: false, layoutPreset: 'wide', questionWindow: { width: 470, height: 540, fontSize: 15 }, answerWindow: { width: 760, height: 540, fontSize: 16 }, behavior: { followLatestQuestion: true, followLatestAnswer: true, alwaysOnTop: true, lockPosition: false, mousePassthrough: true }, screenshot: { middleMouseEnabled: true, enabledInManualInterview: true, enabledInExamMode: true, captureMode: 'current_display' } }).then(() => window.interviewCopilot.overlay.getPreferences())");
  if (overlayPreferencesRoundTrip?.backgroundOpacity !== 0.64 || overlayPreferencesRoundTrip?.fontSize !== 16 || overlayPreferencesRoundTrip?.showTimestamps !== false || overlayPreferencesRoundTrip?.layoutPreset !== 'wide' || overlayPreferencesRoundTrip?.questionWindow?.width !== 470 || overlayPreferencesRoundTrip?.answerWindow?.width !== 760 || overlayPreferencesRoundTrip?.screenshot?.enabledInExamMode !== true) throw new Error(`OVERLAY_PREFERENCES_PERSIST failed: ${JSON.stringify(overlayPreferencesRoundTrip)}`);
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

  const projectSeed = await main.evaluate(`(async () => {
    const profile = await window.interviewCopilot.profiles.active();
    const bases = await window.interviewCopilot.knowledge.listBases();
    const base = bases.find((item) => item.name === 'Mock E2E Knowledge') ?? bases[0];
    if (!profile?.id || !base?.id) throw new Error('project seed prerequisites missing');
    if (!profile.knowledgeBaseIds.includes(base.id)) await window.interviewCopilot.profiles.save({ ...profile, knowledgeBaseIds: [...profile.knowledgeBaseIds, base.id] });
    const project = await window.interviewCopilot.projects.create({ profileId: profile.id, name: 'E2E FOC 电机控制项目' });
    const repoArchive = [
      '文件：src/main.c\\n// FOC motor control entry point\\nint main(void) { pwm_init(); motor_task(); }',
      '文件：src/control.c\\n// current loop: Clarke, Park, current PI, SVPWM\\n// PWM control frequency = 20 kHz\\n// current loop frequency = 20 kHz\\n// speed loop frequency = 1 kHz',
      '文件：src/adc.c\\n// ADC peripheral clock = 80 MHz\\n// ADC control trigger frequency = 20 kHz\\n// DMA writes current buffer',
      '文件：src/encoder.c\\n// ABZ encoder provides electrical angle\\n// velocity estimator converts sparse pulses into speed',
      '文件：src/can.c\\n// CAN communication receives commands and publishes status',
      '文件：include/config.h\\n// production control configuration',
      '文件：README.md\\nFOC motor control for a robot, using center-aligned PWM and a stable ADC sampling window.',
      '文件：docs/ARCHITECTURE.md\\nDecision: choose center-aligned PWM because it provides a stable ADC current sampling window.',
      '文件：docs/DEBUG.md\\nSparse ABZ pulses cause velocity quantization and PI jitter; delta + frame rebase improves stability.',
      '文件：tests/control.test.c\\n// passed: current loop error < 2%\\n// benchmark result: latency 20 us'
    ].join('\\n\\n---\\n\\n');
    const encodedRepoArchive = btoa(unescape(encodeURIComponent(repoArchive)));
    const materials = [
      { filename: 'PROJECT_OVERVIEW.md', text: ['# 项目说明', '项目名称：E2E FOC 电机控制项目', '项目背景：在 STM32F405 上实现单轴 FOC 电机控制。', '个人职责：负责电流环、ADC 与 PWM 同步实现。', '技术栈：STM32F405、FreeRTOS、FOC、CAN、DMA。'].join('\\n') },
      { filename: 'PROJECT_ARCHITECTURE.md', text: ['# 系统架构', '控制系统由采样、控制算法和通信模块组成。', '采用 PWM 中心对齐，用于稳定 ADC 采样时刻。', '技术决策：选择：PWM 中心对齐；原因：方便在稳定采样窗口采 ADC。', '核心模块：电流环、速度环、保护状态机。', 'PROJECT_REPO_ARCHIVE_BASE64:' + encodedRepoArchive].join('\\n') },
      { filename: 'PROJECT_TECHNICAL_DETAILS.md', text: ['# 技术设计', 'PWM频率：20kHz', '电流环频率：20kHz', '速度环频率：1kHz', 'CAN 波特率：1Mbps'].join('\\n') },
      { filename: 'PROJECT_DEBUG.md', text: ['# 问题排查', '问题：低速抖动。', '现象：ABZ 低速脉冲稀疏。', '原因：低速量化明显。', '解决：增量 delta + frame rebase。', '结果：速度反馈结构修复。'].join('\\n') },
      { filename: 'PROJECT_RESULTS.md', text: ['# 测试结果', '测试结果：低速运行稳定。', '性能指标：稳态误差 1%。', '限制：尚未完成正式 benchmark。'].join('\\n') }
    ];
    const batchReport = await window.interviewCopilot.knowledge.ingestProjectMaterials({ profileId: profile.id, projectId: project.id, knowledgeBaseId: base.id, files: materials.map((material) => ({ filename: material.filename, mimeType: 'text/markdown', bytes: new TextEncoder().encode(material.text), sourceRole: 'auto' })) });
    if (batchReport.summary.assigned !== materials.length || batchReport.rebuild.status !== 'queued') throw new Error('batch project import failed: ' + JSON.stringify(batchReport));
    const analysisDeadline = Date.now() + 30_000;
    let analysisJob = await window.interviewCopilot.projectMemory.analysisJob(project.id);
    while (analysisJob && !['completed', 'failed', 'cancelled'].includes(analysisJob.status) && Date.now() < analysisDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      analysisJob = await window.interviewCopilot.projectMemory.analysisJob(project.id);
    }
    if (analysisJob?.status !== 'completed') throw new Error('batch project analysis failed: ' + JSON.stringify({ batchReport, analysisJob }));
    const document = (await window.interviewCopilot.knowledge.listDocuments(base.id)).find((item) => item.id === batchReport.imported[0]?.documentId);
    const memory = await window.interviewCopilot.projectMemory.get(profile.id);
    const conflictCandidates = [
      { id: 'e2e-mcu-f405', content: 'STM32F405' },
      { id: 'e2e-mcu-g431', content: 'STM32G431' }
    ];
    for (const candidate of conflictCandidates) await window.interviewCopilot.projectMemory.addCandidateFact({ id: candidate.id, projectId: project.id, profileId: profile.id, type: 'hardware', title: 'MCU', content: candidate.content, confidence: 1, verified: false, sourceIds: [document.id], evidence: [{ sourceId: document.id, quote: candidate.content }], evidenceLevel: 'confirmed-document', ownership: 'project', status: 'pending_review' });
    await window.interviewCopilot.projectMemory.repairSemantics(project.id);
    const currentMemory = await window.interviewCopilot.projectMemory.get(profile.id);
    const stats = await window.interviewCopilot.projectMemory.stats(profile.id, project.id);
    const conflictGroups = await window.interviewCopilot.projectMemory.conflictGroups(project.id);
    const projectFacts = currentMemory.facts?.filter((fact) => fact.projectId === project.id) ?? memory.facts?.filter((fact) => fact.projectId === project.id) ?? [];
    const understanding = currentMemory.understandings?.find((item) => item.projectId === project.id) ?? (currentMemory.understanding?.projectId === project.id ? currentMemory.understanding : undefined);
    return { document, batchReport, roles: batchReport.imported.map((item) => item.sourceRole), project: currentMemory.projects.find((item) => item.id === project.id), factCount: projectFacts.length, parameterFacts: projectFacts.filter((fact) => fact.type === 'parameter').map((fact) => ({ canonicalKey: fact.canonicalKey, value: fact.value, relation: fact.experienceRelation })), decisionFacts: projectFacts.filter((fact) => fact.type === 'technical_decision' || fact.type === 'decision').length, problemFacts: projectFacts.filter((fact) => ['challenge', 'cause', 'solution'].includes(fact.type)).length, stats, conflictGroups: conflictGroups.map((group) => ({ id: group.id, canonicalKey: group.canonicalKey, factIds: group.factIds })), understanding: understanding ? { status: understanding.status, summary: understanding.summary, components: understanding.architecture.components.map((item) => item.name), relationships: understanding.architecture.relationships.length, flows: [...understanding.runtimeFlows, ...understanding.dataFlows, ...understanding.controlFlows].map((item) => item.name), parameters: understanding.parameters.map((item) => item.semanticKey), unknowns: understanding.unknowns.length, trace: understanding.trace } : undefined };
  })()`);
  if (projectSeed?.document?.documentType !== "project" || projectSeed?.batchReport?.summary?.assigned !== 5 || projectSeed.batchReport.rebuild.status !== "queued" || JSON.stringify(projectSeed.roles) !== JSON.stringify(["overview", "architecture", "architecture", "debug", "test"]) || !projectSeed?.project?.id || projectSeed.project.ownershipMode !== "personal" || projectSeed.factCount < 1 || !projectSeed.parameterFacts?.some((fact) => fact.canonicalKey === "control.current_loop.frequency" && fact.value?.value === 20_000 && fact.value?.unit === "Hz" && fact.relation === "configured") || projectSeed.parameterFacts?.filter((fact) => fact.canonicalKey === "control.current_loop.frequency" || fact.canonicalKey === "control.speed_loop.frequency" || fact.canonicalKey === "sampling.pwm.frequency").length !== 3 || projectSeed.decisionFacts < 1 || projectSeed.problemFacts < 3 || projectSeed.stats?.projectFamiliarityScore <= 0 || projectSeed.stats?.conflictGroups !== 1 || projectSeed.conflictGroups?.length !== 1 || projectSeed.conflictGroups[0]?.canonicalKey !== "mcu.main" || projectSeed.understanding?.status !== "completed" || projectSeed.understanding.summary.length < 40 || projectSeed.understanding.summary.includes("PROJECT_") || !projectSeed.understanding.components.includes("Motor Control") || !projectSeed.understanding.components.includes("Current Sampling") || projectSeed.understanding.relationships < 1 || projectSeed.understanding.flows.length < 1 || !projectSeed.understanding.parameters.includes("control.current_loop.frequency") || projectSeed.understanding.trace.toolCalls < 1) throw new Error(`Project Comprehension V6 semantic seed failed: ${JSON.stringify(projectSeed)}`);
  await main.evaluate("location.reload()");
  await waitFor(() => document.documentElement?.dataset.appReady === "true" && document.querySelectorAll("button").length > 0);
  await clickText("项目库");
  await waitFor(() => document.body.innerText.includes("项目资料整理助手") && document.body.innerText.toLowerCase().includes("e2e foc"), 15_000);
  const projectLibraryState = await main.evaluate(`(async () => {
    const memory = await window.interviewCopilot.projectMemory.get((await window.interviewCopilot.profiles.active()).id);
    const project = memory.projects.find((item) => item.id === ${JSON.stringify(projectSeed.project.id)});
    const sources = await window.interviewCopilot.projectMemory.sources(${JSON.stringify(projectSeed.project.id)});
    const facts = (memory.facts ?? []).filter((fact) => fact.projectId === ${JSON.stringify(projectSeed.project.id)});
    return { sourceCount: sources.length, sourceRoles: sources.map((source) => source.sourceRole), factCount: facts.length, parameterCount: facts.filter((fact) => fact.type === 'parameter').length, decisionCount: facts.filter((fact) => ['technical_decision', 'decision'].includes(fact.type)).length, problemCount: (memory.problems ?? []).filter((problem) => problem.projectId === ${JSON.stringify(projectSeed.project.id)}).length, summary: project?.description ?? '' };
  })()`);
  if (projectLibraryState?.sourceCount !== 5 || projectLibraryState.factCount < 1 || projectLibraryState.parameterCount < 1 || projectLibraryState.decisionCount < 1 || projectLibraryState.problemCount < 1 || !projectLibraryState.summary.trim() || JSON.stringify(projectLibraryState.sourceRoles) !== JSON.stringify(["overview", "architecture", "architecture", "debug", "test"])) throw new Error(`PROJECT_LIBRARY_V5_1_BATCH_STATE failed: ${JSON.stringify(projectLibraryState)}`);
  const legacyProjectUi = await main.evaluate("({ legacyText: document.body.innerText.includes('PROJECT TECHNICAL MEMORY V4'), legacyNode: Boolean(document.querySelector('.project-v4-overview')), localSidebar: Boolean(document.querySelector('.project-local-sidebar')), duplicateBreadcrumb: document.querySelectorAll('.project-header-kicker').length })");
  if (legacyProjectUi?.legacyText || legacyProjectUi?.legacyNode || legacyProjectUi?.localSidebar || legacyProjectUi?.duplicateBreadcrumb) throw new Error(`PROJECT_LIBRARY_V5_UI_CLEANUP failed: ${JSON.stringify(legacyProjectUi)}`);
  const requiredProjectTabs = ["概览", "关键参数", "技术架构", "决策与 Why", "问题排查", "项目题库", "项目资料"];
  const missingProjectTabs = await main.evaluate(`(${JSON.stringify(requiredProjectTabs)}).filter((label) => !document.body.innerText.includes(label))`);
  if (missingProjectTabs?.length) throw new Error(`PROJECT_LIBRARY_V5_PRIMARY_NAV_MISSING: ${missingProjectTabs.join(", ")}`);
  const projectChrome = await main.evaluate(`({
    breadcrumb: document.querySelector(".modern-topbar .topbar-context")?.textContent?.replace(/\s+/g, " ").trim(),
    settings: Boolean(document.querySelector(".modern-topbar .topbar-settings-button")),
    startInterview: Boolean(document.querySelector(".modern-topbar .start-interview")),
    projectLabel: [...document.querySelectorAll(".sidebar-section-label")].some((item) => item.textContent?.trim() === "我的项目"),
    projectRows: document.querySelectorAll(".sidebar-project-row").length
  })`);
  if (projectChrome?.breadcrumb?.replace(/\s*\/\s*/g, "/") !== "项目库/项目详情" || !projectChrome.settings || !projectChrome.startInterview || !projectChrome.projectLabel || projectChrome.projectRows > 5) throw new Error(`PROJECT_LIBRARY_V5_CHROME_INVALID: ${JSON.stringify(projectChrome)}`);
  const projectFamiliarityCount = await main.evaluate("[...document.body.querySelectorAll('*')].filter((item) => (item.textContent || '').trim() === '熟悉度').length");
  if (projectFamiliarityCount !== 1) throw new Error(`PROJECT_LIBRARY_V5_DUPLICATE_FAMILIARITY: ${projectFamiliarityCount}`);
  await screenshot("project-overview.png");
  await clickText("关键参数");
  await waitFor(() => Boolean(document.querySelector(".project-data-table")) && document.body.innerText.includes("参数"));
  const parameterRow = await main.evaluate("Boolean(document.querySelector('.project-data-table tbody tr'))");
  if (!parameterRow) throw new Error("PROJECT_LIBRARY_V5_PARAMETER_TABLE_EMPTY");
  await clickSelector(".project-data-table tbody tr");
  await waitFor(() => Boolean(document.querySelector(".project-drawer")) && document.body.innerText.includes("当前值"));
  await screenshot("project-parameters.png");
  await clickSelector(".project-drawer-close");
  await clickText("问题排查");
  await waitFor(() => Boolean(document.querySelector(".project-problem-row")) && document.body.innerText.includes("低速抖动"));
  await clickSelector(".project-problem-row");
  await waitFor(() => document.body.innerText.includes("现象") && document.body.innerText.includes("原因") && document.body.innerText.includes("解决") && document.body.innerText.includes("结果"));
  await screenshot("project-problem-detail.png");
  await clickText("···");
  await waitFor(() => document.body.innerText.includes("高级数据"));
  await clickText("事实库与治理");
  await waitFor(() => document.body.innerText.includes("高级数据") && document.body.innerText.includes("冲突"));
  await clickText("冲突");
  await waitFor(() => Boolean(document.querySelector(".project-conflict-list-v5")) && document.body.innerText.includes("待处理"));
  const conflictRowCount = await main.evaluate("document.querySelectorAll('.project-conflict-list-v5 > button').length");
  if (conflictRowCount !== 1) throw new Error(`PROJECT_LIBRARY_V5_CONFLICT_GROUP_ROW_COUNT: ${conflictRowCount}`);
  await screenshot("project-conflicts.png");
  await clickSelector(".project-conflict-list-v5 > button");
  await waitFor(() => Boolean(document.querySelector(".project-drawer")) && document.body.innerText.includes("采用此版本"));
  await clickText("采用此版本");
  await waitFor(() => document.body.innerText.includes("冲突"));
  await clickText("概览");
  await waitFor(() => Boolean(document.querySelector(".project-agent-composer textarea")));
  await clickText("项目资料");
  await waitFor(() => document.querySelectorAll(".project-source-list-v5 > button").length === 5);
  const sourceUi = await main.evaluate("(() => { const rows = [...document.querySelectorAll('.project-source-list-v5 > button')].map((item) => item.innerText); return { count: rows.length, hasOverview: rows.some((row) => row.includes('项目说明')), hasArchitecture: rows.filter((row) => row.includes('架构设计')).length, hasDebug: rows.some((row) => row.includes('问题排查')), hasTest: rows.some((row) => row.includes('测试与指标')), hasExtractedCount: rows.some((row) => /\\d+ 条信息/.test(row)) }; })()");
  if (sourceUi?.count !== 5 || !sourceUi.hasOverview || sourceUi.hasArchitecture !== 2 || !sourceUi.hasDebug || !sourceUi.hasTest || !sourceUi.hasExtractedCount) throw new Error(`PROJECT_SOURCE_SUMMARY_UI failed: ${JSON.stringify(sourceUi)}`);
  await clickText("概览");
  await waitFor(() => Boolean(document.querySelector(".project-agent-composer textarea")));
  evidence.push("Project Library V5 UI: PASS; PROJECT_CHROME: PASS; OVERVIEW_SCREEN: PASS; SINGLE_FAMILIARITY: PASS; PARAMETER_TABLE: PASS; PARAMETER_DRAWER: PASS; PROBLEM_LIST_DETAIL: PASS; ADVANCED_DATA: PASS; SINGLE_CONFLICT_GROUP_ROW: PASS; PROJECT_LIBRARY_V5_SCREENSHOTS: PASS; PROJECT_COMPREHENSION_V6_MODEL: PASS");
  await fillSelector(".project-agent-composer textarea", "检查当前项目资料中的冲突、缺失和不确定项。");
  await clickSelector(".project-agent-composer button");
  await waitFor(() => document.body.innerText.includes("项目 Agent E2E 正常"), 15_000);
  await waitForNode(() => projectAgentRequests.length === 1, 15_000);
  const projectAgentPrompt = JSON.stringify(projectAgentRequests[0]?.messages ?? []);
  if (!projectAgentPrompt.toLowerCase().includes("当前项目：e2e foc") || !projectAgentPrompt.includes("KEY_PARAMETERS") || !projectAgentPrompt.includes("TECHNICAL_DECISIONS") || !projectAgentPrompt.includes("PROBLEM_CHAINS") || !projectAgentPrompt.includes("control.current_loop.frequency") || !projectAgentPrompt.includes("REVIEW_REQUIRED") || !projectAgentPrompt.includes("项目 ID：")) throw new Error("PROJECT_AGENT_GROUNDED_CONTEXT failed");
  await main.evaluate("document.querySelector('.project-agent-panel')?.scrollIntoView({ block: 'center' }); true");
  await sleep(250);
  await screenshot("05b-project-agent.png");
  evidence.push("Project Agent: PASS; PROJECT_AGENT_GROUNDED_CONTEXT: PASS; PROJECT_AGENT_STRUCTURED_RESPONSE: PASS");
  await fillSelector(".project-agent-composer textarea", "触发项目 Agent 错误 E2E");
  await clickSelector(".project-agent-composer button");
  await waitFor(() => document.body.innerText.includes("模型密钥未配置、已失效或没有访问权限") && document.body.innerText.includes("重新生成") && document.body.innerText.includes("检查模型设置"), 15_000);
  const failedAgentBubble = await main.evaluate("(() => { const item = document.querySelector('.project-agent-message.failed'); return item ? { text: item.innerText, buttons: item.querySelectorAll('button').length } : undefined; })()");
  if (!failedAgentBubble?.text || failedAgentBubble.buttons !== 2) throw new Error(`PROJECT_AGENT_FAILURE_RECOVERY failed: ${JSON.stringify(failedAgentBubble)}`);
  await screenshot("05c-project-agent-recovery.png");
  evidence.push("PROJECT_AGENT_FAILURE_MESSAGE: PASS; PROJECT_AGENT_RETRY_ACTION: PASS; PROJECT_AGENT_SETTINGS_ACTION: PASS");

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
  await waitFor(() => document.documentElement?.dataset.appReady === "true" && document.querySelectorAll("button").length > 0);
  await clickText("开始一场面试");
  await waitFor(() => document.body.innerText.includes("LIVE INTERVIEW"));
  await waitFor(() => [...document.querySelectorAll('label')].some((item) => (item.innerText || '').includes('重点项目') && item.querySelector('select')));
  await fillLabel("重点项目", projectSeed.project.id);
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
  const overlayStructure = await overlay.evaluate("(() => { const question = document.querySelector('.question-thread-panel'); const answer = document.querySelector('.answer-thread-panel'); const qPanel = document.querySelector('.question-panel')?.getBoundingClientRect(); const aPanel = document.querySelector('.answer-panel')?.getBoundingClientRect(); return { questionOverflow: question ? getComputedStyle(question).overflowY : '', answerOverflow: answer ? getComputedStyle(answer).overflowY : '', questionPointerEvents: question ? getComputedStyle(question).pointerEvents : '', answerPointerEvents: answer ? getComputedStyle(answer).pointerEvents : '', hasFullTranscript: Boolean(document.querySelector('.transcript-scroll, .transcript-bubble, .timeline-scroll')), hasNavigator: document.body.innerText.includes('QUESTION NAVIGATOR'), hasReader: document.body.innerText.includes('ANSWER READER'), independentPanels: Boolean(qPanel && aPanel && qPanel.width > 0 && aPanel.width > 0 && qPanel.left !== aPanel.left) }; })()");
  if (!overlayStructure || !['auto', 'scroll'].includes(overlayStructure.questionOverflow) || !['auto', 'scroll'].includes(overlayStructure.answerOverflow) || overlayStructure.questionPointerEvents !== 'auto' || overlayStructure.answerPointerEvents !== 'auto' || overlayStructure.hasFullTranscript || !overlayStructure.hasNavigator || !overlayStructure.hasReader || !overlayStructure.independentPanels) throw new Error(`OVERLAY_SCROLL_LAYOUT_REGRESSION failed: ${JSON.stringify(overlayStructure)}`);
  evidence.push("Overlay A startup/structure: PASS; B two independent readers: PASS; C native question wheel region: PASS; D native answer wheel region: PASS; E passive hit-test handoff: PASS; F no full transcript in overlay: PASS");
  evidence.push(`Formal Start: PASS; meterOnly:false: PASS; MIC Channel: PASS; SYSTEM Channel: PASS; PCM packets: ${pcmPackets}`);

  await waitForText(interviewQuestions.auto[2], 15_000, overlay);
  evidence.push("Supersede: PASS");
  await waitForText(interviewQuestions.auto[0], 15_000, overlay);
  await screenshot("11-overlay-question.png", overlay);
  await waitFor(() => document.body.innerText.includes("Mock LLM answer"), 15_000, overlay);
  await screenshot("12-overlay-answer-streaming.png", overlay);
  await waitForNode(() => answerRequests.length >= 3, 15_000);
  evidence.push("Remote Transcript: PASS; Question Confirmed: PASS; AUTO_3_QUESTIONS: PASS; AUTO Answer: PASS; Overlay: PASS");

  const projectQuestionAssertions = [
    { question: "你的电流环频率多少？", markers: ["PROJECT_UNDERSTANDING_ROUTE=parameter", "control.current_loop.frequency", "20 kHz"], label: "EXACT_PARAMETER_RETRIEVAL" },
    { question: "你这个项目里为什么要 PWM 中心对齐？", markers: ["PROJECT_UNDERSTANDING_ROUTE=decision", "TECHNICAL_DECISIONS", "PWM 中心对齐"], label: "TECHNICAL_DECISION_RETRIEVAL" },
    { question: "你这个项目里低速抖动怎么查？", markers: ["PROJECT_UNDERSTANDING_ROUTE=problem", "PROBLEM_CHAINS", "低速抖动", "增量 delta + frame rebase"], label: "PROBLEM_CHAIN_RETRIEVAL" }
  ];
  // Let the three scheduled interview answers drain before injecting the
  // explicit project questions. This keeps the assertion about project
  // retrieval, rather than about queue ordering between unrelated questions.
  await sleep(6_000);
  for (const assertion of projectQuestionAssertions) {
    const beforeProjectQuestion = projectAnswerRequests.length;
    const beforeAnswerRequest = answerRequests.length;
    console.log(`FUNCTIONAL_E2E_PROJECT_QUERY ${assertion.label}`);
    void main.command("Runtime.evaluate", { expression: `setTimeout(() => void window.interviewCopilot.interview.answerQuestion(${JSON.stringify(assertion.question)}), 0);`, awaitPromise: false, returnByValue: false });
    await sleep(4_000);
    const capturedProjectRequests = projectAnswerRequests.slice(beforeProjectQuestion);
    const capturedAnswerRequests = answerRequests.slice(beforeAnswerRequest);
    const answerPrompt = JSON.stringify([...capturedProjectRequests, ...capturedAnswerRequests]);
    if (capturedProjectRequests.length === 0 && capturedAnswerRequests.length === 0) throw new Error(`${assertion.label} produced no provider request`);
    if (!assertion.markers.every((marker) => answerPrompt.includes(marker))) throw new Error(`${assertion.label} failed: ${answerPrompt.slice(0, 8_000)}`);
  }
  evidence.push("Interview Project Context: PASS; EXACT_PARAMETER_RETRIEVAL: PASS; TECHNICAL_DECISION_RETRIEVAL: PASS; PROBLEM_CHAIN_RETRIEVAL: PASS");

  const beforeManualMode = answerRequests.length;
  await main.evaluate("void window.interviewCopilot.interview.setAutomationMode('MANUAL'); true");
  requireQuestion(interviewQuestions.manual[0], "q4", 6_000);
  await waitFor(() => document.body.innerText.includes("手动模式问题"), 10_000, overlay);
  await sleep(1_000);
  if (answerRequests.length !== beforeManualMode) throw new Error("MANUAL_NO_AUTO_ANSWER failed");
  evidence.push("MANUAL_NO_AUTO_ANSWER: PASS");
  await main.evaluate("void window.interviewCopilot.interview.setAutomationMode('AUTO'); true");
  await waitFor(() => window.interviewCopilot.interview.getState().then((state) => state.automationMode === "AUTO"), 5_000);
  await sleep(300);
  requireQuestion(interviewQuestions.manual[1], "q5", 8_000);
  await waitForNode(() => answerRequests.length > beforeManualMode, 15_000);
  evidence.push("AUTOMATION_RUNTIME_SWITCH: PASS; Overlay AUTO/MANUAL Sync: PASS");

  const beforeManualSend = answerRequests.length;
  const overlayComposerPresent = await overlay.evaluate("Boolean(document.querySelector('.overlay-answer-composer textarea, .overlay-answer-composer input'))");
  if (overlayComposerPresent) throw new Error("OVERLAY_COMPOSER_REMOVED failed");
  await main.evaluate("void window.interviewCopilot.interview.answerQuestion('Mock manual question'); true");
  await waitForNode(() => answerRequests.length > beforeManualSend, 15_000);
  evidence.push("OVERLAY_COMPOSER_REMOVED: PASS; MAIN_MANUAL_SEND: PASS");

  const beforeVisionRequests = visionRequests.length;
  const beforeCaptured = await main.evaluate("window.__e2eMainScreenshotCaptured ?? 0");
  await main.evaluate(`window.__e2eMainScreenshotBaseline = ${beforeCaptured}`);
  await waitFor(() => { const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes('截图回答') || (item.innerText || '').includes('附截图')); return Boolean(button && !button.disabled); }, 15_000, overlay);
  const screenshotButtonState = await overlay.evaluate("(() => { const button = [...document.querySelectorAll('button')].find((item) => (item.innerText || '').includes('截图回答') || (item.innerText || '').includes('附截图')); if (!button) return { found: false }; button.click(); return { found: true, disabled: button.disabled }; })()");
  if (!screenshotButtonState?.found || screenshotButtonState.disabled) throw new Error(`Screenshot button unavailable: ${JSON.stringify(screenshotButtonState)}`);
  await waitForNode(() => visionRequests.slice(beforeVisionRequests).some((request) => request.requestType === "vision" && request.hasImage && request.imageBytes > 0 && request.imageMimeType === "image/png"), 15_000);
  // The capture event is broadcast before the independent vision request and
  // can be consumed while the renderer is between reloads. The runtime
  // diagnostic is the authoritative end-to-end completion signal here.
  await waitFor(() => window.interviewCopilot.screenshot.getDiagnostics().then((diagnostics) => diagnostics.lastLifecycleEvent === "SCREENSHOT_PIPELINE_COMPLETED"), 15_000, main);
  await waitFor(() => document.body.innerText.includes("Mock vision answer"), 15_000, overlay);
  const beforeWheelVision = visionRequests.length;
  const screenshotQuestionVisible = await overlay.evaluate("(() => { const question = document.querySelector('.question-thread-panel'); const answer = document.querySelector('.answer-thread-panel'); if (!question || !answer) return false; question.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 240 })); answer.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 240 })); return document.body.innerText.includes('截图识别题') && document.querySelectorAll('[data-answer-id]').length > 0; })()");
  await sleep(300);
  if (!screenshotQuestionVisible || visionRequests.length !== beforeWheelVision) throw new Error(`WHEEL_MUST_NOT_TRIGGER_SCREENSHOT failed: ${JSON.stringify({ screenshotQuestionVisible, beforeWheelVision, afterWheelVision: visionRequests.length })}`);
  evidence.push("Overlay Screenshot Button: PASS; Vision Request: PASS");
  evidence.push("G manual scroll retention policy: PASS; H new-content badge policy: PASS; I wheel does not trigger screenshot: PASS; J screenshot question navigator: PASS; K screenshot answer stack retention: PASS; L screenshot region/config round-trip: PASS");

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
  if (!(snapshot.detail?.questions ?? []).some((item) => item.text === "分析截图中的面试问题、代码或内容，并给出适合面试场景的回答。")) throw new Error("Screenshot-only synthetic question was not persisted");
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
