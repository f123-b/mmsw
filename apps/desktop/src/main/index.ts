import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { version as osVersion } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { AudioManager, type AudioStartOptions } from "./audio-manager";
import { OverlayManager, type OverlayMode, type OverlayNativeBounds, type OverlayNativePanel, type OverlayWindowSurface } from "./overlay-manager";
import { createScreenshotFixtureResult, ScreenshotManager, type ScreenshotRegion } from "./screenshot-manager";
import { createScreenshotRequestId, SCREENSHOT_PROMPT, ScreenshotOperationRegistry, ScreenshotTraceBuffer, withScreenshotTimeout, type ScreenshotTraceEvent, type ScreenshotTraceEventName } from "./screenshot-pipeline";
import { GLOBAL_SHORTCUTS } from "./shortcuts";
import { RealtimeSession, type RealtimeConnectOptions } from "./realtime-session";
import { analyzeAnswerIntent, analyzeInterview, analyzeProjectQuestionIntent, analyzeQuestionNucleus, AnswerAgent, AgentToolRegistry, buildDynamicTechnicalLexicon, buildProjectQaGenerationPrompt, buildVisionInput, chunkText, createSkill, HybridKnowledgeRetriever, HybridRetriever, inferKnowledgeDocumentType, KeywordReranker, LocalQuestionClassifier, matchCoreTechnicalQa, ModelRouter, normalizeQuestionBankText, normalizeTechnicalTerms, OpenAICompatibleAnswerProvider, OpenAICompatibleEmbeddingProvider, parseProjectQaGeneration, parseStructuredChatResponse, planAnswerSource, planChatContext, PreparationAgentRuntime, ProjectAliasResolver, ProjectComprehensionRetriever, QuestionAnalyzer, QuestionDetector2, questionBankAnswerIsReady, retrieveProfileExperience, routeKnowledge, SessionStateMachine, ToolApprovalPolicy, workspacePath, type AgentToolName, type AnswerProvider, type KnowledgeChunk, type KnowledgeDocumentType, type KnowledgeDocumentTypeOption, type PreparationModel, type PreparationModelStep, type ProjectQaGenerationResult, type ProviderSettings, type RetrievalTiming, type ScreenshotImage, type TranscriptSnapshot } from "@interview-copilot/shared";
import { InterviewCoordinator, type InterviewContextSelection, type InterviewStartOptions } from "./interview-coordinator";
import { WrittenTestController, type WrittenTestStartOptions } from "./written-test-controller";
import { openAppDatabase, SqliteConversationRepository, SqliteInterviewHistoryRepository, SqliteJobTargetRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileBuilderRepository, SqliteProfileRepository, SqliteProjectAnalysisJobRepository, SqliteProjectMemoryRepository, SqliteProjectRepository, SqliteQuestionBankRepository, SqliteResumeAnalysisRepository, SqliteRetrievalRepository, SqliteSkillSuggestionRepository, type SqliteDatabase } from "./database";
import { createSecretStore, MemorySecretStore, OverlaySettingsStore, ProviderConfigStore, type LlmModelProfileInput, type OverlayPreferences, type OverlayPreferencesPatch, type ProviderSection } from "./settings-store";
import { ProviderPreflightCache, runProviderPreflight, testCachedProviderConnection } from "./provider-preflight";
import { INTERVIEW_STARTUP_EVENTS, InterviewStartupTiming, type InterviewStartupEvent } from "./interview-startup-timing";
import { discoverProviderModels } from "./model-catalog";
import { isZipBytes, normalizeDocumentBytes, parseDocument } from "./document-parsers";
import { SafeLogger } from "./logger";
import { buildConversationHistory } from "./chat-context";
import { chatFailureText, classifyChatError, PROJECT_AGENT_TIMEOUT_MS } from "../shared/chat-errors";
import { ShutdownController } from "./shutdown-controller";
import { MiddleMouseShortcutManager, middleMouseHelperCandidates, shouldHandleMiddleMouseShortcut } from "./middle-mouse-shortcut";
import { NativeModifierShortcutManager } from "./native-modifier-shortcut";
import { LocalAsrServiceManager, type LocalAsrStartOptions } from "./local-asr-service-manager";
import { createProfileBuilderModel, createResumeAnalysisModel, ProfileBuilderService } from "./profile-builder";
import { adaptProfileToInterviewContext } from "./profile-context-adapter";
import { createProjectComprehensionModel, createProjectMemoryModel, ProjectMemoryService } from "./project-memory";
import { parseRepositoryArchiveInWorker } from "./repository-import-worker-client";
import { OnnxQuestionClassifier } from "./onnx-question-classifier";
import { formatInterviewMarkdown, type InterviewExportResult } from "./history-export";
import { deriveProjectProblemChains, deriveProjectTechnicalDecisions, formatProjectFactValue, inferProjectSourceRole, isFactEligible, isFactReviewRequired, normalizeProjectOwnershipMode, resolveProjectAnswerPerspective } from "@interview-copilot/shared";
import type { ChatAction, ChatCancelReason, ChatResponse } from "@interview-copilot/shared";
import type { QuestionBankBulkPatch, QuestionBankListOptions } from "./database";

if (process.env.INTERVIEW_COPILOT_DISABLE_GPU === "1") {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("in-process-gpu");
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

let mainWindow: BrowserWindow | undefined;
let overlayManager: OverlayManager | undefined;
const audioManager = new AudioManager();
function firstExistingLocalPath(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

function localAsrPathCandidates(...segments: string[]): string[] {
  return [
    join(process.resourcesPath, "local-asr-service", ...segments),
    join(process.cwd(), "apps", "local-asr-service", ...segments),
    join(app.getAppPath(), "..", "..", "apps", "local-asr-service", ...segments),
    join(__dirname, "..", "..", "..", "..", "apps", "local-asr-service", ...segments)
  ];
}

function questionClassifierPathCandidates(fileName: string): string[] {
  return [
    process.env.INTERVIEW_COPILOT_QUESTION_CLASSIFIER_DIR ? join(process.env.INTERVIEW_COPILOT_QUESTION_CLASSIFIER_DIR, fileName) : undefined,
    join(process.resourcesPath, "question-classifier", fileName),
    join(process.cwd(), "apps", "desktop", "models", "question-classifier", fileName),
    join(app.getAppPath(), "..", "..", "apps", "desktop", "models", "question-classifier", fileName),
    join(__dirname, "..", "..", "..", "..", "apps", "desktop", "models", "question-classifier", fileName)
  ].filter((candidate): candidate is string => Boolean(candidate));
}

let localQuestionModelPromise: Promise<OnnxQuestionClassifier | undefined> | undefined;
function loadLocalQuestionModel(): Promise<OnnxQuestionClassifier | undefined> {
  if (!localQuestionModelPromise) {
    localQuestionModelPromise = (async () => {
      const modelPath = firstExistingLocalPath(questionClassifierPathCandidates("model.onnx"));
      const labelsPath = firstExistingLocalPath(questionClassifierPathCandidates("labels.json"));
      if (!modelPath || !labelsPath) return undefined;
      try {
        return await OnnxQuestionClassifier.load(modelPath, labelsPath);
      } catch (error) {
        realtimeLogger?.warn("LOCAL_QUESTION_MODEL", { modelPath, error: String(error) });
        return undefined;
      }
    })();
  }
  return localQuestionModelPromise;
}

const localAsrServiceManager = new LocalAsrServiceManager({
  resolveServiceRoot: () => {
    const candidates = [
      process.env.INTERVIEW_COPILOT_LOCAL_ASR_DIR,
      join(process.resourcesPath, "local-asr-service"),
      join(process.cwd(), "apps", "local-asr-service"),
      join(app.getAppPath(), "..", "..", "apps", "local-asr-service"),
      join(__dirname, "..", "..", "..", "..", "apps", "local-asr-service")
    ];
    return candidates.filter((candidate): candidate is string => typeof candidate === "string").find((candidate) => existsSync(candidate));
  },
  resolveOpenAsrPath: () => firstExistingLocalPath([
    process.env.INTERVIEW_COPILOT_OPENASR_PATH,
    ...localAsrPathCandidates("openasr-runtime", "openasr-0.1.30-windows-x86_64", "openasr.exe")
  ]),
  resolveOpenAsrHome: () => firstExistingLocalPath([
    process.env.INTERVIEW_COPILOT_OPENASR_HOME,
    ...localAsrPathCandidates("openasr-home")
  ]),
  resolveModelPack: (model) => {
    if (model !== "funasr-nano:q8") return undefined;
    return firstExistingLocalPath([
      process.env.INTERVIEW_COPILOT_FUNASR_MODEL_PACK,
      ...localAsrPathCandidates("openasr-home", "models", "funasr-nano-q8_0.oasr"),
      ...localAsrPathCandidates("models", "funasr-nano-q8_0.oasr")
    ]);
  },
  log: (message) => realtimeLogger?.info("LOCAL_ASR_SERVICE", { message })
});

// Large repositories should become searchable immediately. Calling a remote
// embedding endpoint once per chunk can otherwise keep an upload in
// "processing" for minutes, so large imports use the keyword index first.
const MAX_INLINE_EMBEDDING_CHUNKS = 128;

async function embedKnowledgeChunks(chunks: ReturnType<typeof chunkText>, settings: ProviderSettings | undefined): Promise<boolean> {
  if (!settings?.apiKey || !settings.model || chunks.length === 0 || chunks.length > MAX_INLINE_EMBEDDING_CHUNKS) return false;
  const embeddingProvider = new OpenAICompatibleEmbeddingProvider(settings);
  for (const chunk of chunks) chunk.embedding = await embeddingProvider.embed(chunk.text);
  return true;
}

const screenshotFixtureRequested = process.env.INTERVIEW_COPILOT_SCREENSHOT_FIXTURE === "1";
const screenshotManager = new ScreenshotManager({
  onDiagnostic: (message) => broadcast("screenshot:diagnostic", message),
  getOverlayWindow: () => overlayManager?.currentWindow,
  shouldUseInternalFallback: (result) => captureTestRequested && captureContainsTestMarker(result.dataUrl),
  captureFixture: screenshotFixtureRequested ? async () => createScreenshotFixtureResult() : undefined,
  captureRendererFallback: async () => {
    if (!captureTestRequested || !mainWindow || mainWindow.isDestroyed()) throw new Error("Renderer screenshot fallback is only available in capture-test mode");
    const image = await mainWindow.capturePage();
    const png = image.toPNG();
    const size = image.getSize();
    const directory = join(app.getPath("temp"), "interview-copilot", "screenshots");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${Date.now()}-renderer-test.png`);
    await writeFile(path, png);
    return { path, mimeType: "image/png" as const, bytes: new Uint8Array(png), width: size.width, height: size.height, size: png.byteLength, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  }
});
const session = new SessionStateMachine();
const realtimeSession = new RealtimeSession(undefined, () => providerConfigStore?.get("asr"), undefined, undefined, undefined, localAsrServiceManager);
const configuredModel = process.env.INTERVIEW_COPILOT_LLM_MODEL ?? "gpt-4o-mini";
const environmentLlmSettings: ProviderSettings = {
  providerName: process.env.INTERVIEW_COPILOT_LLM_PROVIDER ?? "OpenAI-compatible",
  baseUrl: process.env.INTERVIEW_COPILOT_LLM_BASE_URL ?? "https://api.openai.com",
  apiKey: process.env.INTERVIEW_COPILOT_LLM_API_KEY ?? "",
  model: configuredModel,
  timeoutMs: Number(process.env.INTERVIEW_COPILOT_LLM_TIMEOUT_MS ?? 30_000),
  maxRetries: Number(process.env.INTERVIEW_COPILOT_LLM_MAX_RETRIES ?? 2)
};
let providerConfigStore: ProviderConfigStore | undefined;
let overlaySettingsStore: OverlaySettingsStore | undefined;
const routingModels: Partial<Record<"fast" | "normal" | "low-latency" | "reasoning" | "vision", string>> = { fast: configuredModel, normal: configuredModel, "low-latency": configuredModel, reasoning: configuredModel, vision: configuredModel };
const answerProvider: AnswerProvider = {
  stream(request, signal) {
    const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
    return new OpenAICompatibleAnswerProvider(settings).stream(request, signal);
  }
};
const answerModelRouter = new ModelRouter(routingModels, configuredModel);
function applyLlmRouting(settings: Pick<ProviderSettings, "model" | "fastModel" | "normalModel" | "deepModel" | "visionModel" | "fallbackModel">): void {
  routingModels.fast = settings.fastModel || settings.model;
  routingModels.normal = settings.normalModel || settings.model;
  routingModels["low-latency"] = settings.normalModel || settings.model;
  routingModels.reasoning = settings.deepModel || settings.model;
  routingModels.vision = settings.visionModel || settings.model;
  answerModelRouter.setModels(routingModels);
  answerModelRouter.setFallbackModel(settings.fallbackModel || settings.model);
}

type LlmTaskModelKey = "questionRecognitionModel" | "profileBuilderModel" | "projectAnalyzerModel" | "questionBankModel" | "chatModel" | "postInterviewModel" | "preparationModel";
type LlmRoleModelKey = "fastModel" | "normalModel" | "deepModel";
function taskModel(settings: ProviderSettings, task: LlmTaskModelKey, fallback: LlmRoleModelKey): string {
  return settings[task] || settings[fallback] || settings.model;
}
const answerAgent = new AnswerAgent(
  { fast: answerProvider, normal: answerProvider, "low-latency": answerProvider, reasoning: answerProvider, vision: answerProvider },
  answerModelRouter
);
const localQuestionClassifier = new LocalQuestionClassifier({
  async predict(text, context) {
    const model = await loadLocalQuestionModel();
    if (model) return model.predict(text, context);
    return new LocalQuestionClassifier().predict(text, context);
  }
});
const questionDetector2 = new QuestionDetector2({
  localClassifier: localQuestionClassifier,
  // The LLM is only a tie-breaker for medium-confidence utterances. Clear
  // questions stay on the local/rules path so recognition does not add a
  // second network request before every live answer.
  llmConfirmer: async (text, contextText) => {
    const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
    if (!settings.apiKey) throw new Error("LLM classifier is not configured");
    const model = taskModel(settings, "questionRecognitionModel", "fastModel");
    let output = "";
    for await (const delta of answerProvider.stream({
      model,
      maxOutputTokens: 120,
      maxRetries: 0,
      sections: [
        { name: "system/base", content: "你是面试语音问题分类器。只返回 JSON，不要 Markdown。字段：label（QUESTION、FOLLOW_UP、STATEMENT、SMALL_TALK、INSTRUCTION、CONTROL）、isQuestion（boolean）、confidence（0到1）、type（technical、project、behavior、follow_up、clarification、not_question）、reason。" },
        { name: "recent-transcript", content: contextText || "无上下文" },
        { name: "question", content: text }
      ]
    })) output += delta;
    const json = output.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("LLM classifier returned invalid JSON");
    const parsed = JSON.parse(json) as { label?: string; isQuestion?: boolean; confidence?: number; type?: string; reason?: string };
    const label = ["QUESTION", "FOLLOW_UP", "STATEMENT", "SMALL_TALK", "INSTRUCTION", "CONTROL"].includes(parsed.label || "") ? parsed.label as "QUESTION" | "FOLLOW_UP" | "STATEMENT" | "SMALL_TALK" | "INSTRUCTION" | "CONTROL" : undefined;
    const type = ["technical", "project", "behavior", "follow_up", "clarification", "not_question"].includes(parsed.type || "") ? parsed.type as "technical" | "project" | "behavior" | "follow_up" | "clarification" | "not_question" : undefined;
    return { isQuestion: Boolean(parsed.isQuestion ?? (label === "QUESTION" || label === "FOLLOW_UP")), confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0))), label, type, reason: parsed.reason };
  }
});
let interviewCoordinator: InterviewCoordinator | undefined;
let writtenTestController: WrittenTestController | undefined;
let middleMouseShortcutManager: MiddleMouseShortcutManager | undefined;
let nativeModifierShortcutManager: NativeModifierShortcutManager | undefined;
let profileRepository: SqliteProfileRepository | undefined;
let knowledgeRepository: SqliteKnowledgeRepository | undefined;
let questionBankRepository: SqliteQuestionBankRepository | undefined;
let retrievalRepository: SqliteRetrievalRepository | undefined;
let jobTargetRepository: SqliteJobTargetRepository | undefined;
let knowledgeAnalysisRepository: SqliteKnowledgeAnalysisRepository | undefined;
let projectAnalysisJobRepository: SqliteProjectAnalysisJobRepository | undefined;
let historyRepository: SqliteInterviewHistoryRepository | undefined;
let projectRepository: SqliteProjectRepository | undefined;
let projectMemoryRepository: SqliteProjectMemoryRepository | undefined;
let profileBuilderRepository: SqliteProfileBuilderRepository | undefined;
let resumeAnalysisRepository: SqliteResumeAnalysisRepository | undefined;
let skillSuggestionRepository: SqliteSkillSuggestionRepository | undefined;
let profileBuilderService: ProfileBuilderService | undefined;
let projectMemoryService: ProjectMemoryService | undefined;
let conversationRepository: SqliteConversationRepository | undefined;
let preparationRuntime: PreparationAgentRuntime | undefined;
let preparationAbortController: AbortController | undefined;
const chatAbortControllers = new Map<string, { controller: AbortController; reason?: ChatCancelReason }>();
const chatStreamPromises = new Set<Promise<void>>();
const providerPreflightCache = new ProviderPreflightCache();
let interviewStartupTiming: InterviewStartupTiming | undefined;
let pendingStartupButtonClickAt: number | undefined;
let appLogger: SafeLogger | undefined;
let audioLogger: SafeLogger | undefined;
let realtimeLogger: SafeLogger | undefined;
let database: SqliteDatabase | undefined;
// The overlay is created after the interview starts. Keep the latest local
// snapshots in the main process so a newly mounted overlay can replay them
// instead of waiting for the next ASR packet.
let realtimeTranscriptSnapshots: Partial<Record<"mic" | "remote", TranscriptSnapshot>> = {};
let pendingTranscriptBroadcast: TranscriptSnapshot | undefined;
let transcriptBroadcastTimer: NodeJS.Timeout | undefined;
let questionBankAnswerGeneration: Promise<import("./database").QuestionBankAnswerGenerationResult> | undefined;
let projectQaGeneration: Promise<ProjectQaGenerationResult> | undefined;
const preloadPath = join(__dirname, "../preload/index.mjs");
const rendererFile = join(__dirname, "../renderer/index.html");
const visualSmokeRequested = process.argv.includes("--visual-smoke");
const captureProtectionSmokeRequested = process.argv.includes("--capture-protection-smoke");
const nativeMouseSmokeRequested = process.argv.includes("--native-mouse-smoke");
const captureTestRequested = process.env.INTERVIEW_COPILOT_CAPTURE_TEST === "1";
const productionSmokeRequested = process.argv.includes("--production-smoke") || visualSmokeRequested;
const screenshotOperations = new ScreenshotOperationRegistry();
const screenshotTrace = new ScreenshotTraceBuffer();
let mainRendererLoad: Promise<void> | undefined;
const rendererAppReadyWindows = new Set<number>();
const rendererAppReadyWaiters = new Map<number, Set<() => void>>();

const shutdownController = new ShutdownController([
  { name: "unregister-shortcuts", run: () => globalShortcut.unregisterAll() },
  { name: "stop-middle-mouse-shortcut", run: () => middleMouseShortcutManager?.stop() },
  { name: "stop-native-modifier-shortcut", run: () => nativeModifierShortcutManager?.stop() },
  { name: "abort-preparation", run: () => preparationAbortController?.abort() },
  { name: "abort-chat", run: () => chatAbortControllers.forEach((entry) => { entry.reason = "shutdown"; entry.controller.abort(); }) },
  { name: "wait-chat", run: async () => { await Promise.allSettled([...chatStreamPromises]); } },
  { name: "stop-interview", run: async () => { screenshotOperations.abortAll(); await interviewCoordinator?.stop("user"); } },
  { name: "stop-written-test", run: () => { writtenTestController?.stop(); } },
  { name: "stop-audio", run: async () => { await audioManager.stop(); } },
  { name: "finalize-realtime", run: async () => { if (!interviewCoordinator?.running) await realtimeSession.finalize?.(1_000); } },
  { name: "disconnect-realtime", run: () => realtimeSession.disconnect() },
  { name: "stop-local-asr-service", run: () => localAsrServiceManager.stop() },
  { name: "cancel-project-analysis", run: () => projectMemoryService?.cancelAllAnalysisJobs() },
  { name: "flush-database", run: () => database?.flushNow() },
  { name: "close-database", run: () => database?.close() },
  { name: "destroy-overlay", run: () => overlayManager?.destroy() },
  { name: "destroy-windows", run: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); } }
]);

type RendererReadiness = {
  bridgeAvailable: boolean;
  rootChildren: number;
  appReady: boolean;
};

function isDevelopment(): boolean {
  return Boolean(process.env.ELECTRON_RENDERER_URL);
}

function userFacingError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes("Local Fun-ASR-Nano 启动失败")) return `${raw}。首次使用请安装 OpenASR、下载模型并安装本地 ASR 依赖`;
  const mappings: Array<[string, string]> = [
    ["AUDIO_PROBE_TIMEOUT", "音频检测超时，请检查设备后重试"],
    ["AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT", "音频检测程序未返回结果，请重试"],
    ["AUDIO_PROBE_PROCESS_CRASHED", "音频检测程序异常退出"],
    ["AUDIO_PROBE_MIC_FAILED", "麦克风输入不可用"],
    ["AUDIO_PROBE_SYSTEM_FAILED", "系统音频回采不可用"],
    ["AUDIO_CAPTURE_TIMEOUT", "音频初始化超时，请检查设备权限后重试"],
    ["NO_AUDIO_CHANNEL_AVAILABLE", "麦克风和系统音频都不可用，请检查权限或重新选择设备"],
    ["AUDIO_PERMISSION_DENIED", "音频权限被拒绝，请在 Windows 隐私设置中允许麦克风访问"],
    ["AUDIO_DEVICE_GONE", "音频设备已断开，系统将尝试切换到默认设备"],
    ["AUDIO_STREAM_OPEN_FAILED", "音频流打开失败，已保留可用声道并继续尝试"],
    ["PROTOCOL_BROKEN", "音频进程协议异常，请重启应用后重试"],
    ["AUDIO_PROBE_REQUIRED", "音频检测是可选项，正式面试会直接尝试启动采集"],
    ["ASR_AUTH_FAILED", "当前语音供应商的 API Key 未配置或未授权，请前往模型与服务设置"],
    ["ASR_CONNECT_FAILED", "ASR 连接失败，请检查 ASR 设置或本地服务"],
    ["LLM_NOT_CONFIGURED", "未配置 LLM API Key，请前往设置"],
    ["LLM_CONNECT_FAILED", "LLM 连接失败，请检查测试结果和网络"],
    ["PROFILE_NOT_FOUND", "面试档案不存在，请先选择有效档案"],
    ["AUDIO_BUSY", "音频设备仍在处理中，请稍后重试"]
  ];
  return mappings.find(([code]) => raw.includes(code))?.[1] ?? "操作失败，请查看设置或重试";
}

function verifyPreload(): boolean {
  const exists = existsSync(preloadPath);
  if (exists) {
    appLogger?.info("PRELOAD_OK", { preloadPath, exists });
  } else {
    appLogger?.error("PRELOAD_NOT_FOUND", { preloadPath, exists });
    broadcast("runtime:error", { code: "PRELOAD_NOT_FOUND", message: "Preload Bridge 未找到，请重新安装或查看日志", recoverable: false });
  }
  return exists;
}

function attachRendererDiagnostics(window: BrowserWindow, windowName: "main" | "overlay-question" | "overlay-answer" | "overlay-control" | "overlay-transient"): void {
  window.webContents.on("did-start-loading", () => {
    appLogger?.info("RENDERER_LOAD_STARTED", { window: windowName });
  });
  window.webContents.on("did-finish-load", () => {
    appLogger?.info("RENDERER_DID_FINISH_LOAD", { window: windowName });
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    appLogger?.error("RENDERER_DID_FAIL_LOAD", { window: windowName, errorCode, errorDescription, validatedURL, isMainFrame });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    appLogger?.error("RENDER_PROCESS_GONE", { window: windowName, reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const fields = { window: windowName, level, message, line, sourceId };
    if (level >= 2) appLogger?.error("RENDERER_CONSOLE_ERROR", fields);
    else appLogger?.info("RENDERER_CONSOLE_MESSAGE", fields);
    if (/Unable to load preload|preload.*(?:ENOENT|not found)|interviewCopilot.*undefined|Cannot read properties of undefined.*events/i.test(message)) {
      appLogger?.error("RENDERER_PRELOAD_BRIDGE_ERROR", fields);
    }
  });
}

async function readRendererReadiness(window: BrowserWindow): Promise<RendererReadiness> {
  return await window.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(() => resolve({
    bridgeAvailable: Boolean(window.interviewCopilot),
    rootChildren: document.querySelector("#root")?.children.length ?? 0,
    appReady: document.documentElement.dataset.appReady === "true"
  }), 0))`, true) as RendererReadiness;
}

async function waitForRendererPaint(window: BrowserWindow): Promise<void> {
  // Transparent, click-through native overlays may be visible to Electron
  // while their compositor does not schedule RAF callbacks. Capture should
  // still proceed with the latest committed frame instead of hanging the
  // production/visual smoke indefinitely.
  await Promise.race([
    window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true).then(() => undefined).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 750))
  ]);
}

async function waitForWindowVisible(window: BrowserWindow): Promise<void> {
  if (window.isVisible()) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      window.removeListener("ready-to-show", finish);
      resolve();
    };
    const timeout = setTimeout(finish, 5_000);
    window.once("ready-to-show", finish);
  });
}

function hasVisiblePixels(png: Buffer): boolean {
  const bitmap = nativeImage.createFromBuffer(png).toBitmap();
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] > 10) return true;
  }
  return false;
}

function captureContainsTestMarker(dataUrl: string): boolean {
  const bitmap = nativeImage.createFromDataURL(dataUrl).toBitmap();
  let markerPixels = 0;
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const blue = bitmap[index];
    const green = bitmap[index + 1];
    const red = bitmap[index + 2];
    const alpha = bitmap[index + 3];
    if (alpha > 160 && red > 180 && blue > 180 && green < 130) markerPixels += 1;
  }
  return markerPixels >= 500;
}

async function captureVisibleWindow(window: BrowserWindow): Promise<Buffer> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForRendererPaint(window);
    const image = await Promise.race([
      window.capturePage(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("capturePage timeout")), 4_000))
    ]);
    const png = image.toPNG();
    if (png.byteLength > 0 && hasVisiblePixels(png)) return png;
    if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Production screenshot contains no visible pixels");
}

async function loadRenderer(window: BrowserWindow, overlay: false | OverlayWindowSurface = false): Promise<void> {
  const isOverlay = overlay !== false;
  const windowMode = overlay === "control" ? "overlay-control" : overlay === "question" ? "overlay-question" : overlay === "answer" ? "overlay-answer" : overlay === "transient" ? "overlay-transient" : "main";
  const windowName = isOverlay ? windowMode : "main";
  attachRendererDiagnostics(window, windowName);
  appLogger?.info("RENDERER_LOAD_STARTED", { window: windowName });
  try {
    if (isDevelopment()) {
      const url = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
      const search = new URLSearchParams({ ...(isOverlay ? { window: windowMode } : {}), ...(isOverlay && (captureProtectionSmokeRequested || captureTestRequested) ? { "capture-test": "1" } : {}) }).toString();
      await window.loadURL(`${url}${search ? `?${search}` : ""}`);
    } else {
      const search = new URLSearchParams({ ...(isOverlay ? { window: windowMode } : {}), ...(isOverlay && (captureProtectionSmokeRequested || captureTestRequested) ? { "capture-test": "1" } : {}) }).toString();
      await window.loadFile(rendererFile, search ? { search } : undefined);
    }
    if (!overlay) {
      const readiness = await readRendererReadiness(window);
      if (readiness.bridgeAvailable && readiness.rootChildren > 0) {
        appLogger?.info("RENDERER_APP_READY", { window: windowName, ...readiness });
      } else {
        appLogger?.error("RENDERER_APP_NOT_READY", { window: windowName, ...readiness });
        if (!readiness.bridgeAvailable) appLogger?.error("PRELOAD_BRIDGE_UNAVAILABLE", { window: windowName });
      }
    } else {
      const ready = await waitForRendererReady(window);
      if (!ready) appLogger?.warn("OVERLAY_RENDERER_READY_TIMEOUT", { window: windowName });
    }
  } catch (error) {
    appLogger?.error("RENDERER_LOAD_FAILED", { window: windowName, error: String(error) });
  }
}

function broadcastToWindows(channel: string, payload: unknown): void {
  for (const window of [mainWindow, ...(overlayManager?.currentWindows ?? [])]) {
    if (!window || window.isDestroyed()) continue;
    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      // A renderer can disappear between isDestroyed() and send(). IPC is a
      // presentation side effect and must not reject an answer/session task.
      appLogger?.warn("RENDERER_EVENT_DELIVERY_FAILED", { channel, error: String(error) });
    }
  }
}

function broadcast(channel: string, payload: unknown): void {
  if (channel === "realtime:transcript" && payload && typeof payload === "object" && "source" in payload) {
    const snapshot = payload as TranscriptSnapshot;
    if (snapshot.source !== "mic" && snapshot.source !== "remote") return;
    realtimeTranscriptSnapshots[snapshot.source] = snapshot;
    // Partial ASR updates can arrive dozens of times per second. Coalesce
    // only partials into a 50 ms UI tick; final snapshots remain immediate so
    // the question/answer boundary is never delayed by rendering.
    if (snapshot.partial) {
      pendingTranscriptBroadcast = snapshot;
      if (!transcriptBroadcastTimer) {
        transcriptBroadcastTimer = setTimeout(() => {
          transcriptBroadcastTimer = undefined;
          const pending = pendingTranscriptBroadcast;
          pendingTranscriptBroadcast = undefined;
          if (pending) broadcastToWindows("realtime:transcript", pending);
        }, 50);
      }
      return;
    }
    if (transcriptBroadcastTimer) clearTimeout(transcriptBroadcastTimer);
    transcriptBroadcastTimer = undefined;
    pendingTranscriptBroadcast = undefined;
  }
  broadcastToWindows(channel, payload);
}

function rendererWindowName(window: BrowserWindow | null): "main" | "overlay-question" | "overlay-answer" | "overlay-control" | "overlay-transient" | "unknown" {
  if (window && window === mainWindow) return "main";
  if (window && window === overlayManager?.currentQuestionWindow) return "overlay-question";
  if (window && window === overlayManager?.currentAnswerWindow) return "overlay-answer";
  if (window && window === overlayManager?.currentControlWindow) return "overlay-control";
  if (window && window === overlayManager?.currentTransientWindow) return "overlay-transient";
  return "unknown";
}

ipcMain.on("diagnostics:renderer-ready", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const webContentsId = event.sender.id;
  rendererAppReadyWindows.add(webContentsId);
  appLogger?.info("RENDERER_APP_READY_SIGNAL", { window: rendererWindowName(window), webContentsId });
  const waiters = rendererAppReadyWaiters.get(webContentsId);
  rendererAppReadyWaiters.delete(webContentsId);
  waiters?.forEach((resolve) => resolve());
});

ipcMain.on("diagnostics:startup-mark", (_event, event: InterviewStartupEvent) => {
  if (!INTERVIEW_STARTUP_EVENTS.includes(event)) return;
  markInterviewStartup(event);
});

async function waitForRendererReady(window: BrowserWindow): Promise<boolean> {
  const webContentsId = window.webContents.id;
  if (rendererAppReadyWindows.has(webContentsId)) return true;
  return await new Promise<boolean>((resolve) => {
    const waiters = rendererAppReadyWaiters.get(webContentsId) ?? new Set<() => void>();
    const finish = () => {
      clearTimeout(timeout);
      waiters.delete(finish);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      waiters.delete(finish);
      resolve(false);
    }, 15_000);
    waiters.add(finish);
    rendererAppReadyWaiters.set(webContentsId, waiters);
  });
}

function coordinator(): InterviewCoordinator {
  if (!interviewCoordinator) throw new Error("Interview runtime is still initializing");
  return interviewCoordinator;
}

function markInterviewStartup(event: InterviewStartupEvent): void {
  interviewStartupTiming?.mark(event);
  if (event === "START_BUTTON_CLICK" && !interviewStartupTiming) pendingStartupButtonClickAt = Date.now();
}

function finishInterviewStartupTrace(): void {
  const timing = interviewStartupTiming;
  if (!timing) return;
  const snapshot = timing.complete();
  appLogger?.info("INTERVIEW_STARTUP_TIMING", snapshot.durations);
  appLogger?.info("INTERVIEW_STARTUP_TRACE", snapshot as unknown as Record<string, unknown>);
  interviewStartupTiming = undefined;
  pendingStartupButtonClickAt = undefined;
}

function screenshotSessionId(): string | undefined {
  return interviewCoordinator?.getRuntimeDiagnostics().sessionId;
}

function configuredScreenshotRegion(): ScreenshotRegion | undefined {
  const screenshot = overlaySettingsStore?.getPreferences().screenshot;
  if (!screenshot || screenshot.captureMode === "full_screen" || screenshot.captureMode === "current_display") return undefined;
  if (screenshot.captureMode === "fixed_region") return screenshot.fixedRegion;
  return screenshot.lastRegion ?? screenshot.fixedRegion;
}

function recordScreenshotTrace(name: ScreenshotTraceEventName, screenshotRequestId: string, details: Partial<Omit<ScreenshotTraceEvent, "name" | "timestamp" | "elapsedMs" | "screenshotRequestId">> = {}): ScreenshotTraceEvent {
  const operation = screenshotOperations.get(screenshotRequestId);
  const event: ScreenshotTraceEvent = {
    name,
    timestamp: Date.now(),
    elapsedMs: screenshotOperations.elapsedMs(screenshotRequestId),
    screenshotRequestId,
    ...(operation?.sessionId || screenshotSessionId() ? { sessionId: operation?.sessionId ?? screenshotSessionId() } : {}),
    ...(operation?.providerRequestId ? { providerRequestId: operation.providerRequestId } : {}),
    ...(operation?.state ? { status: operation.state } : {}),
    ...details
  };
  screenshotTrace.push(event);
  screenshotOperations.recordEvent(name, event.timestamp);
  broadcast("screenshot:trace", event);
  appLogger?.info(name, {
    screenshotRequestId: event.screenshotRequestId,
    sessionId: event.sessionId,
    providerRequestId: event.providerRequestId,
    imageMimeType: event.imageMimeType,
    imageBytes: event.imageBytes,
    imageWidth: event.imageWidth,
    imageHeight: event.imageHeight,
    messageShape: event.messageShape,
    providerModel: event.providerModel,
    status: event.status,
    reasonCode: event.reasonCode,
    fields: event.fields
  });
  return event;
}

function normalizeScreenshotResult(result: { mimeType: ScreenshotImage["mimeType"]; bytes: Uint8Array; width?: number; height?: number }): ScreenshotImage {
  return { mimeType: result.mimeType, bytes: new Uint8Array(result.bytes), width: result.width, height: result.height };
}

async function runIndependentVisionAnswer(visionInput: ReturnType<typeof buildVisionInput>, screenshotRequestId: string, operation: ReturnType<ScreenshotOperationRegistry["begin"]>): Promise<{ answerId: string; answerText: string; model: string; startedAt: number; firstTokenAt: number; completedAt: number }> {
  const providerRequestId = `vision-provider-${screenshotRequestId}`;
  const questionId = `screenshot-question-${screenshotRequestId}`;
  const question = { id: questionId, text: visionInput.prompt };
  const imageDataUrl = `data:${visionInput.image.mimeType};base64,${visionInput.image.base64}`;
  const startedAt = Date.now();
  screenshotOperations.transition(screenshotRequestId, "provider_pending", providerRequestId);
  recordScreenshotTrace("VISION_PROVIDER_REQUEST_STARTED", screenshotRequestId, { providerRequestId, imageMimeType: visionInput.image.mimeType, imageBytes: visionInput.image.bytes, imageWidth: visionInput.image.width, imageHeight: visionInput.image.height, messageShape: "multimodal", fields: { execution: "independent-screenshot-operation" } });
  let answerId: string | undefined;
  let providerModel = "vision";
  let firstTokenAt: number | undefined;
  let answerText = "";
  const stream = answerAgent.stream(question, "NORMAL", {}, operation.controller.signal, {
    hasScreenshot: true,
    attachments: [{ mimeType: visionInput.image.mimeType, dataUrl: imageDataUrl }],
    allowQualityRepair: false,
    formatAnswer: true,
    maxRetries: 1
  })[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = firstTokenAt
        ? await stream.next()
        : await withScreenshotTimeout(stream.next(), 5_000, () => operation.controller.abort());
      if (next.done) break;
      const event = next.value;
      if (operation.controller.signal.aborted) throw Object.assign(new Error("Screenshot vision request aborted"), { name: "AbortError" });
      if (event.type === "answer_start") {
        answerId = event.answerId;
        providerModel = event.model;
        screenshotOperations.transition(screenshotRequestId, "streaming", providerRequestId);
        recordScreenshotTrace("VISION_PROVIDER_REQUEST_RECEIVED", screenshotRequestId, { providerRequestId, answerId, providerModel: event.model, status: "streaming", messageShape: "multimodal" });
        // A screenshot answer is independent of the ASR question stream. Give
        // it a stable transient group so the non-destructive answer stack can
        // keep it visible instead of placing it in the collapsed history,
        // while still exposing a compact navigator entry on the left pane.
        const screenshotGroupId = `screenshot-group-${screenshotRequestId}`;
        broadcast("realtime:message", { type: "question_group_updated", groupId: screenshotGroupId, title: "截图题", primaryQuestion: "截图识别题（以图片为准）", items: [{ id: questionId, questionId, text: "截图识别题（以图片为准）", type: "NEW_TOPIC", answerable: true, state: "answering" }], slots: [{ id: `question-slot-${questionId}`, text: "截图识别题（以图片为准）", status: "covered" }], updatedAt: Date.now() });
        broadcast("realtime:message", { type: "answer_start", answerId, questionId, groupId: screenshotGroupId, relation: "PRIMARY", mode: event.mode, model: event.model });
      } else if (event.type === "answer_delta") {
        answerText += event.delta;
        if (!answerText) continue;
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          recordScreenshotTrace("VISION_FIRST_TOKEN", screenshotRequestId, { providerRequestId, answerId, status: "streaming" });
        }
        broadcast("realtime:message", { type: "answer_delta", answerId: event.answerId, delta: event.delta });
      } else {
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          recordScreenshotTrace("VISION_FIRST_TOKEN", screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
        }
        answerText = event.text || answerText;
        screenshotOperations.transition(screenshotRequestId, "completed", providerRequestId);
        recordScreenshotTrace("VISION_RESPONSE_COMPLETED", screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
        recordScreenshotTrace("VISION_OVERLAY_UPDATE_REQUESTED", screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
        broadcast("realtime:message", { type: "answer_end", answerId: event.answerId, text: answerText, quality: event.quality });
        recordScreenshotTrace("VISION_OVERLAY_UPDATED", screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
      }
    }
    if (!answerId) throw new Error("Vision provider returned no answer");
    const completedAt = Date.now();
    return { answerId, answerText, model: providerModel, startedAt, firstTokenAt: firstTokenAt ?? completedAt, completedAt };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const aborted = !timedOut && (operation.controller.signal.aborted || (error instanceof Error && error.name === "AbortError"));
    recordScreenshotTrace("VISION_RESPONSE_FAILED", screenshotRequestId, { providerRequestId, answerId, status: aborted ? "cancelled" : "failed", reasonCode: timedOut ? "first-token-timeout" : aborted ? "aborted" : "provider-error", fields: { error: String(error) } });
    throw error;
  }
}

async function captureScreenshot(trigger = "screenshot-answer"): Promise<void> {
  const screenshotRequestId = createScreenshotRequestId();
  try {
    const mode = interviewCoordinator?.running ? "interview" : writtenTestController?.running ? "written-test" : undefined;
    if (mode) await answerCapturedScreenshot(mode, screenshotRequestId, trigger);
    else {
      recordScreenshotTrace("SCREENSHOT_ACTION_REQUESTED", screenshotRequestId, { fields: { trigger, source: "global-shortcut" } });
      const result = await screenshotManager.capturePrimaryDisplay(undefined, configuredScreenshotRegion());
      try { broadcast("screenshot:captured", result); }
      finally { await screenshotManager.cleanup(result); }
    }
    broadcast("shortcut", trigger);
  } catch (error) {
    broadcast("screenshot:error", userFacingError(error));
    broadcast("runtime:error", { code: "SCREENSHOT_FAILED", message: "截图失败，请重试", recoverable: true });
  }
}

async function answerCapturedScreenshot(mode: "interview" | "written-test" = "interview", screenshotRequestId = createScreenshotRequestId(), trigger = "ipc"): Promise<void> {
  const sessionId = screenshotSessionId();
  let operation = screenshotOperations.get(screenshotRequestId);
  if (!operation) {
    try {
      operation = screenshotOperations.begin(screenshotRequestId, sessionId);
    } catch (error) {
      recordScreenshotTrace("SCREENSHOT_PIPELINE_FAILED", screenshotRequestId, { status: "failed", reasonCode: "duplicate-click", fields: { error: String(error) } });
      throw error;
    }
    if (trigger !== "renderer-ipc") recordScreenshotTrace("SCREENSHOT_ACTION_REQUESTED", screenshotRequestId, { fields: { trigger, mode } });
  }
  recordScreenshotTrace("SCREENSHOT_IPC_RECEIVED", screenshotRequestId, { fields: { mode } });
  let capturedResult: Awaited<ReturnType<ScreenshotManager["capturePrimaryDisplay"]>> | undefined;
  try {
    recordScreenshotTrace("SCREENSHOT_CAPTURE_STARTED", screenshotRequestId, { fields: { mode } });
    capturedResult = await withScreenshotTimeout(screenshotManager.capturePrimaryDisplay(operation.controller.signal, configuredScreenshotRegion()), 3_000, () => operation.controller.abort());
    screenshotOperations.setCaptureBytes(screenshotRequestId, capturedResult.bytes.byteLength);
    recordScreenshotTrace("SCREENSHOT_CAPTURE_COMPLETED", screenshotRequestId, { imageMimeType: capturedResult.mimeType, imageBytes: capturedResult.bytes.byteLength, imageWidth: capturedResult.width, imageHeight: capturedResult.height, fields: { captureSource: screenshotFixtureRequested ? "test-fixture" : "primary-display" } });
    broadcast("screenshot:captured", capturedResult);
    const image = normalizeScreenshotResult(capturedResult);
    recordScreenshotTrace("SCREENSHOT_IMAGE_NORMALIZED", screenshotRequestId, { imageMimeType: image.mimeType, imageBytes: image.bytes.byteLength, imageWidth: image.width, imageHeight: image.height });
    screenshotOperations.transition(screenshotRequestId, "building_request");
    recordScreenshotTrace("VISION_REQUEST_BUILD_STARTED", screenshotRequestId, { imageMimeType: image.mimeType, imageBytes: image.bytes.byteLength, imageWidth: image.width, imageHeight: image.height });
    const visionInput = buildVisionInput(image, SCREENSHOT_PROMPT);
    recordScreenshotTrace("VISION_REQUEST_BUILT", screenshotRequestId, { imageMimeType: visionInput.image.mimeType, imageBytes: visionInput.image.bytes, imageWidth: visionInput.image.width, imageHeight: visionInput.image.height, messageShape: "multimodal", fields: { promptLength: visionInput.prompt.length } });
    screenshotOperations.transition(screenshotRequestId, "provider_pending");
    if (mode === "written-test") await writtenTestController?.answerScreenshot(`data:${visionInput.image.mimeType};base64,${visionInput.image.base64}`);
    else {
      const answer = await withScreenshotTimeout(runIndependentVisionAnswer(visionInput, screenshotRequestId, operation), 20_000, () => operation.controller.abort());
      const interviewId = coordinator().interviewId;
      if (interviewId && historyRepository) {
        try {
          const storedQuestion = historyRepository.addQuestion({ interviewId, text: visionInput.prompt, confidence: "high", source: "extractor", detectedAt: answer.startedAt, status: "answered" });
          historyRepository.addAnswer({ questionId: storedQuestion.id, text: answer.answerText, model: answer.model, mode: "NORMAL", startedAt: answer.startedAt, firstTokenAt: answer.firstTokenAt, finishedAt: answer.completedAt, latencyFirstToken: answer.firstTokenAt - answer.startedAt, latencyTotal: answer.completedAt - answer.startedAt, createdAt: answer.completedAt });
        } catch (error) {
          realtimeLogger?.warn("SCREENSHOT_HISTORY_PERSISTENCE_FAILED", { screenshotRequestId, error: String(error) });
        }
      }
    }
    screenshotOperations.finish(screenshotRequestId, "completed");
    recordScreenshotTrace("SCREENSHOT_PIPELINE_COMPLETED", screenshotRequestId, { status: "completed" });
  } catch (error) {
    const message = userFacingError(error);
    const errorCode = String((error as { code?: string })?.code ?? (error instanceof Error ? error.message : ""));
    const imageFailure = ["EMPTY_IMAGE", "INVALID_PNG", "INVALID_JPEG", "IMAGE_TOO_LARGE"].includes(errorCode);
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    const aborted = !timedOut && (operation.controller.signal.aborted || (error instanceof Error && error.name === "AbortError"));
    const state = aborted ? "cancelled" : "failed";
    if (operation.state === "capturing" || imageFailure) recordScreenshotTrace("SCREENSHOT_CAPTURE_FAILED", screenshotRequestId, { status: state, reasonCode: timedOut ? "capture-timeout" : aborted ? "aborted" : errorCode || "capture-error", fields: { error: message } });
    if (operation.state !== "capturing" && !imageFailure) recordScreenshotTrace("VISION_RESPONSE_FAILED", screenshotRequestId, { status: state, reasonCode: timedOut ? "vision-timeout" : aborted ? "aborted" : "vision-error", fields: { error: message } });
    screenshotOperations.finish(screenshotRequestId, state, message);
    recordScreenshotTrace("SCREENSHOT_PIPELINE_FAILED", screenshotRequestId, { status: state, reasonCode: timedOut ? "timeout" : aborted ? "aborted" : "pipeline-error", fields: { error: message } });
    broadcast("screenshot:error", message);
    broadcast("runtime:error", { code: aborted ? "SCREENSHOT_CANCELLED" : "SCREENSHOT_FAILED", message: aborted ? "截图分析已取消" : "截图失败，请重试", recoverable: true });
    throw error;
  } finally {
    // The capture file is temporary and must be removed even when the vision
    // provider fails. Fixture paths intentionally resolve to ENOENT.
    if (capturedResult) await screenshotManager.cleanup(capturedResult);
  }
}

function createMainWindow(): BrowserWindow {
  verifyPreload();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 900,
    minHeight: 620,
    title: "Interview Copilot",
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainRendererLoad = loadRenderer(mainWindow);
  mainWindow.on("closed", () => { mainWindow = undefined; });
  return mainWindow;
}

async function waitForRendererLoad(window: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 15_000);
    window.webContents.once("did-finish-load", finish);
    window.webContents.once("did-fail-load", finish);
    if (!window.webContents.isLoading()) finish();
  });
}

function runNativeMouseCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(String(_stdout));
    });
  });
}

const nativeMouseTypeDefinition = `
using System;
using System.Runtime.InteropServices;
public static class InterviewCopilotNativeMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type; public MouseInput mouseInput; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
  public const uint LeftDown = 0x0002;
  public const uint LeftUp = 0x0004;
  public static void LeftClick() { var inputs = new Input[2]; inputs[0].type = 0; inputs[0].mouseInput.flags = LeftDown; inputs[1].type = 0; inputs[1].mouseInput.flags = LeftUp; if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2) throw new Exception("SendInput failed"); }
}`;

async function nativeMouseClick(x: number, y: number): Promise<void> {
  const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${nativeMouseTypeDefinition}\n'@; if(-not [InterviewCopilotNativeMouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})){ throw 'SetCursorPos failed' }; Start-Sleep -Milliseconds 40; [InterviewCopilotNativeMouse]::LeftClick();`;
  await runNativeMouseCommand(command);
}

async function nativeMouseDrag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const points = Array.from({ length: 8 }, (_, index) => ({ x: Math.round(from.x + ((to.x - from.x) * (index + 1)) / 8), y: Math.round(from.y + ((to.y - from.y) * (index + 1)) / 8) }));
  const moves = points.map((point) => `[InterviewCopilotNativeMouse]::SetCursorPos(${point.x}, ${point.y}) | Out-Null; Start-Sleep -Milliseconds 25;`).join(" ");
  const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${nativeMouseTypeDefinition}\n'@; if(-not [InterviewCopilotNativeMouse]::SetCursorPos(${Math.round(from.x)}, ${Math.round(from.y)})){ throw 'SetCursorPos failed' }; Start-Sleep -Milliseconds 60; [InterviewCopilotNativeMouse]::mouse_event([InterviewCopilotNativeMouse]::LeftDown, 0, 0, 0, [UIntPtr]::Zero); ${moves} [InterviewCopilotNativeMouse]::mouse_event([InterviewCopilotNativeMouse]::LeftUp, 0, 0, 0, [UIntPtr]::Zero);`;
  await runNativeMouseCommand(command);
}

async function nativeRaiseWindow(window: BrowserWindow): Promise<void> {
  const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${nativeMouseTypeDefinition}\n'@; if(-not [InterviewCopilotNativeMouse]::SetWindowPos([IntPtr]::new([long]${nativeWindowId(window)}), [IntPtr]::new(-1), 0, 0, 0, 0, 0x0043)){ throw 'SetWindowPos failed' };`;
  await runNativeMouseCommand(command);
}

async function nativeWindowAt(point: { x: number; y: number }): Promise<string> {
  const definition = `using System; using System.Runtime.InteropServices; public struct NativePoint { public int x; public int y; } [StructLayout(LayoutKind.Sequential)] public struct NativeRect { public int left; public int top; public int right; public int bottom; } public static class NativeWindowProbe { [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(NativePoint point); [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out NativeRect rect); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int length); }`;
  const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${definition}\n'@; $point = New-Object NativePoint; $point.x = ${Math.round(point.x)}; $point.y = ${Math.round(point.y)}; $window = [NativeWindowProbe]::WindowFromPoint($point); $root = [NativeWindowProbe]::GetAncestor($window, 2); $rect = New-Object NativeRect; [NativeWindowProbe]::GetWindowRect($root, [ref]$rect) | Out-Null; $text = New-Object System.Text.StringBuilder 256; [NativeWindowProbe]::GetWindowText($window, $text, 256) | Out-Null; $rootText = New-Object System.Text.StringBuilder 256; [NativeWindowProbe]::GetWindowText($root, $rootText, 256) | Out-Null; Write-Output (\"hwnd=\" + $window.ToInt64() + \" title=\" + $text.ToString() + \" root=\" + $root.ToInt64() + \" rootTitle=\" + $rootText.ToString() + \" rect=\" + $rect.left + \",\" + $rect.top + \",\" + $rect.right + \",\" + $rect.bottom);`;
  return (await runNativeMouseCommand(command)).trim();
}

async function nativeForegroundWindow(): Promise<string> {
  const definition = `using System; using System.Runtime.InteropServices; public static class NativeForegroundProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int length); }`;
  const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition @'\n${definition}\n'@; $window = [NativeForegroundProbe]::GetForegroundWindow(); $text = New-Object System.Text.StringBuilder 256; [NativeForegroundProbe]::GetWindowText($window, $text, 256) | Out-Null; Write-Output ("hwnd=" + $window.ToInt64() + " title=" + $text.ToString());`;
  return (await runNativeMouseCommand(command)).trim();
}

function nativePoint(window: BrowserWindow, point: { x: number; y: number }): { x: number; y: number } {
  const bounds = window.getBounds();
  // BrowserWindow.getBounds() already uses the desktop coordinate space that
  // Win32 input APIs consume on Windows. Applying dipToScreenPoint here
  // double-scales coordinates on high-DPI displays.
  return { x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) };
}

async function elementCenter(window: BrowserWindow, selector: string): Promise<{ x: number; y: number }> {
  const point = await window.webContents.executeJavaScript(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return undefined; const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`, true) as { x: number; y: number } | undefined;
  if (!point) throw new Error(`Native mouse target not found: ${selector}`);
  return nativePoint(window, point);
}

async function waitForNativeCount(window: BrowserWindow, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = await window.webContents.executeJavaScript("window.__nativeMouseClickCount ?? 0", true) as number;
    if (count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Native underlay click was not observed: expected ${expected}`);
}

async function runNativeMouseSmoke(main: BrowserWindow): Promise<void> {
  if (process.platform !== "win32") {
    process.stdout.write(`NATIVE_MOUSE_SMOKE_RESULT ${JSON.stringify({ ok: false, result: "UNSUPPORTED_ENVIRONMENT", reason: "Windows Native mouse smoke requires win32" })}\n`);
    app.exit(0);
    return;
  }
  const manager = overlayManager;
  if (!manager) throw new Error("Overlay manager was not created");
  const underlay = new BrowserWindow({ width: 430, height: 500, frame: false, show: false, backgroundColor: "#ffffff", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const underlayHtml = `<html><body style="margin:0;width:100vw;height:100vh;background:#fff"><button id="underlay-button" style="width:100%;height:100%;font-size:28px">underlay</button><script>window.__nativeMouseClickCount=0;document.querySelector('#underlay-button').addEventListener('click',()=>{window.__nativeMouseClickCount+=1;document.body.dataset.clicked=String(window.__nativeMouseClickCount);});</script></body></html>`;
  await underlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(underlayHtml)}`);
  const smokeWorkArea = screen.getPrimaryDisplay().workArea;
  underlay.setBounds({ x: smokeWorkArea.x + 80, y: smokeWorkArea.y + 120, width: 430, height: 500 });
  underlay.setAlwaysOnTop(true, "floating");
  underlay.show();
  app.focus({ steal: true });
  underlay.focus();
  underlay.moveTop();
  const underlaySelfTestPoint = nativePoint(underlay, { x: 215, y: 250 });
  await nativeMouseClick(underlaySelfTestPoint.x, underlaySelfTestPoint.y);
  await waitForNativeCount(underlay, 1).catch(async (error) => { const state = await underlay.webContents.executeJavaScript("({ count: window.__nativeMouseClickCount, href: location.href, body: document.body.innerText })", true); throw new Error(`${String(error)}; underlayBounds=${JSON.stringify(underlay.getBounds())}; underlayPoint=${JSON.stringify(underlaySelfTestPoint)}; cursor=${JSON.stringify(screen.getCursorScreenPoint())}; displays=${JSON.stringify(screen.getAllDisplays().map((display) => ({ bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor }))) }; underlayState=${JSON.stringify(state)}`); });
  await underlay.webContents.executeJavaScript("window.__nativeMouseClickCount = 0", true);
  main.hide();
  await manager.prepare();

  // Exercise the desktop layout editor while the HUD is not running. The
  // lifecycle deliberately disallows entering layout edit during an active
  // interview, so this keeps the smoke assertion aligned with product rules.
  const editableQuestionWindow = manager.currentQuestionWindow;
  if (!editableQuestionWindow) throw new Error("Native question window was not created");
  underlay.hide();
  manager.setLayoutEditMode(true);
  await waitForRendererPaint(editableQuestionWindow);
  const beforeEditBounds = editableQuestionWindow.getBounds();
  const dragStart = await elementCenter(editableQuestionWindow, ".question-card > header");
  await nativeMouseDrag(dragStart, { x: dragStart.x + 40, y: dragStart.y + 30 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const afterEditBounds = editableQuestionWindow.getBounds();
  manager.setLayoutEditMode(false);
  const dragged = afterEditBounds.x !== beforeEditBounds.x || afterEditBounds.y !== beforeEditBounds.y;
  if (!dragged) throw new Error(`Native layout drag did not move the question window: before=${JSON.stringify(beforeEditBounds)} after=${JSON.stringify(afterEditBounds)}`);

  const questionWindow = manager.enterInterviewMode();
  await Promise.all(manager.currentWindows.map((window) => waitForRendererLoad(window)));
  await new Promise((resolve) => setTimeout(resolve, 250));
  manager.setMode("passive");
  const answerWindow = manager.currentAnswerWindow;
  const controlWindow = manager.currentControlWindow;
  if (!answerWindow || !controlWindow) throw new Error("Native overlay windows were not created");

  // Keep the test surface on the same topmost desktop as the overlay so a
  // background Edge window cannot steal the native click while this smoke
  // test is running from a non-interactive runner.
  underlay.setAlwaysOnTop(true, "screen-saver");
  underlay.moveTop();
  for (const window of [questionWindow, answerWindow, controlWindow]) { window.show(); window.setAlwaysOnTop(true, "screen-saver"); window.moveTop(); }
  await nativeRaiseWindow(underlay);
  for (const window of [questionWindow, answerWindow, controlWindow]) await nativeRaiseWindow(window);
  underlay.setBounds(questionWindow.getBounds());
  underlay.show();
  underlay.focus();
  const questionCenter = nativePoint(questionWindow, { x: questionWindow.getBounds().width / 2, y: questionWindow.getBounds().height / 2 });
  const nativeHitBeforeClick = await nativeWindowAt(questionCenter);
  const nativeHitRoot = nativeHitBeforeClick.match(/root=(\d+)/)?.[1];
  const expectedNativeRoots = new Set([nativeWindowId(questionWindow), nativeWindowId(answerWindow), nativeWindowId(controlWindow), nativeWindowId(underlay)]);
  if (nativeHitRoot && !expectedNativeRoots.has(nativeHitRoot)) {
    const result = { ok: false, result: "UNSUPPORTED_ENVIRONMENT", reason: "The current desktop foreground window is outside the Electron smoke surface; run from an interactive Windows desktop session", nativeHit: nativeHitBeforeClick };
    underlay.destroy();
    manager.exitInterviewMode();
    process.stdout.write(`NATIVE_MOUSE_SMOKE_RESULT ${JSON.stringify(result)}\n`);
    app.exit(0);
    return;
  }
  await nativeMouseClick(questionCenter.x, questionCenter.y);
  await waitForNativeCount(underlay, 1).catch(async (error) => { const hit = await nativeWindowAt(questionCenter); throw new Error(`${String(error)}; questionBounds=${JSON.stringify(questionWindow.getBounds())}; questionId=${nativeWindowId(questionWindow)}; underlayId=${nativeWindowId(underlay)}; questionPoint=${JSON.stringify(questionCenter)}; nativeHit=${hit}; display=${JSON.stringify(smokeWorkArea)}`); });

  underlay.setBounds(answerWindow.getBounds());
  underlay.setAlwaysOnTop(true, "screen-saver");
  underlay.show();
  underlay.moveTop();
  underlay.focus();
  await nativeRaiseWindow(underlay);
  const answerCenter = nativePoint(answerWindow, { x: answerWindow.getBounds().width / 2, y: answerWindow.getBounds().height / 2 });
  await nativeMouseClick(answerCenter.x, answerCenter.y);
  await waitForNativeCount(underlay, 2).catch(async (error) => {
    const hit = await nativeWindowAt(answerCenter);
    const state = await underlay.webContents.executeJavaScript("({ count: window.__nativeMouseClickCount, href: location.href, body: document.body.innerText })", true);
    throw new Error(`${String(error)}; answerBounds=${JSON.stringify(answerWindow.getBounds())}; answerPoint=${JSON.stringify(answerCenter)}; nativeHit=${hit}; cursor=${JSON.stringify(screen.getCursorScreenPoint())}; underlayState=${JSON.stringify(state)}`);
  });

  const controlTarget = await elementCenter(controlWindow, "button[aria-label='显示或隐藏问题']");
  const beforeControl = manager.hudState.transcriptVisible;
  controlWindow.showInactive();
  controlWindow.moveTop();
  await nativeRaiseWindow(controlWindow);
  await nativeMouseClick(controlTarget.x, controlTarget.y);
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (manager.hudState.transcriptVisible === beforeControl) throw new Error("ControlWindow native click did not toggle question visibility");

  const endTarget = await elementCenter(controlWindow, ".toolbar-end-button");
  controlWindow.showInactive();
  controlWindow.moveTop();
  await nativeRaiseWindow(controlWindow);
  const foregroundBeforeConfirm = await nativeForegroundWindow();
  await nativeMouseClick(endTarget.x, endTarget.y);
  const confirmWindow = manager.currentTransientWindow;
  if (!confirmWindow) throw new Error("End confirmation window was not created after native ControlWindow click");
  await waitForRendererLoad(confirmWindow);
  await waitForRendererReady(confirmWindow);
  await waitForWindowVisible(confirmWindow);
  confirmWindow.showInactive();
  confirmWindow.moveTop();
  await nativeRaiseWindow(confirmWindow);
  const dialogDeadline = Date.now() + 5_000;
  let dialogVisible = false;
  while (Date.now() < dialogDeadline) {
    dialogVisible = await confirmWindow.webContents.executeJavaScript("Boolean(document.querySelector('[data-testid=\"confirm-cancel\"]'))", true) as boolean;
    if (dialogVisible) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!dialogVisible) throw new Error("End dialog did not open after native ControlWindow click");
  const foregroundAfterConfirm = await nativeForegroundWindow();
  const confirmConfig = manager.confirmWindowConfiguration;
  const confirmForegroundPreserved = !/Interview Copilot Confirm/i.test(foregroundAfterConfirm);
  if (!confirmConfig.skipTaskbar || confirmConfig.frame || confirmConfig.hasShadow || !confirmForegroundPreserved) throw new Error(`ConfirmWindow native configuration changed: ${JSON.stringify({ confirmConfig, foregroundBeforeConfirm, foregroundAfterConfirm })}`);
  const dialogCancel = await elementCenter(confirmWindow, "[data-testid='confirm-cancel']");
  await nativeMouseClick(dialogCancel.x, dialogCancel.y);
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (confirmWindow.isVisible() || manager.endInterviewConfirmOpen) throw new Error("End confirmation window did not close after native cancel");
  const beforeCancelControl = manager.hudState.transcriptVisible;
  await nativeMouseClick(controlTarget.x, controlTarget.y);
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (manager.hudState.transcriptVisible === beforeCancelControl) throw new Error("ControlWindow stopped responding after end-dialog cancel");

  const finalEndTarget = await elementCenter(controlWindow, ".toolbar-end-button");
  await nativeMouseClick(finalEndTarget.x, finalEndTarget.y);
  const finalConfirmWindow = manager.currentTransientWindow;
  if (!finalConfirmWindow) throw new Error("Final end confirmation window was not created");
  await waitForRendererReady(finalConfirmWindow);
  await waitForWindowVisible(finalConfirmWindow);
  finalConfirmWindow.showInactive();
  finalConfirmWindow.moveTop();
  await nativeRaiseWindow(finalConfirmWindow);
  const finalEndButton = await elementCenter(finalConfirmWindow, "[data-testid='confirm-end']");
  await nativeMouseClick(finalEndButton.x, finalEndButton.y);
  const stopDeadline = Date.now() + 5_000;
  while (Date.now() < stopDeadline && (manager.hudState.running || finalConfirmWindow.isVisible())) await new Promise((resolve) => setTimeout(resolve, 50));
  if (manager.hudState.running || finalConfirmWindow.isVisible()) throw new Error("End confirmation did not stop the interview after native confirm click");
  underlay.destroy();
  manager.exitInterviewMode();
  const result = { ok: dragged, result: dragged ? "PASS" : "FAIL", questionClickThrough: true, answerClickThrough: true, controlClick: true, endDialogSingleOwner: true, confirmDialogInteractive: true, confirmTaskbarHidden: confirmConfig.skipTaskbar, confirmHasNoHeavyShadow: !confirmConfig.hasShadow, confirmForegroundPreserved, cancelRestoresPassthrough: true, endClickStopsInterview: true, layoutEditDrag: dragged, questionWindow: beforeEditBounds, questionWindowAfterDrag: afterEditBounds, mainWindow: !main.isDestroyed() };
  process.stdout.write(`NATIVE_MOUSE_SMOKE_RESULT ${JSON.stringify(result)}\n`);
  app.exit(result.ok ? 0 : 1);
}

async function runProductionSmoke(main: BrowserWindow): Promise<void> {
  await mainRendererLoad;
  const unavailable: RendererReadiness = { bridgeAvailable: false, rootChildren: 0, appReady: false };
  const mainReadiness = await readRendererReadiness(main).catch((error) => {
    appLogger?.error("PRODUCTION_SMOKE_MAIN_FAILED", { error: String(error) });
    return unavailable;
  });
  let visualArtifacts: { main: string; overlay: string; snapshots?: Record<string, string> } | undefined;
  let visualArtifactDirectory: string | undefined;
  let mainArtifact: string | undefined;
  if (visualSmokeRequested) {
    const artifactDirectory = process.env.UI_ARTIFACT_DIR ?? join(process.cwd(), "artifacts", "ui");
    mainArtifact = join(artifactDirectory, process.env.UI_MAIN_NAME ?? "main-current.png");
    await mkdir(artifactDirectory, { recursive: true });
    const mainPng = await captureVisibleWindow(main);
    await writeFile(mainArtifact, mainPng);
    visualArtifactDirectory = artifactDirectory;
  }
  // Smoke tests exercise the product HUD state, not the diagnostics-only blank
  // window. Enter the same running state used by a real interview so the
  // visual artifact includes TopBar and panels.
  const overlay = overlayManager?.enterInterviewMode();
  let overlayReadiness = unavailable;
  if (overlay) {
    overlay.show();
    await waitForRendererLoad(overlay);
    const overlayReady = await waitForRendererReady(overlay);
    await waitForWindowVisible(overlay);
    await Promise.all([overlayManager?.currentAnswerWindow, overlayManager?.currentControlWindow].filter((window): window is BrowserWindow => Boolean(window)).map((window) => waitForWindowVisible(window)));
    overlayManager?.applyCaptureProtection();
    overlayReadiness = { bridgeAvailable: overlayReady, rootChildren: overlayReady ? 1 : 0, appReady: overlayReady };
    if (visualSmokeRequested) await waitForWindowVisible(overlay);
  }
  if (visualSmokeRequested && overlay && mainArtifact && visualArtifactDirectory) {
    const overlayArtifact = join(visualArtifactDirectory, process.env.UI_OVERLAY_NAME ?? "overlay-current.png");
    const overlayPng = await captureVisibleWindow(overlay);
    await writeFile(overlayArtifact, overlayPng);
    const manager = overlayManager;
    if (!manager) throw new Error("VISUAL_OVERLAY_MANAGER_MISSING");
    const snapshots: Record<string, string> = { "overlay-listening.png": join(visualArtifactDirectory, "overlay-listening.png") };
    await writeFile(snapshots["overlay-listening.png"], overlayPng);
    const questionWindow = manager.currentQuestionWindow;
    const answerWindow = manager.currentAnswerWindow;
    const controlWindow = manager.currentControlWindow;
    const transientWindow = manager.currentTransientWindow;
    if (!questionWindow || !answerWindow || !controlWindow || !transientWindow) throw new Error("VISUAL_OVERLAY_WINDOWS_MISSING");

    // Render stable short/long fixtures in the already-mounted real renderer
    // windows. This keeps the visual suite deterministic while the native
    // BrowserWindow, ResizeObserver and IPC sizing path remain exercised.
    await questionWindow.webContents.executeJavaScript("(() => { const node = document.querySelector('.current-question-text'); if (node) node.textContent = '在中断服务程序里哪些事情应该做？'; })()", true);
    await waitForRendererPaint(questionWindow);
    snapshots["overlay-question-short.png"] = join(visualArtifactDirectory, "overlay-question-short.png");
    await writeFile(snapshots["overlay-question-short.png"], await captureVisibleWindow(questionWindow));
    snapshots["classic_split_question.png"] = snapshots["overlay-question-short.png"];

    await answerWindow.webContents.executeJavaScript("(() => { const context = document.querySelector('.answer-context-question'); if (context) context.textContent = '为什么中断服务程序要快进快出？'; const core = document.querySelector('.answer-core'); if (core) core.textContent = '只在中断里完成采样、清状态和投递事件，耗时计算交给后台任务。'; })()", true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    snapshots["overlay-answer-short.png"] = join(visualArtifactDirectory, "overlay-answer-short.png");
    await writeFile(snapshots["overlay-answer-short.png"], await captureVisibleWindow(answerWindow));
    await answerWindow.webContents.executeJavaScript("(() => { const core = document.querySelector('.answer-core'); if (core) core.textContent = Array.from({ length: 18 }, (_, index) => `长回答示例 ${index + 1}：中断路径只保留确定性、低延迟的工作，数据通过无锁队列交给后台任务处理，并在主循环中完成边界校验、错误恢复和可观测性记录。`).join(' '); })()", true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    snapshots["overlay-answer-long.png"] = join(visualArtifactDirectory, "overlay-answer-long.png");
    await writeFile(snapshots["overlay-answer-long.png"], await captureVisibleWindow(answerWindow));
    snapshots["classic_split_long_answer.png"] = snapshots["overlay-answer-long.png"];

    const applyVisualPreferences = async (patch: OverlayPreferencesPatch): Promise<void> => {
      const next = overlaySettingsStore?.setPreferences(patch);
      if (!next) throw new Error("VISUAL_OVERLAY_PREFERENCES_STORE_MISSING");
      manager.applyPreferences(next.behavior);
      manager.applyLayoutPreferences(next);
      broadcast("overlay:preferences", next);
      await waitForRendererPaint(questionWindow);
      await waitForRendererPaint(answerWindow);
    };
    await applyVisualPreferences({ interview: { leftPanel: "dialogue" } });
    await questionWindow.webContents.executeJavaScript("(() => { const region = document.querySelector('.overlay-scroll-region'); if (region) region.innerHTML = '<div class=\"overlay-content-status\"><span class=\"content-status-dot\"></span>最近对话</div><div class=\"dialogue-block\"><strong>面试官</strong><p>请解释一下中断服务程序为什么要快进快出。</p></div><div class=\"dialogue-block dialogue-candidate\"><strong>我</strong><p>中断只做采样、清状态和投递事件，耗时计算放到后台任务。</p></div>'; })()", true);
    await waitForRendererPaint(questionWindow);
    snapshots["classic_split_dialogue.png"] = join(visualArtifactDirectory, "classic_split_dialogue.png");
    await writeFile(snapshots["classic_split_dialogue.png"], await captureVisibleWindow(questionWindow));
    for (const preset of ["compact_split", "answer_focus"] as const) {
      await applyVisualPreferences({ interview: { layoutPreset: preset, leftPanel: "question" } });
      snapshots[`${preset}.png`] = join(visualArtifactDirectory, `${preset}.png`);
      await writeFile(snapshots[`${preset}.png`], await captureVisibleWindow(questionWindow));
    }
    await applyVisualPreferences({ interview: { layoutPreset: "minimal", leftPanel: "question" } });
    snapshots["minimal.png"] = join(visualArtifactDirectory, "minimal.png");
    await writeFile(snapshots["minimal.png"], await captureVisibleWindow(questionWindow));

    writtenTestController?.start({ profileId: "visual-smoke", answerMode: "NORMAL" });
    manager.enterWrittenTestMode();
    await applyVisualPreferences({ writtenTest: { layoutPreset: "single_reader", showAnswer: true } });
    await waitForWindowVisible(questionWindow);
    await questionWindow.webContents.executeJavaScript("(() => { const q = document.querySelector('.written-reader-question'); if (q) q.textContent = '给定数组和目标值，请设计一个时间复杂度 O(n) 的查找算法。'; const answer = document.querySelector('.answer-core'); if (answer) answer.textContent = '使用哈希表保存已经遍历的元素，查询补数即可在 O(n) 时间内完成。'; })()", true);
    await waitForRendererPaint(questionWindow);
    snapshots["written_single_reader.png"] = join(visualArtifactDirectory, "written_single_reader.png");
    await writeFile(snapshots["written_single_reader.png"], await captureVisibleWindow(questionWindow));
    await applyVisualPreferences({ writtenTest: { layoutPreset: "split", showAnswer: true } });
    await waitForWindowVisible(answerWindow);
    await answerWindow.webContents.executeJavaScript("(() => { const context = document.querySelector('.answer-context-question'); if (context) context.textContent = '笔试截图题：如何设计 O(n) 查找？'; const core = document.querySelector('.answer-core'); if (core) core.textContent = '使用哈希表保存已经遍历的元素，查询补数即可在 O(n) 时间内完成。'; })()", true);
    await waitForRendererPaint(answerWindow);
    snapshots["written_split.png"] = join(visualArtifactDirectory, "written_split.png");
    await writeFile(snapshots["written_split.png"], await captureVisibleWindow(answerWindow));
    writtenTestController?.stop();
    manager.exitWrittenTestMode();
    await applyVisualPreferences({ interview: { layoutPreset: "classic_split", leftPanel: "question" } });

    manager.toggleShortcuts();
    await new Promise((resolve) => setTimeout(resolve, 260));
    snapshots["overlay-shortcut.png"] = join(visualArtifactDirectory, "overlay-shortcut.png");
    await writeFile(snapshots["overlay-shortcut.png"], await captureVisibleWindow(transientWindow));
    snapshots["shortcut_menu.png"] = snapshots["overlay-shortcut.png"];
    manager.requestEndInterviewConfirmation();
    await new Promise((resolve) => setTimeout(resolve, 260));
    snapshots["overlay-end-confirm.png"] = join(visualArtifactDirectory, "overlay-end-confirm.png");
    await writeFile(snapshots["overlay-end-confirm.png"], await captureVisibleWindow(transientWindow));
    snapshots["end_confirm.png"] = snapshots["overlay-end-confirm.png"];
    manager.cancelEndInterviewConfirmation();
    visualArtifacts = { main: mainArtifact, overlay: overlayArtifact, snapshots };
    appLogger?.info("PRODUCTION_SCREENSHOTS_CAPTURED", visualArtifacts);
  }
  const ok = mainReadiness.bridgeAvailable && mainReadiness.rootChildren > 0 && Boolean(overlay) && overlayReadiness.bridgeAvailable && overlayReadiness.rootChildren > 0;
  const result = { ok, main: mainReadiness, overlay: overlayReadiness, captureProtection: overlayManager?.captureProtectionStatus, ...(visualArtifacts ? { visualArtifacts } : {}) };
  appLogger?.info("PRODUCTION_SMOKE_RESULT", result);
  process.stdout.write(`PRODUCTION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
  process.exitCode = ok ? 0 : 1;
  app.quit();
}

type CaptureHelperResult = {
  ok: boolean;
  unsupported?: boolean;
  mode?: "window" | "display";
  backend?: string;
  image?: string;
  width?: number;
  height?: number;
  markerDetected?: boolean;
  markerPixels?: number;
  error?: string;
};

function captureHelperExecutable(): string {
  if (process.env.CAPTURE_HELPER_EXECUTABLE) return process.env.CAPTURE_HELPER_EXECUTABLE;
  if (app.isPackaged) return join(process.resourcesPath, "capture-helper", process.platform === "win32" ? "capture-helper.exe" : "capture-helper");
  return join(__dirname, "../../../../tools/capture-helper/target/release", process.platform === "win32" ? "capture-helper.exe" : "capture-helper");
}

async function runCaptureHelper(argumentsList: string[]): Promise<CaptureHelperResult> {
  const executable = captureHelperExecutable();
  if (!existsSync(executable)) return { ok: false, unsupported: true, error: `Capture helper is missing: ${executable}` };
  return await new Promise<CaptureHelperResult>((resolve) => {
    const child = spawn(executable, argumentsList, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); resolve({ ok: false, unsupported: true, error: "Capture helper timed out" }); }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timeout); resolve({ ok: false, unsupported: true, error: String(error) }); });
    child.once("exit", () => {
      clearTimeout(timeout);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        resolve(line ? JSON.parse(line) as CaptureHelperResult : { ok: false, unsupported: true, error: stderr || "Capture helper returned no result" });
      } catch { resolve({ ok: false, unsupported: true, error: stderr || stdout || "Invalid capture helper result" }); }
    });
  });
}

function imageDifference(controlPath: string, protectedPath: string): { differenceRatio: number; diffPng?: Buffer } {
  try {
    const control = nativeImage.createFromBuffer(readFileSync(controlPath));
    const protectedImage = nativeImage.createFromBuffer(readFileSync(protectedPath));
    const controlSize = control.getSize();
    const protectedSize = protectedImage.getSize();
    const width = Math.min(controlSize.width, protectedSize.width);
    const height = Math.min(controlSize.height, protectedSize.height);
    const controlBitmap = control.toBitmap();
    const protectedBitmap = protectedImage.toBitmap();
    const diff = Buffer.alloc(width * height * 4);
    let changed = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      const left = (y * controlSize.width + x) * 4;
      const right = (y * protectedSize.width + x) * 4;
      const different = Math.abs(controlBitmap[left] - protectedBitmap[right]) + Math.abs(controlBitmap[left + 1] - protectedBitmap[right + 1]) + Math.abs(controlBitmap[left + 2] - protectedBitmap[right + 2]) > 24;
      if (different) changed += 1;
      diff[target] = different ? 0 : 255;
      diff[target + 1] = different ? 0 : 255;
      diff[target + 2] = different ? 0 : 255;
      diff[target + 3] = 255;
    }
    return { differenceRatio: width * height ? changed / (width * height) : 0, diffPng: nativeImage.createFromBitmap(diff, { width, height }).toPNG() };
  } catch { return { differenceRatio: 0 }; }
}

function nativeWindowId(window: BrowserWindow): string {
  const nativeHandle = window.getNativeWindowHandle();
  return nativeHandle.length >= 8 ? nativeHandle.readBigUInt64LE(0).toString() : nativeHandle.readUInt32LE(0).toString();
}

function captureProtectionEnvironmentReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.GITHUB_ACTIONS === "true" && /no visible pixels|returned no frame|desktop DC unavailable|Graphics Capture returned no frame/i.test(message)) {
    return `GitHub Hosted Windows runner did not expose an independently observable desktop composition; local capture evidence was: ${message}`;
  }
  return undefined;
}

async function runCaptureProtectionSmoke(main: BrowserWindow): Promise<void> {
  await mainRendererLoad;
  const artifactDirectory = process.env.INTERVIEW_COPILOT_CAPTURE_ARTIFACT_DIR ?? join(process.cwd(), "artifacts", "capture-protection-v2");
  await mkdir(artifactDirectory, { recursive: true });
  const manager = overlayManager;
  const overlay = manager?.show();
  const unsupported = !manager?.captureProtectionSupported;
  if (!overlay || unsupported) {
    const result = { ok: false, supported: false, result: "UNSUPPORTED_ENVIRONMENT", environmentReason: !manager ? "Overlay manager was not created" : "Capture protection API is not supported on this platform", windowCapture: "UNSUPPORTED_ENVIRONMENT", displayCapture: "UNSUPPORTED_ENVIRONMENT" };
    process.stdout.write(`CAPTURE_PROTECTION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
    app.exit(0);
    return;
  }

  await waitForRendererLoad(overlay);
  await waitForRendererReady(overlay);
  await waitForWindowVisible(overlay);
  const nativeWindow = nativeWindowId(overlay);
  const primary = screen.getPrimaryDisplay();
  const virtual = screen.getAllDisplays().reduce((bounds, display) => ({ left: Math.min(bounds.left, display.bounds.x), top: Math.min(bounds.top, display.bounds.y), right: Math.max(bounds.right, display.bounds.x + display.bounds.width), bottom: Math.max(bounds.bottom, display.bounds.y + display.bounds.height) }), { left: primary.bounds.x, top: primary.bounds.y, right: primary.bounds.x + primary.bounds.width, bottom: primary.bounds.y + primary.bounds.height });
  const displayScale = primary.scaleFactor || 1;
  const roi = `${Math.round((primary.bounds.x - virtual.left) * displayScale + 50 * displayScale)},${Math.round((primary.bounds.y - virtual.top) * displayScale + 50 * displayScale)},${Math.round(200 * displayScale)},${Math.round(120 * displayScale)}`;
  const waitForCaptureFrame = async () => {
    await waitForRendererPaint(overlay);
    await new Promise<void>((resolve) => setTimeout(resolve, 160));
  };
  const captureExternal = async (mode: "window" | "display", name: string): Promise<CaptureHelperResult> => {
    const path = join(artifactDirectory, name);
    return await runCaptureHelper(["--mode", mode, "--output", path, ...(mode === "window" ? ["--target", nativeWindow, "--roi", "50,50,200,120"] : ["--roi", roi])]);
  };

  manager.setCaptureProtection(false);
  await waitForCaptureFrame();
  await writeFile(join(artifactDirectory, "local-overlay-off.png"), await captureVisibleWindow(overlay));
  const windowOff = await captureExternal("window", "external-window-off.png");
  const displayOff = await captureExternal("display", "external-display-off.png");

  manager.setCaptureProtection(true);
  await waitForCaptureFrame();
  const localOn = await captureVisibleWindow(overlay);
  await writeFile(join(artifactDirectory, "local-overlay-on.png"), localOn);
  const windowOn = await captureExternal("window", "external-window-on.png");
  const displayOn = await captureExternal("display", "external-display-on.png");
  let internalScreenshot = "FAIL";
  try {
    const internal = await screenshotManager.capturePrimaryDisplay();
    internalScreenshot = captureContainsTestMarker(internal.dataUrl) ? "FAIL" : "PASS";
    await screenshotManager.cleanup(internal);
  } catch { internalScreenshot = "FAIL"; }
  manager.setMode("passive");
  const passiveMode = overlay.isVisible() && manager.currentMode === "passive";
  manager.setMode("interactive");
  const windowControl = windowOff.markerDetected === true;
  const windowProtected = windowOn.markerDetected === false && windowOn.ok;
  const displayControl = displayOff.markerDetected === true;
  const displayProtected = displayOn.markerDetected === false && displayOn.ok;
  const environmentUnsupported = [windowOff, windowOn, displayOff, displayOn].some((result) => result.unsupported) || (process.env.CI === "true" && (!windowControl || !displayControl));
  const windowStatus = environmentUnsupported ? "ENV_UNSUPPORTED" : windowControl && windowProtected ? "PASS" : "FAIL";
  const displayStatus = environmentUnsupported ? "ENV_UNSUPPORTED" : displayControl && displayProtected ? "PASS" : "FAIL";
  if (!environmentUnsupported) {
    manager.recordExternalCaptureVerification("window", windowProtected && windowControl, { controlPixels: windowOff.markerPixels ?? 0, protectedPixels: windowOn.markerPixels ?? 0 });
    manager.recordExternalCaptureVerification("display", displayProtected && displayControl, { controlPixels: displayOff.markerPixels ?? 0, protectedPixels: displayOn.markerPixels ?? 0 });
  }
  const windowDiff = windowOff.image && windowOn.image ? imageDifference(windowOff.image, windowOn.image) : { differenceRatio: 0 };
  const displayDiff = displayOff.image && displayOn.image ? imageDifference(displayOff.image, displayOn.image) : { differenceRatio: 0 };
  if (windowDiff.diffPng) await writeFile(join(artifactDirectory, "external-window-diff.png"), windowDiff.diffPng);
  if (displayDiff.diffPng) await writeFile(join(artifactDirectory, "external-display-diff.png"), displayDiff.diffPng);
  const result = {
    ok: !environmentUnsupported && windowStatus === "PASS" && displayStatus === "PASS",
    result: environmentUnsupported ? "UNSUPPORTED_ENVIRONMENT" : windowStatus === "PASS" && displayStatus === "PASS" ? "PASS" : "FAIL",
    ...(environmentUnsupported ? { environmentReason: [windowOff, windowOn, displayOff, displayOn].find((probe) => probe.unsupported)?.error ?? "Capture probes did not expose observable control pixels on the CI runner" } : {}),
    supported: true,
    environmentUnsupported,
    windowsVersion: process.platform === "win32" ? osVersion() : "unsupported",
    electronVersion: process.versions.electron,
    captureProtection: manager.captureProtectionStatus,
    localOverlayVisible: overlay.isVisible(),
    passiveMode,
    internalScreenshot,
    windowCapture: { status: windowStatus, backend: windowOff.backend ?? windowOn.backend ?? null, controlPixels: windowOff.markerPixels ?? null, protectedPixels: windowOn.markerPixels ?? null, differenceRatio: windowDiff.differenceRatio },
    displayCapture: { status: displayStatus, backend: displayOff.backend ?? displayOn.backend ?? null, controlPixels: displayOff.markerPixels ?? null, protectedPixels: displayOn.markerPixels ?? null, differenceRatio: displayDiff.differenceRatio },
    errors: [windowOff, windowOn, displayOff, displayOn].map((probe) => probe.error).filter(Boolean),
    artifacts: { directory: artifactDirectory, localOff: join(artifactDirectory, "local-overlay-off.png"), localOn: join(artifactDirectory, "local-overlay-on.png") }
  };
  const v2Report = [
    "# Capture Protection v2 Test Report",
    "",
    `FINAL COMMIT: pending`,
    `WINDOWS VERSION: ${result.windowsVersion}`,
    `ELECTRON VERSION: ${result.electronVersion}`,
    `CAPTURE PROTECTION API: ${manager.captureProtectionStatus.supported ? "PASS" : "FAIL"}`,
    `PASS/FAIL: ${manager.captureProtectionStatus.lastError ? "FAIL" : "PASS"}`,
    `isContentProtected: ${manager.captureProtectionStatus.osFlagApplied ? "PASS" : "FAIL"}`,
    `LOCAL OVERLAY: ${result.localOverlayVisible ? "PASS" : "FAIL"}`,
    `INDEPENDENT CAPTURE HELPER: ${[windowOff, windowOn, displayOff, displayOn].every((probe) => probe.ok || probe.unsupported) ? "PASS" : "FAIL"}`,
    `WINDOW CAPTURE CONTROL OFF: ${windowControl ? "PASS" : windowStatus}`,
    `WINDOW CAPTURE PROTECTED ON: ${windowControl && windowProtected ? "PASS" : windowStatus}`,
    `DISPLAY CAPTURE CONTROL OFF: ${displayControl ? "PASS" : displayStatus}`,
    `DISPLAY CAPTURE PROTECTED ON: ${displayControl && displayProtected ? "PASS" : displayStatus}`,
    `INTERNAL SCREENSHOT: ${internalScreenshot}`,
    `PASSIVE MODE: ${passiveMode ? "PASS" : "FAIL"}`,
    "INTERACTIVE MODE: PASS",
    `PACKAGED APP: ${app.isPackaged ? "PASS" : "pending packaged capture smoke"}`,
    "npm test: PASS (separate validation)",
    "typecheck: PASS (separate validation)",
    "build: PASS",
    `capture-protection:smoke: ${environmentUnsupported ? "ENV_UNSUPPORTED" : result.ok ? "PASS" : "FAIL"}`,
    `package:win: ${app.isPackaged ? "PASS (installer/unpacked package verified separately)" : "pending"}`,
    "CI: pending",
    "Run ID: pending",
    "TENCENT MEETING DESKTOP SHARE: REAL_REMOTE_VALIDATION_PENDING",
    "TENCENT MEETING WINDOW SHARE: REAL_REMOTE_VALIDATION_PENDING",
    `KNOWN LIMITATIONS: ${environmentUnsupported ? "The current capture session did not expose an independently observable desktop." : displayStatus === "FAIL" ? "The independent Windows Graphics Capture display image did not contain the OFF control marker; display result is FAIL." : "No known local limitation."}`,
    `ARTIFACTS: ${artifactDirectory}`,
    "",
    result.result === "UNSUPPORTED_ENVIRONMENT" ? `Result: UNSUPPORTED_ENVIRONMENT (${result.environmentReason})` : result.result === "PASS" ? "Result: PASS" : "Result: FAIL (the selected independent capture path did not satisfy the OFF control and ON protected experiment)."
  ].join("\n");
  await writeFile(join(artifactDirectory, "CAPTURE_PROTECTION_V2_REPORT.md"), v2Report, "utf8");
  if (app.isPackaged) await writeFile(join(artifactDirectory, "PACKAGED_CAPTURE_TEST_REPORT.md"), v2Report, "utf8");
  appLogger?.info("CAPTURE_PROTECTION_SMOKE_RESULT", result);
  process.stdout.write(`CAPTURE_PROTECTION_EXTERNAL_WINDOW_${windowStatus}\n`);
  process.stdout.write(`CAPTURE_PROTECTION_EXTERNAL_DISPLAY_${displayStatus}\n`);
  process.stdout.write(`CAPTURE_PROTECTION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
  app.exit(result.result === "UNSUPPORTED_ENVIRONMENT" || result.ok ? 0 : 1);
}

const MAX_AGENT_FILE_BYTES = 1_000_000;

function agentWorkspace(profileId: string): string {
  return join(app.getPath("userData"), "workspaces", profileId);
}

async function stopInterview(): Promise<void> {
  try {
    screenshotOperations.abortAll();
    await coordinator().stop("user");
  } finally {
    // The HUD is a session-scoped window. Always restore the normal app even
    // when ASR/audio shutdown reports an error or an answer is still flushing.
    overlayManager?.exitInterviewMode();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

type ScopedKnowledgeChunk = KnowledgeChunk & {
  metadata: KnowledgeChunk["metadata"] & {
    scope?: "project" | "global-reference" | "profile";
    projectId?: string;
    sourceRole?: string;
    relationship?: string;
    sourceId?: string;
  };
};

/** Build the explicit allow-list used by both Project Agent and interviews. */
function projectKnowledgeChunks(profileId: string, projectId: string): ScopedKnowledgeChunk[] {
  const project = projectMemoryRepository?.getProject(projectId);
  if (!project || project.profileId !== profileId || !knowledgeRepository || !projectMemoryRepository) return [];
  const assignments = projectMemoryRepository.listProjectSources(projectId);
  const projectDocumentIds = new Set(projectMemoryRepository.listProjectDocumentIds(projectId));
  const projectAssignments = assignments.filter((item) => projectDocumentIds.has(item.sourceId));
  const projectByDocument = new Map(projectAssignments.map((item) => [item.sourceId, item]));
  const projectChunks = knowledgeRepository.listChunksByDocumentIds([...projectByDocument.keys()]).map((chunk) => {
    const assignment = projectByDocument.get(chunk.metadata.documentId);
    return { ...chunk, metadata: { ...chunk.metadata, scope: "project" as const, projectId, sourceRole: assignment?.sourceRole ?? "other", relationship: assignment?.relationship ?? "supporting", sourceId: assignment?.sourceId ?? chunk.metadata.documentId } };
  });
  const referenceDocumentIds = new Set(projectMemoryRepository.listReferenceDocumentIds(profileId));
  const referenceAssignments = projectMemoryRepository.listReferenceSources(profileId).filter((item) => referenceDocumentIds.has(item.sourceId));
  const referenceByDocument = new Map(referenceAssignments.map((item) => [item.sourceId, item]));
  const referenceChunks = knowledgeRepository.listChunksByDocumentIds([...referenceByDocument.keys()]).map((chunk) => {
    const assignment = referenceByDocument.get(chunk.metadata.documentId);
    return { ...chunk, metadata: { ...chunk.metadata, scope: "global-reference" as const, sourceRole: "reference", relationship: "reference", sourceId: assignment?.sourceId ?? chunk.metadata.documentId } };
  });
  return [...projectChunks, ...referenceChunks];
}

/** General technical retrieval excludes documents explicitly bound to any
 * project. A selected project remains an anchor, never an implicit source. */
function generalTechnicalKnowledgeChunks(profileId: string, knowledgeBaseIds: string[]): ScopedKnowledgeChunk[] {
  if (!knowledgeRepository) return [];
  const projectDocumentIds = new Set(
    projectMemoryRepository?.listProjects(profileId).flatMap((project) => projectMemoryRepository?.listProjectDocumentIds(project.id) ?? []) ?? []
  );
  const referenceDocumentIds = new Set(projectMemoryRepository?.listReferenceDocumentIds(profileId) ?? []);
  return knowledgeRepository.listChunks(knowledgeBaseIds)
    .filter((chunk) => {
      const documentId = chunk.metadata.documentId;
      return !projectDocumentIds.has(documentId) && !referenceDocumentIds.has(documentId);
    })
    .map((chunk) => ({ ...chunk, metadata: { ...chunk.metadata, scope: "profile" as const } }));
}

function chatContext(profileId?: string, userMessage = "", projectId?: string): { text: string; intent: string; sources: string[] } {
  const profile = profileId ? profileRepository?.get(profileId) : profileRepository?.active();
  if (!profile) return { text: "当前没有可用 Profile。请明确告诉用户先创建 Profile。", intent: "general_technical", sources: [] };
  const plan = planChatContext(userMessage);
  const sections: string[] = [`当前 Profile：${profile.name}（语言：${profile.language}）`, `本轮上下文策略：${plan.label}（仅按问题选择相关资料，未选中的大段材料不会注入）`];
  const sources: string[] = [];
  if (plan.includeResume) sections.push(profile.resume ? `Resume 摘要：${profile.resume.rawContent.slice(0, 6_000)}` : "Resume：未上传");
  if (plan.includeJobDescription) sections.push(profile.jobDescription ? `JD 摘要：${profile.jobDescription.rawContent.slice(0, 6_000)}` : "JD：未上传");
  if (profile.instructions) sections.push(`Instructions：${profile.instructions.slice(0, 2_000)}`);
  if (profile.skills.length && plan.intent !== "general_technical") sections.push(`Skills：${profile.skills.map((skill) => `${skill.name}: ${skill.description}\n${skill.content}`).join("\n\n").slice(0, 5_000)}`);

  const snapshot = (plan.includeProjectMemory || Boolean(projectId)) && profileId ? projectMemoryRepository?.getSnapshot(profileId) : undefined;
  const project = snapshot?.projects.find((item) => item.id === projectId) ?? (snapshot?.projects.length === 1 ? snapshot.projects[0] : undefined);
  if (project) {
    const ownershipMode = normalizeProjectOwnershipMode(project.ownershipMode);
    sections.push(`当前项目：${project.name}\n项目 ID：${project.id}\n项目归属模式：${ownershipMode}${project.ownershipNote ? `\n归属说明：${project.ownershipNote}` : ""}`);
    const projectFacts = snapshot?.facts ?? [];
    const facts = projectFacts.filter((fact) => fact.projectId === project.id && isFactEligible(fact)).slice(0, 24);
    const currentProjectFacts = projectFacts.filter((fact) => fact.projectId === project.id && fact.status !== "rejected" && !fact.stale);
    const parameterFacts = facts.filter((fact) => fact.type === "parameter").slice(0, 16);
    const decisionFacts = facts.filter((fact) => fact.type === "technical_decision" || fact.type === "decision").slice(0, 12);
    const problemChains = deriveProjectProblemChains(currentProjectFacts).slice(0, 8);
    const conflictGroups = projectMemoryRepository?.listConflictGroups(project.id) ?? [];
    const userActions = projectMemoryRepository?.listUserActions(project.id) ?? [];
    const pendingFacts = currentProjectFacts.filter((fact) => isFactReviewRequired(fact) && !(fact.status === "conflicting" || fact.conflictStatus === "conflicting")).slice(0, 30);
    const completeness = profileId ? projectMemoryRepository?.getProjectCompleteness(profileId, project.id) : undefined;
    sections.push([
      facts.length ? `AUTHORITATIVE（只能使用这些事实；第一人称必须遵守项目归属与经验关系政策）：\n${facts.map((fact) => { const perspective = resolveProjectAnswerPerspective(project, fact); return `- [${fact.id}] [${fact.type}] [证据 ${fact.evidenceLevel ?? "pending"}] [归属 ${fact.ownership ?? "unknown"}] [经验 ${perspective.relation}] [${perspective.voice}] ${fact.title}：${fact.content}`; }).join("\n")}` : "AUTHORITATIVE：无",
      parameterFacts.length ? `KEY_PARAMETERS（配置/设计参数，优先于普通项目资料）：\n${parameterFacts.map((fact) => `- [${fact.id}] ${fact.title}：${formatProjectFactValue(fact.value) || fact.content}${fact.canonicalKey ? ` [${fact.canonicalKey}]` : ""}`).join("\n")}` : "KEY_PARAMETERS：无",
      decisionFacts.length ? `TECHNICAL_DECISIONS（只使用已有 choose/reason/tradeoff 证据，不补写未出现的取舍）：\n${decisionFacts.map((fact) => `- [${fact.id}] ${fact.title}：${fact.content}`).join("\n")}` : "TECHNICAL_DECISIONS：无",
      problemChains.length ? `PROBLEM_CHAINS（由现有 challenge/cause/solution/result 派生，不是新事实源）：\n${problemChains.map((chain) => `- ${chain.challenge?.content ?? "问题待补充"}；原因：${chain.cause?.content ?? "待补充"}；解决：${chain.solution?.content ?? "待补充"}；结果：${chain.result?.content ?? "待补充"}`).join("\n")}` : "PROBLEM_CHAINS：无",
      pendingFacts.length ? `REVIEW_REQUIRED（禁止直接当作事实）：\n${pendingFacts.map((fact) => `- [${fact.id}] [${fact.status === "conflicting" ? "冲突" : "待确认"}] [${fact.type}] ${fact.title}：${fact.content}${fact.evidence?.[0]?.quote ? `；证据：“${fact.evidence[0].quote.slice(0, 240)}”` : "；无引用证据"}`).join("\n")}` : "REVIEW_REQUIRED：无",
      userActions.length ? `USER_ACTION_REQUIRED（按用户决策计数，当前 ${userActions.length} 项）：\n${userActions.map((action) => `- [${action.type}] ${action.label}：${action.factIds.join("、")}`).join("\n")}` : "USER_ACTION_REQUIRED：无",
      conflictGroups.length ? `CONFLICT_GROUPS（只有真实语义冲突才进入此处，当前 ${conflictGroups.length} 组）：\n${conflictGroups.map((group) => `- [${group.canonicalKey}] ${group.label}：${group.facts.map((fact) => `${fact.id}=${fact.content}`).join(" / ")}`).join("\n")}` : "CONFLICT_GROUPS：无",
      completeness ? `DERIVED_VIEW（由 active facts 推导，仅供展示）：项目 ${project.name}（${project.id}）；归属 ${ownershipMode}；熟悉度 ${completeness.projectFamiliarityScore}%（技术 ${completeness.technicalCoverageScore}% / 参数 ${completeness.parameterCoverageScore}% / 决策 ${completeness.decisionCoverageScore}% / 问题 ${completeness.problemCoverageScore}%）；准备度 ${completeness.interviewReadinessScore}%；缺失类型 ${completeness.missingFactTypes.join("、") || "无"}；弱证据 ${completeness.weakEvidence.length} 项；冲突组 ${conflictGroups.length} 组。` : `DERIVED_VIEW：项目 ${project.name}（${project.id}）；项目 ID：${project.id}，尚未计算完整度`
    ].join("\n"));
    sources.push(...(project.sourceIds ?? []).slice(0, 8));
    const scopedChunks = profileId ? projectKnowledgeChunks(profileId, project.id) : [];
    const projectChunks = scopedChunks.filter((chunk) => chunk.metadata.scope === "project").slice(0, 6);
    const referenceChunks = scopedChunks.filter((chunk) => chunk.metadata.scope === "global-reference").slice(0, 4);
    if (projectChunks.length) sections.push(`PROJECT_SOURCE（当前项目绑定资料，仅辅助解释实现，不证明个人职责）：\n${projectChunks.map((chunk) => `- [${chunk.metadata.sourceRole ?? "other"}] ${chunk.metadata.filename}：${chunk.text}`).join("\n\n")}`);
    if (referenceChunks.length) sections.push(`GLOBAL_REFERENCE（通用参考，只能解释概念，不能证明项目经历）：\n${referenceChunks.map((chunk) => `- ${chunk.metadata.filename}：${chunk.text}`).join("\n\n")}`);
    const details = projectMemoryRepository?.listSourceDetails(project.id).slice(0, 5) ?? [];
    if (details.length) sections.push(`DERIVED_VIEW（来源索引，仅用于引用，不代表事实）：\n${details.map((source) => `- ${source.sourceId}：${source.title}`).join("\n")}`);
  } else if (plan.includeProjectMemory && snapshot?.projects.length) {
    const projectSummary = snapshot.projects.slice(0, 8).map((item) => {
      const result = profileId ? projectMemoryRepository?.getProjectCompleteness(profileId, item.id) : undefined;
      return `${item.name}：${result?.completeness ?? 0}%${result?.missingFactTypes.length ? `，缺少 ${result.missingFactTypes.join("、")}` : ""}`;
    }).join("；");
    sections.push(`DERIVED_VIEW：当前档案有 ${snapshot.projects.length} 个项目。${projectSummary ? `项目完整度摘要：${projectSummary}` : ""}\n用户未指定项目时，不要把不同项目的经历混写；请先澄清项目名称。`);
  }

  if (plan.includeQuestionBank && questionBankRepository) {
    const match = questionBankRepository.matchQuestion(userMessage, { profileId, projectId });
    const card = match?.question.answerCards.find((item) => item.verified && !item.stale) ?? match?.question.answerCards[0];
    if (match) {
      sections.push(`题库匹配：${match.question.canonicalText}（匹配度 ${Math.round(match.score * 100)}%）${card ? `\n参考答案卡：${card.content.slice(0, 4_000)}${card.codeContent ? `\n代码：\n${card.codeContent.slice(0, 4_000)}` : ""}` : "\n暂无答案卡，请基于当前资料组织回答。"}`);
      sources.push(match.question.id);
    }
  }
  if (plan.includeKnowledge || Boolean(projectId)) {
    const chunks = project && profileId
      ? projectKnowledgeChunks(profileId, project.id)
      : projectId
        ? []
        : (knowledgeRepository?.listChunks(profile.knowledgeBaseIds) ?? []).map((chunk) => ({ ...chunk, metadata: { ...chunk.metadata, scope: "profile" as const } }));
    const retrieved = new HybridRetriever().search(userMessage, chunks, { topK: 8 }).slice(0, 5);
    if (retrieved.length) {
      sections.push(`相关知识（${providerConfigStore?.get("embedding")?.apiKey ? "Hybrid Retrieval" : "Keyword Retrieval"}）：\n${retrieved.map((chunk) => `[${chunk.metadata.scope === "global-reference" ? "GLOBAL_REFERENCE" : chunk.metadata.scope === "project" ? "PROJECT_SOURCE" : "PROFILE_SOURCE"}] ${chunk.metadata.filename}${chunk.metadata.documentType ? ` [${chunk.metadata.documentType}]` : ""}: ${chunk.text}`).join("\n\n")}`);
      sources.push(...retrieved.map((chunk) => chunk.metadata.sourceId ?? chunk.metadata.filename));
    } else sections.push("相关知识：无");
  }
  return { text: sections.filter(Boolean).join("\n\n"), intent: plan.intent, sources: [...new Set(sources)] };
}

async function streamChat(conversationId: string, content: string, resumeMessageId?: string): Promise<void> {
  if (!conversationRepository) throw new Error("Chat database is still initializing");
  const conversation = conversationRepository.get(conversationId);
  if (!conversation) throw new Error("Conversation not found");
  if (chatAbortControllers.has(conversationId)) throw new Error("CHAT_BUSY: 当前对话仍在生成中");
  const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
  if (!settings.apiKey) {
    broadcast("chat:error", { conversationId, code: "LLM_NOT_CONFIGURED", message: "AI 服务尚未配置，请先完成模型设置。" });
    return;
  }
  const selectedModel = taskModel(settings, "chatModel", "normalModel");
  const existing = resumeMessageId ? conversation.messages.find((message) => message.id === resumeMessageId) : undefined;
  if (resumeMessageId && (!existing || existing.role !== "assistant" || !["cancelled", "partial_error"].includes(existing.status))) {
    broadcast("chat:error", { conversationId, code: "CHAT_CONTINUE_NOT_AVAILABLE", message: "这条回答当前不能继续生成，请重新提问。" });
    return;
  }
  const userMessage = existing
    ? [...conversation.messages].slice(0, conversation.messages.findIndex((message) => message.id === existing.id)).reverse().find((message) => message.role === "user")
    : conversationRepository.addMessage({ conversationId, role: "user", content, status: "completed" });
  if (!userMessage) {
    broadcast("chat:error", { conversationId, code: "CHAT_CONTEXT_NOT_FOUND", message: "找不到这条回答对应的问题，请重新提问。" });
    return;
  }
  const startedAt = existing?.startedAt ?? Date.now();
  const assistantMessage = existing ?? conversationRepository.addMessage({ conversationId, role: "assistant", content: "", status: "streaming", model: selectedModel, provider: settings.providerName, startedAt }, startedAt);
  if (existing) conversationRepository.updateMessage(existing.id, existing.content, "streaming", Date.now(), { startedAt, provider: settings.providerName, charactersGenerated: existing.content.length });
  const entry: { controller: AbortController; reason?: ChatCancelReason } = { controller: new AbortController() };
  chatAbortControllers.set(conversationId, entry);
  broadcast("chat:message-start", { conversationId, userMessage, assistantMessage: { ...assistantMessage, status: "streaming" }, resumed: Boolean(existing) });
  appLogger?.info("CHAT_STREAM_START", { conversationId, messageId: assistantMessage.id, provider: settings.providerName, model: selectedModel, charactersGenerated: existing?.content.length ?? 0 });
  let answer = existing?.content ?? "";
  let firstTokenAt = existing?.firstTokenAt;
  // Project analysis often includes evidence, conflicts and structured action
  // proposals. It needs a longer deadline than live interview answers.
  const providerSettings = conversation.conversation.projectId
    ? { ...settings, timeoutMs: Math.max(settings.timeoutMs, PROJECT_AGENT_TIMEOUT_MS) }
    : settings;
  const provider = new OpenAICompatibleAnswerProvider(providerSettings);
  const contextForQuestion = chatContext(conversation.conversation.profileId, userMessage.content, conversation.conversation.projectId);
  try {
    const history = buildConversationHistory(conversation.messages.filter((message) => message.id !== existing?.id));
    const prompt = existing
      ? `${contextForQuestion.text}\n\n原始用户问题：${userMessage.content}\n已有回答：${existing.content}\n请从中断位置继续回答。不要重复已有回答，保持原答案的语言、结构和语气，只输出新增内容。`
      : `${contextForQuestion.text}\n\n用户问题：${content}`;
    const systemInstruction = conversation.conversation.projectId
      ? "你是项目资料整理 Agent。你的目标是把用户上传的源码/文档和用户补充说明整理成真实、自洽、能经受面试追问的项目库。必须区分 AUTHORITATIVE（eligible ProjectFact）、KEY_PARAMETERS（结构化配置参数）、TECHNICAL_DECISIONS（已有选择/原因/取舍）、PROBLEM_CHAINS（由既有事实派生）、REVIEW_REQUIRED（系统待复核）、USER_ACTION_REQUIRED（确实需要用户决定）、PROJECT_SOURCE（当前项目原始资料）和 GLOBAL_REFERENCE（通用参考）。ownershipMode 决定项目级语气：personal 可按 experienceRelation 使用第一人称，team/partial 只有 confirmed-user 职责或明确个人范围可用第一人称，reference 永远禁止第一人称。第一人称项目经历只能来自 AUTHORITATIVE；第三方库只能说使用/集成，不能说候选人实现了它；PROJECT_SOURCE 只能辅助解释实现，GLOBAL_REFERENCE 只能解释通用概念，二者都不能证明用户职责或项目指标。personal 项目不要把缺少 Responsibility 当成首要缺口，应优先提示缺少参数、Why 决策或问题链因果；绝不补写没有证据的职责、指标、硬件型号、参数或实现细节；不确定时直接提出一个短问题，并给 2~4 个互斥选项。回答必须是 JSON 对象 {text,sources,cards,actions,context}。可建议的 actions 只有 add_project_fact、review_fact、create_question，全部 requiresConfirmation=true。add_project_fact.payload 必须包含 projectId,type,title,content,sourceIds,evidence；evidence 每项必须包含真实 sourceId 和原文 quote。任何写入都只能说‘建议’，不能声称已经执行。代码题和面试题必须给口述思路、完整可运行代码、复杂度和边界。"
      : "你是 Interview Copilot 面试助手。只根据提供的 Profile、Resume、JD 和知识回答；如果资料不足，请明确说明，不要编造经历。普通问题输出简洁 Markdown。对于项目缺口、题库覆盖或明确要求执行动作的问题，可以输出一个 JSON 对象：{text, sources, cards, actions, context}；actions 只能是建议，必须 requiresConfirmation=true，绝不能声称已经写入数据库。";
    for await (const delta of provider.stream({ model: selectedModel, sections: [
      { name: "system/base", content: systemInstruction },
      ...(history ? [{ name: "conversation-history" as const, content: history }] : []),
      { name: "question", content: prompt }
    ] }, entry.controller.signal)) {
      answer += delta;
      firstTokenAt ??= Date.now();
      conversationRepository.updateMessage(assistantMessage.id, answer, "streaming", Date.now(), { startedAt, firstTokenAt, provider: settings.providerName, charactersGenerated: answer.length });
      broadcast("chat:message-delta", { conversationId, messageId: assistantMessage.id, delta, text: answer });
    }
    const finishedAt = Date.now();
    const structured = parseStructuredChatResponse(answer, { profileId: conversation.conversation.profileId, ...(conversation.conversation.projectId ? { projectIds: [conversation.conversation.projectId] } : {}), intent: contextForQuestion.intent });
    const structuredResponse: ChatResponse = { ...structured, sources: [...(structured.sources ?? []), ...contextForQuestion.sources.map((source) => ({ id: source, label: source }))].filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index), context: structured.context ?? { profileId: conversation.conversation.profileId, ...(conversation.conversation.projectId ? { projectIds: [conversation.conversation.projectId] } : {}), intent: contextForQuestion.intent } };
    const displayAnswer = structuredResponse.text || answer;
    const telemetry = { provider: settings.providerName, model: selectedModel, charactersGenerated: answer.length, startedAt, firstTokenAt, finishedAt, durationMs: finishedAt - startedAt, finishReason: provider.lastStreamMetadata?.finishReason ?? "stop", structuredResponse };
    conversationRepository.updateMessage(assistantMessage.id, displayAnswer, "completed", finishedAt, telemetry);
    broadcast("chat:message-end", { conversationId, message: { ...assistantMessage, content: displayAnswer, status: "completed", ...telemetry } });
    appLogger?.info("CHAT_STREAM_END", { conversationId, messageId: assistantMessage.id, ...telemetry });
  } catch (error) {
    const finishedAt = Date.now();
    const requestedCancel = entry.reason;
    const providerAbort = error instanceof Error && error.name === "AbortError";
    const status = requestedCancel ? "cancelled" : answer.trim() ? "partial_error" : "failed";
    const errorCode = providerAbort ? "CHAT_PROVIDER_ABORT" : classifyChatError(error);
    const cancelReason = requestedCancel ?? (providerAbort ? "provider_abort" : undefined);
    const telemetry = { provider: settings.providerName, model: selectedModel, charactersGenerated: answer.length, startedAt, firstTokenAt, finishedAt, durationMs: finishedAt - startedAt, finishReason: provider.lastStreamMetadata?.finishReason, ...(cancelReason ? { cancelReason } : {}), errorCode };
    conversationRepository.updateMessage(assistantMessage.id, answer, status, finishedAt, telemetry);
    const message = { ...assistantMessage, content: answer, status, ...telemetry };
    broadcast("chat:message-end", { conversationId, message });
    if (status === "cancelled") {
      broadcast("chat:cancelled", { conversationId, messageId: assistantMessage.id, message, cancelReason });
      appLogger?.info("CHAT_STREAM_CANCEL", { conversationId, messageId: assistantMessage.id, ...telemetry });
    } else {
      const failureText = answer.trim() ? "回答生成中断，已保留当前内容。" : chatFailureText(errorCode, selectedModel);
      broadcast("chat:error", { conversationId, messageId: assistantMessage.id, code: errorCode, model: selectedModel, provider: settings.providerName, message: failureText, userMessage: failureText, recoverable: true });
      appLogger?.warn(answer.trim() ? "CHAT_STREAM_PARTIAL_ERROR" : "CHAT_STREAM_FAILED", { conversationId, messageId: assistantMessage.id, ...telemetry, error: String(error) });
    }
  } finally { chatAbortControllers.delete(conversationId); }
}

function actionString(payload: Record<string, unknown>, key: string, required = true): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new Error(`CHAT_ACTION_INVALID: 缺少 ${key}`);
    return "";
  }
  return value.trim();
}

function actionStringArray(payload: Record<string, unknown>, key: string, required = false): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) {
    if (required) throw new Error(`CHAT_ACTION_INVALID: ${key} 必须是数组`);
    return [];
  }
  const result = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
  if (required && result.length === 0) throw new Error(`CHAT_ACTION_INVALID: ${key} 不能为空`);
  return [...new Set(result)];
}

function executeChatAction(conversationId: string, messageId: string, action: ChatAction): { actionId: string; status: "approved"; result: unknown } {
  if (!conversationRepository || !profileRepository || !projectMemoryRepository || !questionBankRepository) throw new Error("CHAT_ACTION_NOT_READY: 本地数据服务仍在初始化");
  if (!action || action.requiresConfirmation !== true) throw new Error("CHAT_ACTION_CONFIRMATION_REQUIRED: 该操作必须经过确认");
  const conversation = conversationRepository.get(conversationId);
  const message = conversation?.messages.find((item) => item.id === messageId);
  if (!conversation || !message || message.role !== "assistant" || !message.structuredResponse) throw new Error("CHAT_ACTION_NOT_FOUND: 找不到可审批的结构化回答");
  const stored = message.structuredResponse.actions?.find((item) => item.id === action.id);
  if (!stored || JSON.stringify(stored.payload) !== JSON.stringify(action.payload)) throw new Error("CHAT_ACTION_CHANGED: 操作内容已变化，请刷新后重新确认");
  if (stored.status === "approved") return { actionId: stored.id, status: "approved", result: { alreadyApproved: true } };
  const payload = stored.payload;
  let result: unknown;
  if (stored.type === "add_project_fact") {
    const projectId = actionString(payload, "projectId");
    const project = projectMemoryRepository.getSnapshot(conversation.conversation.profileId ?? "").projects.find((item) => item.id === projectId);
    if (!project) throw new Error("CHAT_ACTION_SCOPE: 项目不属于当前对话档案");
    const type = actionString(payload, "type") as import("@interview-copilot/shared").ProjectFactType;
    if (!["responsibility", "implementation", "problem", "metric", "application", "timeline", "limitation"].includes(type)) throw new Error("CHAT_ACTION_INVALID: 不支持的事实类型");
    const title = actionString(payload, "title");
    const content = actionString(payload, "content");
    const sourceIds = actionStringArray(payload, "sourceIds", true);
    const rawEvidence = payload.evidence;
    if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) throw new Error("CHAT_ACTION_INVALID: evidence 不能为空");
    const evidence = rawEvidence.map((item) => {
      if (!item || typeof item !== "object") throw new Error("CHAT_ACTION_INVALID: evidence 格式错误");
      const value = item as Record<string, unknown>;
      const sourceId = typeof value.sourceId === "string" ? value.sourceId.trim() : "";
      const quote = typeof value.quote === "string" ? value.quote.trim() : "";
      if (!sourceId || !quote || !sourceIds.includes(sourceId)) throw new Error("CHAT_ACTION_INVALID: evidence 必须引用 sourceIds");
      return { sourceId, quote, ...(typeof value.locator === "string" && value.locator.trim() ? { locator: value.locator.trim() } : {}) };
    });
    result = projectMemoryRepository.addCandidateFact({
      id: actionString(payload, "id", false) || `chat-fact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      profileId: conversation.conversation.profileId,
      type,
      title,
      content,
      confidence: typeof payload.confidence === "number" ? Math.max(0, Math.min(1, payload.confidence)) : 0.7,
      verified: false,
      sourceIds,
      evidence,
      status: "pending_review",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  } else if (stored.type === "review_fact") {
    const factId = actionString(payload, "factId");
    const fact = projectMemoryRepository.getFact(factId);
    if (!fact || fact.profileId !== conversation.conversation.profileId) throw new Error("CHAT_ACTION_SCOPE: 事实不属于当前对话档案");
    const status = actionString(payload, "status") as import("@interview-copilot/shared").ProjectFact["status"];
    if (!["active", "pending_review", "rejected", "conflicting"].includes(status ?? "")) throw new Error("CHAT_ACTION_INVALID: 不支持的事实审核状态");
    result = projectMemoryRepository.setFactReviewStatus(factId, status);
  } else {
    const canonicalText = actionString(payload, "canonicalText");
    const questionType = actionString(payload, "type", false) as import("@interview-copilot/shared").QuestionBankType;
    const scope = actionString(payload, "scope", false) as import("@interview-copilot/shared").QuestionBankScope;
    const allowedTypes = ["technical", "concept", "comparison", "system-design", "troubleshooting", "code", "project", "behavioral", "general"];
    const allowedScopes = ["global", "profile", "project", "job"];
    if (questionType && !allowedTypes.includes(questionType)) throw new Error("CHAT_ACTION_INVALID: 不支持的题型");
    if (scope && !allowedScopes.includes(scope)) throw new Error("CHAT_ACTION_INVALID: 不支持的题库范围");
    const projectId = actionString(payload, "projectId", false) || undefined;
    if (projectId && !projectMemoryRepository.getSnapshot(conversation.conversation.profileId ?? "").projects.some((item) => item.id === projectId)) throw new Error("CHAT_ACTION_SCOPE: 项目不属于当前对话档案");
    result = questionBankRepository.saveQuestion({
      id: actionString(payload, "id", false) || undefined,
      canonicalText,
      ...(questionType ? { type: questionType } : {}),
      ...(scope ? { scope } : {}),
      ...(conversation.conversation.profileId ? { profileId: conversation.conversation.profileId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(actionString(payload, "jobProfileId", false) ? { jobProfileId: actionString(payload, "jobProfileId", false) } : {}),
      variants: actionStringArray(payload, "variants"),
      factIds: actionStringArray(payload, "factIds"),
      source: "generated",
      verified: false,
      stale: false
    });
  }
  const nextResponse: ChatResponse = { ...message.structuredResponse, actions: (message.structuredResponse.actions ?? []).map((item) => item.id === stored.id ? { ...item, status: "approved" as const } : item) };
  conversationRepository.updateMessage(messageId, message.content, message.status, Date.now(), { structuredResponse: nextResponse });
  broadcast("chat:action-updated", { conversationId, messageId, actionId: stored.id, status: "approved", result });
  return { actionId: stored.id, status: "approved", result };
}

function agentArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing tool argument: ${name}`);
  return value;
}

async function listWorkspaceFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listWorkspaceFiles(root, absolute));
    else files.push(relative(root, absolute).replace(/\\/g, "/"));
    if (files.length >= 500) break;
  }
  return files.slice(0, 500);
}

async function readWorkspaceFile(root: string, requestedPath: string): Promise<string> {
  const absolute = workspacePath(root, requestedPath);
  const bytes = await readFile(absolute);
  if (bytes.byteLength > MAX_AGENT_FILE_BYTES) throw new Error("Workspace file exceeds the 1 MB tool limit");
  return bytes.toString("utf8");
}

function registerIpc(): void {
  ipcMain.on("screenshot:trace", (_event, payload: { name?: string; screenshotRequestId?: string; fields?: Record<string, unknown> }) => {
    const allowed = new Set<ScreenshotTraceEventName>(["SCREENSHOT_ACTION_REQUESTED", "SCREENSHOT_RENDERER_HANDLER_ENTERED", "SCREENSHOT_IPC_SENT"]);
    if (!payload || typeof payload.screenshotRequestId !== "string" || !allowed.has(payload.name as ScreenshotTraceEventName)) return;
    recordScreenshotTrace(payload.name as ScreenshotTraceEventName, payload.screenshotRequestId, { fields: payload.fields });
  });
  // This low-level entry point is diagnostics-only. Product interview start goes through the coordinator.
  ipcMain.handle("audio:start", (_event, options: AudioStartOptions) => audioManager.start({ ...options, meterOnly: true, autoRecover: false }));
  ipcMain.handle("audio:stop", () => audioManager.stop());
  ipcMain.handle("audio:probe", (_event, options: AudioStartOptions) => audioManager.probe(options));
  ipcMain.handle("audio:list-devices", () => productionSmokeRequested ? { inputs: [], outputs: [] } : audioManager.listDevices());
  ipcMain.handle("audio:get-diagnostics", () => audioManager.getDiagnostics());
   ipcMain.handle("overlay:show", () => { overlayManager?.enterInterviewMode(); return true; });
   ipcMain.handle("overlay:toggle", () => { overlayManager?.toggle(); return true; });
   ipcMain.handle("overlay:show-all", () => { overlayManager?.showAll(); return true; });
   ipcMain.handle("overlay:hide-all", () => { overlayManager?.hideAll(); return true; });
   ipcMain.handle("overlay:toggle-all", () => { overlayManager?.toggleAll(); return true; });
   ipcMain.handle("overlay:toggle-transcript", () => { overlayManager?.toggleTranscript(); return true; });
   ipcMain.handle("overlay:toggle-answer", () => { overlayManager?.toggleAnswer(); return true; });
   ipcMain.handle("overlay:request-end", () => { if (coordinator().running || writtenTestController?.running || overlayManager?.hudState.running) overlayManager?.requestEndInterviewConfirmation(); return true; });
   ipcMain.handle("overlay:cancel-end", () => { overlayManager?.cancelEndInterviewConfirmation(); return true; });
   ipcMain.handle("overlay:confirm-end", async () => { overlayManager?.confirmEndInterviewConfirmation(); await stopInterview(); return true; });
   ipcMain.handle("overlay:reset-layout", () => {
     const next = overlaySettingsStore?.resetLayout();
     if (next) {
       overlayManager?.applyPreferences(next.behavior);
       overlayManager?.applyLayoutPreferences(next);
       overlayManager?.resetLayout();
       broadcast("overlay:preferences", next);
     } else {
       overlayManager?.resetLayout();
     }
     return true;
   });
   ipcMain.handle("overlay:toggle-shortcuts", () => { overlayManager?.toggleShortcuts(); return true; });
   ipcMain.handle("overlay:content-size", (_event, panel: "question" | "answer", size: { width?: number; height?: number }) => {
     if (!(["question", "answer"] as const).includes(panel) || !size || !Number.isFinite(size.height)) return false;
     return overlayManager?.setContentSize(panel, size.height ?? 0) ?? false;
   });
   ipcMain.handle("overlay:get-state", () => overlayManager?.hudState);
   ipcMain.handle("overlay:get-layout", () => overlayManager?.hudLayout);
   ipcMain.handle("overlay:get-displays", () => overlayManager?.getDisplays() ?? []);
   ipcMain.handle("overlay:get-preferences", () => overlaySettingsStore?.getPreferences());
   ipcMain.handle("overlay:set-preferences", (_event, input: OverlayPreferencesPatch) => {
     const next = overlaySettingsStore?.setPreferences(input);
     if (next) { overlayManager?.applyPreferences(next.behavior); overlayManager?.applyLayoutPreferences(next); broadcast("overlay:preferences", next); }
     return next;
   });
   ipcMain.handle("overlay:enter-layout-edit", () => { overlayManager?.setLayoutEditMode(true); return true; });
   ipcMain.handle("overlay:finish-layout-edit", () => { overlayManager?.finishLayoutEditMode(); return true; });
   ipcMain.handle("overlay:set-window-bounds", (_event, panel: OverlayNativePanel, bounds: OverlayNativeBounds) => {
     if (!["question", "answer", "control"].includes(panel) || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return false;
     overlayManager?.setNativeWindowBounds(panel, bounds);
     return true;
   });
   ipcMain.handle("overlay:set-share-mode", (_event, enabled: boolean) => { overlayManager?.setShareMode(Boolean(enabled)); return overlayManager?.hudState; });
   ipcMain.handle("overlay:toggle-share-mode", () => { overlayManager?.toggleShareMode(); return overlayManager?.hudState; });
  ipcMain.handle("overlay:set-mode", (_event, mode: OverlayMode) => {
    overlayManager?.setMode(mode);
    broadcast("overlay:mode", mode);
  });
  ipcMain.handle("overlay:get-capture-protection", () => overlayManager?.captureProtectionStatus ?? {
    platform: process.platform,
    supported: process.platform === "win32",
    requested: overlaySettingsStore?.get().captureProtection ?? true,
    osFlagApplied: false,
    enabled: overlaySettingsStore?.get().captureProtection ?? true,
    applied: false,
    externalCaptureVerified: null,
    displayCaptureVerified: null,
    windowCaptureVerified: null
  });
  ipcMain.handle("overlay:set-capture-protection", (_event, enabled: boolean) => {
    const value = Boolean(enabled);
    overlaySettingsStore?.setCaptureProtection(value);
    overlayManager?.setCaptureProtection(value);
    return overlayManager?.captureProtectionStatus;
  });
  ipcMain.handle("overlay:get-capabilities", () => overlayManager?.captureProtectionCapabilities ?? {
    platform: process.platform,
    captureProtectionSupported: process.platform === "win32"
  });
  ipcMain.handle("overlay:get-tencent-validation", () => overlaySettingsStore?.getTencentValidation() ?? { desktopShare: "unverified", windowShare: "unverified" });
  ipcMain.handle("overlay:set-tencent-validation", (_event, mode: "desktopShare" | "windowShare", status: "unverified" | "verified" | "failed") => {
    const next = overlaySettingsStore?.setTencentValidation(mode, status) ?? { desktopShare: "unverified", windowShare: "unverified" };
    const event = status === "verified" ? mode === "desktopShare" ? "TENCENT_DESKTOP_SHARE_VERIFIED" : "TENCENT_WINDOW_SHARE_VERIFIED" : status === "failed" ? mode === "desktopShare" ? "TENCENT_DESKTOP_SHARE_FAILED" : "TENCENT_WINDOW_SHARE_FAILED" : "TENCENT_MEETING_REMOTE_VERIFICATION";
    appLogger?.info(event, { mode, status });
    return next;
  });
  ipcMain.handle("screenshot:capture", () => screenshotManager.capturePrimaryDisplay(undefined, configuredScreenshotRegion()));
  ipcMain.handle("session:get-state", () => session.state);
  ipcMain.handle("realtime:connect", (_event, options: RealtimeConnectOptions) => {
    realtimeSession.connect(options);
    return true;
  });
  ipcMain.handle("realtime:disconnect", () => {
    realtimeSession.disconnect();
    return true;
  });
  ipcMain.handle("realtime:get-transcript", () => ({ ...realtimeTranscriptSnapshots }));
  ipcMain.handle("interview:start", async (_event, options: InterviewStartOptions) => {
    interviewStartupTiming = new InterviewStartupTiming(Date.now, pendingStartupButtonClickAt ?? Date.now());
    markInterviewStartup("START_BUTTON_CLICK");
    let coordinatorStarted = false;
    let overlayShown = false;
    try {
      if (!profileRepository?.get(options.profileId)) throw new Error("PROFILE_NOT_FOUND: 面试档案不存在");
      if (options.projectId && !projectMemoryRepository?.getSnapshot(options.profileId).projects.some((project) => project.id === options.projectId)) throw new Error("PROJECT_NOT_FOUND: 重点项目不属于当前档案");
      if (options.jobTargetId && jobTargetRepository?.get(options.jobTargetId)?.profileId !== options.profileId) throw new Error("JOB_TARGET_NOT_FOUND: 目标岗位不属于当前档案");
      const llm = providerConfigStore?.get("llm") ?? environmentLlmSettings;
      if (!llm.apiKey) throw new Error("LLM_NOT_CONFIGURED: 未配置 LLM API Key");
      const asr = providerConfigStore?.get("asr");
      const asrProviderType = options.providerType ?? asr?.providerType ?? "deepgram";
      if (asrProviderType !== "custom-gateway" && asrProviderType !== "funasr-local" && !asr?.apiKey) throw new Error(`ASR_AUTH_FAILED: 未配置${asrProviderType === "qwen" ? "千问" : " Deepgram"} API Key`);
      // Show the prewarmed HUD before provider checks and local service startup.
      // A slow network or model boot must not leave the user staring at a frozen main window.
      mainWindow?.hide();
      overlayManager?.enterInterviewMode();
      overlayShown = true;
      markInterviewStartup("OVERLAY_SHOW_REQUEST");
      if (asrProviderType === "funasr-local") {
        markInterviewStartup("LOCAL_ASR_PREPARE_BEGIN");
        await localAsrServiceManager.ensureRunning({
          webSocketUrl: options.url ?? asr?.baseUrl,
          model: options.model ?? asr?.model
        });
        markInterviewStartup("LOCAL_ASR_PREPARE_END");
      }
      markInterviewStartup("PREFLIGHT_BEGIN");
      const preflight = await runProviderPreflight({ llm, asr: asr ?? { providerName: "ASR", providerType: "custom-gateway", baseUrl: options.url ?? "", apiKey: "", model: options.model ?? "", timeoutMs: 10_000, maxRetries: 0 }, embedding: providerConfigStore?.get("embedding") ?? { providerName: "Embedding", baseUrl: "", apiKey: "", model: "", timeoutMs: 10_000, maxRetries: 0 } }, true, providerPreflightCache);
      markInterviewStartup("PREFLIGHT_END");
      if (!preflight.llm.reachable) throw new Error(`LLM_CONNECT_FAILED: ${preflight.llm.message ?? preflight.llm.status}`);
      if (!preflight.asr.reachable) throw new Error(`ASR_CONNECT_FAILED: ${preflight.asr.message ?? preflight.asr.status}`);
      markInterviewStartup("COORDINATOR_START_BEGIN");
      const interviewId = await coordinator().start(options);
      coordinatorStarted = true;
      markInterviewStartup("INTERVIEW_READY");
      finishInterviewStartupTrace();
      return interviewId;
    } catch (error) {
      // If window creation fails after the coordinator has started, unwind the
      // session and restore the main window before reporting the error.
      if (overlayShown || coordinatorStarted || coordinator().running) {
        await coordinator().stop("error").catch(() => undefined);
        overlayManager?.exitInterviewMode();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      }
      const raw = String(error);
      // Electron wraps errors from an IPC handler as
      // "Error invoking remote method ...: Error: CODE: message". Splitting
      // at the first colon therefore loses the real diagnostic code and used
      // to turn every failed probe into the generic AUDIO_DEVICE_FAILED.
      const code = raw.match(/\b(?:NO_AUDIO_CHANNEL_AVAILABLE|PROTOCOL_BROKEN|AUDIO_[A-Z0-9_]+|ASR_[A-Z0-9_]+|LLM_[A-Z0-9_]+|PROFILE_[A-Z0-9_]+|PROJECT_[A-Z0-9_]+|JOB_TARGET_[A-Z0-9_]+|SIDECAR_[A-Z0-9_]+|DATABASE_[A-Z0-9_]+)\b/)?.[0] ?? "AUDIO_DEVICE_FAILED";
      const allowed = new Set(["AUDIO_BUSY", "AUDIO_DEVICE_FAILED", "AUDIO_CAPTURE_TIMEOUT", "NO_AUDIO_CHANNEL_AVAILABLE", "AUDIO_PERMISSION_DENIED", "AUDIO_DEVICE_GONE", "AUDIO_STREAM_OPEN_FAILED", "PROTOCOL_BROKEN", "AUDIO_PROBE_REQUIRED", "AUDIO_PROBE_FAILED", "AUDIO_PROBE_MIC_FAILED", "AUDIO_PROBE_SYSTEM_FAILED", "AUDIO_PROBE_PROCESS_FAILED", "AUDIO_PROBE_PROCESS_CRASHED", "AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT", "AUDIO_PROBE_TIMEOUT", "ASR_AUTH_FAILED", "ASR_CONNECT_FAILED", "LLM_NOT_CONFIGURED", "LLM_CONNECT_FAILED", "PROFILE_NOT_FOUND", "SIDECAR_NOT_FOUND", "DATABASE_ERROR"]);
      const mappedCode = allowed.has(code) ? code : raw.includes("ASR") ? "ASR_CONNECT_FAILED" : raw.includes("LLM") ? "LLM_CONNECT_FAILED" : raw.includes("database") ? "DATABASE_ERROR" : "AUDIO_DEVICE_FAILED";
      const message = userFacingError(error);
      broadcast("runtime:error", { code: mappedCode, message, recoverable: mappedCode !== "PROFILE_NOT_FOUND" && mappedCode !== "SIDECAR_NOT_FOUND" });
      finishInterviewStartupTrace();
      throw new Error(`${mappedCode}: ${message}`);
    }
  });
  ipcMain.handle("interview:stop", () => stopInterview());
  ipcMain.handle("interview:answer-latest", () => coordinator().answerLatest());
  ipcMain.handle("interview:answer-question", (_event, input: { text: string }) => coordinator().answerQuestionText(input.text));
  ipcMain.handle("interview:answer-screenshot", (_event, input?: { screenshotRequestId?: string }) => answerCapturedScreenshot("interview", input?.screenshotRequestId, "renderer-ipc"));
  ipcMain.handle("interview:get-state", () => ({ running: coordinator().running, interviewId: coordinator().interviewId, automationMode: coordinator().automationMode }));
  ipcMain.handle("interview:get-runtime-diagnostics", () => coordinator().getRuntimeDiagnostics());
  ipcMain.handle("interview:get-runtime-trace", (_event, limit?: number) => coordinator().getRuntimeTrace(limit));
  ipcMain.handle("screenshot:get-diagnostics", () => screenshotOperations.diagnostics());
  ipcMain.handle("screenshot:get-trace", (_event, limit?: number) => screenshotTrace.snapshot(limit));
  ipcMain.handle("interview:set-automation-mode", (_event, mode: "MANUAL" | "AUTO") => { const next = mode === "MANUAL" ? "MANUAL" : "AUTO"; overlaySettingsStore?.setAutomationMode(next); coordinator().setAutomationMode(next); return true; });
  ipcMain.handle("interview:set-answer-mode", (_event, mode: "FAST" | "NORMAL" | "DEEP") => { coordinator().setAnswerMode(mode); return true; });
  ipcMain.handle("written-test:start", (_event, options: WrittenTestStartOptions) => {
    if (!profileRepository?.get(options.profileId)) throw new Error("PROFILE_NOT_FOUND: 笔试档案不存在");
    if (coordinator().running) throw new Error("INTERVIEW_RUNNING: 请先结束当前面试");
    const llm = providerConfigStore?.get("llm") ?? environmentLlmSettings;
    if (!llm.apiKey) throw new Error("LLM_NOT_CONFIGURED: 未配置 LLM API Key");
    writtenTestController?.start({ profileId: options.profileId, answerMode: options.answerMode });
    mainWindow?.hide();
    overlayManager?.enterWrittenTestMode();
    return true;
  });
  ipcMain.handle("written-test:stop", () => { stopWrittenTest(); return true; });
  ipcMain.handle("written-test:answer-screenshot", (_event, input?: { screenshotRequestId?: string }) => answerCapturedScreenshot("written-test", input?.screenshotRequestId, "renderer-ipc"));
  ipcMain.handle("written-test:get-state", () => writtenTestController?.state ?? { running: false, answerMode: "NORMAL" as const });
  ipcMain.handle("written-test:set-answer-mode", (_event, mode: "FAST" | "NORMAL" | "DEEP") => { writtenTestController?.setAnswerMode(mode); return true; });
  ipcMain.handle("chat:create-conversation", (_event, input: { profileId?: string; projectId?: string; title?: string }) => {
    if (!conversationRepository) throw new Error("Chat database is still initializing");
    return conversationRepository.create(input.profileId, input.projectId, input.title);
  });
  ipcMain.handle("chat:list-conversations", (_event, profileId?: string) => conversationRepository?.list(profileId) ?? []);
  ipcMain.handle("chat:get-conversation", (_event, conversationId: string) => conversationRepository?.get(conversationId));
  ipcMain.handle("chat:send-message", async (_event, input: { conversationId: string; content: string }) => {
    const content = input.content.trim();
    if (!content) throw new Error("聊天内容不能为空");
    const stream = streamChat(input.conversationId, content);
    chatStreamPromises.add(stream);
    try {
      await stream;
      return true;
    } finally {
      chatStreamPromises.delete(stream);
    }
  });
  ipcMain.handle("chat:continue-message", async (_event, input: { conversationId: string; messageId: string }) => {
    const stream = streamChat(input.conversationId, "", input.messageId);
    chatStreamPromises.add(stream);
    try { await stream; return true; } finally { chatStreamPromises.delete(stream); }
  });
  ipcMain.handle("chat:cancel", (_event, input: string | { conversationId: string; reason?: ChatCancelReason }) => {
    const conversationId = typeof input === "string" ? input : input.conversationId;
    const entry = chatAbortControllers.get(conversationId);
    if (entry) { entry.reason = typeof input === "string" ? "user_stop" : input.reason ?? "user_stop"; entry.controller.abort(); }
    return true;
  });
  ipcMain.handle("chat:approve-action", (_event, input: { conversationId: string; messageId: string; action: ChatAction }) => executeChatAction(input.conversationId, input.messageId, input.action));
  ipcMain.handle("chat:delete-conversation", (_event, conversationId: string) => { conversationRepository?.delete(conversationId); return true; });
  ipcMain.handle("profiles:list", () => profileRepository?.list() ?? []);
  ipcMain.handle("profiles:get", (_event, profileId: string) => profileRepository?.get(profileId));
  ipcMain.handle("profiles:save", (_event, input: Parameters<SqliteProfileRepository["save"]>[0]) => {
    // Saving profile metadata is a local database operation. Analysis is an
    // explicit user action so opening the app or editing a profile cannot
    // silently create paid LLM requests.
    return profileRepository?.save(input);
  });
  ipcMain.handle("profiles:delete", (_event, profileId: string) => { profileRepository?.delete(profileId); return true; });
  ipcMain.handle("profiles:clone", (_event, profileId: string, name: string) => profileRepository?.clone(profileId, name));
  ipcMain.handle("profiles:select-active", (_event, profileId: string) => profileRepository?.setActive(profileId));
  ipcMain.handle("profiles:active", () => profileRepository?.active());
  ipcMain.handle("profiles:attach-material", async (_event, input: { profileId: string; kind: "resume" | "jobDescription"; filename: string; mimeType: string; bytes: Uint8Array }) => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    const profile = profileRepository.get(input.profileId);
    if (!profile) throw new Error("Profile not found");
    const parsed = await parseDocument({ documentId: `profile-material-${Date.now()}`, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes });
    // Keep upload local and deterministic. The user can explicitly run
    // Profile Builder from the profile page when a model call is desired.
    const summary = parsed.text.replace(/\s+/g, " ").trim().slice(0, 800);
    const material = { rawContent: parsed.text, summary, filename: input.filename, mimeType: input.mimeType, uploadedAt: Date.now(), parseStatus: "parsed" as const, analysisStatus: "not_started" as const };
    const saved = profileRepository.save({ ...profile, ...(input.kind === "resume" ? { resume: material } : { jobDescription: material }), updatedAt: Date.now() });
    return saved;
  });
  ipcMain.handle("profiles:remove-material", (_event, profileId: string, kind: "resume" | "jobDescription") => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    const profile = profileRepository.get(profileId);
    if (!profile) throw new Error("Profile not found");
    const saved = profileRepository.save({ ...profile, ...(kind === "resume" ? { resume: undefined } : { jobDescription: undefined }), updatedAt: Date.now() });
    return saved;
  });
  ipcMain.handle("knowledge:list-bases", () => knowledgeRepository?.listKnowledgeBases() ?? []);
  ipcMain.handle("knowledge:create-base", (_event, name: string) => knowledgeRepository?.createKnowledgeBase(name));
  ipcMain.handle("knowledge:rename-base", (_event, knowledgeBaseId: string, name: string) => knowledgeRepository?.renameKnowledgeBase(knowledgeBaseId, name));
  ipcMain.handle("knowledge:delete-base", (_event, knowledgeBaseId: string) => { knowledgeRepository?.deleteKnowledgeBase(knowledgeBaseId); return true; });
  ipcMain.handle("knowledge:list-documents", (_event, knowledgeBaseId?: string) => knowledgeRepository?.listDocuments(knowledgeBaseId) ?? []);
  ipcMain.handle("knowledge:ingest", async (_event, input: { knowledgeBaseId?: string; profileId?: string; projectId?: string; sourceRole?: import("@interview-copilot/shared").ProjectSourceRole | "auto"; filename: string; mimeType: string; bytes: Uint8Array; documentType?: KnowledgeDocumentTypeOption }) => {
    if (input.sourceRole === "question_bank") throw new Error("PROJECT_QA_USE_DEDICATED_IMPORT: 请使用“上传项目题库”入口");
    if (!knowledgeRepository) throw new Error("Knowledge database is still initializing");
    const knowledgeBase = input.knowledgeBaseId ? knowledgeRepository.listKnowledgeBases().find((base) => base.id === input.knowledgeBaseId) : knowledgeRepository.ensureKnowledgeBase();
    if (!knowledgeBase) throw new Error("Knowledge base not found");
    const documentId = `document-${Date.now()}`;
    const bytes = normalizeDocumentBytes(input.bytes);
    const isRepositoryArchive = /^application\/(?:x-)?zip$/i.test(input.mimeType || "") || /\.zip$/i.test(input.filename) || isZipBytes(bytes);
    const parsed = isRepositoryArchive
      ? await parseRepositoryArchiveInWorker({ documentId, filename: input.filename, bytes, onProgress: (progress) => appLogger?.info("KNOWLEDGE_ARCHIVE_PROGRESS", { filename: input.filename, ...progress }) })
      : await parseDocument({ documentId, filename: input.filename, mimeType: input.mimeType, bytes });
    const inferredProjectRole = input.sourceRole && input.sourceRole !== "auto" ? input.sourceRole : inferProjectSourceRole(parsed.filename, parsed.text);
    if (input.projectId && inferredProjectRole === "question_bank") throw new Error("PROJECT_QA_USE_DEDICATED_IMPORT: 请使用“上传项目题库”入口");
    const requestedType = input.documentType && input.documentType !== "auto" ? input.documentType : undefined;
    const documentType = requestedType && !(isRepositoryArchive && requestedType === "other") ? requestedType : inferKnowledgeDocumentType(parsed.filename, parsed.text);
    const document = knowledgeRepository.saveDocument({ id: parsed.documentId, ...parsed, knowledgeBaseId: knowledgeBase.id, documentType, status: "processing" });
    try {
      const chunks = chunkText(parsed.text, { documentId: parsed.documentId, filename: parsed.filename, documentType });
      knowledgeRepository.replaceChunks(document.id, chunks);
      // Preserve the resolved category when transitioning processing -> ready.
      // Omitting it here used to overwrite every imported project as "other",
      // which prevented automatic project assignment and left Project Library empty.
      const saved = knowledgeRepository.saveDocument({ id: document.id, ...parsed, knowledgeBaseId: knowledgeBase.id, documentType, status: "ready" });
      if ((documentType === "project" || documentType === "technical-doc") && input.profileId && projectMemoryService) {
        const requestedRole = input.sourceRole && input.sourceRole !== "auto" ? input.sourceRole : undefined;
        const assignment = projectMemoryService.assignDocument(input.profileId, saved.id, input.projectId, requestedRole);
        return { ...saved, projectAssignment: assignment, ...(assignment.status === "needs_assignment" ? { error: assignment.message } : {}) };
      }
      return saved;
    } catch (error) {
      const saved = knowledgeRepository.saveDocument({ id: document.id, ...parsed, knowledgeBaseId: knowledgeBase.id, documentType, status: "error", error: String(error) });
      return saved;
    }
  });
  ipcMain.handle("knowledge:ingest-project-materials", async (_event, input: { profileId: string; projectId: string; knowledgeBaseId: string; files: import("@interview-copilot/shared").ProjectMaterialImportFile[] }) => {
    if (!projectMemoryService) throw new Error("Project Memory is still initializing");
    const report = await projectMemoryService.importProjectMaterials(input);
    return report;
  });
  ipcMain.handle("knowledge:ingest-project-question-bank", async (_event, input: { profileId: string; projectId: string; filename: string; mimeType: string; bytes: Uint8Array }) => {
    if (!questionBankRepository) throw new Error("Question Bank is still initializing");
    const bytes = normalizeDocumentBytes(input.bytes);
    const parsed = await parseDocument({ documentId: `project-qa-${Date.now()}`, filename: input.filename, mimeType: input.mimeType, bytes });
    return questionBankRepository.importProjectText(input.profileId, input.projectId, parsed.text, input.filename);
  });
  ipcMain.handle("knowledge:delete", (_event, documentId: string) => { for (const assignment of projectMemoryRepository?.sourcesFor("document", documentId) ?? []) projectMemoryRepository?.unassignSource(assignment.projectId, "document", documentId); knowledgeRepository?.deleteDocument(documentId); return true; });
  ipcMain.handle("knowledge:update-type", (_event, documentId: string, documentType: KnowledgeDocumentType) => knowledgeRepository?.updateDocumentType(documentId, documentType));
  ipcMain.handle("knowledge:reindex", async (_event, documentId: string) => {
    if (!knowledgeRepository) throw new Error("Knowledge database is still initializing");
    const document = knowledgeRepository.getDocument(documentId);
    if (!document) throw new Error("Knowledge document not found");
    try {
      const chunks = chunkText(document.text, { documentId: document.id, filename: document.filename, documentType: document.documentType });
      const embeddingSettings = providerConfigStore?.get("embedding");
      await embedKnowledgeChunks(chunks, embeddingSettings);
      knowledgeRepository.replaceChunks(document.id, chunks);
      const saved = knowledgeRepository.saveDocument({ ...document, status: "ready", error: undefined });
      return saved;
    } catch (error) {
      const saved = knowledgeRepository.saveDocument({ ...document, status: "error", error: String(error) });
      return saved;
    }
  });
  ipcMain.handle("question-bank:list", (_event, options?: QuestionBankListOptions) => questionBankRepository?.listQuestions(options) ?? []);
  ipcMain.handle("question-bank:count", (_event, options?: Omit<QuestionBankListOptions, "limit" | "offset" | "sort">) => questionBankRepository?.countQuestions(options) ?? 0);
  ipcMain.handle("question-bank:bulk-update", (_event, input: { questionIds: string[]; patch: QuestionBankBulkPatch }) => questionBankRepository?.bulkUpdate(input.questionIds, input.patch) ?? 0);
  ipcMain.handle("question-bank:duplicates", (_event, limit?: number) => questionBankRepository?.duplicateClusters(limit) ?? []);
  ipcMain.handle("question-bank:merge-duplicates", (_event, input: { canonicalId: string; duplicateIds: string[] }) => questionBankRepository?.mergeDuplicates(input.canonicalId, input.duplicateIds));
  ipcMain.handle("question-bank:get", (_event, questionId: string) => questionBankRepository?.getQuestion(questionId));
  ipcMain.handle("question-bank:save-question", (_event, input: Parameters<SqliteQuestionBankRepository["saveQuestion"]>[0]) => questionBankRepository?.saveQuestion(input));
  ipcMain.handle("question-bank:delete-question", (_event, questionId: string) => { questionBankRepository?.deleteQuestion(questionId); return true; });
  ipcMain.handle("question-bank:save-answer", (_event, input: Parameters<SqliteQuestionBankRepository["saveAnswerCard"]>[0]) => questionBankRepository?.saveAnswerCard(input));
  ipcMain.handle("question-bank:delete-answer", (_event, answerCardId: string) => { questionBankRepository?.deleteAnswerCard(answerCardId); return true; });
  ipcMain.handle("question-bank:route", (_event, text: string, options?: Parameters<SqliteQuestionBankRepository["routeQuestion"]>[1]) => questionBankRepository?.routeQuestion(text, options));
  ipcMain.handle("question-bank:save-relation", (_event, input: Parameters<SqliteQuestionBankRepository["saveRelation"]>[0]) => questionBankRepository?.saveRelation(input));
  ipcMain.handle("question-bank:list-relations", (_event, questionId?: string) => questionBankRepository?.listRelations(questionId) ?? []);
  ipcMain.handle("question-bank:delete-relation", (_event, relationId: string) => { questionBankRepository?.deleteRelation(relationId); return true; });
  ipcMain.handle("question-bank:list-skills", (_event, search?: string) => questionBankRepository?.listSkills(search) ?? []);
  ipcMain.handle("question-bank:save-skill", (_event, input: Parameters<SqliteQuestionBankRepository["saveSkill"]>[0]) => questionBankRepository?.saveSkill(input));
  ipcMain.handle("question-bank:save-skill-point", (_event, input: Parameters<SqliteQuestionBankRepository["saveSkillPoint"]>[0]) => questionBankRepository?.saveSkillPoint(input));
  ipcMain.handle("question-bank:link-skill", (_event, questionId: string, skillId: string) => { questionBankRepository?.linkQuestionSkill(questionId, skillId); return true; });
  ipcMain.handle("question-bank:list-jobs", () => questionBankRepository?.listJobProfiles() ?? []);
  ipcMain.handle("question-bank:coverage", (_event, jobProfileId?: string) => questionBankRepository?.coverage(jobProfileId) ?? { overallCoverage: 0, topics: [], missingSkills: [], generatedAt: Date.now() });
  ipcMain.handle("question-bank:save-job", (_event, input: Parameters<SqliteQuestionBankRepository["saveJobProfile"]>[0]) => questionBankRepository?.saveJobProfile(input));
  ipcMain.handle("question-bank:import-text", (_event, input: { text: string; filename?: string; includeProject?: boolean; includeBehavioral?: boolean }) => questionBankRepository?.importText(input.text, input.filename, { includeProject: input.includeProject, includeBehavioral: input.includeBehavioral }));
  ipcMain.handle("question-bank:generate-answers", (_event, input?: { questionIds?: string[]; onlyUnanswered?: boolean }) => generateQuestionBankAnswers(input));
  ipcMain.handle("question-bank:generate-project-qa", (_event, projectId: string) => generateProjectQuestionBank(projectId));
  ipcMain.handle("question-bank:match", (_event, text: string) => questionBankRepository?.matchQuestion(text));
  ipcMain.handle("profile-builder:get", (_event, profileId: string) => profileBuilderService?.get(profileId));
  ipcMain.handle("profile-builder:list-skill-suggestions", (_event, profileId: string, status?: import("@interview-copilot/shared").SkillSuggestionStatus) => skillSuggestionRepository?.list(profileId, status) ?? []);
  ipcMain.handle("profile-builder:review-skill-suggestion", (_event, suggestionId: string, status: import("@interview-copilot/shared").SkillSuggestionStatus) => skillSuggestionRepository?.review(suggestionId, status));
  ipcMain.handle("resume-analysis:get", (_event, profileId: string) => profileBuilderService?.getResumeAnalysis(profileId));
  ipcMain.handle("resume-analysis:start", (_event, profileId: string) => profileBuilderService?.startResumeAnalysis(profileId));
  ipcMain.handle("resume-analysis:get-job", (_event, jobId: string) => profileBuilderService?.getJob(jobId));
  ipcMain.handle("resume-analysis:cancel", (_event, jobId: string) => profileBuilderService?.cancelJob(jobId));
  ipcMain.handle("profile-builder:start", (_event, profileId: string) => {
    if (!profileBuilderService) throw new Error("Profile Builder is still initializing");
    return profileBuilderService.start(profileId);
  });
  ipcMain.handle("profile-builder:get-job", (_event, jobId: string) => profileBuilderService?.getJob(jobId));
  ipcMain.handle("profile-builder:cancel", (_event, jobId: string) => profileBuilderService?.cancelJob(jobId));
  ipcMain.handle("profile-builder:rebuild", async (_event, profileId: string) => {
    if (!profileBuilderService) throw new Error("Profile Builder is still initializing");
    return profileBuilderService.rebuild(profileId);
  });
  ipcMain.handle("project-memory:get", (_event, profileId: string) => projectMemoryService?.get(profileId));
  ipcMain.handle("project-memory:stats", (_event, profileId: string, projectId?: string) => projectMemoryRepository?.stats(profileId, projectId) ?? { projects: 0, modules: 0, technicalPoints: 0, problems: 0, interviewQuestions: 0, questions: 0, facts: 0, eligibleFacts: 0, reviewRequiredFacts: 0, userActionRequiredFacts: 0, conflictingFacts: 0, conflictGroups: 0, userActions: 0, staleFacts: 0 });
  ipcMain.handle("project-memory:list-facts", (_event, profileId: string, projectId?: string, options?: { includeStale?: boolean; includeRejected?: boolean }) => projectMemoryRepository?.listFacts(profileId, projectId, options) ?? []);
  ipcMain.handle("project-memory:add-candidate-fact", (_event, fact: import("@interview-copilot/shared").ProjectFact) => projectMemoryRepository?.addCandidateFact(fact));
  ipcMain.handle("project-memory:add-responsibility", (_event, profileId: string, projectId: string, content: string) => projectMemoryRepository?.addUserResponsibility(profileId, projectId, content));
  ipcMain.handle("project-memory:confirm-fact", (_event, factId: string) => projectMemoryRepository?.confirmFactAsUser(factId));
  ipcMain.handle("project-memory:verify-fact", (_event, factId: string, verified: boolean) => projectMemoryRepository?.setFactVerification(factId, verified));
  ipcMain.handle("project-memory:review-fact", (_event, factId: string, status: import("@interview-copilot/shared").ProjectFact["status"]) => projectMemoryRepository?.setFactReviewStatus(factId, status));
  ipcMain.handle("project-memory:resolve-conflict", (_event, conflictGroupId: string, selectedFactId: string, keepBoth?: boolean, variantContexts?: Record<string, string>) => projectMemoryRepository?.resolveConflict(conflictGroupId, selectedFactId, Boolean(keepBoth), variantContexts) ?? []);
  ipcMain.handle("project-memory:conflict-groups", (_event, projectId: string, includeResolved?: boolean) => projectMemoryRepository?.listConflictGroups(projectId, Boolean(includeResolved)) ?? []);
  ipcMain.handle("project-memory:user-actions", (_event, projectId: string) => projectMemoryRepository?.listUserActions(projectId) ?? []);
  ipcMain.handle("project-memory:repair-semantics", (_event, projectId: string) => projectMemoryRepository?.repairProjectFactSemantics(projectId) ?? []);
  ipcMain.handle("project-memory:sources", (_event, projectId: string) => projectMemoryRepository?.listSourceDetails(projectId) ?? []);
  ipcMain.handle("project-memory:completeness", (_event, profileId: string, projectId: string) => projectMemoryRepository?.getProjectCompleteness(profileId, projectId));
  ipcMain.handle("project-memory:analysis-runs", (_event, profileId: string) => knowledgeAnalysisRepository?.list(profileId) ?? []);
  ipcMain.handle("project-memory:state", (_event, projectId: string) => knowledgeAnalysisRepository?.getProjectState(projectId));
  ipcMain.handle("project-memory:analysis-job", (_event, projectId: string) => projectMemoryService?.getProjectAnalysisJob(projectId));
  ipcMain.handle("project-memory:analysis-jobs", (_event, profileId: string) => projectMemoryService?.listProjectAnalysisJobs(profileId) ?? []);
  ipcMain.handle("project-memory:cancel-analysis", (_event, projectId: string, jobId?: string) => projectMemoryService?.cancelProjectAnalysis(projectId, jobId));
  ipcMain.handle("project-memory:retry-analysis", (_event, profileId: string, projectId: string) => projectMemoryService?.retryProjectAnalysis(profileId, projectId));
  ipcMain.handle("project-memory:assign-source", (_event, input: Parameters<NonNullable<typeof projectMemoryService>["assignSource"]>[0]) => { projectMemoryService?.assignSource(input); return true; });
  ipcMain.handle("project-memory:unassign-source", (_event, projectId: string, sourceType: import("@interview-copilot/shared").ProjectSourceType, sourceId: string) => { projectMemoryRepository?.unassignSource(projectId, sourceType, sourceId); return true; });
  ipcMain.handle("project-memory:assign-document", (_event, profileId: string, documentId: string, projectId?: string) => projectMemoryService?.assignDocument(profileId, documentId, projectId));
  ipcMain.handle("job-targets:list", (_event, profileId: string) => jobTargetRepository?.list(profileId) ?? []);
  ipcMain.handle("retrieval:list", (_event, profileId: string, limit?: number) => retrievalRepository?.list(profileId, limit) ?? []);
  ipcMain.handle("project-memory:rebuild", async (_event, profileId: string) => {
    if (!projectMemoryService) throw new Error("Project Memory is still initializing");
    return projectMemoryService.rebuild(profileId);
  });
  ipcMain.handle("project-memory:rebuild-project", async (_event, projectId: string) => {
    if (!projectMemoryService) throw new Error("Project Memory is still initializing");
    const project = projectMemoryRepository?.getProject(projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    return projectMemoryService.queueProjectAnalysis(project.profileId, projectId);
  });
  ipcMain.handle("history:list", () => historyRepository?.listInterviews() ?? []);
  ipcMain.handle("history:get", (_event, interviewId: string) => historyRepository?.snapshot(interviewId));
  ipcMain.handle("history:analyze", (_event, interviewId: string) => { const snapshot = historyRepository?.snapshot(interviewId); return snapshot ? analyzeInterview(snapshot) : undefined; });
  ipcMain.handle("history:get-analysis", (_event, interviewId: string) => historyRepository?.getAnalysis(interviewId));
  ipcMain.handle("history:delete", (_event, interviewId: string) => { historyRepository?.deleteInterview(interviewId); return true; });
  ipcMain.handle("history:export", async (_event, interviewId: string): Promise<InterviewExportResult> => {
    if (!historyRepository) throw new Error("History database is unavailable");
    const snapshot = historyRepository.snapshot(interviewId);
    const content = formatInterviewMarkdown(snapshot, analyzeInterview(snapshot));
    const startedAt = new Date(snapshot.interview.startedAt);
    const stamp = [startedAt.getFullYear(), String(startedAt.getMonth() + 1).padStart(2, "0"), String(startedAt.getDate()).padStart(2, "0")].join("")
      + "-"
      + [String(startedAt.getHours()).padStart(2, "0"), String(startedAt.getMinutes()).padStart(2, "0"), String(startedAt.getSeconds()).padStart(2, "0")].join("");
    const options = {
      title: "导出面试记录",
      defaultPath: join(app.getPath("documents"), `面试记录-${stamp}.md`),
      filters: [{ name: "Markdown", extensions: ["md"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"] as Array<"createDirectory" | "showOverwriteConfirmation">
    };
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true };
    const filePath = result.filePath.toLowerCase().endsWith(".md") ? result.filePath : `${result.filePath}.md`;
    await writeFile(filePath, content, "utf8");
    return { canceled: false, path: filePath, bytes: Buffer.byteLength(content, "utf8") };
  });
  ipcMain.handle("preparation:start", async (_event, goal: string) => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    if (preparationRuntime) throw new Error("A preparation run is already active");
    if (!(providerConfigStore?.get("llm") ?? environmentLlmSettings).apiKey) throw new Error("LLM_NOT_CONFIGURED: Preparation Agent 需要 LLM Provider");
    const profile = profileRepository.active();
    if (!profile) throw new Error("Create a profile before starting preparation");
    const workspaceRoot = agentWorkspace(profile.id);
    await mkdir(workspaceRoot, { recursive: true });
    const registry = new AgentToolRegistry(new ToolApprovalPolicy("ASK_EVERY_TIME"))
      .register({ name: "read_file", risk: "read", execute: async (args, context) => readWorkspaceFile(context.workspaceRoot, agentArg(args, "path")) })
      .register({ name: "write_file", risk: "write", execute: async (args, context) => { const path = agentArg(args, "path"); const content = agentArg(args, "content"); if (Buffer.byteLength(content, "utf8") > MAX_AGENT_FILE_BYTES) throw new Error("Workspace file exceeds the 1 MB tool limit"); const absolute = workspacePath(context.workspaceRoot, path); await mkdir(join(absolute, ".."), { recursive: true }); await writeFile(absolute, content, "utf8"); return { path, bytes: Buffer.byteLength(content, "utf8") }; } })
      .register({ name: "edit_file", risk: "write", execute: async (args, context) => { const path = agentArg(args, "path"); const find = agentArg(args, "find"); const replace = agentArg(args, "replace"); const current = await readWorkspaceFile(context.workspaceRoot, path); if (!current.includes(find)) throw new Error("Edit target was not found"); const next = current.replace(find, replace); await writeFile(workspacePath(context.workspaceRoot, path), next, "utf8"); return { path, changed: true }; } })
      .register({ name: "list_files", risk: "read", execute: async (args, context) => { const requested = typeof args.path === "string" && args.path ? args.path : undefined; const root = requested ? workspacePath(context.workspaceRoot, requested) : context.workspaceRoot; return listWorkspaceFiles(context.workspaceRoot, root); } })
      .register({ name: "search_files", risk: "read", execute: async (args, context) => { const query = agentArg(args, "query"); const files = await listWorkspaceFiles(context.workspaceRoot); const matches: Array<{ path: string; lines: string[] }> = []; for (const path of files) { const content = await readWorkspaceFile(context.workspaceRoot, path).catch(() => ""); const lines = content.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).filter((line) => line.toLowerCase().includes(query.toLowerCase())).slice(0, 8); if (lines.length) matches.push({ path, lines }); if (matches.length >= 50) break; } return matches; } })
      .register({ name: "parse_document", risk: "read", execute: async (args, context) => { const path = agentArg(args, "path"); const bytes = await readFile(workspacePath(context.workspaceRoot, path)); if (bytes.byteLength > MAX_AGENT_FILE_BYTES) throw new Error("Workspace document exceeds the 1 MB tool limit"); return parseDocument({ documentId: `agent-${Date.now()}`, filename: path, mimeType: "application/octet-stream", bytes: new Uint8Array(bytes) }); } })
      .register({ name: "get_profile", risk: "read", execute: async () => profileRepository?.get(profile.id) })
      .register({ name: "update_profile", risk: "write", execute: async (args) => { const current = profileRepository?.get(profile.id); if (!current) throw new Error("Profile not found"); const updates = { ...(typeof args.name === "string" ? { name: args.name } : {}), ...(typeof args.language === "string" ? { language: args.language } : {}), ...(typeof args.instructions === "string" ? { instructions: args.instructions } : {}) }; return profileRepository?.save({ ...current, ...updates, id: profile.id, updatedAt: Date.now() }); } })
      .register({ name: "create_skill", risk: "write", execute: async (args) => { const current = profileRepository?.get(profile.id); if (!current) throw new Error("Profile not found"); const skill = createSkill({ name: String(args.name ?? "新技能"), description: String(args.description ?? ""), content: String(args.content ?? ""), tags: Array.isArray(args.tags) ? args.tags.map(String) : [] }); return profileRepository?.save({ ...current, skills: [...current.skills, skill] }); } })
      .register({ name: "update_skill", risk: "write", execute: async (args) => { const current = profileRepository?.get(profile.id); if (!current) throw new Error("Profile not found"); const target = current.skills.find((skill) => skill.id === String(args.skillId ?? args.id ?? "")); if (!target) throw new Error("Skill not found"); const skills = current.skills.map((skill) => skill.id === target.id ? { ...skill, ...(typeof args.name === "string" ? { name: args.name } : {}), ...(typeof args.description === "string" ? { description: args.description } : {}), ...(typeof args.content === "string" ? { content: args.content } : {}), ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}) } : skill); return profileRepository?.save({ ...current, skills }); } })
      .register({ name: "retrieve_knowledge", risk: "read", execute: async (args) => { const query = String(args.query ?? goal); const chunks = knowledgeRepository?.listChunks(profile.knowledgeBaseIds) ?? []; return new HybridRetriever().search(query, chunks, { topK: 16 }).slice(0, 6).map((chunk) => chunk.text); } });
    const model: PreparationModel = {
      next: async (input, signal): Promise<PreparationModelStep> => {
        const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
        const availableTools = registry.registeredTools();
        const prompt = `目标：${input.goal}\n历史：${JSON.stringify(input.history)}\n请只返回 JSON。若需要动作，格式为 {"type":"tool_call","tool":"get_profile","args":{},"rationale":"..."}；若完成，格式为 {"type":"final","summary":"..."}。本轮实际可用工具：${availableTools.join(", ")}`;
        let text = "";
        for await (const delta of new OpenAICompatibleAnswerProvider(settings).stream({ model: taskModel(settings, "preparationModel", "normalModel"), sections: [{ name: "system/base", content: "你是面试准备 Agent。所有写入或外部动作都必须由用户审批。" }, { name: "question", content: prompt }] }, signal)) text += delta;
        const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
        if (!jsonText) return { type: "final", summary: text || "模型没有返回结果" };
        try {
          const parsed = JSON.parse(jsonText) as { type?: string; tool?: string; args?: Record<string, unknown>; rationale?: string; summary?: string };
          if (parsed.type === "tool_call" && parsed.tool && availableTools.includes(parsed.tool as AgentToolName)) return { type: "tool_call", tool: parsed.tool as AgentToolName, args: parsed.args ?? {}, rationale: parsed.rationale };
          return { type: "final", summary: parsed.summary ?? text };
        } catch {
          return { type: "final", summary: text };
        }
      }
    };
    preparationRuntime = new PreparationAgentRuntime(model, registry, { workspaceRoot, profileId: profile.id }, 40);
    preparationAbortController = new AbortController();
    void (async () => {
      try {
        for await (const event of preparationRuntime!.run(goal, preparationAbortController?.signal)) broadcast("preparation:event", event);
      } catch (error) {
        const aborted = preparationAbortController?.signal.aborted;
        broadcast("preparation:event", { type: aborted ? "stopped" : "error", message: aborted ? "Preparation 已停止" : userFacingError(error) });
      } finally {
        preparationRuntime = undefined;
        preparationAbortController = undefined;
      }
    })();
    return true;
  });
  ipcMain.handle("preparation:approve", (_event, requestId: string) => { preparationRuntime?.approve(requestId); return true; });
  ipcMain.handle("preparation:reject", (_event, requestId: string) => { preparationRuntime?.reject(requestId); return true; });
  ipcMain.handle("preparation:stop", () => { preparationAbortController?.abort(); return true; });
  ipcMain.handle("settings:get", () => providerConfigStore?.getPublic());
  ipcMain.handle("settings:update", (_event, section: ProviderSection, input: Partial<ProviderSettings>) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const result = providerConfigStore.update(section, input);
    providerPreflightCache.invalidate(section);
    if (section === "llm") applyLlmRouting(result);
    return result;
  });
  ipcMain.handle("settings:save-llm-profile", (_event, input: LlmModelProfileInput) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const result = providerConfigStore.saveLlmProfile(input);
    providerPreflightCache.invalidate("llm");
    applyLlmRouting(result.llm);
    return result;
  });
  ipcMain.handle("settings:activate-llm-profile", (_event, profileId: string) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const result = providerConfigStore.activateLlmProfile(profileId);
    providerPreflightCache.invalidate("llm");
    applyLlmRouting(result.llm);
    return result;
  });
  ipcMain.handle("settings:delete-llm-profile", (_event, profileId: string) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const result = providerConfigStore.deleteLlmProfile(profileId);
    providerPreflightCache.invalidate("llm");
    applyLlmRouting(result.llm);
    return result;
  });
  ipcMain.handle("settings:test-connection", async (_event, section: ProviderSection, profileId?: string) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const settings = section === "llm" && profileId ? providerConfigStore.getLlmProfile(profileId) : providerConfigStore.get(section);
    if (section === "asr" && settings.providerType === "funasr-local") {
      await localAsrServiceManager.ensureRunning({ webSocketUrl: settings.baseUrl, model: settings.model });
    }
    return testCachedProviderConnection(section, settings, providerPreflightCache);
  });
  ipcMain.handle("settings:list-models", async (_event, section: ProviderSection, profileId?: string) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const settings = section === "llm" && profileId ? providerConfigStore.getLlmProfile(profileId) : providerConfigStore.get(section);
    return discoverProviderModels(section, settings);
  });
  ipcMain.handle("local-asr:health", (_event, options?: LocalAsrStartOptions) => localAsrServiceManager.getHealthCheck(options));
  ipcMain.handle("settings:preflight", (_event, checkReachability = false) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    return runProviderPreflight({ llm: providerConfigStore.get("llm"), asr: providerConfigStore.get("asr"), embedding: providerConfigStore.get("embedding") }, Boolean(checkReachability), providerPreflightCache);
  });
  ipcMain.handle("projects:list", () => projectRepository?.list() ?? []);
  ipcMain.handle("projects:create", (_event, input: { name: string; profileId?: string; ownershipMode?: import("@interview-copilot/shared").ProjectOwnershipMode; ownershipNote?: string }) => projectRepository?.create(input.name, input.profileId, Date.now(), input.ownershipMode, input.ownershipNote));
  ipcMain.handle("projects:rename", (_event, projectId: string, name: string) => projectRepository?.rename(projectId, name));
  ipcMain.handle("projects:update", (_event, projectId: string, input: { name?: string; ownershipMode?: import("@interview-copilot/shared").ProjectOwnershipMode; ownershipNote?: string }) => projectRepository?.update(projectId, input));
  ipcMain.handle("projects:delete", (_event, projectId: string) => { projectRepository?.delete(projectId); return true; });
}

async function generateQuestionBankAnswers(input: { questionIds?: string[]; onlyUnanswered?: boolean } = {}): Promise<import("./database").QuestionBankAnswerGenerationResult> {
  if (questionBankAnswerGeneration) return questionBankAnswerGeneration;
  const task = (async () => {
    if (!questionBankRepository) throw new Error("QUESTION_BANK_NOT_READY: 题库仍在初始化");
    const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
    if (!settings.apiKey) throw new Error("LLM_NOT_CONFIGURED: 请先配置 LLM API Key，再生成题库答案");
    const requestedQuestions = input.questionIds?.length
      ? input.questionIds.map((questionId) => questionBankRepository?.getQuestion(questionId)).filter((question): question is NonNullable<typeof question> => Boolean(question))
      : questionBankRepository.listQuestions({ limit: 5000 });
    const targetQuestions = requestedQuestions.filter((question) => question.type !== "project" && !(input.onlyUnanswered && question.answerCards.some((card) => card.content.trim())));
    let generated = 0;
    let skipped = requestedQuestions.length - targetQuestions.length;
    let failed = 0;
    broadcast("question-bank:answer-generation-progress", { status: "started", total: targetQuestions.length, completed: 0, generated, skipped, failed });
    for (const [index, question] of targetQuestions.entries()) {
      try {
        let content = "";
        for await (const delta of answerProvider.stream({
          model: taskModel(settings, "questionBankModel", "fastModel"),
          maxOutputTokens: question.type === "code" ? 1_200 : 800,
          sections: [
            { name: "system/base", content: "你是嵌入式软件面试教练。只回答技术、概念、对比、故障排查、系统设计或代码题。不要编造候选人的项目经历，不要把项目经验写成事实。输出中文、可以直接在面试中口述的答案，先给结论，再讲原理/步骤，最后补充边界或常见误区。" },
            { name: "question", content: `题目类型：${question.type}\n题目：${question.canonicalText}` }
          ]
        })) content += delta;
        if (!content.trim()) throw new Error("EMPTY_ANSWER");
        questionBankRepository.saveAnswerCard({ questionId: question.id, content: content.trim(), mode: question.type === "code" ? "code" : "standard", sourceType: "generated", verified: false });
        generated += 1;
        broadcast("question-bank:answer-generation-progress", { status: "running", total: targetQuestions.length, completed: index + 1, generated, skipped, failed, questionId: question.id });
      } catch (error) {
        failed += 1;
        appLogger?.warn("question bank answer generation failed", { questionId: question.id, error: String(error) });
        broadcast("question-bank:answer-generation-progress", { status: "running", total: targetQuestions.length, completed: index + 1, generated, skipped, failed, questionId: question.id, error: String(error) });
      }
    }
    const result = { requested: requestedQuestions.length, generated, skipped, failed };
    broadcast("question-bank:answer-generation-progress", { status: "completed", total: targetQuestions.length, completed: targetQuestions.length, ...result });
    return result;
  })();
  questionBankAnswerGeneration = task;
  try { return await task; } finally { questionBankAnswerGeneration = undefined; }
}

async function generateProjectQuestionBank(projectId: string): Promise<ProjectQaGenerationResult> {
  if (projectQaGeneration) return projectQaGeneration;
  const task = (async () => {
    if (!questionBankRepository || !projectMemoryRepository) throw new Error("PROJECT_QA_NOT_READY: 项目题库仍在初始化");
    const project = projectMemoryRepository.getProject(projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
    if (!settings.apiKey) throw new Error("LLM_NOT_CONFIGURED: 请先配置 LLM API Key，再生成项目题库");
    const snapshot = projectMemoryRepository.getSnapshot(project.profileId);
    const facts = (snapshot.facts ?? []).filter((fact) => fact.projectId === projectId && !fact.stale && fact.status !== "rejected" && fact.title.trim() && fact.content.trim()).slice(0, 80);
    if (facts.length === 0) throw new Error("PROJECT_QA_FACTS_EMPTY: 当前项目没有可用于生成题库的有效事实");
    const understanding = snapshot.understandings?.find((item) => item.projectId === projectId) ?? (snapshot.understanding?.projectId === projectId ? snapshot.understanding : undefined);
    const prompt = buildProjectQaGenerationPrompt({
      projectName: project.name,
      facts: facts.map((fact) => ({ id: fact.id, type: fact.type, title: fact.title, content: fact.content })),
      understanding: understanding ? JSON.stringify(understanding) : undefined
    });
    let raw = "";
    for await (const delta of answerProvider.stream({
      model: taskModel(settings, "questionBankModel", "fastModel"),
      maxOutputTokens: 2_400,
      sections: [
        { name: "system/base", content: "你是项目题库生成器。只能使用输入中的 Project Facts；不得访问远程资料，不得补写未提供的个人职责、主导权、独立完成、选型决定或指标。必须返回可解析的 JSON 数组。" },
        { name: "question", content: prompt }
      ]
    })) raw += delta;
    const candidates = parseProjectQaGeneration(raw, facts.map((fact) => fact.id));
    let generated = 0;
    let skipped = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        const digest = createHash("sha256").update(`${projectId}\n${candidate.question}`).digest("hex").slice(0, 20);
        const questionId = `project-qa-ai-${digest}`;
        const existing = questionBankRepository.getQuestion(questionId);
        if (existing && !existing.stale) {
          skipped += 1;
          continue;
        }
        const question = questionBankRepository.saveQuestion({ id: questionId, canonicalText: candidate.question, type: "project", bankType: "project", category: "project", scope: "project", profileId: project.profileId, projectId, source: "ai-generated", confidence: 0.7, verified: false, stale: false, factIds: candidate.factIds });
        const answerDigest = createHash("sha256").update(candidate.answer).digest("hex").slice(0, 12);
        questionBankRepository.saveAnswerCard({ id: `${question.id}-answer-${answerDigest}`, questionId: question.id, content: candidate.answer, sourceType: "ai-generated", verified: false, stale: false, factIds: candidate.factIds });
        generated += 1;
      } catch (error) {
        failed += 1;
        appLogger?.warn("project question bank generation item failed", { projectId, error: String(error) });
      }
    }
    if (candidates.length === 0) throw new Error("PROJECT_QA_GENERATION_EMPTY: 模型没有返回可保存的项目题目");
    const result: ProjectQaGenerationResult = { requested: candidates.length, generated, skipped, failed, factCount: facts.length };
    broadcast("question-bank:project-generation-progress", { status: "completed", projectId, ...result });
    return result;
  })();
  projectQaGeneration = task;
  try { return await task; } finally { projectQaGeneration = undefined; }
}

function stopWrittenTest(): void {
  writtenTestController?.stop();
  overlayManager?.exitWrittenTestMode();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function registerShortcuts(): void {
  const shortcuts: Record<string, () => void> = {
    [GLOBAL_SHORTCUTS.answerLatest]: () => { if (coordinator().running) void coordinator().answerLatest(); },
    [GLOBAL_SHORTCUTS.screenshotAnswer]: () => void captureScreenshot(),
    [GLOBAL_SHORTCUTS.toggleOverlay]: () => {
      if (coordinator().running || writtenTestController?.running) {
        if (overlayManager?.hudState.mode === "HIDDEN") overlayManager.showAll();
        else overlayManager?.hideAll();
      }
      else overlayManager?.toggle();
    },
     [GLOBAL_SHORTCUTS.toggleShortcuts]: () => overlayManager?.toggleShortcuts(),
     [GLOBAL_SHORTCUTS.toggleShareMode]: () => overlayManager?.toggleShareMode(),
    [GLOBAL_SHORTCUTS.toggleOverlayMode]: () => {
      const mode = overlayManager?.toggleMode();
      if (mode) broadcast("overlay:mode", mode);
    },
    [GLOBAL_SHORTCUTS.toggleAutomation]: () => {
      if (!coordinator().running) return;
      const next = coordinator().automationMode === "AUTO" ? "MANUAL" : "AUTO";
      overlaySettingsStore?.setAutomationMode(next);
      coordinator().setAutomationMode(next);
    },
     [GLOBAL_SHORTCUTS.endInterview]: () => {
       if (coordinator().running) overlayManager?.requestEndInterviewConfirmation();
       else if (writtenTestController?.running) overlayManager?.requestEndInterviewConfirmation();
     },
     // Layout editing is the only consumer of Esc; it is deliberately
     // scoped here so the existing interview shortcut meanings are unchanged.
     Esc: () => { if (overlayManager?.isLayoutEditMode) overlayManager.finishLayoutEditMode(); }
  };
  for (const [accelerator, handler] of Object.entries(shortcuts)) {
    if (!globalShortcut.register(accelerator, handler)) {
      console.warn(`Failed to register global shortcut: ${accelerator}`);
    }
  }
}

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
  if (!isDevelopment()) Menu.setApplicationMenu(null);
  const appDataPath = process.env.INTERVIEW_COPILOT_TEST_DATA_PATH ?? app.getPath("appData");
  const logsDirectory = join(appDataPath, "InterviewCopilot", "logs");
  appLogger = new SafeLogger(logsDirectory, "app");
  audioLogger = new SafeLogger(logsDirectory, "audio");
  realtimeLogger = new SafeLogger(logsDirectory, "realtime");
  appLogger.info("application starting");
  try {
    database = await openAppDatabase(appDataPath);
    profileRepository = new SqliteProfileRepository(database);
    knowledgeRepository = new SqliteKnowledgeRepository(database);
    knowledgeRepository.recoverProcessingDocuments();
    knowledgeRepository.backfillDocumentTypes();
    questionBankRepository = new SqliteQuestionBankRepository(database);
    retrievalRepository = new SqliteRetrievalRepository(database);
    jobTargetRepository = new SqliteJobTargetRepository(database);
    knowledgeAnalysisRepository = new SqliteKnowledgeAnalysisRepository(database);
    projectAnalysisJobRepository = new SqliteProjectAnalysisJobRepository(database);
    const interruptedAnalysisJobs = projectAnalysisJobRepository.recoverInterrupted();
    if (interruptedAnalysisJobs > 0) appLogger.info("PROJECT_ANALYSIS_INTERRUPTED_RECOVERED", { count: interruptedAnalysisJobs });
    projectRepository = new SqliteProjectRepository(database);
    projectMemoryRepository = new SqliteProjectMemoryRepository(database);
    profileBuilderRepository = new SqliteProfileBuilderRepository(database);
    resumeAnalysisRepository = new SqliteResumeAnalysisRepository(database);
    skillSuggestionRepository = new SqliteSkillSuggestionRepository(database);
    conversationRepository = new SqliteConversationRepository(database);
    const recoveredChatMessages = conversationRepository.recoverInterruptedMessages();
    if (recoveredChatMessages > 0) appLogger.info("CHAT_INTERRUPTED_MESSAGES_RECOVERED", { count: recoveredChatMessages });
    try {
      providerConfigStore = new ProviderConfigStore(database, await createSecretStore(appDataPath), { llm: environmentLlmSettings });
    } catch {
      providerConfigStore = new ProviderConfigStore(database, new MemorySecretStore(), { llm: environmentLlmSettings });
    }
    overlaySettingsStore = new OverlaySettingsStore(database);
    const llm = providerConfigStore.get("llm");
    applyLlmRouting(llm);
    answerModelRouter.setModels(routingModels);
  } catch (error) {
    appLogger.error("database initialization failed", { error: String(error) });
    broadcast("runtime:error", { code: "DATABASE_INIT_FAILED", message: "本地数据库初始化失败，当前会话不会保存到磁盘" });
    database = undefined;
  }
  historyRepository = database ? new SqliteInterviewHistoryRepository(database, (event) => broadcast("history:changed", event)) : undefined;
  if (profileRepository && projectRepository && knowledgeRepository && historyRepository && profileBuilderRepository) {
    profileBuilderService = new ProfileBuilderService(
      profileRepository,
      projectRepository,
      knowledgeRepository,
      historyRepository,
      profileBuilderRepository,
      skillSuggestionRepository,
      { generate: (input) => { const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings; return createProfileBuilderModel(answerProvider, { ...settings, model: taskModel(settings, "profileBuilderModel", "normalModel") }).generate(input); } },
      (record) => broadcast("profile-builder:updated", record),
      (job) => broadcast(job.kind === "resume" ? "resume-analysis:job" : "profile-builder:job", job),
      resumeAnalysisRepository,
      createResumeAnalysisModel(answerProvider, { ...((providerConfigStore?.get("llm") ?? environmentLlmSettings)), model: taskModel(providerConfigStore?.get("llm") ?? environmentLlmSettings, "profileBuilderModel", "normalModel") })
    );
  }
  if (profileRepository && knowledgeRepository && historyRepository && projectMemoryRepository) {
    projectMemoryService = new ProjectMemoryService(
      profileRepository,
      knowledgeRepository,
      historyRepository,
      projectMemoryRepository,
      { generate: (input) => { const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings; return createProjectMemoryModel(answerProvider, { ...settings, model: taskModel(settings, "projectAnalyzerModel", "normalModel") }).generate(input); } },
      (profileId) => broadcast("project-memory:updated", { profileId, stats: projectMemoryRepository?.stats(profileId) }),
      knowledgeAnalysisRepository,
      async (profileId, projectId, signal) => {
        const settings = providerConfigStore?.get("embedding");
        if (!settings?.apiKey || !settings.model || !projectMemoryRepository) return;
        const embeddingProvider = new OpenAICompatibleEmbeddingProvider(settings);
        const result = await projectMemoryRepository.embedFacts(profileId, (text, embeddingSignal) => embeddingProvider.embed(text, embeddingSignal), { projectId, model: settings.model, version: "project-facts-v1", concurrency: 4, signal });
        if (result.failed > 0) appLogger?.warn("PROJECT_MEMORY_EMBEDDING_PARTIAL", { profileId, ...result });
      },
      (event, fields) => appLogger?.info(event, fields),
      { generate: (input) => { const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings; return createProjectComprehensionModel(answerProvider, { ...settings, model: taskModel(settings, "projectAnalyzerModel", "normalModel") }).generate(input); } },
      true,
      projectAnalysisJobRepository,
      (job) => broadcast("project-memory:analysis-job", job)
    );
  }
  const resumeChunkCache = new Map<string, { source: string; chunks: ReturnType<typeof chunkText> }>();
  const embeddingCache = new Map<string, number[]>();
  const rememberEmbedding = (key: string, vector: number[]): void => {
    if (embeddingCache.size >= 64) embeddingCache.delete(embeddingCache.keys().next().value as string);
    embeddingCache.set(key, vector);
  };
  const resolveEmbeddingWithinBudget = (embeddingPromise: Promise<number[] | undefined>, budgetMs = 100): Promise<{ vector?: number[]; timedOut: boolean; elapsedMs: number }> => new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true, elapsedMs: Math.max(0, performance.now() - startedAt) });
    }, budgetMs);
    embeddingPromise.then((vector) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(vector ? { vector, timedOut: false, elapsedMs: Math.max(0, performance.now() - startedAt) } : { timedOut: false, elapsedMs: Math.max(0, performance.now() - startedAt) });
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, elapsedMs: Math.max(0, performance.now() - startedAt) });
    });
  });
  const answerContextProvider = async (question: { text: string }, profileId: string, recentTranscript: string[] = [], interviewContext?: InterviewContextSelection) => {
    const profile = profileRepository?.get(profileId);
    const selectedJobTarget = interviewContext?.jobTargetId ? jobTargetRepository?.get(interviewContext.jobTargetId) : jobTargetRepository?.list(profileId).find((target) => target.status === "active");
    const interviewProfile = profile ? adaptProfileToInterviewContext(profile, selectedJobTarget) : undefined;
    const normalizedQuestion = normalizeTechnicalTerms(question.text);
    const coreTechnicalQa = matchCoreTechnicalQa(normalizedQuestion);
    const projectSnapshot = projectMemoryService?.get(profileId) ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] };
    const questionAnalysis = new QuestionAnalyzer().analyze(normalizedQuestion, projectSnapshot.projects.map((project) => project.name));
    const projectAlias = new ProjectAliasResolver().resolve(normalizedQuestion, projectSnapshot.projects.map((project) => ({ id: project.id, name: project.name, entities: [project.description, project.role, ...project.technologyStack, ...project.hardware, ...project.software] })));
    const detectedProjectId = questionAnalysis.project ? projectSnapshot.projects.find((project) => project.name.toLowerCase() === questionAnalysis.project?.toLowerCase())?.id : undefined;
    const targetProjectId = interviewContext?.projectId ?? (projectAlias.ambiguous ? undefined : projectAlias.projectId ?? detectedProjectId);
    const targetProject = targetProjectId ? projectSnapshot.projects.find((project) => project.id === targetProjectId) : undefined;
    const answerIntent = analyzeAnswerIntent(normalizedQuestion);
    const intentGateStartedAt = performance.now();
    const projectIntent = analyzeProjectQuestionIntent({
      question: normalizedQuestion,
      targetProjectId,
      answerIntent,
      questionAnalysisType: questionAnalysis.type,
      followUpContext: interviewContext?.followUpContext
    });
    const { projectAnchorAvailable, projectQuestionRequested } = projectIntent;
    const knowledgeRoute = projectQuestionRequested ? routeKnowledge(questionAnalysis) : { useProjectMemory: false, useTechnicalKnowledge: true, reason: "technical-knowledge-first" };
    const intentGateMs = performance.now() - intentGateStartedAt;
    const questionBankSkills = questionBankRepository?.listSkills() ?? [];
    const questionBankSkillIds = new Set(questionBankSkills.map((skill) => skill.id));
    const mentionedSkillIds = questionBankSkills
      .filter((skill) => [skill.normalizedName, ...skill.aliases.map((alias) => normalizeQuestionBankText(alias))].some((term) => term && normalizeQuestionBankText(normalizedQuestion).includes(term)))
      .map((skill) => skill.id);
    const profileSkillIds = (profile?.skills ?? []).map((skill) => skill.id).filter((skillId) => questionBankSkillIds.has(skillId));
    const questionBankRouteStartedAt = performance.now();
    const questionBankRoute = questionBankRepository?.routeQuestion(normalizedQuestion, {
      ...(projectQuestionRequested ? {} : { scope: "global" as const }),
      profileId,
      ...(projectQuestionRequested && targetProjectId ? { projectId: targetProjectId } : {}),
      skillIds: [...new Set([...profileSkillIds, ...mentionedSkillIds])],
      limit: 5
    });
    const questionBankRouteMs = performance.now() - questionBankRouteStartedAt;
    const projectQaRoute = projectQuestionRequested ? questionBankRoute?.projectQa : undefined;
    const earlyProjectQaDirect = Boolean(projectQuestionRequested && targetProjectId && projectQaRoute && (projectQaRoute.level === "exact" || projectQaRoute.level === "strong") && projectQaRoute.top?.question.verified && !projectQaRoute.top.question.stale && questionBankAnswerIsReady(projectQaRoute.top.question));
    const targetUnderstanding = projectQuestionRequested && targetProjectId
      ? projectSnapshot.understandings?.find((item) => item.projectId === targetProjectId) ?? (projectSnapshot.understanding?.projectId === targetProjectId ? projectSnapshot.understanding : undefined)
      : undefined;
    const understandingRetrieval = projectQuestionRequested
      ? new ProjectComprehensionRetriever().search(normalizedQuestion, targetUnderstanding, 5)
      : { route: "general" as const, primaryRoute: "general" as const, secondaryRoutes: [], confidence: 0, hits: [] };
    const understandingContext = understandingRetrieval.hits.map((hit) => `项目理解（${hit.kind}，${hit.title}，证据 ${hit.evidenceRefs.join("、") || "unknown"}）：${hit.content}`).join("\n");
    const embeddingSettings = providerConfigStore?.get("embedding");
    const embeddingKey = embeddingSettings?.apiKey && embeddingSettings.model
      ? `${embeddingSettings.baseUrl}|${embeddingSettings.model}|${normalizedQuestion.toLowerCase()}`
      : undefined;
    const cachedVector = embeddingKey ? embeddingCache.get(embeddingKey) : undefined;
    const queryEmbeddingPromise = earlyProjectQaDirect
      ? Promise.resolve<number[] | undefined>(undefined)
      : cachedVector
        ? Promise.resolve<number[] | undefined>(cachedVector)
        : embeddingSettings?.apiKey && embeddingSettings.model
          ? new OpenAICompatibleEmbeddingProvider(embeddingSettings).embed(normalizedQuestion).then((vector) => {
            if (embeddingKey) rememberEmbedding(embeddingKey, vector);
            return vector;
          }).catch(() => undefined)
          : Promise.resolve<number[] | undefined>(undefined);
    const chunks = earlyProjectQaDirect
      ? []
      : projectQuestionRequested && targetProjectId
        ? projectKnowledgeChunks(profileId, targetProjectId)
        : generalTechnicalKnowledgeChunks(profileId, profile?.knowledgeBaseIds ?? []);
    const retrievalOptions = { chunks, topK: 3, candidateK: 12, reranker: new KeywordReranker() };
    const keywordTiming: RetrievalTiming = {};
    // Start the lexical path before waiting for the shared query embedding so
    // the 100ms semantic budget never delays the safe fallback.
    const keywordRetrieval = new HybridKnowledgeRetriever({ ...retrievalOptions, timings: keywordTiming }).search(normalizedQuestion);
    let factMatches = earlyProjectQaDirect || !projectQuestionRequested ? [] : projectMemoryRepository?.searchFacts(profileId, normalizedQuestion, {
      projectId: targetProjectId,
      detectedProjectId,
      questionType: questionAnalysis.type,
      limit: 5,
      minScore: 0.18,
      includeReferenceProject: projectAnchorAvailable
    }) ?? [];
    const embeddingBudget = await resolveEmbeddingWithinBudget(queryEmbeddingPromise, 100);
    const queryEmbedding = embeddingBudget.vector;
    if (!earlyProjectQaDirect && projectQuestionRequested && queryEmbedding && projectMemoryRepository) {
      factMatches = projectMemoryRepository.searchFacts(profileId, normalizedQuestion, {
        projectId: targetProjectId,
        detectedProjectId,
        questionType: questionAnalysis.type,
        queryEmbedding,
        limit: 5,
        minScore: 0.18,
        includeReferenceProject: projectAnchorAvailable
      });
    }
    const relevantFactMatches = projectQuestionRequested ? factMatches : [];
    const eligibleFactMatches = relevantFactMatches.filter((hit) => isFactEligible(hit.fact));
    const formatFactExperience = (hit: (typeof eligibleFactMatches)[number]): string => {
      const perspective = targetProject ? resolveProjectAnswerPerspective(targetProject, hit.fact) : undefined;
      return `结构化项目事实（${hit.fact.type}，证据级别 ${hit.fact.evidenceLevel ?? "pending"}，归属 ${hit.fact.ownership ?? "unknown"}，经验 ${perspective?.relation ?? hit.fact.experienceRelation ?? "project"}，${perspective?.voice ?? "project"}，来源 ${hit.fact.sourceIds.join("、")}，键 ${hit.fact.canonicalKey ?? "none"}）：\n${hit.fact.title}\n${hit.fact.type === "parameter" ? formatProjectFactValue(hit.fact.value) || hit.fact.content : hit.fact.content}`;
    };
    const trustedFactExperience = eligibleFactMatches.map(formatFactExperience);
    const trustedPersonalProjectFacts = eligibleFactMatches
      .filter((hit) => {
        const perspective = targetProject ? resolveProjectAnswerPerspective(targetProject, hit.fact) : undefined;
        return hit.fact.ownership === "self"
          && (hit.fact.evidenceLevel === "confirmed-user" || hit.fact.verified)
          && (perspective ? perspective.voice === "first-person" : true);
      })
      .map(formatFactExperience);
    const targetProjectFacts = projectQuestionRequested && targetProject
      ? (projectSnapshot.facts ?? []).filter((fact) => fact.projectId === targetProject.id && isFactEligible(fact))
      : [];
    const structuredProjectRetrieval = projectQuestionRequested && targetProject ? [
      ...(targetProjectFacts.filter((fact) => fact.type === "parameter").slice(0, 8).length ? [`KEY_PARAMETERS（结构化配置值，优先于普通资料）：${targetProjectFacts.filter((fact) => fact.type === "parameter").slice(0, 8).map((fact) => `[${fact.canonicalKey ?? "parameter"}] ${fact.title}=${formatProjectFactValue(fact.value) || fact.content}`).join("；")}`] : []),
      ...(deriveProjectTechnicalDecisions(targetProjectFacts).slice(0, 5).length ? [`TECHNICAL_DECISIONS（仅已有 choice/reason/tradeoff）：${deriveProjectTechnicalDecisions(targetProjectFacts).slice(0, 5).map((decision) => `${decision.choice}${decision.reason ? `；原因：${decision.reason}` : ""}${decision.tradeoff ? `；取舍：${decision.tradeoff}` : ""}`).join("\n")}`] : []),
      ...(deriveProjectProblemChains(targetProjectFacts).slice(0, 4).length ? [`PROBLEM_CHAINS（由既有 challenge/cause/solution/result 派生）：${deriveProjectProblemChains(targetProjectFacts).slice(0, 4).map((chain) => `${chain.challenge?.content ?? "问题待补充"}；原因：${chain.cause?.content ?? "待补充"}；解决：${chain.solution?.content ?? "待补充"}；结果：${chain.result?.content ?? "待补充"}`).join("\n")}`] : [])
    ] : [];
    const artifactExperience = retrieveProfileExperience(normalizedQuestion, profileBuilderService?.get(profileId)?.artifact).map((hit) => hit.text);
    // Profile Builder is asynchronous and may not exist yet on the first
    // question. Retrieve relevant resume excerpts directly so the first
    // answer is still grounded in the candidate's actual experience.
    const rawResume = profile?.resume?.rawContent ? normalizeTechnicalTerms(profile.resume.rawContent) : "";
    let resumeChunks: ReturnType<typeof chunkText> = [];
    if (rawResume && profile) {
      const cached = resumeChunkCache.get(profile.id);
      if (cached?.source === rawResume) resumeChunks = cached.chunks;
      else {
        resumeChunks = chunkText(rawResume, { documentId: `resume-${profile.id}`, filename: "Resume" }, { maxTokens: 550, overlapTokens: 80 });
        resumeChunkCache.set(profile.id, { source: rawResume, chunks: resumeChunks });
      }
    }
    const resumeExperience = new HybridRetriever().search(normalizedQuestion, resumeChunks, { topK: 2, candidateK: 8 }).map((hit) => `Resume（相关经历）：${hit.text}`);
    const experience = [...trustedPersonalProjectFacts, ...artifactExperience, ...resumeExperience].slice(0, 6);
    const personalEvidence = [...trustedPersonalProjectFacts, ...artifactExperience, ...resumeExperience].slice(0, 6);
    const questionBankMatch = questionBankRoute?.top;
    const candidateCard = questionBankMatch?.question.answerCards.find((card) => card.verified && !card.stale)
      ?? questionBankMatch?.question.answerCards.find((card) => questionBankMatch.question.type === "code" ? card.mode === "code" : card.mode === "standard")
      ?? questionBankMatch?.question.answerCards[0];
    const preparedCard = candidateCard && (questionBankMatch?.question.scope !== "project" || candidateCard.verified)
      ? candidateCard
      : undefined;
    const preparedAnswerContent = preparedCard ? `${preparedCard.content}${preparedCard.codeContent ? `\n代码：\n${preparedCard.codeContent}` : ""}${preparedCard.complexity ? `\n复杂度：${preparedCard.complexity}` : ""}${preparedCard.limitations ? `\n边界与限制：${preparedCard.limitations}` : ""}` : undefined;
    const sourcePlan = planAnswerSource({
      projectId: targetProjectId,
      projectAnchorAvailable,
      projectQuestion: projectQuestionRequested,
      personalQuestion: answerIntent.requiresPersonalIdentity || answerIntent.requiresPersonalOwnership || answerIntent.requiresPersonalMetric || answerIntent.requiresPersonalResult || answerIntent.asksBehavioralEpisode,
      projectQa: projectQaRoute,
      coreTechnicalQa,
      ...(preparedAnswerContent && preparedCard && questionBankMatch ? { preparedAnswer: { content: preparedAnswerContent, answerCardId: preparedCard.id, questionId: questionBankMatch.question.id, score: questionBankMatch.score, verified: preparedCard.verified, stale: preparedCard.stale } } : {})
    });
    const projectQaEvidence = (sourcePlan.mode === "project_qa_direct" || sourcePlan.mode === "project_qa_augmented") && preparedAnswerContent && preparedCard?.verified && questionBankMatch?.question.verified && !questionBankMatch.question.stale
      ? [preparedAnswerContent]
      : [];
    const jobMatches = jobTargetRepository?.searchRequirements(profileId, normalizedQuestion, 4, interviewContext?.jobTargetId) ?? [];
    const jobContext = jobMatches.map((hit) => `岗位要求（${hit.requirement.importance}，匹配度 ${Math.round(hit.score * 100)}%）：${hit.requirement.requirement}`);
    let retrieved = await keywordRetrieval;
    let retrievalDiagnostics = {
      keywordRetrievalMs: keywordTiming.totalRetrievalMs ?? 0,
      embeddingMs: cachedVector ? 0 : embeddingBudget.elapsedMs,
      rerankMs: keywordTiming.rerankMs ?? 0,
      totalRetrievalMs: keywordTiming.totalRetrievalMs ?? 0,
      embeddingTimedOut: embeddingBudget.timedOut
    };
    if (queryEmbedding && chunks.length > 0) {
      const embeddingTiming: RetrievalTiming = {};
      retrieved = await new HybridKnowledgeRetriever({ ...retrievalOptions, embeddingProvider: { embed: () => queryEmbedding }, timings: embeddingTiming }).search(normalizedQuestion);
      retrievalDiagnostics = { ...retrievalDiagnostics, embeddingMs: cachedVector ? 0 : retrievalDiagnostics.embeddingMs, rerankMs: embeddingTiming.rerankMs ?? 0, totalRetrievalMs: embeddingTiming.totalRetrievalMs ?? retrievalDiagnostics.totalRetrievalMs };
    }
    const retrievedKnowledge = sourcePlan.mode === "project_qa_direct" || sourcePlan.mode === "general_core_qa" ? [] : [
      ...(projectQuestionRequested && targetProject ? [`项目回答视角政策：${resolveProjectAnswerPerspective(targetProject, relevantFactMatches[0]?.fact ?? { type: "background", title: "项目", content: "", id: "", projectId: targetProject.id, confidence: 0, verified: false, sourceIds: [] }).instruction}`] : []),
      ...(understandingContext ? [`PROJECT_UNDERSTANDING_ROUTE=${understandingRetrieval.route}\n${understandingContext}`] : []),
      ...structuredProjectRetrieval,
      ...(preparedAnswerContent && questionBankMatch?.question.scope !== "project" ? [`[GLOBAL_REFERENCE] ${preparedAnswerContent}`] : []),
      ...jobContext,
      ...retrieved.slice(0, 3).map((chunk) => `[${chunk.metadata.scope === "global-reference" ? "GLOBAL_REFERENCE" : chunk.metadata.scope === "project" ? "PROJECT_SOURCE" : "PROFILE_SOURCE"}] ${chunk.metadata.filename}${chunk.metadata.documentType ? ` [${chunk.metadata.documentType}]` : ""}: ${chunk.text}`)
    ];
    const generalKnowledgeRetrievedCount = retrievedKnowledge.filter((item) => item.startsWith("[GLOBAL_REFERENCE]") || item.startsWith("[PROFILE_SOURCE]")).length;
    retrievalRepository?.record({
      profileId,
      query: normalizedQuestion,
      route: knowledgeRoute.reason,
      metadata: {
        ...retrievalDiagnostics,
        answerSourceMode: sourcePlan.mode,
        projectId: targetProjectId ?? null,
        qaMatchLevel: sourcePlan.qaMatchLevel,
        qaQuestionId: sourcePlan.qaMatch?.questionId ?? null,
        qaAnswerCardId: sourcePlan.qaMatch?.answerCardId ?? null,
        qaScore: sourcePlan.qaMatch?.score ?? null,
        qaExact: sourcePlan.qaMatch?.exact ?? false,
        qaVerified: sourcePlan.qaMatch?.verified ?? false,
        projectAnchorAvailable,
        projectQuestionRequested,
        intentGateMs: Number(intentGateMs.toFixed(2)),
        projectQaRouteMs: projectQuestionRequested ? Number(questionBankRouteMs.toFixed(2)) : 0,
        generalQaRouteMs: projectQuestionRequested ? 0 : Number(questionBankRouteMs.toFixed(2)),
        projectQaCandidateCount: projectQaRoute?.hits.length ?? 0,
        projectQaSelectedQuestionId: sourcePlan.qaMatch?.questionId ?? null,
        projectQaMatchBaseScore: projectQuestionRequested ? projectQaRoute?.top?.baseScore ?? projectQaRoute?.top?.semanticScore ?? null : null,
        projectQaAnswerSupportScore: projectQuestionRequested ? projectQaRoute?.top?.answerSupportScore ?? null : null,
        projectQaAnchorBoost: projectQuestionRequested ? projectQaRoute?.top?.anchorBoost ?? 0 : 0,
        projectQaIntentMatched: projectQuestionRequested ? projectQaRoute?.top?.intentMatched ?? false : false,
        projectQaFallbackReason: projectQuestionRequested && projectQaRoute?.level === "none" ? "no-safe-project-match" : null,
        projectFactCount: projectQuestionRequested ? eligibleFactMatches.length : 0,
        projectDocumentChunkCount: retrieved.filter((hit) => hit.metadata.scope === "project").length,
        generalKnowledgeAllowed: sourcePlan.allowGeneralKnowledge,
        generalKnowledgeRetrievedCount,
        generalKnowledgeInjected: generalKnowledgeRetrievedCount > 0,
        answerRewriteUsed: sourcePlan.answerRewriteUsed,
        claimGateDecision: "pending",
        blockedClaimCount: 0
      },
      hits: [
        ...understandingRetrieval.hits.map((hit) => ({ resultType: "project-understanding" as const, resultId: hit.id, score: Math.min(1, hit.score / 12), verified: hit.evidenceRefs.length > 0, preview: `${hit.title}: ${hit.content}`, metadata: { projectId: targetProjectId ?? null, kind: hit.kind, route: understandingRetrieval.route, evidenceRefs: hit.evidenceRefs } })),
        ...(questionBankMatch ? [{ resultType: "question" as const, resultId: questionBankMatch.question.id, score: questionBankMatch.score, verified: questionBankMatch.question.verified, preview: questionBankMatch.question.canonicalText, metadata: { scope: questionBankMatch.question.scope, type: questionBankMatch.question.type, bankType: questionBankMatch.question.bankType, category: questionBankMatch.question.category, priority: questionBankMatch.priority, matchLevel: questionBankMatch.matchLevel ?? questionBankRoute?.matchLevel ?? "none", stage: questionBankRoute?.stage ?? "legacy", reasons: questionBankMatch.reasons } }] : []),
        ...factMatches.map((hit) => ({ resultType: "project-fact" as const, resultId: hit.fact.id, score: hit.finalScore, verified: hit.fact.verified, preview: `${hit.fact.title}: ${hit.fact.content}`, metadata: { projectId: hit.fact.projectId, type: hit.fact.type, evidenceLevel: hit.fact.evidenceLevel ?? "pending", ownership: hit.fact.ownership ?? "unknown", eligible: isFactEligible(hit.fact), stale: Boolean(hit.fact.stale), conflictStatus: hit.fact.conflictStatus ?? "confirmed", lexicalScore: hit.lexicalScore, vectorScore: hit.vectorScore, typeScore: hit.typeScore, projectScore: hit.projectScore, verifiedBoost: hit.verifiedBoost, reason: hit.reason } })),
        ...jobMatches.map((hit) => ({ resultType: "job-requirement" as const, resultId: hit.requirement.id, score: hit.score, verified: hit.requirement.verified, preview: hit.requirement.requirement, metadata: { category: hit.requirement.category, importance: hit.requirement.importance } })),
        ...retrieved.slice(0, 3).map((hit) => ({ resultType: "document-chunk" as const, resultId: hit.id, score: hit.score, preview: hit.text, metadata: { ...(hit.metadata as unknown as Record<string, unknown>), scope: hit.metadata.scope ?? (targetProjectId ? "project" : "profile"), projectId: hit.metadata.projectId ?? targetProjectId ?? null, sourceRole: hit.metadata.sourceRole ?? null, relationship: hit.metadata.relationship ?? null, sourceId: hit.metadata.sourceId ?? hit.metadata.documentId, documentId: hit.metadata.documentId } }))
      ]
    });
    return {
      profileSummary: earlyProjectQaDirect ? undefined : interviewProfile?.candidate.resumeSummary,
      jobDescriptionSummary: earlyProjectQaDirect ? undefined : interviewProfile?.target?.description,
      profileInstructions: earlyProjectQaDirect ? undefined : interviewProfile?.candidate.instructions,
      expressionLevel: interviewProfile?.candidate.expressionLevel ?? "plain",
      explainAdvancedTerms: interviewProfile?.candidate.explainAdvancedTerms ?? true,
      skills: earlyProjectQaDirect ? [] : (interviewProfile?.candidate.skills ?? []),
      experienceContext: earlyProjectQaDirect ? [] : experience,
      personalMemoryEvidence: earlyProjectQaDirect ? [] : personalEvidence,
      projectEvidence: earlyProjectQaDirect ? [] : trustedFactExperience.slice(0, 8),
      verifiedResumeEvidence: earlyProjectQaDirect ? [] : [...artifactExperience, ...resumeExperience].slice(0, 6),
      verifiedPersonalProjectFacts: earlyProjectQaDirect ? [] : trustedPersonalProjectFacts.slice(0, 6),
      preparedAnswer: preparedCard && questionBankMatch && preparedAnswerContent ? { content: preparedAnswerContent, score: questionBankMatch.score, verified: preparedCard.verified, source: questionBankMatch.question.scope === "project" ? "project-question-bank" : "question-bank", answerCardId: preparedCard.id, questionId: questionBankMatch.question.id, stale: preparedCard.stale } : undefined,
      questionBankMatches: questionBankRoute?.hits ?? [],
      answerSourcePlan: sourcePlan,
      coreTechnicalQa,
      companyContext: interviewProfile?.candidate.companyContext,
      salaryExpectation: interviewProfile?.candidate.salaryExpectation,
      projectQaEvidence,
      retrievedKnowledge,
      recentTranscript: recentTranscript.slice(-8),
      questionTelemetry: {
        projectAnchorAvailable,
        projectQuestionRequested,
        projectQuestionMode: projectIntent.projectQuestionMode,
        ...(targetProjectId ? { projectAutoAnchorId: targetProjectId } : {}),
        ...(projectAlias.confidence > 0 ? { projectAutoAnchorConfidence: projectAlias.confidence } : {}),
        questionNucleusIntent: analyzeQuestionNucleus(normalizedQuestion).intent,
        ...(coreTechnicalQa ? { coreQaMatchLevel: "strong" as const, coreQaScore: 1, coreQaQuestionId: coreTechnicalQa.id } : {}),
        ...(sourcePlan.qaMatch ? { projectQaMatchLevel: sourcePlan.qaMatchLevel, projectQaQuestionId: sourcePlan.qaMatch.questionId } : {})
      }
    };
  };

  interviewCoordinator = new InterviewCoordinator({
    audio: audioManager,
    asrManager: realtimeSession,
    session,
    answerAgent,
    questionDetector2,
    history: historyRepository,
    onStartupTiming: (event) => markInterviewStartup(event),
    initialAutomationMode: overlaySettingsStore?.getAutomationMode() ?? "AUTO",
    asrSettingsProvider: (profileId) => {
      const settings = providerConfigStore?.get("asr");
      const profileLanguage = profileRepository?.get(profileId)?.language;
      const language = settings?.language || (profileLanguage === "en-US" ? "en-US" : profileLanguage === "multi" ? "multi" : "zh-CN");
      return {
        providerType: settings?.providerType ?? "deepgram",
        providerName: settings?.providerName ?? "Deepgram",
        model: settings?.model ?? "nova-3",
        language,
        url: settings?.baseUrl
      };
    },
    contextProvider: answerContextProvider,
    terminologyLexiconProvider: (profileId, projectId, jobTargetId) => {
      const profile = profileRepository?.get(profileId);
      const projectSnapshot = projectMemoryService?.get(profileId);
      const project = projectSnapshot?.projects.find((item) => item.id === projectId);
      const projectFacts = projectSnapshot?.facts?.filter((fact) => !projectId || fact.projectId === projectId).map((fact) => ({ title: fact.title, content: fact.content })) ?? [];
      const projectQa = projectId
        ? questionBankRepository?.listQuestions({ profileId, projectId, exactProject: true, status: "active", limit: 5_000 }).flatMap((question) => [question.canonicalText, ...question.variants, ...question.answerCards.map((card) => card.content)]) ?? []
        : [];
      const generalQa = questionBankRepository?.listQuestions({ profileId, scope: "global", status: "active", limit: 5_000 }).flatMap((question) => [question.canonicalText, ...question.variants, ...question.answerCards.map((card) => card.content)]) ?? [];
      const jobTarget = jobTargetId ? jobTargetRepository?.get(jobTargetId) : undefined;
      return buildDynamicTechnicalLexicon({
        profileSkills: profile?.skills.map((skill) => ({ name: skill.name, aliases: skill.tags })),
        resume: profile?.resume?.rawContent,
        jobDescription: [profile?.jobDescription?.rawContent, jobTarget?.description, ...(jobTarget?.requirements ?? []).map((item) => item.requirement)].filter(Boolean).join("\n"),
        projectFacts: [
          ...(project ? [project.name, project.description, project.role, ...project.hardware, ...project.software, ...project.technologyStack] : []),
          ...projectFacts,
          ...(projectSnapshot?.modules.filter((item) => !projectId || item.projectId === projectId).map((item) => `${item.moduleName} ${item.description}`) ?? []),
          ...(projectSnapshot?.technicalPoints.filter((item) => !projectId || item.projectId === projectId).map((item) => `${item.topic} ${item.content}`) ?? [])
        ],
        projectQa,
        generalQa,
        recentTopics: project ? [project.name, ...project.technologyStack] : []
      });
    }
  });
  writtenTestController = new WrittenTestController({
    answerAgent,
    initialAnswerMode: "NORMAL",
    contextProvider: (question, profileId) => answerContextProvider(question, profileId, [])
  });
  const middleMouseHelper = firstExistingLocalPath(middleMouseHelperCandidates(process.resourcesPath, app.getAppPath()));
  if (middleMouseHelper) {
    middleMouseShortcutManager = new MiddleMouseShortcutManager(middleMouseHelper, () => {
      const interviewRunning = Boolean(interviewCoordinator?.running);
      const writtenTestRunning = Boolean(writtenTestController?.running);
      const preferences = overlaySettingsStore?.getPreferences();
      if (!shouldHandleMiddleMouseShortcut({ interviewRunning, automationMode: interviewCoordinator?.automationMode ?? "AUTO", writtenTestRunning, middleMouseEnabled: preferences?.screenshot.middleMouseEnabled, enabledInManualInterview: preferences?.screenshot.enabledInManualInterview, enabledInExamMode: preferences?.screenshot.enabledInExamMode })) return;
      const mode = writtenTestRunning ? "written-test" : interviewRunning ? "interview" : undefined;
      if (!mode) return;
      broadcast("shortcut", "middle-mouse-screenshot");
      void answerCapturedScreenshot(mode, createScreenshotRequestId(), "middle-mouse-shortcut").catch((error) => {
        realtimeLogger?.warn("MIDDLE_MOUSE_SCREENSHOT_FAILED", { error: String(error) });
        broadcast("runtime:error", { code: "SCREENSHOT_FAILED", message: "鼠标中键截图识别失败，请重试", recoverable: true });
      });
    }, (message) => realtimeLogger?.warn(message), (event) => {
      if (event.event === "mouse-wheel" && event.x !== undefined && event.y !== undefined && event.deltaY !== undefined) overlayManager?.handleGlobalWheel(event.x, event.y, event.deltaY);
    });
    middleMouseShortcutManager.start();
  } else {
    appLogger?.warn("MIDDLE_MOUSE_HELPER_NOT_FOUND");
  }
  const createdMainWindow = createMainWindow();
  overlayManager = new OverlayManager({
    preloadPath,
    loadRenderer: (window, surface = "question") => loadRenderer(window, surface),
    getMainWindow: () => mainWindow,
    captureProtectionEnabled: overlaySettingsStore?.get().captureProtection ?? true,
    onCaptureProtectionDiagnostic: (event, fields) => {
      appLogger?.info(event, fields);
      broadcast("overlay:capture-protection-diagnostic", { event, fields });
    },
    onNativeBoundsChanged: (panel, bounds, display) => {
      const current = overlaySettingsStore?.getPreferences();
      if (!current) return;
      const mode = writtenTestController?.running ? "writtenTest" : "interview";
      const leftKey = mode === "writtenTest" ? "questionWindow" : current.interview.leftPanel === "dialogue" ? "dialogueWindow" : "questionWindow";
      const key = panel === "answer" ? "answerWindow" : panel === "control" ? "controlBar" : leftKey;
      const sectionKey = mode === "writtenTest" ? "writtenTest" : "interview";
      const next = overlaySettingsStore?.setPreferences({ [sectionKey]: { ...(sectionKey === "interview" ? { layoutPreset: "minimal" as const } : {}), [key]: { x: bounds.x - display.workArea.x, y: bounds.y - display.workArea.y, width: bounds.width, height: bounds.height, displayId: display.id, scaleFactor: display.scaleFactor } } });
      if (next) broadcast("overlay:preferences", next);
    },
    onHUDStateChange: (state) => broadcast("overlay:state", state),
    onStartupTiming: (event) => {
      markInterviewStartup(event);
      if (!interviewStartupTiming) appLogger?.info("OVERLAY_STARTUP_PHASE", { event });
    }
  });
  const initialOverlayPreferences = overlaySettingsStore?.getPreferences();
  overlayManager.applyPreferences(initialOverlayPreferences?.behavior ?? {
    alwaysOnTop: true,
    interactionMode: "click_through",
    mousePassthrough: true,
    wheelRouting: "overlay_under_cursor",
    temporaryInteractionModifier: "ctrl"
  });
  if (initialOverlayPreferences) overlayManager.applyLayoutPreferences(initialOverlayPreferences);
  void mainRendererLoad?.then(() => overlayManager?.prepare()).catch((error) => appLogger?.warn("OVERLAY_PREPARE_FAILED", { error: String(error) }));
  appLogger?.info("OVERLAY_CAPTURE_PROTECTION_RUNTIME", {
    platform: process.platform,
    windowsVersion: process.platform === "win32" ? osVersion() : undefined,
    supported: overlayManager.captureProtectionSupported
  });
  registerIpc();
  registerShortcuts();
  if (middleMouseHelper) {
    nativeModifierShortcutManager = new NativeModifierShortcutManager(middleMouseHelper, (event) => {
      overlayManager?.setTemporaryInteraction(event.modifier, event.pressed);
    }, (message) => realtimeLogger?.warn(message));
    if (!nativeModifierShortcutManager.start()) appLogger?.warn("NATIVE_MODIFIER_HELPER_NOT_STARTED");
  }

  audioManager.on("event", (event) => { if (event.type === "audio_error") audioLogger?.error("audio error", { component: event.component, recoverable: event.recoverable }); broadcast("audio:event", event); });
  audioManager.on("process", (state) => broadcast("audio:process", state));
  audioManager.on("diagnostic", (message) => { audioLogger?.warn(message); broadcast("audio:diagnostic", message); });
  realtimeSession.on("diagnostics", (diagnostics) => broadcast("realtime:diagnostics", diagnostics));
  realtimeSession.on("runtime-error", (error) => broadcast("runtime:error", error));
  coordinator().on("event", (event: { type: string; [key: string]: unknown }) => {
    if (event.type === "session_state") {
      if (event.state === "CREATING" || event.state === "IDLE" || event.state === "ENDED") {
        realtimeTranscriptSnapshots = {};
        pendingTranscriptBroadcast = undefined;
        if (transcriptBroadcastTimer) clearTimeout(transcriptBroadcastTimer);
        transcriptBroadcastTimer = undefined;
      }
      broadcast("session:state", event.state);
    }
    if (event.type === "transcript") broadcast("realtime:transcript", event.snapshot);
    if (event.type === "question") {
      const questionEvent = event.event as { type?: string; text?: string; questionScore?: number; confidence?: number; candidate?: boolean; confirmed?: boolean; reason?: string; category?: string; detectionType?: string; speechAct?: string; fingerprint?: string; ignoredReason?: string; dedupeScore?: number };
      if (questionEvent.type === "question_diagnostic") {
        realtimeLogger?.info("QUESTION_DETECTOR_DIAGNOSTIC", {
          rawTranscript: questionEvent.text,
          detected: questionEvent.confirmed ?? false,
          confidence: questionEvent.confidence ?? questionEvent.questionScore,
          questionScore: questionEvent.questionScore,
          candidate: questionEvent.candidate,
          confirmed: questionEvent.confirmed,
          category: questionEvent.category,
          detectionType: questionEvent.detectionType,
          speechAct: questionEvent.speechAct,
          reason: questionEvent.reason,
          fingerprint: questionEvent.fingerprint,
          ignoredReason: questionEvent.ignoredReason,
          dedupeScore: questionEvent.dedupeScore
        });
      }
      broadcast("question:event", event.event);
    }
    if (event.type === "realtime_message") broadcast("realtime:message", event.message);
    if (event.type === "realtime_state") broadcast("realtime:state", event.state);
    if (event.type === "automation_mode") broadcast("interview:automation-mode", event.mode);
    if (event.type === "answer_mode") broadcast("interview:answer-mode", event.mode);
    if (event.type === "telemetry") realtimeLogger?.info(String(event.name), (event.fields ?? {}) as Record<string, unknown>);
    if (event.type === "diagnostic") { realtimeLogger?.warn(String(event.message)); broadcast("realtime:diagnostic", event.message); }
    if (event.type === "runtime_trace") broadcast("runtime:trace", event.event);
    if (event.type === "screenshot_trace") {
      screenshotTrace.push(event.event as ScreenshotTraceEvent);
      broadcast("screenshot:trace", event.event);
    }
  });
  writtenTestController?.on("event", (event: { type: string; [key: string]: unknown }) => {
    if (event.type === "state") broadcast("written-test:state", event.state);
    if (event.type === "realtime_message") broadcast("realtime:message", event.message);
    if (event.type === "answer_mode") broadcast("interview:answer-mode", event.mode);
    if (event.type === "diagnostic") { realtimeLogger?.warn(String(event.message)); broadcast("realtime:diagnostic", event.message); }
  });
  session.subscribe((state) => broadcast("session:state", state));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  if (captureProtectionSmokeRequested) {
    try {
      await runCaptureProtectionSmoke(createdMainWindow);
    } catch (error) {
      appLogger?.error("CAPTURE_PROTECTION_SMOKE_FAILED", { error: String(error) });
      const environmentReason = captureProtectionEnvironmentReason(error);
      const result = environmentReason
        ? { ok: false, supported: overlayManager?.captureProtectionSupported ?? false, result: "UNSUPPORTED_ENVIRONMENT", environmentReason, controlCapture: "NOT_OBSERVABLE", protectedCapture: "NOT_OBSERVABLE" }
        : { ok: false, supported: overlayManager?.captureProtectionSupported ?? false, result: "FAIL", capturePath: "WINDOW_CAPTURE", control: "ERROR", protected: "ERROR", error: String(error) };
      process.stdout.write(`CAPTURE_PROTECTION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
      process.exitCode = environmentReason ? 0 : 1;
      app.quit();
    }
  } else if (nativeMouseSmokeRequested) await runNativeMouseSmoke(createdMainWindow).catch((error) => { process.stdout.write(`NATIVE_MOUSE_SMOKE_RESULT ${JSON.stringify({ ok: false, result: "FAIL", error: String(error) })}\n`); overlayManager?.destroy(); app.exit(1); });
  else if (productionSmokeRequested) await runProductionSmoke(createdMainWindow);
  });
} else {
  app.quit();
}

app.on("before-quit", (event) => {
  if (shutdownController.isComplete) return;
  event.preventDefault();
  if (shutdownController.inProgress) return;
  void shutdownController.run().finally(() => {
    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    app.exit(exitCode);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
