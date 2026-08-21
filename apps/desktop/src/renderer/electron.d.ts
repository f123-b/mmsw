import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import type { InterviewStartOptions } from "../main/interview-coordinator";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { QuestionEvent } from "@interview-copilot/shared";
import type { CaptureProtectionCapabilities, CaptureProtectionState, HUDLayout, HUDState, OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";
import type { Profile, ProfileInput, ProviderSettings } from "@interview-copilot/shared";
import type { ProviderCenterPublicConfig, PublicProviderSettings, ProviderSection, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import type { ConversationMessageRecord, ConversationRecord, ProfileBuilderArtifactRecord, ProjectRecord } from "../main/database";
import type { ProviderCheckResult, ProviderPreflightResult } from "../main/provider-preflight";

declare global {
  interface Window {
    interviewCopilot: {
      diagnostics: {
        markRendererReady(): void;
      };
      audio: {
        start(options?: AudioStartOptions): Promise<void>;
        stop(): Promise<void>;
        probe(options?: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">): Promise<import("@interview-copilot/protocol").ProbeResult>;
        listDevices(): Promise<AudioDevices>;
      };
      overlay: {
        show(): Promise<void>;
        toggle(): Promise<void>;
        showAll(): Promise<boolean>;
        hideAll(): Promise<boolean>;
        toggleAll(): Promise<boolean>;
        resetLayout(): Promise<boolean>;
        toggleShortcuts(): Promise<boolean>;
        getState(): Promise<HUDState | undefined>;
        getLayout(): Promise<HUDLayout | undefined>;
        setShareMode(enabled: boolean): Promise<HUDState | undefined>;
        toggleShareMode(): Promise<HUDState | undefined>;
        setMode(mode: OverlayMode): Promise<void>;
        setControlRegion(interactive: boolean): Promise<boolean>;
        getCaptureProtection(): Promise<CaptureProtectionState>;
        setCaptureProtection(enabled: boolean): Promise<CaptureProtectionState | undefined>;
        getCapabilities(): Promise<CaptureProtectionCapabilities>;
        getTencentValidation(): Promise<TencentValidationState>;
        setTencentValidation(mode: "desktopShare" | "windowShare", status: TencentValidationStatus): Promise<TencentValidationState>;
      };
      screenshot: {
        capture(): Promise<ScreenshotResult>;
      };
      session: {
        getState(): Promise<SessionState>;
      };
      realtime: {
        connect(options: RealtimeConnectOptions): Promise<boolean>;
        disconnect(): Promise<boolean>;
      };
      interview: {
        start(options: InterviewStartOptions): Promise<string>;
        stop(): Promise<void>;
        answerLatest(): Promise<void>;
        answerQuestion(text: string): Promise<void>;
        answerScreenshot(): Promise<void>;
        getState(): Promise<{ running: boolean; interviewId?: string; automationMode: "MANUAL" | "AUTO" }>;
        setAutomationMode(mode: "MANUAL" | "AUTO"): Promise<boolean>;
        setAnswerMode(mode: "FAST" | "NORMAL" | "DEEP"): Promise<boolean>;
      };
      chat: {
        createConversation(input: { profileId?: string; projectId?: string; title?: string }): Promise<ConversationRecord>;
        listConversations(profileId?: string): Promise<ConversationRecord[]>;
        getConversation(conversationId: string): Promise<{ conversation: ConversationRecord; messages: ConversationMessageRecord[] } | undefined>;
        sendMessage(conversationId: string, content: string): Promise<boolean>;
        cancel(conversationId: string): Promise<boolean>;
        deleteConversation(conversationId: string): Promise<boolean>;
      };
      profiles: {
        list(): Promise<Profile[]>;
        get(profileId: string): Promise<Profile | undefined>;
        save(input: Profile | ProfileInput): Promise<Profile | undefined>;
        delete(profileId: string): Promise<boolean>;
        clone(profileId: string, name: string): Promise<Profile | undefined>;
        selectActive(profileId: string): Promise<Profile | undefined>;
        active(): Promise<Profile | undefined>;
        attachMaterial(input: { profileId: string; kind: "resume" | "jobDescription"; filename: string; mimeType: string; bytes: Uint8Array }): Promise<Profile | undefined>;
        removeMaterial(profileId: string, kind: "resume" | "jobDescription"): Promise<Profile | undefined>;
      };
      profileBuilder: {
        get(profileId: string): Promise<ProfileBuilderArtifactRecord | undefined>;
        rebuild(profileId: string): Promise<ProfileBuilderArtifactRecord>;
      };
      settings: {
        get(): Promise<ProviderCenterPublicConfig | undefined>;
        update(section: ProviderSection, input: Partial<ProviderSettings>): Promise<PublicProviderSettings | undefined>;
        testConnection(section: ProviderSection): Promise<ProviderCheckResult>;
        preflight(checkReachability?: boolean): Promise<ProviderPreflightResult>;
      };
      projects: {
        list(): Promise<ProjectRecord[]>;
        create(input: { name: string; profileId?: string }): Promise<ProjectRecord | undefined>;
        rename(projectId: string, name: string): Promise<ProjectRecord | undefined>;
        delete(projectId: string): Promise<boolean>;
      };
      knowledge: {
        listBases(): Promise<Array<{ id: string; name: string; createdAt: number; updatedAt: number }>>;
        createBase(name: string): Promise<{ id: string; name: string; createdAt: number; updatedAt: number } | undefined>;
        renameBase(knowledgeBaseId: string, name: string): Promise<{ id: string; name: string; createdAt: number; updatedAt: number } | undefined>;
        deleteBase(knowledgeBaseId: string): Promise<boolean>;
        listDocuments(knowledgeBaseId?: string): Promise<Array<{ id: string; knowledgeBaseId: string; filename: string; mimeType: string; status: string; error?: string }>>;
        ingest(input: { knowledgeBaseId?: string; filename: string; mimeType: string; bytes: Uint8Array }): Promise<unknown>;
        delete(documentId: string): Promise<boolean>;
        reindex(documentId: string): Promise<unknown>;
      };
      history: {
        list(): Promise<Array<{ id: string; profileId: string; startedAt: number; endedAt?: number; status: string; language: string; automationMode: string; createdAt: number }>>;
        get(interviewId: string): Promise<unknown>;
        analyze(interviewId: string): Promise<{ durationMs: number; questionCount: number; answeredQuestionCount: number; answerRate: number; averageFirstTokenMs?: number; averageAnswerLatencyMs?: number } | undefined>;
        getAnalysis(interviewId: string): Promise<unknown>;
        delete(interviewId: string): Promise<boolean>;
      };
      preparation: {
        start(goal: string): Promise<boolean>;
        approve(requestId: string): Promise<boolean>;
        reject(requestId: string): Promise<boolean>;
        stop(): Promise<boolean>;
      };
      events: {
        onAudio(listener: (event: AudioSidecarEvent) => void): () => void;
        onAudioDiagnostic(listener: (message: string) => void): () => void;
        onSessionState(listener: (state: SessionState) => void): () => void;
        onOverlayMode(listener: (mode: OverlayMode) => void): () => void;
        onOverlayState(listener: (state: HUDState) => void): () => void;
        onOverlayLayout(listener: (layout: HUDLayout) => void): () => void;
        onOverlayCommand(listener: (command: "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end") => void): () => void;
        onOverlayCaptureProtection(listener: (state: CaptureProtectionState) => void): () => void;
        onShortcut(listener: (shortcut: string) => void): () => void;
        onAudioProcess(listener: (state: AudioProcessState) => void): () => void;
        onScreenshot(listener: (result: ScreenshotResult) => void): () => void;
        onScreenshotError(listener: (message: string) => void): () => void;
        onScreenshotDiagnostic(listener: (message: string) => void): () => void;
        onRealtimeState(listener: (state: string) => void): () => void;
        onRealtimeDiagnostics(listener: (diagnostics: AsrRuntimeDiagnostics) => void): () => void;
        onRealtimeTranscript(listener: (snapshot: TranscriptSnapshot) => void): () => void;
        onRealtimeMessage(listener: (message: RealtimeServerMessage) => void): () => void;
        onRealtimeDiagnostic(listener: (message: string) => void): () => void;
        onRuntimeError(listener: (error: { code: string; message: string; recoverable: boolean }) => void): () => void;
        onQuestion(listener: (event: QuestionEvent) => void): () => void;
        onAutomationMode(listener: (mode: "MANUAL" | "AUTO") => void): () => void;
        onAnswerMode(listener: (mode: "FAST" | "NORMAL" | "DEEP") => void): () => void;
        onPreparationEvent(listener: (event: unknown) => void): () => void;
        onChatMessageStart(listener: (event: unknown) => void): () => void;
        onChatMessageDelta(listener: (event: unknown) => void): () => void;
        onChatMessageEnd(listener: (event: unknown) => void): () => void;
        onChatError(listener: (event: unknown) => void): () => void;
        onProfileBuilderUpdated(listener: (event: ProfileBuilderArtifactRecord) => void): () => void;
      };
    };
  }
}

export {};
