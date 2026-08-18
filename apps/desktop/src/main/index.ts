import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { join } from "node:path";
import { AudioManager, type AudioStartOptions } from "./audio-manager";
import { OverlayManager, type OverlayMode } from "./overlay-manager";
import { ScreenshotManager } from "./screenshot-manager";
import { GLOBAL_SHORTCUTS } from "./shortcuts";
import { RealtimeSession, type RealtimeConnectOptions } from "./realtime-session";
import { AGENT_TOOL_NAMES, analyzeInterview, AnswerAgent, AgentToolRegistry, chunkText, createSkill, HybridRetriever, ModelRouter, OpenAICompatibleAnswerProvider, OpenAICompatibleEmbeddingProvider, PreparationAgentRuntime, SessionStateMachine, ToolApprovalPolicy, type AnswerProvider, type PreparationModel, type PreparationModelStep, type ProviderSettings } from "@interview-copilot/shared";
import { InterviewCoordinator, type InterviewStartOptions } from "./interview-coordinator";
import { openAppDatabase, SqliteInterviewHistoryRepository, SqliteKnowledgeRepository, SqliteProfileRepository, type SqliteDatabase } from "./database";
import { createSecretStore, MemorySecretStore, ProviderConfigStore, type ProviderSection } from "./settings-store";
import { parseDocument } from "./document-parsers";
import { SafeLogger } from "./logger";

let mainWindow: BrowserWindow | undefined;
let overlayManager: OverlayManager | undefined;
const audioManager = new AudioManager();
const screenshotManager = new ScreenshotManager({
  onDiagnostic: (message) => broadcast("screenshot:diagnostic", message)
});
const session = new SessionStateMachine();
const realtimeSession = new RealtimeSession();
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
const routingModels: Partial<Record<"fast" | "low-latency" | "reasoning" | "vision", string>> = { fast: configuredModel, "low-latency": configuredModel, reasoning: configuredModel, vision: configuredModel };
const answerProvider: AnswerProvider = {
  stream(request, signal) {
    const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
    return new OpenAICompatibleAnswerProvider(settings).stream(request, signal);
  }
};
const answerAgent = new AnswerAgent(
  { fast: answerProvider, "low-latency": answerProvider, reasoning: answerProvider, vision: answerProvider },
  new ModelRouter(routingModels)
);
let interviewCoordinator: InterviewCoordinator | undefined;
let profileRepository: SqliteProfileRepository | undefined;
let knowledgeRepository: SqliteKnowledgeRepository | undefined;
let historyRepository: SqliteInterviewHistoryRepository | undefined;
let preparationRuntime: PreparationAgentRuntime | undefined;
let appLogger: SafeLogger | undefined;
let audioLogger: SafeLogger | undefined;
let realtimeLogger: SafeLogger | undefined;
let database: SqliteDatabase | undefined;
const preloadPath = join(__dirname, "../preload/index.js");
const rendererFile = join(__dirname, "../renderer/index.html");

function isDevelopment(): boolean {
  return Boolean(process.env.ELECTRON_RENDERER_URL);
}

async function loadRenderer(window: BrowserWindow, overlay = false): Promise<void> {
  if (isDevelopment()) {
    const url = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
    await window.loadURL(`${url}${overlay ? "?window=overlay" : ""}`);
  } else {
    await window.loadFile(rendererFile, overlay ? { search: "window=overlay" } : undefined);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of [mainWindow, overlayManager?.currentWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function coordinator(): InterviewCoordinator {
  if (!interviewCoordinator) throw new Error("Interview runtime is still initializing");
  return interviewCoordinator;
}

async function captureScreenshot(trigger = "screenshot-answer"): Promise<void> {
  try {
    const result = await screenshotManager.capturePrimaryDisplay();
    broadcast("screenshot:captured", result);
    broadcast("shortcut", trigger);
    if (trigger === "screenshot-answer" && interviewCoordinator?.running) void interviewCoordinator.answerScreenshot(result.dataUrl);
  } catch (error) {
    broadcast("screenshot:error", String(error));
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: "Interview Copilot",
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  void loadRenderer(mainWindow);
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

function registerIpc(): void {
  // This low-level entry point is diagnostics-only. Product interview start goes through the coordinator.
  ipcMain.handle("audio:start", (_event, options: AudioStartOptions) => audioManager.start({ ...options, meterOnly: true, autoRecover: false }));
  ipcMain.handle("audio:stop", () => audioManager.stop());
  ipcMain.handle("audio:probe", (_event, options: AudioStartOptions) => audioManager.probe(options));
  ipcMain.handle("audio:list-devices", () => audioManager.listDevices());
  ipcMain.handle("overlay:show", () => { overlayManager?.show(); return true; });
  ipcMain.handle("overlay:toggle", () => { overlayManager?.toggle(); return true; });
  ipcMain.handle("overlay:set-mode", (_event, mode: OverlayMode) => {
    overlayManager?.setMode(mode);
    broadcast("overlay:mode", mode);
  });
  ipcMain.handle("screenshot:capture", () => screenshotManager.capturePrimaryDisplay());
  ipcMain.handle("session:get-state", () => session.state);
  ipcMain.handle("realtime:connect", (_event, options: RealtimeConnectOptions) => {
    realtimeSession.connect(options);
    return true;
  });
  ipcMain.handle("realtime:disconnect", () => {
    realtimeSession.disconnect();
    return true;
  });
  ipcMain.handle("interview:start", (_event, options: InterviewStartOptions) => coordinator().start(options));
  ipcMain.handle("interview:stop", () => coordinator().stop("user"));
  ipcMain.handle("interview:answer-latest", () => coordinator().answerLatest());
  ipcMain.handle("profiles:list", () => profileRepository?.list() ?? []);
  ipcMain.handle("profiles:get", (_event, profileId: string) => profileRepository?.get(profileId));
  ipcMain.handle("profiles:save", (_event, input: Parameters<SqliteProfileRepository["save"]>[0]) => profileRepository?.save(input));
  ipcMain.handle("profiles:delete", (_event, profileId: string) => { profileRepository?.delete(profileId); return true; });
  ipcMain.handle("profiles:clone", (_event, profileId: string, name: string) => profileRepository?.clone(profileId, name));
  ipcMain.handle("profiles:select-active", (_event, profileId: string) => profileRepository?.setActive(profileId));
  ipcMain.handle("profiles:active", () => profileRepository?.active());
  ipcMain.handle("profiles:attach-material", async (_event, input: { profileId: string; kind: "resume" | "jobDescription"; filename: string; mimeType: string; bytes: Uint8Array }) => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    const profile = profileRepository.get(input.profileId);
    if (!profile) throw new Error("Profile not found");
    const parsed = await parseDocument({ documentId: `profile-material-${Date.now()}`, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes });
    let summary = parsed.text.slice(0, 800);
    const settings = providerConfigStore?.get("llm");
    if (settings?.apiKey && settings.model) {
      try {
        let generated = "";
        for await (const delta of new OpenAICompatibleAnswerProvider(settings).stream({ model: settings.model, sections: [{ name: "system/base", content: "请把材料总结为真实、可核验的中文面试上下文，保留技能、职责和量化结果。只输出摘要。" }, { name: "question", content: parsed.text.slice(0, 12_000) }] })) generated += delta;
        if (generated.trim()) summary = generated.trim();
      } catch (error) {
        appLogger?.warn("material summary failed", { error: String(error) });
      }
    }
    const material = { rawContent: parsed.text, summary };
    return profileRepository.save({ ...profile, ...(input.kind === "resume" ? { resume: material } : { jobDescription: material }), updatedAt: Date.now() });
  });
  ipcMain.handle("knowledge:list-bases", () => knowledgeRepository?.listKnowledgeBases() ?? []);
  ipcMain.handle("knowledge:create-base", (_event, name: string) => knowledgeRepository?.createKnowledgeBase(name));
  ipcMain.handle("knowledge:list-documents", (_event, knowledgeBaseId?: string) => knowledgeRepository?.listDocuments(knowledgeBaseId) ?? []);
  ipcMain.handle("knowledge:ingest", async (_event, input: { knowledgeBaseId?: string; filename: string; mimeType: string; bytes: Uint8Array }) => {
    if (!knowledgeRepository) throw new Error("Knowledge database is still initializing");
    const knowledgeBase = input.knowledgeBaseId ? knowledgeRepository.listKnowledgeBases().find((base) => base.id === input.knowledgeBaseId) : knowledgeRepository.ensureKnowledgeBase();
    if (!knowledgeBase) throw new Error("Knowledge base not found");
    const parsed = await parseDocument({ documentId: `document-${Date.now()}`, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes });
    const document = knowledgeRepository.saveDocument({ id: parsed.documentId, ...parsed, knowledgeBaseId: knowledgeBase.id, status: "processing" });
    try {
      const chunks = chunkText(parsed.text, { documentId: parsed.documentId, filename: parsed.filename });
      const embeddingSettings = providerConfigStore?.get("embedding");
      if (embeddingSettings?.apiKey && embeddingSettings.model) {
        const embeddingProvider = new OpenAICompatibleEmbeddingProvider(embeddingSettings);
        for (const chunk of chunks) chunk.embedding = await embeddingProvider.embed(chunk.text);
      }
      knowledgeRepository.replaceChunks(document.id, chunks);
      return knowledgeRepository.saveDocument({ id: document.id, ...parsed, knowledgeBaseId: knowledgeBase.id, status: "ready" });
    } catch (error) {
      return knowledgeRepository.saveDocument({ id: document.id, ...parsed, knowledgeBaseId: knowledgeBase.id, status: "error", error: String(error) });
    }
  });
  ipcMain.handle("knowledge:delete", (_event, documentId: string) => { knowledgeRepository?.deleteDocument(documentId); return true; });
  ipcMain.handle("history:list", () => historyRepository?.listInterviews() ?? []);
  ipcMain.handle("history:get", (_event, interviewId: string) => historyRepository?.snapshot(interviewId));
  ipcMain.handle("history:analyze", (_event, interviewId: string) => { const snapshot = historyRepository?.snapshot(interviewId); return snapshot ? analyzeInterview(snapshot) : undefined; });
  ipcMain.handle("preparation:start", (_event, goal: string) => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    if (preparationRuntime) throw new Error("A preparation run is already active");
    const profile = profileRepository.active();
    if (!profile) throw new Error("Create a profile before starting preparation");
    const registry = new AgentToolRegistry(new ToolApprovalPolicy("ASK_EVERY_TIME"))
      .register({ name: "get_profile", risk: "read", execute: async () => profileRepository?.get(profile.id) })
      .register({ name: "update_profile", risk: "write", execute: async (args) => profileRepository?.save({ ...profile, ...args, id: profile.id, updatedAt: Date.now() }) })
      .register({ name: "create_skill", risk: "write", execute: async (args) => { const current = profileRepository?.get(profile.id); if (!current) throw new Error("Profile not found"); const skill = createSkill({ name: String(args.name ?? "新技能"), description: String(args.description ?? ""), content: String(args.content ?? ""), tags: Array.isArray(args.tags) ? args.tags.map(String) : [] }); return profileRepository?.save({ ...current, skills: [...current.skills, skill] }); } })
      .register({ name: "retrieve_knowledge", risk: "read", execute: async (args) => { const query = String(args.query ?? goal); const chunks = knowledgeRepository?.listChunks(profile.knowledgeBaseIds) ?? []; return new HybridRetriever().search(query, chunks, { topK: 6 }).map((chunk) => chunk.text); } });
    const model: PreparationModel = {
      next: async (input, signal): Promise<PreparationModelStep> => {
        const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
        const prompt = `目标：${input.goal}\n历史：${JSON.stringify(input.history)}\n请只返回 JSON。若需要动作，格式为 {"type":"tool_call","tool":"get_profile","args":{},"rationale":"..."}；若完成，格式为 {"type":"final","summary":"..."}。可用工具：${AGENT_TOOL_NAMES.join(", ")}`;
        let text = "";
        for await (const delta of new OpenAICompatibleAnswerProvider(settings).stream({ model: settings.model, sections: [{ name: "system/base", content: "你是面试准备 Agent。所有写入或外部动作都必须由用户审批。" }, { name: "question", content: prompt }] }, signal)) text += delta;
        const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
        if (!jsonText) return { type: "final", summary: text || "模型没有返回结果" };
        try {
          const parsed = JSON.parse(jsonText) as { type?: string; tool?: string; args?: Record<string, unknown>; rationale?: string; summary?: string };
          if (parsed.type === "tool_call" && parsed.tool && AGENT_TOOL_NAMES.includes(parsed.tool as typeof AGENT_TOOL_NAMES[number])) return { type: "tool_call", tool: parsed.tool as typeof AGENT_TOOL_NAMES[number], args: parsed.args ?? {}, rationale: parsed.rationale };
          return { type: "final", summary: parsed.summary ?? text };
        } catch {
          return { type: "final", summary: text };
        }
      }
    };
    preparationRuntime = new PreparationAgentRuntime(model, registry, { workspaceRoot: app.getPath("userData"), profileId: profile.id }, 40);
    void (async () => {
      try {
        for await (const event of preparationRuntime!.run(goal)) broadcast("preparation:event", event);
      } catch (error) {
        broadcast("preparation:event", { type: "error", message: String(error) });
      } finally {
        preparationRuntime = undefined;
      }
    })();
    return true;
  });
  ipcMain.handle("preparation:approve", (_event, requestId: string) => { preparationRuntime?.approve(requestId); return true; });
  ipcMain.handle("preparation:reject", (_event, requestId: string) => { preparationRuntime?.reject(requestId); return true; });
  ipcMain.handle("settings:get", () => providerConfigStore?.getPublic());
  ipcMain.handle("settings:update", (_event, section: ProviderSection, input: Partial<ProviderSettings>) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const result = providerConfigStore.update(section, input);
    if (section === "llm") {
      routingModels.fast = result.model;
      routingModels["low-latency"] = result.model;
      routingModels.reasoning = result.model;
      routingModels.vision = result.model;
    }
    return result;
  });
}

function registerShortcuts(): void {
  const shortcuts: Record<string, () => void> = {
    [GLOBAL_SHORTCUTS.answerLatest]: () => void coordinator().answerLatest(),
    [GLOBAL_SHORTCUTS.screenshotAnswer]: () => void captureScreenshot(),
    [GLOBAL_SHORTCUTS.toggleOverlay]: () => overlayManager?.toggle(),
    [GLOBAL_SHORTCUTS.toggleOverlayMode]: () => {
      const mode = overlayManager?.toggleMode();
      if (mode) broadcast("overlay:mode", mode);
    },
    [GLOBAL_SHORTCUTS.toggleAutomation]: () => broadcast("shortcut", "toggle-automation"),
    [GLOBAL_SHORTCUTS.endInterview]: () => {
      void coordinator().stop("user");
    }
  };
  for (const [accelerator, handler] of Object.entries(shortcuts)) {
    if (!globalShortcut.register(accelerator, handler)) {
      console.warn(`Failed to register global shortcut: ${accelerator}`);
    }
  }
}

app.whenReady().then(async () => {
  const logsDirectory = join(app.getPath("appData"), "InterviewCopilot", "logs");
  appLogger = new SafeLogger(logsDirectory, "app");
  audioLogger = new SafeLogger(logsDirectory, "audio");
  realtimeLogger = new SafeLogger(logsDirectory, "realtime");
  appLogger.info("application starting");
  try {
    database = await openAppDatabase(app.getPath("appData"));
    profileRepository = new SqliteProfileRepository(database);
    knowledgeRepository = new SqliteKnowledgeRepository(database);
    try {
      providerConfigStore = new ProviderConfigStore(database, await createSecretStore(app.getPath("appData")), { llm: environmentLlmSettings });
    } catch {
      providerConfigStore = new ProviderConfigStore(database, new MemorySecretStore(), { llm: environmentLlmSettings });
    }
    const persistedModel = providerConfigStore.get("llm").model;
    routingModels.fast = persistedModel;
    routingModels["low-latency"] = persistedModel;
    routingModels.reasoning = persistedModel;
    routingModels.vision = persistedModel;
  } catch (error) {
    appLogger.error("database initialization failed", { error: String(error) });
    broadcast("runtime:error", { code: "DATABASE_INIT_FAILED", message: "本地数据库初始化失败，当前会话不会保存到磁盘" });
    database = undefined;
  }
  historyRepository = database ? new SqliteInterviewHistoryRepository(database) : undefined;
  interviewCoordinator = new InterviewCoordinator({
    audio: audioManager,
    realtime: realtimeSession,
    session,
    answerAgent,
    history: historyRepository,
    asrSettingsProvider: () => { const settings = providerConfigStore?.get("asr"); return { providerName: settings?.providerName ?? "Custom WebSocket ASR Gateway", apiKey: settings?.apiKey ?? "", model: settings?.model ?? "" }; },
    contextProvider: async (question, profileId) => {
      const profile = profileRepository?.get(profileId);
      const chunks = knowledgeRepository?.listChunks(profile?.knowledgeBaseIds ?? []) ?? [];
      let retrieved = new HybridRetriever().search(question.text, chunks, { topK: 16 });
      const embeddingSettings = providerConfigStore?.get("embedding");
      if (embeddingSettings?.apiKey && embeddingSettings.model && chunks.length > 0) {
        try {
          const vector = await new OpenAICompatibleEmbeddingProvider(embeddingSettings).embed(question.text);
          retrieved = new HybridRetriever().search(question.text, chunks, { topK: 16, embeddingProvider: { embed: () => vector } });
        } catch (error) {
          broadcast("realtime:diagnostic", `RAG embedding unavailable; keyword retrieval used: ${String(error)}`);
        }
      }
      return {
        profileSummary: profile?.resume?.summary,
        jobDescriptionSummary: profile?.jobDescription?.summary,
        skills: (profile?.skills ?? []).map((skill) => ({ id: skill.id, name: skill.name, content: `${skill.description}\n${skill.content}` })),
        retrievedKnowledge: retrieved.slice(0, 6).map((chunk) => `${chunk.metadata.filename}: ${chunk.text}`)
      };
    }
  });
  createMainWindow();
  overlayManager = new OverlayManager({
    preloadPath,
    loadRenderer: (window) => loadRenderer(window, true)
  });
  registerIpc();
  registerShortcuts();

  audioManager.on("event", (event) => broadcast("audio:event", event));
  audioManager.on("process", (state) => broadcast("audio:process", state));
  audioManager.on("diagnostic", (message) => { audioLogger?.warn(message); broadcast("audio:diagnostic", message); });
  coordinator().on("event", (event: { type: string; [key: string]: unknown }) => {
    if (event.type === "session_state") broadcast("session:state", event.state);
    if (event.type === "transcript") broadcast("realtime:transcript", event.snapshot);
    if (event.type === "question") broadcast("question:event", event.event);
    if (event.type === "realtime_message") broadcast("realtime:message", event.message);
    if (event.type === "realtime_state") broadcast("realtime:state", event.state);
    if (event.type === "diagnostic") { realtimeLogger?.warn(String(event.message)); broadcast("realtime:diagnostic", event.message); }
  });
  session.subscribe((state) => broadcast("session:state", state));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  void interviewCoordinator?.stop("user");
  database?.close();
  overlayManager?.destroy();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
