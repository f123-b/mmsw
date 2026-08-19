import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import type { InterviewStartOptions } from "../main/interview-coordinator";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { QuestionEvent } from "@interview-copilot/shared";
import type { OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";
import type { Profile, ProfileInput, ProviderSettings } from "@interview-copilot/shared";
import type { ProviderCenterPublicConfig, PublicProviderSettings, ProviderSection } from "../main/settings-store";

declare global {
  interface Window {
    interviewCopilot: {
      diagnostics: {
        markRendererReady(): void;
      };
      audio: {
        start(options?: AudioStartOptions): Promise<void>;
        stop(): Promise<void>;
        probe(options?: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">): Promise<void>;
        listDevices(): Promise<AudioDevices>;
      };
      overlay: {
        show(): Promise<void>;
        toggle(): Promise<void>;
        setMode(mode: OverlayMode): Promise<void>;
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
        setAutomationMode(mode: "MANUAL" | "AUTO"): Promise<boolean>;
        setAnswerMode(mode: "FAST" | "NORMAL" | "DEEP"): Promise<boolean>;
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
      settings: {
        get(): Promise<ProviderCenterPublicConfig | undefined>;
        update(section: ProviderSection, input: Partial<ProviderSettings>): Promise<PublicProviderSettings | undefined>;
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
      };
      events: {
        onAudio(listener: (event: AudioSidecarEvent) => void): () => void;
        onAudioDiagnostic(listener: (message: string) => void): () => void;
        onSessionState(listener: (state: SessionState) => void): () => void;
        onOverlayMode(listener: (mode: OverlayMode) => void): () => void;
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
      };
    };
  }
}

export {};
