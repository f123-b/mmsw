import { contextBridge, ipcRenderer } from "electron";
import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { ScreenshotDiagnostics, ScreenshotTraceEvent } from "../main/screenshot-pipeline";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import type { InterviewStartOptions } from "../main/interview-coordinator";
import type { InterviewRuntimeDiagnostics, RuntimeTraceEvent } from "../main/runtime-diagnostics";
import type { WrittenTestStartOptions, WrittenTestState } from "../main/written-test-controller";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { QuestionEvent } from "@interview-copilot/shared";
import type { CaptureProtectionCapabilities, CaptureProtectionState, HUDLayout, HUDState, OverlayMode } from "../main/overlay-manager";
import type { OverlayPreferences, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import type { SessionState } from "@interview-copilot/shared";
import type { ChatAction, Profile, ProfileInput, ProjectAnalysisJob, ProjectFact, ProjectMaterialImportReport, ProjectQaGenerationResult, ProjectQuestionBankImportReport, ProjectSourceRole, ProviderSettings, QuestionBankCoverageResult, QuestionBankJobProfileRecord, QuestionBankQuestionRecord, QuestionBankRelationRecord, QuestionBankRouteResult, QuestionBankSkillRecord, QuestionBankAnswerCardRecord } from "@interview-copilot/shared";
import type { LlmModelProfileInput, ProviderCenterPublicConfig, PublicProviderSettings, ProviderSection } from "../main/settings-store";
import type { ConversationMessageRecord, ConversationRecord, JobTargetRecord, KnowledgeAnalysisRunRecord, ProfileBuilderArtifactRecord, ProjectRecord, QuestionBankAnswerCardInput, QuestionBankAnswerGenerationResult, QuestionBankBulkPatch, QuestionBankDuplicateCluster, QuestionBankImportResult, QuestionBankJobProfileInput, QuestionBankListOptions, QuestionBankQuestionInput, QuestionBankRelationInput, QuestionBankRouteQuery, QuestionBankSkillInput, QuestionBankSkillPointInput, RetrievalRunRecord } from "../main/database";
import type { ProviderCheckResult, ProviderPreflightResult } from "../main/provider-preflight";
import type { LocalAsrHealthCheck, LocalAsrStartOptions } from "../main/local-asr-service-manager";
import type { ModelCatalogResult } from "../main/model-catalog";

function createRendererScreenshotRequestId(): string {
  return `screenshot-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
}

function requestScreenshotAnalysis(channel: "interview:answer-screenshot" | "written-test:answer-screenshot"): Promise<void> {
  const screenshotRequestId = createRendererScreenshotRequestId();
  ipcRenderer.send("screenshot:trace", { name: "SCREENSHOT_ACTION_REQUESTED", screenshotRequestId, fields: { source: "renderer" } });
  ipcRenderer.send("screenshot:trace", { name: "SCREENSHOT_RENDERER_HANDLER_ENTERED", screenshotRequestId, fields: { channel } });
  ipcRenderer.send("screenshot:trace", { name: "SCREENSHOT_IPC_SENT", screenshotRequestId, fields: { channel } });
  return ipcRenderer.invoke(channel, { screenshotRequestId }) as Promise<void>;
}

const api = {
  diagnostics: {
    markRendererReady: () => ipcRenderer.send("diagnostics:renderer-ready")
  },
  audio: {
    start: (options?: AudioStartOptions) => ipcRenderer.invoke("audio:start", options),
    stop: () => ipcRenderer.invoke("audio:stop"),
    probe: (options?: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">) => ipcRenderer.invoke("audio:probe", options),
    listDevices: (): Promise<AudioDevices> => ipcRenderer.invoke("audio:list-devices")
  },
  overlay: {
    show: () => ipcRenderer.invoke("overlay:show"),
    toggle: () => ipcRenderer.invoke("overlay:toggle"),
    showAll: () => ipcRenderer.invoke("overlay:show-all"),
    hideAll: () => ipcRenderer.invoke("overlay:hide-all"),
    toggleAll: () => ipcRenderer.invoke("overlay:toggle-all"),
    toggleTranscript: () => ipcRenderer.invoke("overlay:toggle-transcript"),
    toggleAnswer: () => ipcRenderer.invoke("overlay:toggle-answer"),
    resetLayout: () => ipcRenderer.invoke("overlay:reset-layout"),
    toggleShortcuts: () => ipcRenderer.invoke("overlay:toggle-shortcuts"),
    getState: (): Promise<HUDState | undefined> => ipcRenderer.invoke("overlay:get-state"),
    getLayout: (): Promise<HUDLayout | undefined> => ipcRenderer.invoke("overlay:get-layout"),
    getPreferences: (): Promise<OverlayPreferences> => ipcRenderer.invoke("overlay:get-preferences"),
    setPreferences: (input: Partial<OverlayPreferences>): Promise<OverlayPreferences> => ipcRenderer.invoke("overlay:set-preferences", input),
    setShareMode: (enabled: boolean): Promise<HUDState | undefined> => ipcRenderer.invoke("overlay:set-share-mode", enabled),
    toggleShareMode: (): Promise<HUDState | undefined> => ipcRenderer.invoke("overlay:toggle-share-mode"),
    setMode: (mode: OverlayMode) => ipcRenderer.invoke("overlay:set-mode", mode),
    setControlRegion: (interactive: boolean) => ipcRenderer.invoke("overlay:set-control-region", interactive),
    getCaptureProtection: (): Promise<CaptureProtectionState> => ipcRenderer.invoke("overlay:get-capture-protection"),
    setCaptureProtection: (enabled: boolean): Promise<CaptureProtectionState | undefined> => ipcRenderer.invoke("overlay:set-capture-protection", enabled),
    getCapabilities: (): Promise<CaptureProtectionCapabilities> => ipcRenderer.invoke("overlay:get-capabilities"),
    getTencentValidation: (): Promise<TencentValidationState> => ipcRenderer.invoke("overlay:get-tencent-validation"),
    setTencentValidation: (mode: "desktopShare" | "windowShare", status: TencentValidationStatus): Promise<TencentValidationState> => ipcRenderer.invoke("overlay:set-tencent-validation", mode, status)
  },
  screenshot: {
    capture: (): Promise<ScreenshotResult> => ipcRenderer.invoke("screenshot:capture"),
    getDiagnostics: (): Promise<ScreenshotDiagnostics> => ipcRenderer.invoke("screenshot:get-diagnostics"),
    getTrace: (limit?: number): Promise<ScreenshotTraceEvent[]> => ipcRenderer.invoke("screenshot:get-trace", limit)
  },
  session: {
    getState: (): Promise<SessionState> => ipcRenderer.invoke("session:get-state")
  },
  realtime: {
    connect: (options: RealtimeConnectOptions) => ipcRenderer.invoke("realtime:connect", options),
    disconnect: () => ipcRenderer.invoke("realtime:disconnect"),
    getTranscript: (): Promise<Partial<Record<"mic" | "remote", TranscriptSnapshot>>> => ipcRenderer.invoke("realtime:get-transcript")
  },
  localAsr: {
    health: (options?: LocalAsrStartOptions): Promise<LocalAsrHealthCheck> => ipcRenderer.invoke("local-asr:health", options)
  },
  interview: {
    start: (options: InterviewStartOptions) => ipcRenderer.invoke("interview:start", options) as Promise<string>,
    stop: () => ipcRenderer.invoke("interview:stop") as Promise<void>,
    answerLatest: () => ipcRenderer.invoke("interview:answer-latest") as Promise<void>,
    answerQuestion: (text: string) => ipcRenderer.invoke("interview:answer-question", { text }) as Promise<void>,
    answerScreenshot: () => requestScreenshotAnalysis("interview:answer-screenshot"),
    getState: () => ipcRenderer.invoke("interview:get-state") as Promise<{ running: boolean; interviewId?: string; automationMode: "MANUAL" | "AUTO" }>,
    getRuntimeDiagnostics: () => ipcRenderer.invoke("interview:get-runtime-diagnostics") as Promise<InterviewRuntimeDiagnostics>,
    getRuntimeTrace: (limit?: number) => ipcRenderer.invoke("interview:get-runtime-trace", limit) as Promise<RuntimeTraceEvent[]>,
    setAutomationMode: (mode: "MANUAL" | "AUTO") => ipcRenderer.invoke("interview:set-automation-mode", mode) as Promise<boolean>,
    setAnswerMode: (mode: "FAST" | "NORMAL" | "DEEP") => ipcRenderer.invoke("interview:set-answer-mode", mode) as Promise<boolean>
  },
  writtenTest: {
    start: (options: WrittenTestStartOptions) => ipcRenderer.invoke("written-test:start", options) as Promise<boolean>,
    stop: () => ipcRenderer.invoke("written-test:stop") as Promise<boolean>,
    answerScreenshot: () => requestScreenshotAnalysis("written-test:answer-screenshot"),
    getState: () => ipcRenderer.invoke("written-test:get-state") as Promise<WrittenTestState>,
    setAnswerMode: (mode: "FAST" | "NORMAL" | "DEEP") => ipcRenderer.invoke("written-test:set-answer-mode", mode) as Promise<boolean>
  },
  chat: {
    createConversation: (input: { profileId?: string; projectId?: string; title?: string }): Promise<ConversationRecord> => ipcRenderer.invoke("chat:create-conversation", input),
    listConversations: (profileId?: string): Promise<ConversationRecord[]> => ipcRenderer.invoke("chat:list-conversations", profileId),
    getConversation: (conversationId: string): Promise<{ conversation: ConversationRecord; messages: ConversationMessageRecord[] } | undefined> => ipcRenderer.invoke("chat:get-conversation", conversationId),
    sendMessage: (conversationId: string, content: string): Promise<boolean> => ipcRenderer.invoke("chat:send-message", { conversationId, content }),
    continueMessage: (conversationId: string, messageId: string): Promise<boolean> => ipcRenderer.invoke("chat:continue-message", { conversationId, messageId }),
    cancel: (conversationId: string, reason: "user_stop" | "navigation" | "shutdown" | "superseded" | "provider_abort" | "timeout" = "user_stop"): Promise<boolean> => ipcRenderer.invoke("chat:cancel", { conversationId, reason }),
    approveAction: (input: { conversationId: string; messageId: string; action: ChatAction }): Promise<{ actionId: string; status: "approved"; result: unknown }> => ipcRenderer.invoke("chat:approve-action", input),
    deleteConversation: (conversationId: string): Promise<boolean> => ipcRenderer.invoke("chat:delete-conversation", conversationId)
  },
  profiles: {
    list: (): Promise<Profile[]> => ipcRenderer.invoke("profiles:list"),
    get: (profileId: string): Promise<Profile | undefined> => ipcRenderer.invoke("profiles:get", profileId),
    save: (input: Profile | ProfileInput): Promise<Profile | undefined> => ipcRenderer.invoke("profiles:save", input),
    delete: (profileId: string): Promise<boolean> => ipcRenderer.invoke("profiles:delete", profileId),
    clone: (profileId: string, name: string): Promise<Profile | undefined> => ipcRenderer.invoke("profiles:clone", profileId, name),
    selectActive: (profileId: string): Promise<Profile | undefined> => ipcRenderer.invoke("profiles:select-active", profileId),
    active: (): Promise<Profile | undefined> => ipcRenderer.invoke("profiles:active"),
    attachMaterial: (input: { profileId: string; kind: "resume" | "jobDescription"; filename: string; mimeType: string; bytes: Uint8Array }): Promise<Profile | undefined> => ipcRenderer.invoke("profiles:attach-material", input),
    removeMaterial: (profileId: string, kind: "resume" | "jobDescription") => ipcRenderer.invoke("profiles:remove-material", profileId, kind)
  },
  profileBuilder: {
    get: (profileId: string): Promise<ProfileBuilderArtifactRecord | undefined> => ipcRenderer.invoke("profile-builder:get", profileId),
    rebuild: (profileId: string): Promise<ProfileBuilderArtifactRecord> => ipcRenderer.invoke("profile-builder:rebuild", profileId)
  },
  projectMemory: {
    get: (profileId: string) => ipcRenderer.invoke("project-memory:get", profileId),
    stats: (profileId: string, projectId?: string) => ipcRenderer.invoke("project-memory:stats", profileId, projectId),
    listFacts: (profileId: string, projectId?: string, options?: { includeStale?: boolean; includeRejected?: boolean }): Promise<ProjectFact[]> => ipcRenderer.invoke("project-memory:list-facts", profileId, projectId, options),
    addCandidateFact: (fact: ProjectFact): Promise<ProjectFact | undefined> => ipcRenderer.invoke("project-memory:add-candidate-fact", fact),
    addResponsibility: (profileId: string, projectId: string, content: string): Promise<ProjectFact | undefined> => ipcRenderer.invoke("project-memory:add-responsibility", profileId, projectId, content),
    confirmFact: (factId: string): Promise<ProjectFact | undefined> => ipcRenderer.invoke("project-memory:confirm-fact", factId),
    verifyFact: (factId: string, verified: boolean): Promise<ProjectFact | undefined> => ipcRenderer.invoke("project-memory:verify-fact", factId, verified),
    reviewFact: (factId: string, status: "active" | "pending_review" | "rejected" | "conflicting"): Promise<ProjectFact | undefined> => ipcRenderer.invoke("project-memory:review-fact", factId, status),
    resolveConflict: (conflictGroupId: string, selectedFactId: string, keepBoth?: boolean, variantContexts?: Record<string, string>) => ipcRenderer.invoke("project-memory:resolve-conflict", conflictGroupId, selectedFactId, keepBoth, variantContexts),
    conflictGroups: (projectId: string, includeResolved?: boolean) => ipcRenderer.invoke("project-memory:conflict-groups", projectId, includeResolved),
    userActions: (projectId: string) => ipcRenderer.invoke("project-memory:user-actions", projectId),
    repairSemantics: (projectId: string) => ipcRenderer.invoke("project-memory:repair-semantics", projectId),
    sources: (projectId: string): Promise<unknown[]> => ipcRenderer.invoke("project-memory:sources", projectId),
    completeness: (profileId: string, projectId: string): Promise<unknown> => ipcRenderer.invoke("project-memory:completeness", profileId, projectId),
    analysisRuns: (profileId: string): Promise<KnowledgeAnalysisRunRecord[]> => ipcRenderer.invoke("project-memory:analysis-runs", profileId),
    state: (projectId: string) => ipcRenderer.invoke("project-memory:state", projectId),
    assignSource: (input: { profileId: string; projectId: string; sourceType: "document" | "repository" | "resume_section" | "user_fact"; sourceId: string; relationship?: "primary" | "supporting" | "reference"; sourceRole?: string; assignmentMethod?: string; confidence?: number; verified?: boolean }) => ipcRenderer.invoke("project-memory:assign-source", input),
    unassignSource: (projectId: string, sourceType: string, sourceId: string) => ipcRenderer.invoke("project-memory:unassign-source", projectId, sourceType, sourceId),
    assignDocument: (profileId: string, documentId: string, projectId?: string) => ipcRenderer.invoke("project-memory:assign-document", profileId, documentId, projectId),
    rebuild: (profileId: string) => ipcRenderer.invoke("project-memory:rebuild", profileId),
    rebuildProject: (projectId: string): Promise<ProjectAnalysisJob> => ipcRenderer.invoke("project-memory:rebuild-project", projectId),
    analysisJob: (projectId: string): Promise<ProjectAnalysisJob | undefined> => ipcRenderer.invoke("project-memory:analysis-job", projectId),
    analysisJobs: (profileId: string): Promise<ProjectAnalysisJob[]> => ipcRenderer.invoke("project-memory:analysis-jobs", profileId),
    cancelAnalysis: (projectId: string, jobId?: string): Promise<ProjectAnalysisJob | undefined> => ipcRenderer.invoke("project-memory:cancel-analysis", projectId, jobId),
    retryAnalysis: (profileId: string, projectId: string): Promise<ProjectAnalysisJob | undefined> => ipcRenderer.invoke("project-memory:retry-analysis", profileId, projectId)
  },
  jobTargets: {
    list: (profileId: string): Promise<JobTargetRecord[]> => ipcRenderer.invoke("job-targets:list", profileId)
  },
  retrieval: {
    list: (profileId: string, limit?: number): Promise<RetrievalRunRecord[]> => ipcRenderer.invoke("retrieval:list", profileId, limit)
  },
  settings: {
    get: (): Promise<ProviderCenterPublicConfig | undefined> => ipcRenderer.invoke("settings:get"),
    update: (section: ProviderSection, input: Partial<ProviderSettings>): Promise<PublicProviderSettings | undefined> => ipcRenderer.invoke("settings:update", section, input),
    saveLlmProfile: (input: LlmModelProfileInput): Promise<ProviderCenterPublicConfig | undefined> => ipcRenderer.invoke("settings:save-llm-profile", input),
    activateLlmProfile: (profileId: string): Promise<ProviderCenterPublicConfig | undefined> => ipcRenderer.invoke("settings:activate-llm-profile", profileId),
    deleteLlmProfile: (profileId: string): Promise<ProviderCenterPublicConfig | undefined> => ipcRenderer.invoke("settings:delete-llm-profile", profileId),
    testConnection: (section: ProviderSection, profileId?: string): Promise<ProviderCheckResult> => ipcRenderer.invoke("settings:test-connection", section, profileId),
    listModels: (section: ProviderSection, profileId?: string): Promise<ModelCatalogResult> => ipcRenderer.invoke("settings:list-models", section, profileId),
    preflight: (checkReachability?: boolean): Promise<ProviderPreflightResult> => ipcRenderer.invoke("settings:preflight", checkReachability)
  },
  projects: {
    list: (): Promise<ProjectRecord[]> => ipcRenderer.invoke("projects:list"),
    create: (input: { name: string; profileId?: string; ownershipMode?: "personal" | "team" | "partial" | "reference"; ownershipNote?: string }): Promise<ProjectRecord | undefined> => ipcRenderer.invoke("projects:create", input),
    rename: (projectId: string, name: string): Promise<ProjectRecord | undefined> => ipcRenderer.invoke("projects:rename", projectId, name),
    update: (projectId: string, input: { name?: string; ownershipMode?: "personal" | "team" | "partial" | "reference"; ownershipNote?: string }): Promise<ProjectRecord | undefined> => ipcRenderer.invoke("projects:update", projectId, input),
    delete: (projectId: string): Promise<boolean> => ipcRenderer.invoke("projects:delete", projectId)
  },
  knowledge: {
    listBases: () => ipcRenderer.invoke("knowledge:list-bases"),
    createBase: (name: string) => ipcRenderer.invoke("knowledge:create-base", name),
    renameBase: (knowledgeBaseId: string, name: string) => ipcRenderer.invoke("knowledge:rename-base", knowledgeBaseId, name),
    deleteBase: (knowledgeBaseId: string) => ipcRenderer.invoke("knowledge:delete-base", knowledgeBaseId) as Promise<boolean>,
    listDocuments: (knowledgeBaseId?: string) => ipcRenderer.invoke("knowledge:list-documents", knowledgeBaseId),
    ingest: (input: { knowledgeBaseId?: string; profileId?: string; projectId?: string; sourceRole?: ProjectSourceRole | "auto"; filename: string; mimeType: string; bytes: Uint8Array; documentType?: string }) => ipcRenderer.invoke("knowledge:ingest", input),
    ingestProjectMaterials: (input: { profileId: string; projectId: string; knowledgeBaseId: string; files: Array<{ filename: string; mimeType: string; bytes: Uint8Array; sourceRole?: ProjectSourceRole | "auto" }> }): Promise<ProjectMaterialImportReport> => ipcRenderer.invoke("knowledge:ingest-project-materials", input),
    ingestProjectQuestionBank: (input: { profileId: string; projectId: string; filename: string; mimeType: string; bytes: Uint8Array }): Promise<ProjectQuestionBankImportReport> => ipcRenderer.invoke("knowledge:ingest-project-question-bank", input),
    updateType: (documentId: string, documentType: string) => ipcRenderer.invoke("knowledge:update-type", documentId, documentType),
    delete: (documentId: string) => ipcRenderer.invoke("knowledge:delete", documentId),
    reindex: (documentId: string) => ipcRenderer.invoke("knowledge:reindex", documentId)
  },
  questionBank: {
    list: (options?: QuestionBankListOptions): Promise<QuestionBankQuestionRecord[]> => ipcRenderer.invoke("question-bank:list", options),
    count: (options?: Omit<QuestionBankListOptions, "limit" | "offset" | "sort">): Promise<number> => ipcRenderer.invoke("question-bank:count", options),
    bulkUpdate: (questionIds: string[], patch: QuestionBankBulkPatch): Promise<number> => ipcRenderer.invoke("question-bank:bulk-update", { questionIds, patch }),
    duplicates: (limit?: number): Promise<QuestionBankDuplicateCluster[]> => ipcRenderer.invoke("question-bank:duplicates", limit),
    mergeDuplicates: (canonicalId: string, duplicateIds: string[]): Promise<QuestionBankQuestionRecord | undefined> => ipcRenderer.invoke("question-bank:merge-duplicates", { canonicalId, duplicateIds }),
    get: (questionId: string): Promise<QuestionBankQuestionRecord | undefined> => ipcRenderer.invoke("question-bank:get", questionId),
    saveQuestion: (input: QuestionBankQuestionInput): Promise<QuestionBankQuestionRecord | undefined> => ipcRenderer.invoke("question-bank:save-question", input),
    deleteQuestion: (questionId: string): Promise<boolean> => ipcRenderer.invoke("question-bank:delete-question", questionId),
    saveAnswer: (input: QuestionBankAnswerCardInput): Promise<QuestionBankAnswerCardRecord | undefined> => ipcRenderer.invoke("question-bank:save-answer", input),
    deleteAnswer: (answerCardId: string): Promise<boolean> => ipcRenderer.invoke("question-bank:delete-answer", answerCardId),
    route: (text: string, options?: QuestionBankRouteQuery): Promise<QuestionBankRouteResult | undefined> => ipcRenderer.invoke("question-bank:route", text, options),
    saveRelation: (input: QuestionBankRelationInput): Promise<QuestionBankRelationRecord | undefined> => ipcRenderer.invoke("question-bank:save-relation", input),
    listRelations: (questionId?: string): Promise<QuestionBankRelationRecord[]> => ipcRenderer.invoke("question-bank:list-relations", questionId),
    deleteRelation: (relationId: string): Promise<boolean> => ipcRenderer.invoke("question-bank:delete-relation", relationId),
    listSkills: (search?: string): Promise<QuestionBankSkillRecord[]> => ipcRenderer.invoke("question-bank:list-skills", search),
    saveSkill: (input: QuestionBankSkillInput): Promise<QuestionBankSkillRecord | undefined> => ipcRenderer.invoke("question-bank:save-skill", input),
    saveSkillPoint: (input: QuestionBankSkillPointInput): Promise<unknown> => ipcRenderer.invoke("question-bank:save-skill-point", input),
    linkSkill: (questionId: string, skillId: string): Promise<boolean> => ipcRenderer.invoke("question-bank:link-skill", questionId, skillId),
    listJobs: (): Promise<QuestionBankJobProfileRecord[]> => ipcRenderer.invoke("question-bank:list-jobs"),
    coverage: (jobProfileId?: string): Promise<QuestionBankCoverageResult> => ipcRenderer.invoke("question-bank:coverage", jobProfileId),
    saveJob: (input: QuestionBankJobProfileInput): Promise<QuestionBankJobProfileRecord | undefined> => ipcRenderer.invoke("question-bank:save-job", input),
    importText: (input: { text: string; filename?: string; includeProject?: boolean; includeBehavioral?: boolean }): Promise<QuestionBankImportResult | undefined> => ipcRenderer.invoke("question-bank:import-text", input),
    generateAnswers: (input?: { questionIds?: string[]; onlyUnanswered?: boolean }): Promise<QuestionBankAnswerGenerationResult> => ipcRenderer.invoke("question-bank:generate-answers", input),
    generateProjectQa: (projectId: string): Promise<ProjectQaGenerationResult> => ipcRenderer.invoke("question-bank:generate-project-qa", projectId),
    match: (text: string): Promise<{ question: QuestionBankQuestionRecord; score: number; exact: boolean } | undefined> => ipcRenderer.invoke("question-bank:match", text)
  },
  history: {
    list: () => ipcRenderer.invoke("history:list"),
    get: (interviewId: string) => ipcRenderer.invoke("history:get", interviewId),
    analyze: (interviewId: string) => ipcRenderer.invoke("history:analyze", interviewId),
    getAnalysis: (interviewId: string) => ipcRenderer.invoke("history:get-analysis", interviewId),
    delete: (interviewId: string) => ipcRenderer.invoke("history:delete", interviewId) as Promise<boolean>
  },
  preparation: {
    start: (goal: string) => ipcRenderer.invoke("preparation:start", goal),
    approve: (requestId: string) => ipcRenderer.invoke("preparation:approve", requestId),
    reject: (requestId: string) => ipcRenderer.invoke("preparation:reject", requestId),
    stop: () => ipcRenderer.invoke("preparation:stop")
  },
  events: {
    onAudio: (listener: (event: AudioSidecarEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: AudioSidecarEvent) => listener(payload);
      ipcRenderer.on("audio:event", handler);
      return () => ipcRenderer.removeListener("audio:event", handler);
    },
    onAudioDiagnostic: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("audio:diagnostic", handler);
      return () => ipcRenderer.removeListener("audio:diagnostic", handler);
    },
    onSessionState: (listener: (state: SessionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: SessionState) => listener(state);
      ipcRenderer.on("session:state", handler);
      return () => ipcRenderer.removeListener("session:state", handler);
    },
    onOverlayMode: (listener: (mode: OverlayMode) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, mode: OverlayMode) => listener(mode);
      ipcRenderer.on("overlay:mode", handler);
      return () => ipcRenderer.removeListener("overlay:mode", handler);
    },
    onOverlayState: (listener: (state: HUDState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: HUDState) => listener(state);
      ipcRenderer.on("overlay:state", handler);
      return () => ipcRenderer.removeListener("overlay:state", handler);
    },
    onOverlayLayout: (listener: (layout: HUDLayout) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, layout: HUDLayout) => listener(layout);
      ipcRenderer.on("overlay:layout", handler);
      return () => ipcRenderer.removeListener("overlay:layout", handler);
    },
    onOverlayCommand: (listener: (command: "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end") => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end") => listener(command);
      ipcRenderer.on("overlay:command", handler);
      return () => ipcRenderer.removeListener("overlay:command", handler);
    },
    onOverlayCaptureProtection: (listener: (state: CaptureProtectionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: CaptureProtectionState) => listener(state);
      ipcRenderer.on("overlay:capture-protection", handler);
      return () => ipcRenderer.removeListener("overlay:capture-protection", handler);
    },
    onShortcut: (listener: (shortcut: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, shortcut: string) => listener(shortcut);
      ipcRenderer.on("shortcut", handler);
      return () => ipcRenderer.removeListener("shortcut", handler);
    },
    onAudioProcess: (listener: (state: AudioProcessState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AudioProcessState) => listener(state);
      ipcRenderer.on("audio:process", handler);
      return () => ipcRenderer.removeListener("audio:process", handler);
    },
    onScreenshot: (listener: (result: ScreenshotResult) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, result: ScreenshotResult) => listener(result);
      ipcRenderer.on("screenshot:captured", handler);
      return () => ipcRenderer.removeListener("screenshot:captured", handler);
    },
    onScreenshotError: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("screenshot:error", handler);
      return () => ipcRenderer.removeListener("screenshot:error", handler);
    },
    onScreenshotDiagnostic: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("screenshot:diagnostic", handler);
      return () => ipcRenderer.removeListener("screenshot:diagnostic", handler);
    },
    onScreenshotTrace: (listener: (event: ScreenshotTraceEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, trace: ScreenshotTraceEvent) => listener(trace);
      ipcRenderer.on("screenshot:trace", handler);
      return () => ipcRenderer.removeListener("screenshot:trace", handler);
    },
      onRealtimeState: (listener: (state: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: string) => listener(state);
      ipcRenderer.on("realtime:state", handler);
      return () => ipcRenderer.removeListener("realtime:state", handler);
      },
      onRealtimeDiagnostics: (listener: (diagnostics: AsrRuntimeDiagnostics) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, diagnostics: AsrRuntimeDiagnostics) => listener(diagnostics);
        ipcRenderer.on("realtime:diagnostics", handler);
        return () => ipcRenderer.removeListener("realtime:diagnostics", handler);
      },
    onRealtimeTranscript: (listener: (snapshot: TranscriptSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: TranscriptSnapshot) => listener(snapshot);
      ipcRenderer.on("realtime:transcript", handler);
      return () => ipcRenderer.removeListener("realtime:transcript", handler);
    },
    onRealtimeMessage: (listener: (message: RealtimeServerMessage) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: RealtimeServerMessage) => listener(message);
      ipcRenderer.on("realtime:message", handler);
      return () => ipcRenderer.removeListener("realtime:message", handler);
    },
    onRealtimeDiagnostic: (listener: (message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on("realtime:diagnostic", handler);
      return () => ipcRenderer.removeListener("realtime:diagnostic", handler);
    },
    onRuntimeTrace: (listener: (event: RuntimeTraceEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, trace: RuntimeTraceEvent) => listener(trace);
      ipcRenderer.on("runtime:trace", handler);
      return () => ipcRenderer.removeListener("runtime:trace", handler);
    },
    onRuntimeError: (listener: (error: { code: string; message: string; recoverable: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, error: { code: string; message: string; recoverable: boolean }) => listener(error);
      ipcRenderer.on("runtime:error", handler);
      return () => ipcRenderer.removeListener("runtime:error", handler);
    },
    onQuestion: (listener: (event: QuestionEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, question: QuestionEvent) => listener(question);
      ipcRenderer.on("question:event", handler);
      return () => ipcRenderer.removeListener("question:event", handler);
    },
    onAutomationMode: (listener: (mode: "MANUAL" | "AUTO") => void) => {
      const handler = (_event: Electron.IpcRendererEvent, mode: "MANUAL" | "AUTO") => listener(mode);
      ipcRenderer.on("interview:automation-mode", handler);
      return () => ipcRenderer.removeListener("interview:automation-mode", handler);
    },
    onAnswerMode: (listener: (mode: "FAST" | "NORMAL" | "DEEP") => void) => {
      const handler = (_event: Electron.IpcRendererEvent, mode: "FAST" | "NORMAL" | "DEEP") => listener(mode);
      ipcRenderer.on("interview:answer-mode", handler);
      return () => ipcRenderer.removeListener("interview:answer-mode", handler);
    },
    onWrittenTestState: (listener: (state: WrittenTestState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: WrittenTestState) => listener(state);
      ipcRenderer.on("written-test:state", handler);
      return () => ipcRenderer.removeListener("written-test:state", handler);
    },
    onPreparationEvent: (listener: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("preparation:event", handler);
      return () => ipcRenderer.removeListener("preparation:event", handler);
    },
    onChatMessageStart: (listener: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("chat:message-start", handler);
      return () => ipcRenderer.removeListener("chat:message-start", handler);
    },
    onChatMessageDelta: (listener: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("chat:message-delta", handler);
      return () => ipcRenderer.removeListener("chat:message-delta", handler);
    },
    onChatMessageEnd: (listener: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("chat:message-end", handler);
      return () => ipcRenderer.removeListener("chat:message-end", handler);
    },
    onChatError: (listener: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("chat:error", handler);
      return () => ipcRenderer.removeListener("chat:error", handler);
    },
    onOverlayPreferences: (listener: (preferences: OverlayPreferences) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, preferences: OverlayPreferences) => listener(preferences);
      ipcRenderer.on("overlay:preferences", handler);
      return () => ipcRenderer.removeListener("overlay:preferences", handler);
    },
    onChatCancelled: (listener: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
      ipcRenderer.on("chat:cancelled", handler);
      return () => ipcRenderer.removeListener("chat:cancelled", handler);
    },
    onProfileBuilderUpdated: (listener: (event: ProfileBuilderArtifactRecord) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ProfileBuilderArtifactRecord) => listener(payload);
      ipcRenderer.on("profile-builder:updated", handler);
      return () => ipcRenderer.removeListener("profile-builder:updated", handler);
    },
    onProjectAnalysisJob: (listener: (event: ProjectAnalysisJob) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: ProjectAnalysisJob) => listener(payload);
      ipcRenderer.on("project-memory:analysis-job", handler);
      return () => ipcRenderer.removeListener("project-memory:analysis-job", handler);
    },
    onQuestionBankAnswerGenerationProgress: (listener: (event: { status: "started" | "running" | "completed"; total: number; completed: number; generated: number; skipped: number; failed: number; questionId?: string; error?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { status: "started" | "running" | "completed"; total: number; completed: number; generated: number; skipped: number; failed: number; questionId?: string; error?: string }) => listener(payload);
      ipcRenderer.on("question-bank:answer-generation-progress", handler);
      return () => ipcRenderer.removeListener("question-bank:answer-generation-progress", handler);
    }
  }
};

contextBridge.exposeInMainWorld("interviewCopilot", api);
