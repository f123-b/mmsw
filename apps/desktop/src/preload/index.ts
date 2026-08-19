import { contextBridge, ipcRenderer } from "electron";
import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import type { InterviewStartOptions } from "../main/interview-coordinator";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { QuestionEvent } from "@interview-copilot/shared";
import type { CaptureProtectionCapabilities, CaptureProtectionState, OverlayMode } from "../main/overlay-manager";
import type { TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import type { SessionState } from "@interview-copilot/shared";
import type { Profile, ProfileInput, ProviderSettings } from "@interview-copilot/shared";
import type { ProviderCenterPublicConfig, PublicProviderSettings, ProviderSection } from "../main/settings-store";
import type { ConversationMessageRecord, ConversationRecord, ProjectRecord } from "../main/database";
import type { ProviderCheckResult, ProviderPreflightResult } from "../main/provider-preflight";

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
    setMode: (mode: OverlayMode) => ipcRenderer.invoke("overlay:set-mode", mode),
    getCaptureProtection: (): Promise<CaptureProtectionState> => ipcRenderer.invoke("overlay:get-capture-protection"),
    setCaptureProtection: (enabled: boolean): Promise<CaptureProtectionState | undefined> => ipcRenderer.invoke("overlay:set-capture-protection", enabled),
    getCapabilities: (): Promise<CaptureProtectionCapabilities> => ipcRenderer.invoke("overlay:get-capabilities"),
    getTencentValidation: (): Promise<TencentValidationState> => ipcRenderer.invoke("overlay:get-tencent-validation"),
    setTencentValidation: (mode: "desktopShare" | "windowShare", status: TencentValidationStatus): Promise<TencentValidationState> => ipcRenderer.invoke("overlay:set-tencent-validation", mode, status)
  },
  screenshot: {
    capture: (): Promise<ScreenshotResult> => ipcRenderer.invoke("screenshot:capture")
  },
  session: {
    getState: (): Promise<SessionState> => ipcRenderer.invoke("session:get-state")
  },
  realtime: {
    connect: (options: RealtimeConnectOptions) => ipcRenderer.invoke("realtime:connect", options),
    disconnect: () => ipcRenderer.invoke("realtime:disconnect")
  },
  interview: {
    start: (options: InterviewStartOptions) => ipcRenderer.invoke("interview:start", options) as Promise<string>,
    stop: () => ipcRenderer.invoke("interview:stop") as Promise<void>,
    answerLatest: () => ipcRenderer.invoke("interview:answer-latest") as Promise<void>,
    answerQuestion: (text: string) => ipcRenderer.invoke("interview:answer-question", { text }) as Promise<void>,
    answerScreenshot: () => ipcRenderer.invoke("interview:answer-screenshot") as Promise<void>,
    getState: () => ipcRenderer.invoke("interview:get-state") as Promise<{ running: boolean; interviewId?: string; automationMode: "MANUAL" | "AUTO" }>,
    setAutomationMode: (mode: "MANUAL" | "AUTO") => ipcRenderer.invoke("interview:set-automation-mode", mode) as Promise<boolean>,
    setAnswerMode: (mode: "FAST" | "NORMAL" | "DEEP") => ipcRenderer.invoke("interview:set-answer-mode", mode) as Promise<boolean>
  },
  chat: {
    createConversation: (input: { profileId?: string; projectId?: string; title?: string }): Promise<ConversationRecord> => ipcRenderer.invoke("chat:create-conversation", input),
    listConversations: (profileId?: string): Promise<ConversationRecord[]> => ipcRenderer.invoke("chat:list-conversations", profileId),
    getConversation: (conversationId: string): Promise<{ conversation: ConversationRecord; messages: ConversationMessageRecord[] } | undefined> => ipcRenderer.invoke("chat:get-conversation", conversationId),
    sendMessage: (conversationId: string, content: string): Promise<boolean> => ipcRenderer.invoke("chat:send-message", { conversationId, content }),
    cancel: (conversationId: string): Promise<boolean> => ipcRenderer.invoke("chat:cancel", conversationId),
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
  settings: {
    get: (): Promise<ProviderCenterPublicConfig | undefined> => ipcRenderer.invoke("settings:get"),
    update: (section: ProviderSection, input: Partial<ProviderSettings>): Promise<PublicProviderSettings | undefined> => ipcRenderer.invoke("settings:update", section, input),
    testConnection: (section: ProviderSection): Promise<ProviderCheckResult> => ipcRenderer.invoke("settings:test-connection", section),
    preflight: (checkReachability?: boolean): Promise<ProviderPreflightResult> => ipcRenderer.invoke("settings:preflight", checkReachability)
  },
  projects: {
    list: (): Promise<ProjectRecord[]> => ipcRenderer.invoke("projects:list"),
    create: (input: { name: string; profileId?: string }): Promise<ProjectRecord | undefined> => ipcRenderer.invoke("projects:create", input),
    rename: (projectId: string, name: string): Promise<ProjectRecord | undefined> => ipcRenderer.invoke("projects:rename", projectId, name),
    delete: (projectId: string): Promise<boolean> => ipcRenderer.invoke("projects:delete", projectId)
  },
  knowledge: {
    listBases: () => ipcRenderer.invoke("knowledge:list-bases"),
    createBase: (name: string) => ipcRenderer.invoke("knowledge:create-base", name),
    renameBase: (knowledgeBaseId: string, name: string) => ipcRenderer.invoke("knowledge:rename-base", knowledgeBaseId, name),
    deleteBase: (knowledgeBaseId: string) => ipcRenderer.invoke("knowledge:delete-base", knowledgeBaseId) as Promise<boolean>,
    listDocuments: (knowledgeBaseId?: string) => ipcRenderer.invoke("knowledge:list-documents", knowledgeBaseId),
    ingest: (input: { knowledgeBaseId?: string; filename: string; mimeType: string; bytes: Uint8Array }) => ipcRenderer.invoke("knowledge:ingest", input),
    delete: (documentId: string) => ipcRenderer.invoke("knowledge:delete", documentId),
    reindex: (documentId: string) => ipcRenderer.invoke("knowledge:reindex", documentId)
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
    }
  }
};

contextBridge.exposeInMainWorld("interviewCopilot", api);
