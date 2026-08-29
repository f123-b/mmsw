import type { AudioProcessState, AudioStartOptions } from "../main/audio-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { ScreenshotDiagnostics, ScreenshotTraceEvent } from "../main/screenshot-pipeline";
import type { AudioDevices, AudioSidecarEvent } from "@interview-copilot/protocol";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import type { RealtimeConnectOptions } from "../main/realtime-session";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import type { InterviewStartOptions } from "../main/interview-coordinator";
import type { WrittenTestStartOptions, WrittenTestState } from "../main/written-test-controller";
import type { HistoryChangedEvent, TranscriptSnapshot } from "@interview-copilot/shared";
import type { QuestionEvent } from "@interview-copilot/shared";
import type { CaptureProtectionCapabilities, CaptureProtectionState, HUDLayout, HUDState, OverlayMode } from "../main/overlay-manager";
import type { SessionState } from "@interview-copilot/shared";
import type { ChatAction, KnowledgeDocumentType, Profile, ProfileInput, ProjectAnalysisJob, ProjectFact, ProjectMaterialImportReport, ProjectMemorySnapshot, ProjectQaGenerationResult, ProjectQuestionBankImportReport, ProjectSourceRole, ProviderSettings, QuestionBankCoverageResult, QuestionBankJobProfileRecord, QuestionBankQuestionRecord, QuestionBankRelationRecord, QuestionBankRouteResult, QuestionBankSkillRecord, QuestionBankAnswerCardRecord } from "@interview-copilot/shared";
import type { LlmModelProfileInput, OverlayPreferences, ProviderCenterPublicConfig, PublicProviderSettings, ProviderSection, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import type { ConversationMessageRecord, ConversationRecord, JobTargetRecord, KnowledgeAnalysisRunRecord, ProfileBuilderArtifactRecord, ProjectAnalysisState, ProjectMemoryStats, ProjectRecord, QuestionBankAnswerCardInput, QuestionBankAnswerGenerationResult, QuestionBankBulkPatch, QuestionBankDuplicateCluster, QuestionBankImportResult, QuestionBankJobProfileInput, QuestionBankListOptions, QuestionBankQuestionInput, QuestionBankRelationInput, QuestionBankRouteQuery, QuestionBankSkillInput, QuestionBankSkillPointInput, RetrievalRunRecord } from "../main/database";
import type { ProviderCheckResult, ProviderPreflightResult } from "../main/provider-preflight";
import type { LocalAsrHealthCheck, LocalAsrStartOptions } from "../main/local-asr-service-manager";
import type { ModelCatalogResult } from "../main/model-catalog";
import type { InterviewExportResult } from "../main/history-export";

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
        getPreferences(): Promise<OverlayPreferences>;
        setPreferences(input: Partial<OverlayPreferences>): Promise<OverlayPreferences>;
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
        getDiagnostics(): Promise<ScreenshotDiagnostics>;
        getTrace(limit?: number): Promise<ScreenshotTraceEvent[]>;
      };
      session: {
        getState(): Promise<SessionState>;
      };
      realtime: {
        connect(options: RealtimeConnectOptions): Promise<boolean>;
        disconnect(): Promise<boolean>;
        getTranscript(): Promise<Partial<Record<"mic" | "remote", TranscriptSnapshot>>>;
      };
      localAsr: {
        health(options?: LocalAsrStartOptions): Promise<LocalAsrHealthCheck>;
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
        continueMessage(conversationId: string, messageId: string): Promise<boolean>;
        cancel(conversationId: string, reason?: "user_stop" | "navigation" | "shutdown" | "superseded" | "provider_abort" | "timeout"): Promise<boolean>;
        approveAction(input: { conversationId: string; messageId: string; action: ChatAction }): Promise<{ actionId: string; status: "approved"; result: unknown }>;
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
        stats(profileId: string, projectId?: string): Promise<ProjectMemoryStats>;
        listFacts(profileId: string, projectId?: string, options?: { includeStale?: boolean; includeRejected?: boolean }): Promise<ProjectFact[]>;
        addCandidateFact(fact: ProjectFact): Promise<ProjectFact | undefined>;
        addResponsibility(profileId: string, projectId: string, content: string): Promise<ProjectFact | undefined>;
        confirmFact(factId: string): Promise<ProjectFact | undefined>;
        verifyFact(factId: string, verified: boolean): Promise<ProjectFact | undefined>;
        reviewFact(factId: string, status: "active" | "pending_review" | "rejected" | "conflicting"): Promise<ProjectFact | undefined>;
        resolveConflict(conflictGroupId: string, selectedFactId: string, keepBoth?: boolean, variantContexts?: Record<string, string>): Promise<ProjectFact[]>;
        conflictGroups(projectId: string, includeResolved?: boolean): Promise<unknown[]>;
        userActions(projectId: string): Promise<unknown[]>;
        repairSemantics(projectId: string): Promise<ProjectFact[]>;
        sources(projectId: string): Promise<unknown[]>;
        completeness(profileId: string, projectId: string): Promise<unknown>;
        analysisRuns(profileId: string): Promise<KnowledgeAnalysisRunRecord[]>;
        state(projectId: string): Promise<ProjectAnalysisState | undefined>;
        assignSource(input: { profileId: string; projectId: string; sourceType: "document" | "repository" | "resume_section" | "user_fact"; sourceId: string; relationship?: "primary" | "supporting" | "reference"; sourceRole?: string; assignmentMethod?: string; confidence?: number; verified?: boolean }): Promise<boolean>;
        unassignSource(projectId: string, sourceType: string, sourceId: string): Promise<boolean>;
        assignDocument(profileId: string, documentId: string, projectId?: string): Promise<unknown>;
        rebuild(profileId: string): Promise<ProjectMemorySnapshot>;
        rebuildProject(projectId: string): Promise<ProjectAnalysisJob>;
        analysisJob(projectId: string): Promise<ProjectAnalysisJob | undefined>;
        analysisJobs(profileId: string): Promise<ProjectAnalysisJob[]>;
        cancelAnalysis(projectId: string, jobId?: string): Promise<ProjectAnalysisJob | undefined>;
        retryAnalysis(profileId: string, projectId: string): Promise<ProjectAnalysisJob | undefined>;
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
        testConnection(section: ProviderSection, profileId?: string): Promise<ProviderCheckResult>;
        listModels(section: ProviderSection, profileId?: string): Promise<ModelCatalogResult>;
        preflight(checkReachability?: boolean): Promise<ProviderPreflightResult>;
      };
      projects: {
        list(): Promise<ProjectRecord[]>;
        create(input: { name: string; profileId?: string; ownershipMode?: "personal" | "team" | "partial" | "reference"; ownershipNote?: string }): Promise<ProjectRecord | undefined>;
        rename(projectId: string, name: string): Promise<ProjectRecord | undefined>;
        update(projectId: string, input: { name?: string; ownershipMode?: "personal" | "team" | "partial" | "reference"; ownershipNote?: string }): Promise<ProjectRecord | undefined>;
        delete(projectId: string): Promise<boolean>;
      };
      knowledge: {
        listBases(): Promise<Array<{ id: string; name: string; createdAt: number; updatedAt: number }>>;
        createBase(name: string): Promise<{ id: string; name: string; createdAt: number; updatedAt: number } | undefined>;
        renameBase(knowledgeBaseId: string, name: string): Promise<{ id: string; name: string; createdAt: number; updatedAt: number } | undefined>;
        deleteBase(knowledgeBaseId: string): Promise<boolean>;
        listDocuments(knowledgeBaseId?: string): Promise<Array<{ id: string; knowledgeBaseId: string; filename: string; mimeType: string; documentType: KnowledgeDocumentType; status: string; error?: string }>>;
        ingest(input: { knowledgeBaseId?: string; profileId?: string; projectId?: string; sourceRole?: ProjectSourceRole | "auto"; filename: string; mimeType: string; bytes: Uint8Array; documentType?: KnowledgeDocumentType | "auto" }): Promise<unknown>;
        ingestProjectMaterials(input: { profileId: string; projectId: string; knowledgeBaseId: string; files: Array<{ filename: string; mimeType: string; bytes: Uint8Array; sourceRole?: ProjectSourceRole | "auto" }> }): Promise<ProjectMaterialImportReport>;
        ingestProjectQuestionBank(input: { profileId: string; projectId: string; filename: string; mimeType: string; bytes: Uint8Array }): Promise<ProjectQuestionBankImportReport>;
        updateType(documentId: string, documentType: KnowledgeDocumentType): Promise<unknown>;
        delete(documentId: string): Promise<boolean>;
        reindex(documentId: string): Promise<unknown>;
      };
      questionBank: {
        list(options?: QuestionBankListOptions): Promise<QuestionBankQuestionRecord[]>;
        count(options?: Omit<QuestionBankListOptions, "limit" | "offset" | "sort">): Promise<number>;
        bulkUpdate(questionIds: string[], patch: QuestionBankBulkPatch): Promise<number>;
        duplicates(limit?: number): Promise<QuestionBankDuplicateCluster[]>;
        mergeDuplicates(canonicalId: string, duplicateIds: string[]): Promise<QuestionBankQuestionRecord | undefined>;
        get(questionId: string): Promise<QuestionBankQuestionRecord | undefined>;
        saveQuestion(input: QuestionBankQuestionInput): Promise<QuestionBankQuestionRecord | undefined>;
        deleteQuestion(questionId: string): Promise<boolean>;
        saveAnswer(input: QuestionBankAnswerCardInput): Promise<QuestionBankAnswerCardRecord | undefined>;
        deleteAnswer(answerCardId: string): Promise<boolean>;
        route(text: string, options?: QuestionBankRouteQuery): Promise<QuestionBankRouteResult | undefined>;
        saveRelation(input: QuestionBankRelationInput): Promise<QuestionBankRelationRecord | undefined>;
        listRelations(questionId?: string): Promise<QuestionBankRelationRecord[]>;
        deleteRelation(relationId: string): Promise<boolean>;
        listSkills(search?: string): Promise<QuestionBankSkillRecord[]>;
        saveSkill(input: QuestionBankSkillInput): Promise<QuestionBankSkillRecord | undefined>;
        saveSkillPoint(input: QuestionBankSkillPointInput): Promise<unknown>;
        linkSkill(questionId: string, skillId: string): Promise<boolean>;
        listJobs(): Promise<QuestionBankJobProfileRecord[]>;
        coverage(jobProfileId?: string): Promise<QuestionBankCoverageResult>;
        saveJob(input: QuestionBankJobProfileInput): Promise<QuestionBankJobProfileRecord | undefined>;
        importText(input: { text: string; filename?: string; includeProject?: boolean; includeBehavioral?: boolean }): Promise<QuestionBankImportResult | undefined>;
        generateAnswers(input?: { questionIds?: string[]; onlyUnanswered?: boolean }): Promise<QuestionBankAnswerGenerationResult>;
        generateProjectQa(projectId: string): Promise<ProjectQaGenerationResult>;
        match(text: string): Promise<{ question: QuestionBankQuestionRecord; score: number; exact: boolean } | undefined>;
      };
      history: {
        list(): Promise<Array<{ id: string; profileId: string; startedAt: number; endedAt?: number; status: string; language: string; automationMode: string; createdAt: number }>>;
        get(interviewId: string): Promise<unknown>;
        analyze(interviewId: string): Promise<{ durationMs: number; questionCount: number; answeredQuestionCount: number; answerRate: number; averageFirstTokenMs?: number; averageAnswerLatencyMs?: number } | undefined>;
        getAnalysis(interviewId: string): Promise<unknown>;
        delete(interviewId: string): Promise<boolean>;
        export(interviewId: string): Promise<InterviewExportResult>;
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
        onHistoryChanged(listener: (event: HistoryChangedEvent) => void): () => void;
        onOverlayMode(listener: (mode: OverlayMode) => void): () => void;
        onOverlayState(listener: (state: HUDState) => void): () => void;
        onOverlayLayout(listener: (layout: HUDLayout) => void): () => void;
        onOverlayPreferences(listener: (preferences: OverlayPreferences) => void): () => void;
        onOverlayCommand(listener: (command: "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end") => void): () => void;
        onOverlayCaptureProtection(listener: (state: CaptureProtectionState) => void): () => void;
        onShortcut(listener: (shortcut: string) => void): () => void;
        onAudioProcess(listener: (state: AudioProcessState) => void): () => void;
        onScreenshot(listener: (result: ScreenshotResult) => void): () => void;
        onScreenshotError(listener: (message: string) => void): () => void;
      onScreenshotDiagnostic(listener: (message: string) => void): () => void;
      onScreenshotTrace(listener: (event: ScreenshotTraceEvent) => void): () => void;
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
        onChatCancelled(listener: (event: unknown) => void): () => void;
        onProfileBuilderUpdated(listener: (event: ProfileBuilderArtifactRecord) => void): () => void;
        onProjectAnalysisJob(listener: (event: ProjectAnalysisJob) => void): () => void;
        onQuestionBankAnswerGenerationProgress(listener: (event: { status: "started" | "running" | "completed"; total: number; completed: number; generated: number; skipped: number; failed: number; questionId?: string; error?: string }) => void): () => void;
      };
    };
  }
}

export {};
