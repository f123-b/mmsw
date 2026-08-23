import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import type { InterviewStartOptions } from "../main/interview-coordinator";
import type { WrittenTestStartOptions, WrittenTestState } from "../main/written-test-controller";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { QuestionEvent } from "@interview-copilot/shared";
import type { CaptureProtectionCapabilities, CaptureProtectionState, HUDLayout, HUDState, OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";
import type { KnowledgeDocumentType, Profile, ProfileInput, ProjectFact, ProjectMemorySnapshot, ProviderSettings, QuestionBankJobProfileRecord, QuestionBankQuestionRecord, QuestionBankType, QuestionBankSkillRecord, QuestionBankAnswerCardRecord } from "@interview-copilot/shared";
import type { LlmModelProfileInput, ProviderCenterPublicConfig, PublicProviderSettings, ProviderSection, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import type { ConversationMessageRecord, ConversationRecord, JobTargetRecord, KnowledgeAnalysisRunRecord, ProfileBuilderArtifactRecord, ProjectMemoryStats, ProjectRecord, QuestionBankAnswerCardInput, QuestionBankAnswerGenerationResult, QuestionBankImportResult, QuestionBankJobProfileInput, QuestionBankQuestionInput, QuestionBankSkillInput, QuestionBankSkillPointInput, RetrievalRunRecord } from "../main/database";
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
        toggleTranscript(): Promise<boolean>;
        toggleAnswer(): Promise<boolean>;
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
      writtenTest: {
        start(options: WrittenTestStartOptions): Promise<boolean>;
        stop(): Promise<boolean>;
        answerScreenshot(): Promise<void>;
        getState(): Promise<WrittenTestState>;
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
      projectMemory: {
        get(profileId: string): Promise<ProjectMemorySnapshot | undefined>;
        stats(profileId: string): Promise<ProjectMemoryStats>;
        listFacts(profileId: string, projectId?: string): Promise<ProjectFact[]>;
        verifyFact(factId: string, verified: boolean): Promise<ProjectFact | undefined>;
        analysisRuns(profileId: string): Promise<KnowledgeAnalysisRunRecord[]>;
        rebuild(profileId: string): Promise<ProjectMemorySnapshot>;
      };
      jobTargets: {
        list(profileId: string): Promise<JobTargetRecord[]>;
      };
      retrieval: {
        list(profileId: string, limit?: number): Promise<RetrievalRunRecord[]>;
      };
      settings: {
        get(): Promise<ProviderCenterPublicConfig | undefined>;
        update(section: ProviderSection, input: Partial<ProviderSettings>): Promise<PublicProviderSettings | undefined>;
        saveLlmProfile(input: LlmModelProfileInput): Promise<ProviderCenterPublicConfig | undefined>;
        activateLlmProfile(profileId: string): Promise<ProviderCenterPublicConfig | undefined>;
        deleteLlmProfile(profileId: string): Promise<ProviderCenterPublicConfig | undefined>;
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
        listDocuments(knowledgeBaseId?: string): Promise<Array<{ id: string; knowledgeBaseId: string; filename: string; mimeType: string; documentType: KnowledgeDocumentType; status: string; error?: string }>>;
        ingest(input: { knowledgeBaseId?: string; filename: string; mimeType: string; bytes: Uint8Array; documentType?: KnowledgeDocumentType | "auto" }): Promise<unknown>;
        updateType(documentId: string, documentType: KnowledgeDocumentType): Promise<unknown>;
        delete(documentId: string): Promise<boolean>;
        reindex(documentId: string): Promise<unknown>;
      };
      questionBank: {
        list(options?: { search?: string; type?: QuestionBankType; limit?: number }): Promise<QuestionBankQuestionRecord[]>;
        get(questionId: string): Promise<QuestionBankQuestionRecord | undefined>;
        saveQuestion(input: QuestionBankQuestionInput): Promise<QuestionBankQuestionRecord | undefined>;
        deleteQuestion(questionId: string): Promise<boolean>;
        saveAnswer(input: QuestionBankAnswerCardInput): Promise<QuestionBankAnswerCardRecord | undefined>;
        deleteAnswer(answerCardId: string): Promise<boolean>;
        listSkills(search?: string): Promise<QuestionBankSkillRecord[]>;
        saveSkill(input: QuestionBankSkillInput): Promise<QuestionBankSkillRecord | undefined>;
        saveSkillPoint(input: QuestionBankSkillPointInput): Promise<unknown>;
        linkSkill(questionId: string, skillId: string): Promise<boolean>;
        listJobs(): Promise<QuestionBankJobProfileRecord[]>;
        saveJob(input: QuestionBankJobProfileInput): Promise<QuestionBankJobProfileRecord | undefined>;
        importText(input: { text: string; filename?: string; includeProject?: boolean; includeBehavioral?: boolean }): Promise<QuestionBankImportResult | undefined>;
        generateAnswers(input?: { questionIds?: string[]; onlyUnanswered?: boolean }): Promise<QuestionBankAnswerGenerationResult>;
        match(text: string): Promise<{ question: QuestionBankQuestionRecord; score: number; exact: boolean } | undefined>;
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
        onWrittenTestState(listener: (state: WrittenTestState) => void): () => void;
        onPreparationEvent(listener: (event: unknown) => void): () => void;
        onChatMessageStart(listener: (event: unknown) => void): () => void;
        onChatMessageDelta(listener: (event: unknown) => void): () => void;
        onChatMessageEnd(listener: (event: unknown) => void): () => void;
        onChatError(listener: (event: unknown) => void): () => void;
        onProfileBuilderUpdated(listener: (event: ProfileBuilderArtifactRecord) => void): () => void;
        onQuestionBankAnswerGenerationProgress(listener: (event: { status: "started" | "running" | "completed"; total: number; completed: number; generated: number; skipped: number; failed: number; questionId?: string; error?: string }) => void): () => void;
      };
    };
  }
}

export {};
