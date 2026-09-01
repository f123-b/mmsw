import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ClientControlMessage, RealtimeServerMessage, TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerAgent,
  analyzeAnswerIntent,
  classifyAnswerQuestion,
  FollowUpContextResolver,
  InterviewBrain,
  InterviewMemory,
  InterviewHistoryStore,
  normalizeTechnicalTerms,
  buildDynamicTechnicalLexicon,
  classifyQuestionSemanticFrame,
  AnswerScheduler,
  answerRelationForQuestion,
  analyzeQuestionNucleus,
  QuestionGroupManager,
  TurnBuilder,
  ContextAnchorStore,
  ContextLock,
  SessionEvidenceStore,
  requiresPersonalClaimEvidence,
  SpeechActClassifier,
  SemanticTurnGate,
  QuestionUnderstanding,
  CanonicalRemoteTurnAssembler,
  AmbiguousSemanticResolver,
  type CanonicalRemoteTurn,
  ActiveProjectResolver,
  InterviewMemo,
  RuntimeInterviewTelemetry,
  ProjectConsistencyGuard,
  ProjectTruthGuard,
  stripClaimGateAuditText,
  WrittenProblemStateStore,
  shouldHardRejectSpeechAct,
  QuestionTrace,
  questionTraceTextMetadata,
  QuestionDetector,
  QuestionDetector2,
  SessionStateMachine,
  TechnicalTerminologyNormalizer,
  ContextAwareAsrNormalizer,
  buildSessionTerminologyContext,
  splitIntraSegmentQuestions,
  evaluateSubstantiveAnchorEligibility,
  UnresolvedAsrGate,
  planAnswerSource,
  type AnswerContextInput,
  type AnswerTelemetry,
  type DynamicTechnicalLexicon,
  type AnswerMode,
  type AnswerRecord,
  type AsrLanguage,
  type ModelSnapshot,
  type InterviewRecord,
  type InterviewDirectionSelection,
  type QuestionRecord,
  type QuestionCandidate,
  type QuestionEvent,
  type SessionState,
  type TranscriptRecord,
  type TranscriptUtterance,
  type InterviewTurn,
  type EvidenceSnapshot,
  type CandidateStatementEvidence,
  type FollowUpContext,
  type VisionInput,
  type QuestionGroup,
  type ProjectAliasCandidate,
  type SessionTerminologyContext,
  type TerminologyRolloutMode,
  type AmbiguousSemanticClient
} from "@interview-copilot/shared";
import type { AudioStartOptions } from "./audio-manager";
import type { RealtimeConnectOptions, RealtimeConnectionState } from "./realtime-session";
import {
  RuntimeAbortRegistry,
  RuntimeLatencyTelemetry,
  RuntimeTimerRegistry,
  RuntimeTraceBuffer,
  withRuntimeTimeout,
  type InterviewRuntimeDiagnostics,
  type RuntimeAnswerState,
  type RuntimeLatencyMetrics,
  type RuntimeQuestionState,
  type RuntimeSessionState,
  type RuntimeTraceEvent,
  type RuntimeTraceEventName
} from "./runtime-diagnostics";
import type { ScreenshotTraceEvent, ScreenshotTraceEventName } from "./screenshot-pipeline";

export interface InterviewAudioPort {
  readonly configuredPath?: string;
  readonly isRunning?: boolean;
  start(options: AudioStartOptions): void | Promise<void>;
  stop(): void | Promise<void>;
  waitForIdle?(timeoutMs?: number): Promise<void>;
  on(event: "pcm-packet" | "event" | "diagnostic", listener: (...args: any[]) => void): this;
}

export interface InterviewASRPort {
  connect(options: RealtimeConnectOptions): void;
  finalize?(timeoutMs?: number): Promise<void>;
  disconnect(): void;
  sendAudio(packet: Uint8Array): void;
  sendControl(message: ClientControlMessage): void;
  on(event: "state" | "transcript" | "message" | "diagnostic", listener: (...args: any[]) => void): this;
}

/** Backward-compatible name retained for integrations built before ASRManager. */
export type InterviewRealtimePort = InterviewASRPort;

export interface InterviewStartOptions extends Omit<RealtimeConnectOptions, "autoReconnect" | "language"> {
  profileId: string;
  projectId?: string;
  jobTargetId?: string;
  inputDeviceId?: string;
  outputDeviceId?: string;
  automationMode?: "MANUAL" | "AUTO";
  answerMode: AnswerMode;
  language?: string;
  terminologyLexicon?: DynamicTechnicalLexicon;
  terminologyContext?: SessionTerminologyContext;
  terminologyMode?: TerminologyRolloutMode;
  /** Optional per-interview direction selection; absent keeps the legacy route. */
  directionSelection?: InterviewDirectionSelection;
  /** Candidate project index used by the sticky active-project resolver. */
  projectCandidates?: readonly ProjectAliasCandidate[];
  /** Precomputed low-churn context shared by every answer in this session. */
  stableInterviewPrefix?: string;
}

export interface InterviewContextSelection {
  /** Live requests use the preloaded lane; rich retrieval is background work. */
  contextMode?: "fast" | "rich";
  /** Lifecycle hook for detached rich retrieval; never part of the answer contract. */
  onRichContext?: (phase: "started" | "completed") => void;
  projectId?: string;
  jobTargetId?: string;
  followUpContext?: FollowUpContext;
}

export interface InterviewHistoryPort {
  createInterview(input: Omit<InterviewRecord, "id" | "createdAt">, now?: number): InterviewRecord;
  endInterview(interviewId: string, status?: "ended" | "error", endedAt?: number): InterviewRecord;
  addTranscript(input: Omit<TranscriptRecord, "id" | "createdAt">, now?: number): TranscriptRecord | undefined;
  addQuestion(input: Omit<QuestionRecord, "id">): QuestionRecord;
  updateQuestionStatus?(questionId: string, status: QuestionRecord["status"]): QuestionRecord | undefined;
  addAnswer(input: Omit<AnswerRecord, "id">): AnswerRecord;
  getRevision?(interviewId: string): number;
}

export interface InterviewCoordinatorOptions {
  audio: InterviewAudioPort;
  asrManager?: InterviewASRPort;
  realtime?: InterviewRealtimePort;
  session: SessionStateMachine;
  answerAgent: AnswerAgent;
  detector?: QuestionDetector;
  questionDetector2?: QuestionDetector2;
  memory?: InterviewMemory;
  history?: InterviewHistoryPort;
  contextProvider?: (question: QuestionCandidate, profileId: string, recentTranscript: string[], context?: InterviewContextSelection) => AnswerContextInput | Promise<AnswerContextInput>;
  terminologyLexiconProvider?: (profileId: string, projectId?: string, jobTargetId?: string) => DynamicTechnicalLexicon | Promise<DynamicTechnicalLexicon>;
  terminologyContextProvider?: (profileId: string, projectId?: string, jobTargetId?: string, directionSelection?: InterviewDirectionSelection) => SessionTerminologyContext | Promise<SessionTerminologyContext>;
  terminologyModeProvider?: (profileId: string) => TerminologyRolloutMode;
  asrSettingsProvider?: (profileId: string) => Pick<RealtimeConnectOptions, "providerType" | "providerName" | "model" | "language" | "url">;
  interviewBrain?: InterviewBrain;
  now?: () => number;
  initialAutomationMode?: "MANUAL" | "AUTO";
  /** Live interview confirmation debounce. Kept configurable for ASR providers with slower finalization. */
  questionSilenceMs?: number;
  /** Upper bound for one answer so a stalled provider cannot block queued questions. */
  answerTimeoutMs?: number;
  /** Upper bound between provider start and its first visible token. */
  providerFirstTokenTimeoutMs?: number;
  /** Upper bound for profile/project retrieval before the answer is failed. */
  contextTimeoutMs?: number;
  /** Hard boundary for local session cleanup after graceful cancellation. */
  stopTimeoutMs?: number;
  /** Optional main-process startup trace hooks. They never affect runtime behavior. */
  onStartupTiming?: (event: "AUDIO_READY" | "ASR_READY") => void;
  /** Warm the local question model during session startup, off the ASR path. */
  questionClassifierWarmup?: () => Promise<unknown>;
  /** Optional tiny JSON resolver for the 0.40–0.85 confidence band only. */
  ambiguousSemanticResolver?: AmbiguousSemanticClient;
}

export type InterviewCoordinatorEvent =
  | { type: "session_state"; state: SessionState }
  | { type: "transcript"; snapshot: unknown; segment: TranscriptSegment }
  | { type: "question"; event: QuestionEvent }
  | { type: "realtime_message"; message: RealtimeServerMessage }
  | { type: "realtime_state"; state: RealtimeConnectionState }
  | { type: "automation_mode"; mode: "MANUAL" | "AUTO" }
  | { type: "answer_mode"; mode: AnswerMode }
  | { type: "diagnostic"; message: string }
  | { type: "telemetry"; name: string; fields: Record<string, unknown> }
  | { type: "runtime_trace"; event: RuntimeTraceEvent }
  | { type: "screenshot_trace"; event: ScreenshotTraceEvent };

interface RuntimeQuestionRecord {
  question: QuestionCandidate;
  state: RuntimeQuestionState;
  sessionGeneration: number;
}

interface RuntimeAnswerRecord {
  operationId: string;
  questionId: string;
  sessionGeneration: number;
  providerRequestId: string;
  state: RuntimeAnswerState;
  controller: AbortController;
  answerId?: string;
  startedAt: number;
  firstTokenAt?: number;
  detached?: boolean;
  screenshotRequestId?: string;
}

export class InterviewCoordinator extends EventEmitter {
  private readonly detector: QuestionDetector;
  private readonly detector2: QuestionDetector2;
  private readonly brain: InterviewBrain;
  private readonly followUpContextResolver = new FollowUpContextResolver();
  private readonly memory: InterviewMemory;
  private readonly history: InterviewHistoryPort;
  private readonly now: () => number;
  private readonly speechActClassifier = new SpeechActClassifier();
  private readonly semanticTurnGate = new SemanticTurnGate(this.speechActClassifier);
  private readonly questionUnderstanding = new QuestionUnderstanding();
  private readonly ambiguousSemanticResolver: AmbiguousSemanticResolver;
  private readonly unresolvedAsrGate = new UnresolvedAsrGate();
  private readonly anchorStore: ContextAnchorStore;
  private sessionTerminologyLexicon: DynamicTechnicalLexicon = buildDynamicTechnicalLexicon();
  private readonly sessionTerminologyNormalizer = new TechnicalTerminologyNormalizer({ mode: "high_confidence" });
  private readonly contextAwareAsrNormalizer = new ContextAwareAsrNormalizer();
  private sessionTerminologyContext: SessionTerminologyContext | undefined;
  private readonly turnBuilder = new TurnBuilder();
  private readonly questionGroups = new QuestionGroupManager(this.turnBuilder);
  private readonly answerScheduler = new AnswerScheduler();
  private readonly canonicalRemoteTurnAssembler = new CanonicalRemoteTurnAssembler({ maxGapMs: 2_000, semanticGate: this.semanticTurnGate });
  private readonly activeProjectResolver = new ActiveProjectResolver();
  private readonly projectConsistencyGuard = new ProjectConsistencyGuard();
  private readonly interviewMemo = new InterviewMemo();
  private readonly interviewTelemetry = new RuntimeInterviewTelemetry();
  private readonly writtenProblemState = new WrittenProblemStateStore();
  private readonly contextLock = new ContextLock();
  private readonly sessionEvidence = new SessionEvidenceStore();
  private readonly turns = new Map<string, InterviewTurn>();
  private readonly contextProvider: (question: QuestionCandidate, profileId: string, recentTranscript: string[], context?: InterviewContextSelection) => AnswerContextInput | Promise<AnswerContextInput>;
  private defaultAutomationMode: "MANUAL" | "AUTO";
  private activeInterviewId: string | undefined;
  private activeOptions: InterviewStartOptions | undefined;
  private activeProfileId: string | undefined;
  private currentQuestion: QuestionCandidate | undefined;
  private answerController: AbortController | undefined;
  private answerId: string | undefined;
  private answerQuestionId: string | undefined;
  private answerMode: AnswerMode | undefined;
  private answerModel: string | undefined;
  private answerStartedAt: number | undefined;
  private answerFirstTokenAt: number | undefined;
  private accumulatedAnswerText = "";
  private readonly questionConfirmedAt = new Map<string, number>();
  private readonly asr: InterviewASRPort;
  private readonly recentTranscript: string[] = [];
  private readonly historyQuestionIds = new Map<string, string>();
  private finalQuestionQueue: Promise<void> | undefined;
  private readonly questionSilenceMs: number;
  private answerGeneration = 0;
  private answerTriggerTimer: NodeJS.Timeout | undefined;
  private pendingAnswerQuestion: QuestionCandidate | undefined;
  private readonly visibleAnswerGroups = new Set<string>();
  private readonly answerContextSnapshots = new Map<string, {
    recentTranscript: string[];
    memory: ReturnType<InterviewMemory["snapshot"]>;
    sessionEvidence: CandidateStatementEvidence[];
    trace?: QuestionTrace;
  }>();
  private activeAnswerQuestion: QuestionCandidate | undefined;
  private activeModelSnapshot: ModelSnapshot | undefined;
  private sessionGeneration = 0;
  private pendingQuestionTrace: QuestionTrace | undefined;
  private currentQuestionTrace: QuestionTrace | undefined;
  private activeQuestionTrace: QuestionTrace | undefined;
  /** A pure transition marker changes the next question boundary, but is not a question itself. */
  private pendingTopicTransition = false;
  private runtimeSessionState: RuntimeSessionState = "idle";
  private readonly runtimeTimers = new RuntimeTimerRegistry();
  private readonly runtimeLatency = new RuntimeLatencyTelemetry();
  private readonly runtimeAbortControllers = new RuntimeAbortRegistry();
  private readonly runtimeTrace = new RuntimeTraceBuffer();
  private readonly runtimeQuestions = new Map<string, RuntimeQuestionRecord>();
  private readonly runtimeAnswers = new Map<string, RuntimeAnswerRecord>();
  private readonly answerTasks = new Set<Promise<void>>();
  private readonly questionTasks = new Set<Promise<void>>();
  private stopPromise: Promise<void> | undefined;
  private lastProgressAt = Date.now();
  private runtimeSessionStartedAt = 0;
  private runtimeSessionId: string | undefined;
  private lastRuntimeLifecycleEvent: RuntimeTraceEventName | undefined;
  private lastRuntimeLifecycleEventAt: number | undefined;

  constructor(private readonly options: InterviewCoordinatorOptions) {
    super();
    this.asr = options.asrManager ?? options.realtime ?? (() => { throw new Error("ASRManager is required"); })();
    // The semantic completion gate owns the adaptive wait. This value is only
    // the temporal detector fallback for partial/revision handling.
    this.questionSilenceMs = Math.max(80, options.questionSilenceMs ?? 160);
    this.detector = options.detector ?? new QuestionDetector({ silenceMs: this.questionSilenceMs });
    this.detector2 = options.questionDetector2 ?? new QuestionDetector2();
    this.brain = options.interviewBrain ?? new InterviewBrain();
    this.ambiguousSemanticResolver = new AmbiguousSemanticResolver(options.ambiguousSemanticResolver);
    this.memory = options.memory ?? new InterviewMemory(10);
    this.history = options.history ?? new InterviewHistoryStore();
    this.now = options.now ?? (() => Date.now());
    this.anchorStore = new ContextAnchorStore(this.now);
    this.contextProvider = options.contextProvider ?? (() => ({}));
    this.defaultAutomationMode = options.initialAutomationMode ?? "AUTO";
    this.bindPorts();
  }

  get interviewId(): string | undefined { return this.activeInterviewId; }
  get running(): boolean { return Boolean(this.activeInterviewId) && this.runtimeSessionState === "running"; }
  get automationMode(): "MANUAL" | "AUTO" { return this.activeOptions?.automationMode ?? this.defaultAutomationMode; }
  get runtimeState(): RuntimeSessionState { return this.runtimeSessionState; }
  get activeProject() { return this.activeProjectResolver.state.activeProject; }
  getWrittenProblemContext(): string { return this.writtenProblemState.promptContext(); }
  getRuntimeInterviewTelemetry() { return this.interviewTelemetry.snapshot(); }

  private get activeProjectId(): string | undefined {
    // The resolver is the single source of truth. A start-option project is
    // applied through setManual during start(); falling back to the option
    // here would bypass AMBIGUOUS/CONFLICT/UNRESOLVED hard gates.
    return this.activeProjectResolver.state.status === "ACTIVE"
      ? this.activeProjectResolver.state.activeProject?.projectId
      : undefined;
  }

  private observeProjectContext(text: string, speaker: "interviewer" | "candidate", now: number, entities: readonly string[] = [], topics: readonly string[] = []): void {
    const current = this.activeProjectResolver.state.activeProject;
    const consistency = this.projectConsistencyGuard.evaluate(text, current);
    if (consistency.decision === "PROJECT_ENTITY_CONFLICT") {
      this.interviewMemo.recordContradiction(`${consistency.conflictingEntities.join("、")}：${consistency.reason}`);
      this.recordRuntimeTrace("PROJECT_ENTITY_CONFLICT", { confidence: consistency.confidence, entities: consistency.conflictingEntities.join("、"), correctionCandidate: consistency.correctionCandidate }, { reasonCode: consistency.reason });
    }
    const resolution = this.activeProjectResolver.observe({ text, speaker, projects: this.activeOptions?.projectCandidates, now, entities, topics });
    if (resolution.activeProject) {
      this.interviewMemo.setProject(resolution.activeProject.projectName);
      if (resolution.changed) this.recordRuntimeTrace("PROJECT_RESOLVED", { projectId: resolution.activeProject.projectId, confidence: resolution.activeProject.confidence, source: resolution.activeProject.source }, { reasonCode: resolution.reason });
    }
  }

  getRuntimeDiagnostics(): InterviewRuntimeDiagnostics {
    const pendingQuestions = [...this.runtimeQuestions.values()].filter((item) => ["detected", "confirmed", "queued"].includes(item.state)).length;
    const activeAnswers = [...this.runtimeAnswers.values()].filter((item) => !["committed", "cancelled", "failed"].includes(item.state)).length;
    const activeStreams = [...this.runtimeAnswers.values()].filter((item) => item.state === "provider_pending" || item.state === "streaming").length;
    const activeProviderRequests = [...this.runtimeAnswers.values()].filter((item) => item.state === "provider_pending" || item.state === "streaming").length;
    return {
      ...(this.runtimeSessionId ? { sessionId: this.runtimeSessionId } : {}),
      sessionState: this.runtimeSessionState,
      pendingQuestions,
      activeAnswers,
      activeStreams,
      transcriptQueueDepth: this.canonicalRemoteTurnAssembler.pending.length + this.questionTasks.size,
      answerQueueDepth: this.answerScheduler.queueDepth,
      activeAbortControllers: this.runtimeAbortControllers.size,
      activeTimers: this.runtimeTimers.size,
      activeProviderRequests,
      activeAudioSessions: this.options.audio.isRunning ? 1 : 0,
      // Port listeners are application-scoped and bound once in the constructor;
      // no session-owned listener is retained between starts.
      activeListeners: 0,
      ...(this.lastRuntimeLifecycleEvent ? { lastLifecycleEvent: this.lastRuntimeLifecycleEvent } : {}),
      ...(this.lastRuntimeLifecycleEventAt ? { lastLifecycleEventAt: this.lastRuntimeLifecycleEventAt } : {})
    };
  }

  getRuntimeTrace(limit = 30): RuntimeTraceEvent[] { return this.runtimeTrace.snapshot(limit); }

  getRuntimeLatencyMetrics(): RuntimeLatencyMetrics { return this.runtimeLatency.metrics(); }

  isRuntimeIdle(): boolean {
    const diagnostics = this.getRuntimeDiagnostics();
    return !["starting", "running", "stopping"].includes(diagnostics.sessionState)
      && diagnostics.pendingQuestions === 0
      && diagnostics.activeAnswers === 0
      && diagnostics.activeStreams === 0
      && diagnostics.transcriptQueueDepth === 0
      && diagnostics.answerQueueDepth === 0
      && diagnostics.activeProviderRequests === 0
      && diagnostics.activeAbortControllers === 0
      && diagnostics.activeTimers === 0
      && diagnostics.activeAudioSessions === 0
      && diagnostics.activeListeners === 0;
  }

  recordOverlayTrace(eventName: "OVERLAY_UPDATE_REQUESTED" | "OVERLAY_UPDATED", fields: Record<string, string | number | boolean | undefined> = {}): void {
    this.recordRuntimeTrace(eventName, fields, {
      ...(typeof fields.questionId === "string" ? { questionId: fields.questionId } : {}),
      ...(typeof fields.answerId === "string" ? { answerId: fields.answerId } : {})
    });
  }

  private recordScreenshotTrace(
    name: ScreenshotTraceEventName,
    screenshotRequestId: string,
    details: Omit<Partial<ScreenshotTraceEvent>, "name" | "timestamp" | "elapsedMs" | "screenshotRequestId"> = {}
  ): void {
    const timestamp = this.now();
    const event: ScreenshotTraceEvent = {
      name,
      timestamp,
      elapsedMs: this.runtimeSessionStartedAt ? Math.max(0, timestamp - this.runtimeSessionStartedAt) : 0,
      screenshotRequestId,
      ...(this.runtimeSessionId ? { sessionId: this.runtimeSessionId } : {}),
      ...details
    };
    this.emitEvent({ type: "screenshot_trace", event });
  }

  private recordRuntimeTrace(
    name: RuntimeTraceEventName,
    fields: Record<string, string | number | boolean | undefined> = {},
    ids: { sessionId?: string; questionId?: string; answerId?: string; providerRequestId?: string; reasonCode?: string } = {}
  ): void {
    const timestamp = this.now();
    const diagnostics = this.getRuntimeDiagnostics();
    const event: RuntimeTraceEvent = {
      name,
      timestamp,
      ...(this.runtimeSessionStartedAt ? { elapsedMs: Math.max(0, timestamp - this.runtimeSessionStartedAt) } : {}),
      ...(ids.sessionId ?? diagnostics.sessionId ? { sessionId: ids.sessionId ?? diagnostics.sessionId } : {}),
      ...(ids.questionId ? { questionId: ids.questionId } : {}),
      ...(ids.answerId ? { answerId: ids.answerId } : {}),
      ...(ids.providerRequestId ? { providerRequestId: ids.providerRequestId } : {}),
      sessionState: diagnostics.sessionState,
      ...(ids.questionId && this.runtimeQuestions.get(ids.questionId) ? { questionState: this.runtimeQuestions.get(ids.questionId)?.state } : {}),
      ...(ids.questionId ? { answerState: [...this.runtimeAnswers.values()].find((item) => item.questionId === ids.questionId)?.state } : {}),
      pendingQuestions: diagnostics.pendingQuestions,
      activeAnswers: diagnostics.activeAnswers,
      activeStreams: diagnostics.activeStreams,
      transcriptQueueDepth: diagnostics.transcriptQueueDepth,
      answerQueueDepth: diagnostics.answerQueueDepth,
      activeAbortControllers: diagnostics.activeAbortControllers,
      activeTimers: diagnostics.activeTimers,
      activeProviderRequests: diagnostics.activeProviderRequests,
      activeAudioSessions: diagnostics.activeAudioSessions,
      activeListeners: diagnostics.activeListeners,
      ...(ids.reasonCode ? { reasonCode: ids.reasonCode } : {}),
      ...(Object.keys(fields).length ? { fields: { ...fields } } : {})
    };
    this.runtimeTrace.push(event);
    if (name !== "STALE_RUNTIME_EVENT_DROPPED") this.lastProgressAt = timestamp;
    this.lastRuntimeLifecycleEvent = name;
    this.lastRuntimeLifecycleEventAt = timestamp;
    this.emitEvent({ type: "runtime_trace", event });
  }

  private setRuntimeState(state: RuntimeSessionState): void {
    if (this.runtimeSessionState === state) return;
    this.runtimeSessionState = state;
    this.lastProgressAt = this.now();
  }

  private markQuestionState(question: QuestionCandidate, state: RuntimeQuestionState): void {
    this.runtimeQuestions.set(question.id, { question, state, sessionGeneration: this.sessionGeneration });
  }

  private markQuestionStateById(questionId: string, state: RuntimeQuestionState): void {
    const existing = this.runtimeQuestions.get(questionId);
    if (existing) this.runtimeQuestions.set(questionId, { ...existing, state });
  }

  private markLatency(questionId: string, stage: Parameters<RuntimeLatencyTelemetry["mark"]>[1], at = this.now()): void {
    this.runtimeLatency.mark(questionId, stage, at);
  }

  private clearRuntimeTimers(): void { this.runtimeTimers.clearAll(); }

  private clearRuntimeRegistries(): void {
    this.runtimeAbortControllers.clear();
    this.runtimeAnswers.clear();
  }

  private trackAnswerTask(task: Promise<void>): Promise<void> {
    this.answerTasks.add(task);
    void task.then(
      () => this.answerTasks.delete(task),
      () => this.answerTasks.delete(task)
    );
    return task;
  }

  private trackQuestionTask(task: Promise<void>): Promise<void> {
    this.questionTasks.add(task);
    void task.then(
      () => this.questionTasks.delete(task),
      () => this.questionTasks.delete(task)
    );
    return task;
  }

  private launchAnswer(question: QuestionCandidate, mode = this.activeOptions?.answerMode ?? "NORMAL"): void {
    void this.trackAnswerTask(this.answer(question, mode));
  }

  setAutomationMode(mode: "MANUAL" | "AUTO"): void {
    this.defaultAutomationMode = mode;
    if (this.activeOptions) this.activeOptions = { ...this.activeOptions, automationMode: mode };
    this.emitEvent({ type: "automation_mode", mode });
  }

  setAnswerMode(mode: AnswerMode): void {
    if (this.activeOptions) this.activeOptions = { ...this.activeOptions, answerMode: mode };
    this.emitEvent({ type: "answer_mode", mode });
  }

  async start(startOptions: InterviewStartOptions): Promise<string> {
    if (this.activeInterviewId || this.stopPromise) await this.stop("user");
    this.runtimeSessionId = undefined;
    this.runtimeSessionStartedAt = 0;
    this.setRuntimeState("starting");
    this.recordRuntimeTrace("INTERVIEW_SESSION_START_REQUESTED", {}, { reasonCode: "start-requested" });
    try {
      if (this.options.audio.configuredPath && !existsSync(this.options.audio.configuredPath)) throw new Error(`SIDECAR_NOT_FOUND: Audio Sidecar not found: ${this.options.audio.configuredPath}`);
      const asrSettings = this.options.asrSettingsProvider?.(startOptions.profileId);
      const providerType = asrSettings?.providerType ?? startOptions.providerType ?? "custom-gateway";
      const connectUrl = startOptions.url ?? asrSettings?.url ?? "";
      if (providerType === "custom-gateway" && !connectUrl.trim()) throw new Error("Custom ASR Gateway URL is required");
      await this.options.audio.waitForIdle?.();
      if (this.options.audio.isRunning) throw new Error("AUDIO_BUSY: audio sidecar is still running");
      const automationMode = startOptions.automationMode ?? this.defaultAutomationMode;
      this.transition("CREATING");
      const startedAt = this.now();
      const record = this.history.createInterview({
      profileId: startOptions.profileId,
      ...(startOptions.projectId ? { projectId: startOptions.projectId } : {}),
      ...(startOptions.jobTargetId ? { jobTargetId: startOptions.jobTargetId } : {}),
      startedAt,
      status: "running",
      language: startOptions.language ?? "zh-CN",
      automationMode
    }, startedAt);
      this.sessionGeneration += 1;
      this.activeInterviewId = record.id;
      this.runtimeSessionId = record.id;
      this.runtimeSessionStartedAt = startedAt;
      this.activeOptions = { ...startOptions, automationMode };
      this.activeProfileId = startOptions.profileId;
      const providedLexicon = startOptions.terminologyLexicon ?? this.options.terminologyLexiconProvider?.(startOptions.profileId, startOptions.projectId, startOptions.jobTargetId);
      if (providedLexicon && typeof (providedLexicon as PromiseLike<DynamicTechnicalLexicon>).then === "function") this.sessionTerminologyLexicon = await (providedLexicon as Promise<DynamicTechnicalLexicon>);
      else this.sessionTerminologyLexicon = (providedLexicon as DynamicTechnicalLexicon | undefined) ?? buildDynamicTechnicalLexicon({ recentTopics: [startOptions.projectId].filter((value): value is string => Boolean(value)) });
      const providedTerminologyContext = startOptions.terminologyContext ?? this.options.terminologyContextProvider?.(startOptions.profileId, startOptions.projectId, startOptions.jobTargetId, startOptions.directionSelection);
      let terminologyContext: SessionTerminologyContext;
      if (providedTerminologyContext && typeof (providedTerminologyContext as PromiseLike<SessionTerminologyContext>).then === "function") terminologyContext = await (providedTerminologyContext as Promise<SessionTerminologyContext>);
      else terminologyContext = providedTerminologyContext as SessionTerminologyContext | undefined ?? buildSessionTerminologyContext({ recentTopics: [startOptions.projectId].filter((value): value is string => Boolean(value)) });
      this.sessionTerminologyNormalizer.setContext(terminologyContext);
      this.sessionTerminologyContext = terminologyContext;
      this.sessionTerminologyNormalizer.setMode(startOptions.terminologyMode ?? this.options.terminologyModeProvider?.(startOptions.profileId) ?? "high_confidence");
      this.detector.reset();
      this.questionGroups.reset();
      this.answerScheduler.reset();
      this.visibleAnswerGroups.clear();
      this.contextLock.clear();
      this.sessionEvidence.reset();
      this.canonicalRemoteTurnAssembler.clear();
      this.activeProjectResolver.reset(startedAt);
      this.interviewMemo.reset();
      this.interviewTelemetry.reset();
      this.writtenProblemState.reset();
      if (startOptions.projectId) {
        const selectedProject = startOptions.projectCandidates?.find((project) => project.id === startOptions.projectId);
        this.activeProjectResolver.setManual({
          projectId: startOptions.projectId,
          projectName: selectedProject?.name ?? startOptions.projectId,
          entities: selectedProject?.entities ? [...selectedProject.entities] : undefined,
          topics: selectedProject?.aliases ? [...selectedProject.aliases] : undefined
        }, startedAt);
        this.interviewMemo.setProject(selectedProject?.name ?? startOptions.projectId);
      }
      this.turns.clear();
      this.anchorStore.reset();
      this.memory.reset();
      this.clearAnswerTrigger();
      this.answerContextSnapshots.clear();
      this.activeAnswerQuestion = undefined;
      this.activeModelSnapshot = this.options.answerAgent.getModelSnapshot();
      this.pendingQuestionTrace = undefined;
      this.currentQuestionTrace = undefined;
      this.activeQuestionTrace = undefined;
      this.currentQuestion = undefined;
      this.pendingTopicTransition = false;
      this.runtimeQuestions.clear();
      this.runtimeLatency.clear();
      this.clearRuntimeTimers();
      this.clearRuntimeRegistries();
      this.answerTasks.clear();
      this.questionTasks.clear();
      this.answerGeneration += 1;
      this.historyQuestionIds.clear();
      this.questionConfirmedAt.clear();
      this.recentTranscript.length = 0;
      this.clearRemoteAssemblyTimer();
      this.recordRuntimeTrace("INTERVIEW_SESSION_STARTED", {}, { reasonCode: "session-created" });
      const warmup = this.options.questionClassifierWarmup
        ? (async () => {
          this.recordRuntimeTrace("QUESTION_CLASSIFIER_WARMUP_STARTED", {}, { reasonCode: "session-start" });
          try {
            await this.options.questionClassifierWarmup?.();
            this.recordRuntimeTrace("QUESTION_CLASSIFIER_WARMUP_COMPLETED", {}, { reasonCode: "session-start" });
          } catch (error) {
            this.recordRuntimeTrace("QUESTION_CLASSIFIER_WARMUP_FAILED", { error: String(error) }, { reasonCode: "fallback-rules-semantic" });
          }
        })()
        : Promise.resolve();
      // Connect ASR before opening capture. Audio can deliver its first PCM
      // packet synchronously from start(); RealtimeSession queues packets
      // while the socket is opening, so no leading speech is lost.
      this.transition("CONNECTING");
      this.asr.connect({ ...startOptions, ...asrSettings, providerType, url: connectUrl, language: asrSettings?.language ?? (startOptions.language as AsrLanguage | undefined), autoReconnect: true });
      this.options.onStartupTiming?.("ASR_READY");
      const audioStart = Promise.resolve(this.options.audio.start({ inputDeviceId: startOptions.inputDeviceId, outputDeviceId: startOptions.outputDeviceId, meterOnly: false, autoRecover: true }));
      await Promise.all([audioStart, warmup]);
      this.options.onStartupTiming?.("AUDIO_READY");
      return record.id;
    } catch (error) {
      await Promise.resolve(this.options.audio.stop()).catch(() => undefined);
      try { this.asr.disconnect(); } catch { /* best-effort start unwind */ }
      this.failInterview(String(error));
      throw error;
    }
  }

  async stop(reason: "user" | "error" = "user"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  private async performStop(reason: "user" | "error"): Promise<void> {
    const interviewId = this.activeInterviewId;
    if (!interviewId && this.isRuntimeIdle()) return;
    this.recordRuntimeTrace("INTERVIEW_SESSION_STOP_REQUESTED", {}, { reasonCode: reason });
    this.setRuntimeState("stopping");
    this.sessionGeneration += 1;
    this.answerGeneration += 1;
    this.recordRuntimeTrace("INTERVIEW_SESSION_STOPPING", {}, { reasonCode: "stop-boundary" });
    this.clearRemoteAssemblyTimer();
    this.clearAnswerTrigger();
    for (const question of this.answerScheduler.queue) {
      this.markQuestionStateById(question.id, "cancelled");
      this.recordRuntimeTrace("QUESTION_CANCELLED", {}, { questionId: question.id, reasonCode: "session-stop" });
    }
    if (this.pendingAnswerQuestion) {
      const questionId = this.pendingAnswerQuestion.id;
      this.markQuestionStateById(questionId, "cancelled");
      this.recordRuntimeTrace("QUESTION_CANCELLED", {}, { questionId, reasonCode: "session-stop" });
    }
    this.pendingAnswerQuestion = undefined;
    this.answerContextSnapshots.clear();
    this.cancelAnswer(reason === "error" ? "timeout" : "user");
    this.runtimeAbortControllers.abortAll();
    for (const [questionId, record] of this.runtimeQuestions) {
      if (["finished", "cancelled", "failed"].includes(record.state)) continue;
      this.markQuestionStateById(questionId, "cancelled");
      this.recordRuntimeTrace("QUESTION_CANCELLED", {}, { questionId, reasonCode: "session-stop" });
    }
    this.recordRuntimeTrace("RUNTIME_CLEANUP_STARTED", {}, { reasonCode: "abort-and-drain" });

    const answerTasks = [...this.answerTasks, ...this.questionTasks];
    const drain = Promise.allSettled(answerTasks);
    const stopTimeoutMs = Math.max(250, this.options.stopTimeoutMs ?? 4_000);
    const drained = await withRuntimeTimeout(drain, stopTimeoutMs, () => this.emitDiagnostic("RUNTIME_CLEANUP_TIMEOUT: answer task did not settle"));
    if (drained === undefined) {
      for (const answer of this.runtimeAnswers.values()) answer.detached = true;
      this.answerTasks.clear();
      this.questionTasks.clear();
      this.runtimeAnswers.clear();
      this.runtimeAbortControllers.clear();
    }
    try {
      await withRuntimeTimeout(Promise.resolve(this.options.audio.stop()), stopTimeoutMs, () => this.emitDiagnostic("RUNTIME_CLEANUP_TIMEOUT: audio stop did not settle"));
    } catch (error) { this.emitDiagnostic(`Audio stop failed: ${String(error)}`); }
    try {
      if (this.asr.finalize) await withRuntimeTimeout(this.asr.finalize(1_000), stopTimeoutMs, () => this.emitDiagnostic("RUNTIME_CLEANUP_TIMEOUT: ASR finalize did not settle"));
    } catch (error) { this.emitDiagnostic(`ASR finalize failed: ${String(error)}`); }
    try { this.asr.disconnect(); } catch (error) { this.emitDiagnostic(`ASR disconnect failed: ${String(error)}`); }

    if (!this.options.session.canTransition("ENDING") && this.options.session.canTransition("ERROR")) this.transition("ERROR");
    if (this.options.session.canTransition("ENDING")) this.transition("ENDING");
    if (interviewId) {
      try { this.history.endInterview(interviewId, reason === "error" ? "error" : "ended", this.now()); }
      catch (error) { this.emitDiagnostic(`History end failed: ${String(error)}`); }
    }
    if (this.options.session.canTransition("ENDED")) this.transition("ENDED");
    this.activeInterviewId = undefined;
    this.activeOptions = undefined;
    this.activeProfileId = undefined;
    this.currentQuestion = undefined;
    this.pendingTopicTransition = false;
    this.questionConfirmedAt.clear();
    this.recentTranscript.length = 0;
    this.canonicalRemoteTurnAssembler.clear();
    this.clearRuntimeTimers();
    this.finalQuestionQueue = undefined;
    this.detector.reset();
    this.questionGroups.reset();
    this.answerScheduler.reset();
    this.visibleAnswerGroups.clear();
    this.contextLock.clear();
    this.sessionEvidence.reset();
    this.turns.clear();
    this.anchorStore.reset();
    this.memory.reset();
    this.historyQuestionIds.clear();
    this.activeModelSnapshot = undefined;
    this.pendingQuestionTrace = undefined;
    this.currentQuestionTrace = undefined;
    this.activeQuestionTrace = undefined;
    this.runtimeQuestions.clear();
    this.runtimeAnswers.clear();
    this.runtimeAbortControllers.clear();
    this.answerTasks.clear();
    this.questionTasks.clear();
    this.setRuntimeState(reason === "error" ? "failed" : "stopped");
    this.recordRuntimeTrace("RUNTIME_CLEANUP_COMPLETED", {}, { reasonCode: drained === undefined ? "forced-local-close" : "drained" });
    this.recordRuntimeTrace("INTERVIEW_SESSION_STOPPED", {}, { reasonCode: reason });
    if (this.isRuntimeIdle()) this.recordRuntimeTrace("RUNTIME_IDLE", {}, { reasonCode: "all-runtime-resources-released" });
  }

  async answerLatest(): Promise<void> {
    if (this.currentQuestion) {
      await this.trackAnswerTask(this.answer(this.currentQuestion));
      return;
    }
    const latest = this.detector.lastConfirmed;
    if (latest) await this.trackAnswerTask(this.answer(latest));
    else this.emitDiagnostic("No confirmed question is available");
  }

  async answerScreenshot(input: string | VisionInput, screenshotRequestId = `screenshot-${this.now()}`): Promise<void> {
    if (!this.running) {
      this.emitDiagnostic("Interview is not running");
      return;
    }
    let question = this.currentQuestion ?? this.detector.lastConfirmed;
    if (!question) {
      question = {
        id: `screenshot-question-${this.now()}`,
        text: "请分析截图中的题目、代码或内容，并给出适合面试场景的回答。",
        confidence: "high",
        score: 1,
        source: "extractor",
        detectedAt: this.now(),
        status: "confirmed"
      };
      const emitted = this.emitQuestion({ type: "question_confirmed", question });
      if (emitted.type === "question_confirmed" || emitted.type === "question_superseded") question = emitted.question;
    }
    const mode = this.activeOptions?.answerMode ?? "NORMAL";
    const dataUrl = typeof input === "string" ? input : `data:${input.image.mimeType};base64,${input.image.base64}`;
    const mimeType = typeof input === "string" ? dataUrl.match(/^data:(image\/(?:png|jpeg));/)?.[1] ?? "image/png" : input.image.mimeType;
    await this.trackAnswerTask(this.answer(question, mode, { hasScreenshot: true, attachments: [{ mimeType, dataUrl }], screenshotRequestId }));
  }

  async answerQuestionText(text: string): Promise<void> {
    const clean = normalizeTechnicalTerms(text);
    if (!clean) {
      await this.answerLatest();
      return;
    }
    let question: QuestionCandidate = {
      id: `manual-question-${this.now()}`,
      text: clean,
      confidence: "high",
      score: 1,
      source: "extractor",
      detectedAt: this.now(),
      status: "confirmed",
      speechAct: "QUESTION",
      detectionType: "technical",
      answerable: true,
      shouldAnswer: true,
      answerabilityState: "ANSWERABLE"
    };
    if (this.activeInterviewId) {
      const emitted = this.emitQuestion({ type: "question_confirmed", question });
      if (emitted.type === "question_confirmed" || emitted.type === "question_superseded") question = emitted.question;
    }
    await this.trackAnswerTask(this.answer(question));
  }

  async answer(question: QuestionCandidate, mode = this.activeOptions?.answerMode ?? "NORMAL", streamOptions: { hasScreenshot?: boolean; attachments?: Array<{ mimeType: string; dataUrl: string }>; screenshotRequestId?: string } = {}): Promise<void> {
    if (!this.running) {
      this.emitDiagnostic("Interview is not running");
      return;
    }
    const frozenContext = this.answerContextSnapshots.get(question.id) ?? {
      recentTranscript: [...this.recentTranscript],
      memory: this.memory.snapshot(),
      sessionEvidence: this.sessionEvidence.snapshot(),
      ...(this.currentQuestion?.id === question.id && this.currentQuestionTrace ? { trace: this.currentQuestionTrace } : {})
    };
    this.answerContextSnapshots.set(question.id, frozenContext);
    const schedulerDecision = this.answerScheduler.request({
      id: question.id,
      text: question.text,
      ...(question.groupId ? { groupId: question.groupId } : {}),
      ...(question.relationType ? { relationType: question.relationType } : {})
    }, {
      now: this.now(),
      ...(question.groupId ? { groupId: question.groupId } : {}),
      ...(question.relationType ? { relationType: question.relationType } : {})
    });
    if (schedulerDecision.action !== "start") {
      if (schedulerDecision.action === "merge") {
        this.markQuestionState(question, "queued");
        this.markQuestionGroup(question.id, "queued");
        this.recordRuntimeTrace("QUESTION_MERGED", { schedulerAction: schedulerDecision.action, planPatch: schedulerDecision.planPatch, groupId: question.groupId, relationType: question.relationType }, { questionId: question.id, reasonCode: schedulerDecision.reason });
        return;
      }
      if (schedulerDecision.action !== "ignore" && this.activeAnswerQuestion?.id !== question.id) {
        this.markQuestionState(question, "queued");
        this.markQuestionGroup(question.id, "queued");
        this.recordRuntimeTrace("QUESTION_QUEUED", { schedulerAction: schedulerDecision.action }, { questionId: question.id, reasonCode: schedulerDecision.reason });
        this.emitDiagnostic(`ANSWER_QUEUED: ${question.id} (${schedulerDecision.queueDepth})`);
      }
      return;
    }
    const generation = this.answerGeneration;
    const sessionId = this.runtimeSessionId;
    const answerSessionGeneration = this.sessionGeneration;
    if (!this.runtimeQuestions.has(question.id)) {
      this.markQuestionState(question, "confirmed");
      this.recordRuntimeTrace("QUESTION_CONFIRMED", { textLength: question.text.length }, { questionId: question.id, reasonCode: "answer-request" });
    }
    const operationId = `answer-operation-${question.id}-${generation}-${this.now()}`;
    const providerRequestId = `provider-request-${question.id}-${generation}-${this.now()}`;
    this.activeAnswerQuestion = question;
    const answerTrace = frozenContext.trace;
    this.activeQuestionTrace = answerTrace;
    this.detector.markAnswering(question.id);
    this.markQuestionGroup(question.id, "answering");
    this.markQuestionStateById(question.id, "answering");
    this.options.history?.updateQuestionStatus?.(this.historyQuestionIds.get(question.id) ?? question.id, "answering");
    const controller = this.runtimeAbortControllers.create(operationId);
    this.runtimeAnswers.set(operationId, { operationId, questionId: question.id, sessionGeneration: this.sessionGeneration, providerRequestId, state: "created", controller, startedAt: this.now(), ...(streamOptions.screenshotRequestId ? { screenshotRequestId: streamOptions.screenshotRequestId } : {}) });
    this.answerController = controller;
    this.recordRuntimeTrace("ANSWER_REQUEST_CREATED", {}, { questionId: question.id, providerRequestId });
    this.runtimeTimers.set(`answer-total:${operationId}`, () => {
      if (!this.runtimeAnswers.has(operationId) || controller.signal.aborted) return;
      this.emitDiagnostic(`ANSWER_TIMEOUT: ${question.id}`);
      this.cancelAnswer("timeout", "answer-timeout");
    }, Math.max(50, this.options.answerTimeoutMs ?? 20_000));
    const startedAt = this.now();
    answerTrace?.mark("retrievalStarted", startedAt);
    this.accumulatedAnswerText = "";
    try {
      const answerOperation = this.runtimeAnswers.get(operationId);
      if (answerOperation) answerOperation.state = "context_loading";
      this.answerScheduler.markContextBuilding(question.id);
      this.recordRuntimeTrace("CONTEXT_BUILDING", {}, { questionId: question.id, providerRequestId });
      this.recordRuntimeTrace("FAST_CONTEXT_STARTED", {}, { questionId: question.id, providerRequestId });
      this.markLatency(question.id, "fastContextStartedAt");
      this.recordRuntimeTrace("PROJECT_CONTEXT_STARTED", {}, { questionId: question.id, providerRequestId });
      const isFollowUp = question.speechAct === "FOLLOW_UP" || question.detectionType === "follow_up" || question.category === "followup";
      const followUpContext = isFollowUp
        ? this.followUpContextResolver.resolve(
          { id: question.id, parentQuestionId: question.parentQuestionId, rootQuestionId: question.rootQuestionId, text: question.text },
          frozenContext.memory,
          {
            relatedProject: /项目|简历|经历|负责|做过|成果|业绩/.test(question.text) ? this.activeProjectId : undefined,
            relatedTechnicalTopic: frozenContext.memory.currentTopic
          }
        )
        : undefined;
      const providerContextResult = this.contextProvider(question, this.activeProfileId ?? "", [...frozenContext.recentTranscript], {
        contextMode: "fast",
        onRichContext: (phase) => {
          if (!this.activeInterviewId || this.runtimeSessionId !== sessionId) return;
          this.recordRuntimeTrace(phase === "started" ? "RICH_CONTEXT_STARTED" : "RICH_CONTEXT_COMPLETED", {}, { questionId: question.id, providerRequestId, reasonCode: "background-rich-context" });
        },
        projectId: this.activeProjectId,
        jobTargetId: this.activeOptions?.jobTargetId,
        ...(followUpContext ? { followUpContext } : {})
      });
      // Keep the default synchronous context path truly synchronous. This
      // removes an avoidable microtask from consecutive-question handling;
      // async profile/knowledge retrieval still remains cancellable below.
      const isPromiseLike = (value: AnswerContextInput | Promise<AnswerContextInput>): value is Promise<AnswerContextInput> => Boolean(value && typeof (value as PromiseLike<AnswerContextInput>).then === "function");
      const contextTimeoutMs = Math.max(50, this.options.contextTimeoutMs ?? this.options.answerTimeoutMs ?? 20_000);
      let providerContext: AnswerContextInput | undefined = isPromiseLike(providerContextResult)
        ? await withRuntimeTimeout(providerContextResult, contextTimeoutMs, () => {
          if (controller.signal.aborted || generation !== this.answerGeneration) return;
          this.emitDiagnostic(`PROJECT_CONTEXT_TIMEOUT: ${question.id}`);
          this.recordRuntimeTrace("PROJECT_CONTEXT_FAILED", {}, { questionId: question.id, providerRequestId, reasonCode: "context-timeout" });
          this.cancelAnswer("timeout", "context-timeout");
        })
        : providerContextResult;
      answerTrace?.mark("retrievalEnded", this.now());
      if (!providerContext || controller.signal.aborted || generation !== this.answerGeneration) {
        if (streamOptions.screenshotRequestId) throw Object.assign(new Error("Screenshot vision request cancelled"), { name: "AbortError" });
        return;
      }
      const routeKind = classifyAnswerQuestion(question.text, question.detectionType);
      const routeIntent = analyzeAnswerIntent({ question: question.text, kind: routeKind });
      const projectQuestionRequested = routeKind === "project"
        || routeIntent.asksProjectImplementation
        || routeIntent.allowsProjectEvidence
        || /(?:这个|该|当前)?项目|简历里|你们的系统|这套方案|实际实现|项目中|项目里/iu.test(question.text);
      if (projectQuestionRequested && !this.activeProjectId) {
        const unresolvedPlan = planAnswerSource({ projectQuestion: true, projectAnchorAvailable: false });
        providerContext = {
          ...providerContext,
          answerSourcePlan: unresolvedPlan,
          projectQaEvidence: [],
          projectEvidence: [],
          preparedAnswer: undefined,
          currentProject: undefined,
          questionTelemetry: {
            ...(providerContext.questionTelemetry ?? {}),
            projectQuestionRequested: true,
            projectResolutionReason: this.activeProjectResolver.state.lastReason ?? "project-context-unresolved"
          }
        };
        this.recordRuntimeTrace("PROJECT_CONTEXT_UNRESOLVED", {
          questionRequested: true,
          resolverStatus: this.activeProjectResolver.state.status,
          sourceMode: unresolvedPlan.mode
        }, { questionId: question.id, providerRequestId, reasonCode: "project-hard-gate" });
      }
      const memorySnapshot = frozenContext.memory;
      const contextFinishedAt = this.now();
      if (providerContext.contextMode === "fast") {
        this.recordRuntimeTrace("FAST_CONTEXT_COMPLETED", { contextMs: contextFinishedAt - (this.runtimeLatency.snapshot().find((sample) => sample.id === question.id)?.fastContextStartedAt ?? contextFinishedAt) }, { questionId: question.id, providerRequestId });
        this.markLatency(question.id, "fastContextCompletedAt", contextFinishedAt);
      } else {
        this.recordRuntimeTrace("RICH_CONTEXT_STARTED", {}, { questionId: question.id, providerRequestId });
        this.recordRuntimeTrace("RICH_CONTEXT_COMPLETED", {}, { questionId: question.id, providerRequestId });
      }
      const contextTelemetry = providerContext.questionTelemetry ?? {};
      const contextSourceMode = providerContext.answerSourcePlan?.mode;
      if (contextTelemetry.selfIntroductionDetected) {
        this.recordRuntimeTrace("SELF_INTRO_DETECTED", { confidence: 0.99, cacheHit: Boolean(providerContext.selfIntroduction?.approved) }, { questionId: question.id, providerRequestId });
        if (contextSourceMode === "self_intro_rewrite") this.recordRuntimeTrace("SELF_INTRO_REWRITE", { cacheHit: true }, { questionId: question.id, providerRequestId });
      }
      if (contextTelemetry.projectResolutionReason && contextTelemetry.projectAutoAnchorId) this.recordRuntimeTrace("PROJECT_RESOLVED", { reason: contextTelemetry.projectResolutionReason, score: contextTelemetry.projectAutoAnchorConfidence }, { questionId: question.id, providerRequestId });
      if (contextTelemetry.projectQuestionRequested) {
        this.recordRuntimeTrace("PROJECT_QA_ROUTE", { matchLevel: contextTelemetry.projectQaMatchLevel, overviewHitCount: contextTelemetry.projectOverviewHitCount, cacheHit: contextTelemetry.projectCacheHit }, { questionId: question.id, providerRequestId });
        if ((contextTelemetry.projectOverviewHitCount ?? 0) > 0) this.recordRuntimeTrace("PROJECT_OVERVIEW_RETRIEVAL", { hitCount: contextTelemetry.projectOverviewHitCount, cacheHit: contextTelemetry.projectCacheHit }, { questionId: question.id, providerRequestId });
        if (providerContext.contextMode === "fast") this.recordRuntimeTrace("PROJECT_FAST_CONTEXT_READY", { route: contextSourceMode, cacheHit: contextTelemetry.projectCacheHit }, { questionId: question.id, providerRequestId });
      }
      const projectQaContextDirect = providerContext.answerSourcePlan?.mode === "project_qa_direct" || providerContext.answerSourcePlan?.mode === "self_intro_direct" || providerContext.answerSourcePlan?.mode === "self_intro_rewrite";
      const evidenceSnapshot: EvidenceSnapshot = this.contextLock.lock({
        questionId: question.id,
        profileId: this.activeProfileId,
        projectId: this.activeProjectId,
        jobTargetId: this.activeOptions?.jobTargetId,
        profileSummary: providerContext.profileSummary,
        jobDescriptionSummary: providerContext.jobDescriptionSummary,
        profileInstructions: providerContext.profileInstructions,
        currentProject: providerContext.currentProject,
        currentModule: providerContext.currentModule,
        currentTopic: providerContext.currentTopic ?? frozenContext.memory.currentTopic,
        personalMemoryEvidence: providerContext.personalMemoryEvidence,
        experienceContext: providerContext.experienceContext,
        projectEvidence: projectQaContextDirect ? [] : providerContext.projectEvidence,
        verifiedResumeEvidence: providerContext.verifiedResumeEvidence,
        verifiedPersonalProjectFacts: providerContext.verifiedPersonalProjectFacts,
        retrievedKnowledge: projectQaContextDirect ? [] : providerContext.retrievedKnowledge,
        answerSourcePlan: providerContext.answerSourcePlan,
        projectQaEvidence: providerContext.projectQaEvidence,
        recentTranscript: frozenContext.recentTranscript,
        interviewMemory: memorySnapshot,
        sessionEvidence: frozenContext.sessionEvidence,
        candidateStatements: frozenContext.sessionEvidence
      });
      const lockedProviderContext: AnswerContextInput = {
        ...providerContext,
        profileSummary: evidenceSnapshot.profileSummary,
        jobDescriptionSummary: evidenceSnapshot.jobDescriptionSummary,
        profileInstructions: evidenceSnapshot.profileInstructions,
        currentProject: evidenceSnapshot.currentProject,
        currentModule: evidenceSnapshot.currentModule,
        personalMemoryEvidence: evidenceSnapshot.personalMemoryEvidence,
        experienceContext: evidenceSnapshot.experienceContext,
        projectEvidence: evidenceSnapshot.projectEvidence,
        retrievedKnowledge: evidenceSnapshot.retrievedKnowledge,
        recentTranscript: evidenceSnapshot.recentTranscript,
        interviewMemory: evidenceSnapshot.interviewMemory,
        sessionEvidence: evidenceSnapshot.sessionEvidence,
        candidateStatements: evidenceSnapshot.candidateStatements,
        answerSourcePlan: evidenceSnapshot.answerSourcePlan,
        projectQaEvidence: evidenceSnapshot.projectQaEvidence,
        evidenceSnapshot,
        ...(this.activeOptions?.stableInterviewPrefix ? { stableInterviewPrefix: this.activeOptions.stableInterviewPrefix } : {}),
        interviewMemo: this.interviewMemo.toText()
      };
      if (answerOperation) answerOperation.state = "provider_pending";
      if (answerOperation) answerOperation.state = "request_ready";
      this.answerScheduler.markReady(question.id);
      this.recordRuntimeTrace("REQUEST_READY", {}, { questionId: question.id, providerRequestId });
      this.recordRuntimeTrace("PROJECT_CONTEXT_READY", {}, { questionId: question.id, providerRequestId });
      // A queued question must retain the topic and transcript that existed
      // when it was confirmed. Looking at global "latest" memory here caused
      // an older memory-leak question to inherit a later RS-485/RS-232 topic.
      const preparedAnswer = lockedProviderContext.preparedAnswer;
      const answerKind = classifyAnswerQuestion(question.text, question.detectionType);
      const answerIntent = analyzeAnswerIntent({ question: question.text, kind: answerKind });
      const personalThreadText = `${followUpContext?.rootQuestion ?? ""}\n${followUpContext?.parentQuestion ?? ""}`;
      const isProjectQuestion = ["project", "behavioral"].includes(answerKind) || /项目|简历|经历|负责|做过|成果|业绩|你做的|你的实现|你的方案|在这个结构下/.test(question.text);
      const requiresPersonalGrounding = requiresPersonalClaimEvidence(answerIntent)
        || answerIntent.asksBehavioralEpisode
        || (isFollowUp && (/项目|简历|经历|负责|做过|成果|业绩/.test(personalThreadText) || (lockedProviderContext.sessionEvidence?.length ?? 0) > 0));
      const projectQaMode = lockedProviderContext.answerSourcePlan?.mode;
      const requiresClaimValidation = requiresPersonalGrounding || projectQaMode === "project_qa_direct" || projectQaMode === "project_qa_augmented";
      const selfIntroDirect = projectQaMode === "self_intro_direct";
      const projectQaDirect = projectQaMode === "project_qa_direct";
      const ordinaryQuestionBankDirect = !isProjectQuestion && !answerIntent.requiresPersonalIdentity && !requiresClaimValidation;
      if (preparedAnswer && preparedAnswer.verified && preparedAnswer.score >= 0.88 && !streamOptions.hasScreenshot && (ordinaryQuestionBankDirect || selfIntroDirect || projectQaDirect)) {
        this.emitDiagnostic("QUESTION_BANK_DIRECT_HIT");
        if (selfIntroDirect) this.recordRuntimeTrace("SELF_INTRO_DIRECT", { cacheHit: true }, { questionId: question.id, providerRequestId });
        if (projectQaDirect) this.recordRuntimeTrace("PROJECT_QA_DIRECT", { cacheHit: true, qaMatchLevel: lockedProviderContext.answerSourcePlan?.qaMatchLevel }, { questionId: question.id, providerRequestId });
        const answerId = `question-bank-answer-${question.id}-${startedAt}`;
        const finishedAt = this.now();
        const answerOperation = this.runtimeAnswers.get(operationId);
        if (answerOperation) {
          answerOperation.answerId = answerId;
          answerOperation.firstTokenAt = finishedAt;
          answerOperation.state = "completed";
        }
        this.runtimeTimers.clear(`answer-first-token:${operationId}`);
        this.answerId = answerId;
        this.answerQuestionId = question.id;
        this.answerMode = mode;
        const directModel = selfIntroDirect ? "self-introduction" : projectQaDirect ? "project-question-bank" : "question-bank";
        this.answerModel = directModel;
        this.answerStartedAt = startedAt;
        this.answerFirstTokenAt = finishedAt;
        this.emitRealtimeMessage({ type: "answer_start", answerId, questionId: question.id, mode, model: directModel, ...(question.groupId ? { groupId: question.groupId, relation: answerRelationForQuestion(question) } : {}) });
        const preparedText = selfIntroDirect ? preparedAnswer.content : normalizeTechnicalTerms(preparedAnswer.content);
        const projectTruth = new ProjectTruthGuard().check({ answer: preparedText, evidenceSnapshot });
        const displayText = stripClaimGateAuditText(projectTruth.answer);
        this.answerScheduler.markVisibleOutput(displayText);
        if (question.groupId) this.visibleAnswerGroups.add(question.groupId);
        const confirmedAt = this.questionConfirmedAt.get(question.id) ?? startedAt;
        const telemetry = this.buildAnswerTelemetry(question, { answerSourceMode: projectQaMode ?? "question-bank", technicalGuardDecision: "allow", technicalViolationCount: 0, claimGateDecision: "allow", blockedPersonalClaimCount: 0, projectTruthDecision: projectTruth.decision, blockedClaimCount: projectTruth.blockedClaimCount });
        this.recordInterviewTelemetry(question, telemetry, finishedAt);
        this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: displayText, model: directModel, mode, startedAt, firstTokenAt: finishedAt, finishedAt, latencyFirstToken: finishedAt - confirmedAt, latencyTotal: finishedAt - confirmedAt, telemetry, ...(question.groupId ? { groupId: question.groupId } : {}), relation: answerRelationForQuestion(question), answerRunId: operationId, createdAt: finishedAt });
        if (answerOperation) answerOperation.state = "committed";
        this.recordRuntimeTrace("ANSWER_COMMITTED", {}, { questionId: question.id, answerId, providerRequestId, reasonCode: directModel });
        this.emitRealtimeMessage({ type: "answer_end", answerId, text: displayText });
        this.recordRuntimeTrace("FIRST_VISIBLE_TOKEN", {}, { questionId: question.id, answerId, providerRequestId });
        this.markLatency(question.id, "firstVisibleTokenAt", finishedAt);
        this.recordRuntimeTrace("ANSWER_COMPLETED", {}, { questionId: question.id, answerId, providerRequestId });
      answerTrace?.update({ answerSource: selfIntroDirect ? "project-qa" : projectQaDirect ? "project-qa" : "question-bank" }).mark("answerLookupStarted", startedAt).mark("answerVisible", finishedAt).mark("answerEnded", finishedAt);
        this.emitQuestionTrace(answerTrace);
        this.memory.recordAnswer(preparedText, { question: question.text, questionId: question.id, groupId: question.groupId, createdAt: finishedAt });
        this.detector.markAnswered(question.id);
        this.markQuestionGroup(question.id, "answered");
        this.markQuestionStateById(question.id, "answered");
        this.markQuestionStateById(question.id, "finished");
        this.recordRuntimeTrace("QUESTION_FINISHED", {}, { questionId: question.id, answerId, providerRequestId, reasonCode: "answer-committed" });
        this.options.history?.updateQuestionStatus?.(this.historyQuestionIds.get(question.id) ?? question.id, "answered");
        this.answerId = undefined;
        this.answerQuestionId = undefined;
        this.answerMode = undefined;
        this.answerModel = undefined;
        this.answerStartedAt = undefined;
        this.answerFirstTokenAt = undefined;
        return;
      }
      const context = { ...lockedProviderContext, recentTranscript: lockedProviderContext.recentTranscript ?? [...frozenContext.recentTranscript], interviewMemory: lockedProviderContext.interviewMemory ?? memorySnapshot, questionTelemetry: this.buildAnswerTelemetry(question), ...(this.activeOptions?.stableInterviewPrefix ? { stableInterviewPrefix: this.activeOptions.stableInterviewPrefix } : {}), interviewMemo: this.interviewMemo.toText(), ...(followUpContext ? { followUpContext } : {}) };
      const activePlan = this.answerScheduler.active?.id === question.id && !this.answerScheduler.active?.hasVisibleOutput ? this.answerScheduler.active.plan : undefined;
      const plannedQuestionText = activePlan
        ? [activePlan.question, ...activePlan.constraints, ...activePlan.examples, ...activePlan.subQuestions].filter(Boolean).join("\n")
        : question.text;
      answerTrace?.update({ answerSource: projectQaMode ? "project-qa" : "llm", ...(projectQaMode ? { answerSourceMode: projectQaMode, qaMatchLevel: lockedProviderContext.answerSourcePlan?.qaMatchLevel } : {}) }).mark("llmRequestStarted", this.now());
      this.recordRuntimeTrace("PROVIDER_STREAM_REQUESTED", {}, { questionId: question.id, providerRequestId });
      this.recordRuntimeTrace("PROVIDER_REQUEST_STARTED", {}, { questionId: question.id, providerRequestId });
      this.markLatency(question.id, "providerRequestStartedAt");
      if (streamOptions.screenshotRequestId) {
        this.recordScreenshotTrace("VISION_PROVIDER_REQUEST_STARTED", streamOptions.screenshotRequestId, { providerRequestId, status: "provider_pending", messageShape: "multimodal" });
      }
      this.runtimeTimers.set(`answer-first-token:${operationId}`, () => {
        const answer = this.runtimeAnswers.get(operationId);
        if (!answer || answer.firstTokenAt !== undefined || controller.signal.aborted) return;
        this.emitDiagnostic(`PROVIDER_FIRST_TOKEN_TIMEOUT: ${question.id}`);
        this.cancelAnswer("timeout", "first-token-timeout");
      }, Math.max(50, this.options.providerFirstTokenTimeoutMs ?? 10_000));
      this.answerScheduler.markRequestSent(question.id);
      if (answerOperation) answerOperation.state = "request_sent";
      this.recordRuntimeTrace("PROVIDER_REQUEST_SENT", {}, { questionId: question.id, providerRequestId });
      this.markLatency(question.id, "providerRequestSentAt");
      let claimGateFirstPassRecorded = false;
      for await (const event of this.options.answerAgent.stream({ id: question.id, text: plannedQuestionText, ...(isFollowUp ? { kind: "follow-up" as const } : {}) }, mode, context, controller.signal, {
        ...streamOptions,
        // Live Interview exposes provider deltas, while AnswerAgent still runs
        // the plan -> coverage -> depth-repair -> final quality chain before
        // answer_end. Repair is bounded to missing facets and max length.
        directDisplay: false,
        emitDeltas: true,
        allowQualityRepair: true,
        formatAnswer: true,
        maxRetries: 1,
        preferFastRoute: this.activeOptions?.automationMode === "AUTO" && !streamOptions.hasScreenshot,
        modelOverride: this.activeModelSnapshot
      })) {
        if (controller.signal.aborted || generation !== this.answerGeneration || answerSessionGeneration !== this.sessionGeneration || sessionId !== this.runtimeSessionId || !this.activeInterviewId) {
          this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "provider-stream-event", type: event.type }, { sessionId, questionId: question.id, providerRequestId, reasonCode: "stale-answer-generation" });
          if (streamOptions.screenshotRequestId) throw Object.assign(new Error("Screenshot vision request became stale"), { name: "AbortError" });
          return;
        }
        if (event.type === "answer_start") {
          const answerOperation = this.runtimeAnswers.get(operationId);
          if (answerOperation) {
            answerOperation.state = "streaming";
            answerOperation.answerId = event.answerId;
          }
          this.answerId = event.answerId;
          this.answerQuestionId = question.id;
          this.answerMode = event.mode;
          this.answerModel = event.model;
          this.answerStartedAt = this.now();
          this.answerFirstTokenAt = undefined;
          this.recordRuntimeTrace("PROVIDER_STREAM_STARTED", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
          if (streamOptions.screenshotRequestId) {
            this.recordScreenshotTrace("VISION_PROVIDER_REQUEST_RECEIVED", streamOptions.screenshotRequestId, { providerRequestId, answerId: event.answerId, providerModel: event.model, status: "streaming", messageShape: "multimodal" });
          }
          this.emitRealtimeMessage({ type: "answer_start", answerId: event.answerId, questionId: event.questionId, mode: event.mode, model: event.model, ...(question.groupId ? { groupId: question.groupId, relation: answerRelationForQuestion(question) } : {}) });
        } else if (event.type === "claim_gate_pass") {
          claimGateFirstPassRecorded = true;
          this.runtimeLatency.setDuration(question.id, "claimGateMs", event.elapsedMs);
          this.recordRuntimeTrace("CLAIM_GATE_FIRST_PASS", { claimGateMs: event.elapsedMs }, { questionId: question.id, answerId: event.answerId, providerRequestId });
        } else if (event.type === "answer_delta") {
          this.accumulatedAnswerText += event.delta;
          if (event.delta.trim() && question.groupId) this.visibleAnswerGroups.add(question.groupId);
          this.answerScheduler.observeOutput(event.delta);
          const firstTokenAt = this.answerFirstTokenAt ?? this.now();
          const firstToken = this.answerFirstTokenAt === undefined;
          this.answerFirstTokenAt = firstTokenAt;
          const answerOperation = this.runtimeAnswers.get(operationId);
          if (answerOperation) {
            answerOperation.state = "streaming";
            answerOperation.firstTokenAt ??= firstTokenAt;
          }
          if (firstToken) {
            this.runtimeTimers.clear(`answer-first-token:${operationId}`);
            this.markLatency(question.id, "providerFirstTokenAt", firstTokenAt);
            this.recordRuntimeTrace("PROVIDER_FIRST_TOKEN", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
            if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_FIRST_TOKEN", streamOptions.screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "streaming" });
          }
          answerTrace?.mark("firstToken", this.answerFirstTokenAt);
          this.emitRealtimeMessage({ type: "answer_delta", answerId: event.answerId, delta: event.delta });
          if (firstToken) {
            this.recordRuntimeTrace("FIRST_VISIBLE_TOKEN", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
            this.markLatency(question.id, "firstVisibleTokenAt");
          }
        } else {
          const finishedAt = this.now();
          const answerText = event.text || this.accumulatedAnswerText;
          if (event.quality?.coverage) {
            this.recordRuntimeTrace("ANSWER_COVERAGE_CHECKED", {
              requiredFacetCount: event.quality.coverage.requiredFacets.length,
              coveredFacetCount: event.quality.coverage.coveredFacets.length,
              missingFacets: event.quality.coverage.missingFacets.join(","),
              characterCount: event.quality.coverage.characterCount,
              estimatedDurationSec: event.quality.coverage.estimatedDurationSec,
              depthPass: event.quality.coverage.depthPass,
              needsRepair: event.quality.coverage.needsRepair
            }, { questionId: question.id, answerId: event.answerId, providerRequestId, reasonCode: "answer-plan-coverage" });
            if (event.quality.telemetry?.answerRepairApplied) {
              this.recordRuntimeTrace("ANSWER_DEPTH_REPAIR", {
                missingFacets: event.quality.telemetry.missingFacets?.join(","),
                characterCount: event.quality.telemetry.answerCharacterCount,
                estimatedDurationSec: event.quality.telemetry.answerEstimatedDurationSec
              }, { questionId: question.id, answerId: event.answerId, providerRequestId, reasonCode: "bounded-facet-supplement" });
            }
            const answerRuntimeTrace = event.quality.telemetry?.answerRuntimeTrace;
            if (answerRuntimeTrace) {
              this.recordRuntimeTrace("ANSWER_RUNTIME_TRACE", {
                sourceMode: answerRuntimeTrace.sourceMode,
                requiredFacetCount: answerRuntimeTrace.requiredFacets.length,
                coveredFacetCount: answerRuntimeTrace.coveredFacets.length,
                missingFacets: answerRuntimeTrace.missingFacets.join(","),
                initialCharacterCount: answerRuntimeTrace.initialCharacterCount,
                finalCharacterCount: answerRuntimeTrace.finalCharacterCount,
                estimatedDurationSec: answerRuntimeTrace.estimatedDurationSec,
                depthPass: answerRuntimeTrace.depthPass,
                needsRepair: answerRuntimeTrace.needsRepair,
                repairApplied: answerRuntimeTrace.repairApplied
              }, { questionId: question.id, answerId: event.answerId, providerRequestId, reasonCode: "answer-runtime-trace" });
            }
          }
          // If a provider does not emit deltas, completion is still the first
          // visible response. Normal live providers stream through the branch
          // above and set answerFirstTokenAt when the first delta arrives.
          const hadFirstToken = this.answerFirstTokenAt !== undefined;
          this.answerFirstTokenAt ??= finishedAt;
          const answerOperation = this.runtimeAnswers.get(operationId);
          if (answerOperation) {
            answerOperation.state = "completed";
            answerOperation.firstTokenAt ??= finishedAt;
          }
          this.runtimeTimers.clear(`answer-first-token:${operationId}`);
          this.runtimeTimers.clear(`answer-total:${operationId}`);
          if (!hadFirstToken) {
            this.answerFirstTokenAt = finishedAt;
            if (answerOperation) answerOperation.firstTokenAt ??= finishedAt;
            this.recordRuntimeTrace("PROVIDER_FIRST_TOKEN", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
            this.markLatency(question.id, "providerFirstTokenAt", finishedAt);
            this.recordRuntimeTrace("FIRST_VISIBLE_TOKEN", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
            this.markLatency(question.id, "firstVisibleTokenAt", finishedAt);
            if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_FIRST_TOKEN", streamOptions.screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
          }
          this.recordRuntimeTrace("PROVIDER_STREAM_COMPLETED", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
          this.recordRuntimeTrace("ANSWER_COMPLETED", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
          if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_RESPONSE_COMPLETED", streamOptions.screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
          answerTrace?.mark("answerEnded", finishedAt);
          if (event.quality) answerTrace?.update({ answerSourceMode: event.quality.answerSourceMode, qaMatchLevel: event.quality.qaMatchLevel, claimGateDecision: event.quality.claimGateDecision, blockedClaimCount: event.quality.blockedClaimCount });
          if (event.quality?.issues.includes("QUALITY_UNGROUNDED_CLAIM")) this.emitDiagnostic("QUALITY_UNGROUNDED_CLAIM");
          if (event.quality?.issues.includes("strict-grounding-fallback")) this.emitDiagnostic("STRICT_GROUNDING_FALLBACK");
          if (event.quality?.telemetry?.claimGateMs !== undefined && !claimGateFirstPassRecorded) {
            this.runtimeLatency.setDuration(question.id, "claimGateMs", event.quality.telemetry.claimGateMs);
            this.recordRuntimeTrace("CLAIM_GATE_FIRST_PASS", { claimGateMs: event.quality.telemetry.claimGateMs }, { questionId: question.id, answerId: event.answerId, providerRequestId });
          }
          const confirmedAt = this.questionConfirmedAt.get(question.id) ?? startedAt;
          const telemetry = this.buildAnswerTelemetry(question, {
            ...(event.quality?.telemetry ?? {}),
            answerSourceMode: event.quality?.answerSourceMode,
            technicalGuardDecision: "allow",
            technicalViolationCount: 0,
            claimGateDecision: event.quality?.claimGateDecision,
            blockedPersonalClaimCount: event.quality?.blockedClaimCount
          });
          this.recordInterviewTelemetry(question, telemetry, finishedAt);
          this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: answerText, model: this.answerModel ?? "configured", mode: this.answerMode ?? mode, startedAt: this.answerStartedAt ?? startedAt, firstTokenAt: this.answerFirstTokenAt, finishedAt, latencyFirstToken: this.answerFirstTokenAt === undefined ? undefined : this.answerFirstTokenAt - confirmedAt, latencyTotal: finishedAt - confirmedAt, telemetry, ...(question.groupId ? { groupId: question.groupId } : {}), relation: answerRelationForQuestion(question), answerRunId: operationId, createdAt: finishedAt });
          if (answerOperation) answerOperation.state = "committed";
          this.recordRuntimeTrace("ANSWER_COMMITTED", {}, { questionId: question.id, answerId: event.answerId, providerRequestId, reasonCode: "provider-completed" });
          this.emitRealtimeMessage({ type: "answer_end", answerId: event.answerId, text: answerText, quality: event.quality });
          this.emitQuestionTrace(answerTrace);
          this.memory.recordAnswer(answerText, { question: question.text, questionId: question.id, groupId: question.groupId, createdAt: finishedAt });
          this.detector.markAnswered(question.id);
          this.markQuestionGroup(question.id, "answered");
          this.markQuestionStateById(question.id, "answered");
          this.markQuestionStateById(question.id, "finished");
          this.recordRuntimeTrace("QUESTION_FINISHED", {}, { questionId: question.id, answerId: event.answerId, providerRequestId, reasonCode: "answer-committed" });
          this.options.history?.updateQuestionStatus?.(this.historyQuestionIds.get(question.id) ?? question.id, "answered");
          this.answerId = undefined;
          this.answerQuestionId = undefined;
          this.answerMode = undefined;
          this.answerModel = undefined;
          this.answerStartedAt = undefined;
          this.answerFirstTokenAt = undefined;
          this.accumulatedAnswerText = "";
        }
      }
    } catch (error) {
      const answerOperation = this.runtimeAnswers.get(operationId);
      if (controller.signal.aborted || generation !== this.answerGeneration) {
        if (answerOperation && !answerOperation.detached && !["committed", "cancelled", "failed"].includes(answerOperation.state)) {
          answerOperation.state = "cancelled";
          this.recordRuntimeTrace("PROVIDER_STREAM_CANCELLED", {}, { questionId: question.id, answerId: answerOperation.answerId, providerRequestId, reasonCode: "abort" });
          this.markQuestionStateById(question.id, "cancelled");
          this.recordRuntimeTrace("QUESTION_CANCELLED", {}, { questionId: question.id, answerId: answerOperation.answerId, providerRequestId, reasonCode: "abort" });
        }
        if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_RESPONSE_FAILED", streamOptions.screenshotRequestId, { providerRequestId, answerId: answerOperation?.answerId, status: "cancelled", reasonCode: "abort" });
        if (streamOptions.screenshotRequestId) throw Object.assign(new Error("Screenshot vision request cancelled"), { name: "AbortError" });
        return;
      }
      // Always close the visible answer state on a provider failure. Without
      // this terminal event the overlay remains in “生成中” forever and the
      // next question can look as if it was ignored.
      const hadTrackedOperation = Boolean(answerOperation);
      const contextWasActive = answerOperation?.state === "created" || answerOperation?.state === "context_loading";
      if (contextWasActive) this.recordRuntimeTrace("PROJECT_CONTEXT_FAILED", {}, { questionId: question.id, providerRequestId, reasonCode: "context-error" });
      this.cancelAnswer("timeout", contextWasActive ? "context-error" : "provider-error");
      if (!hadTrackedOperation) {
        this.recordRuntimeTrace("PROVIDER_STREAM_FAILED", {}, { questionId: question.id, providerRequestId, reasonCode: "provider-error" });
        this.markQuestionStateById(question.id, "failed");
        this.recordRuntimeTrace("QUESTION_FAILED", {}, { questionId: question.id, providerRequestId, reasonCode: "provider-error" });
      }
      this.emitDiagnostic(`LLM_FAILED: ${String(error)}`);
      if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_RESPONSE_FAILED", streamOptions.screenshotRequestId, { providerRequestId, answerId: answerOperation?.answerId, status: "failed", reasonCode: contextWasActive ? "context-error" : "provider-error", fields: { error: String(error) } });
      this.emitRealtimeMessage({ type: "runtime_error", code: "LLM_FAILED", message: "答案生成失败，请检查模型配置后重试", recoverable: true });
      if (streamOptions.screenshotRequestId) throw error;
    } finally {
      this.runtimeTimers.clear(`answer-total:${operationId}`);
      this.runtimeTimers.clear(`answer-first-token:${operationId}`);
      this.runtimeAbortControllers.delete(operationId);
      this.runtimeAnswers.delete(operationId);
      if (sessionId === this.runtimeSessionId && this.runtimeSessionState === "running") {
        this.recordRuntimeTrace("ANSWER_OPERATION_CLEANUP_COMPLETED", {}, { sessionId, questionId: question.id, answerId: this.answerId, providerRequestId, reasonCode: "answer-finally" });
      }
      const isCurrentOperation = generation === this.answerGeneration
        && answerSessionGeneration === this.sessionGeneration
        && sessionId === this.runtimeSessionId
        && Boolean(this.activeInterviewId);
      if (isCurrentOperation) {
        if (this.answerController === controller) this.answerController = undefined;
        if (this.activeAnswerQuestion?.id === question.id) this.activeAnswerQuestion = undefined;
        if (this.activeQuestionTrace === answerTrace) this.activeQuestionTrace = undefined;
        this.answerContextSnapshots.delete(question.id);
        const next = this.answerScheduler.complete(question.id, { activateNext: false });
        const nextQuestion = next ? this.runtimeQuestions.get(next.id)?.question : undefined;
        if (nextQuestion && this.running) this.launchAnswer(nextQuestion);
      }
    }
  }

  private bindPorts(): void {
    this.options.audio.on("pcm-packet", (packet: Uint8Array) => this.asr.sendAudio(packet));
    this.asr.on("state", (state: RealtimeConnectionState) => {
      this.emitEvent({ type: "realtime_state", state });
      if (!this.activeInterviewId || ["stopping", "stopped", "failed", "idle"].includes(this.runtimeSessionState)) {
        this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "asr-state", state }, { reasonCode: "inactive-session" });
        return;
      }
      if (state === "connected" && this.options.session.canTransition("READY")) {
        this.transition("READY");
        if (this.options.session.canTransition("RUNNING")) {
          this.transition("RUNNING");
          this.setRuntimeState("running");
        }
      }
      if (state === "reconnecting" && this.options.session.canTransition("RECONNECTING")) this.transition("RECONNECTING");
      if (state === "error" && this.running) this.emitDiagnostic("ASR connection failed; reconnect is still enabled");
    });
    this.asr.on("transcript", (snapshot: unknown, rawSegment: TranscriptSegment) => {
      const receivedAt = this.now();
      const contextAwareAsr = this.contextAwareAsrNormalizer.normalize({
        rawTranscript: rawSegment.text,
        projectLexicon: this.sessionTerminologyLexicon,
        recentContext: this.recentTranscript.slice(-6),
        currentTopic: this.anchorStore.snapshot(receivedAt).currentTopic,
        context: this.sessionTerminologyContext,
        mode: this.activeOptions?.terminologyMode ?? "high_confidence"
      });
      const segmentTerminology = this.sessionTerminologyNormalizer.normalizeTranscript(rawSegment.text, {
        contextText: this.memory.contextText(),
        currentTopic: this.anchorStore.snapshot(receivedAt).currentTopic,
        legacyLexicon: this.sessionTerminologyLexicon,
        partial: !rawSegment.final
      });
      const segment = { ...rawSegment, text: contextAwareAsr.canonicalTranscript, rawText: rawSegment.text } as TranscriptSegment & { rawText: string };
      if (!this.activeInterviewId || this.runtimeSessionState !== "running") {
        this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "transcript", source: segment.source, final: segment.final, textLength: segment.text.length }, { reasonCode: "inactive-session" });
        return;
      }
      this.observeProjectContext(rawSegment.text, rawSegment.source === "remote" ? "interviewer" : "candidate", receivedAt);
      this.recordRuntimeTrace("TRANSCRIPT_RECEIVED", { source: segment.source, final: segment.final, textLength: segment.text.length });
      if (segment.final) this.recordRuntimeTrace("ASR_FINAL_RECEIVED", { source: segment.source, textLength: segment.text.length }, { reasonCode: "asr-final" });
      else this.recordRuntimeTrace("ASR_PARTIAL_RECEIVED", { source: segment.source, textLength: segment.text.length }, { reasonCode: "asr-partial" });
      this.emit("event", { type: "transcript", snapshot, segment });
      if (segment.final) {
        this.history.addTranscript({ interviewId: this.activeInterviewId, source: segment.source, text: segment.text, rawText: rawSegment.text, normalizedText: segmentTerminology.normalizedText, canonicalText: segmentTerminology.canonicalText, terminologyCorrections: segmentTerminology.corrections, startMs: segment.startMs, endMs: segment.endMs, final: true, confidence: segment.confidence });
        this.emitTelemetry("TERMINOLOGY_METRICS", { mode: segmentTerminology.mode, durationMs: segmentTerminology.normalizationMs, correctionsApplied: segmentTerminology.metrics.correctionsApplied, highConfidenceCorrections: segmentTerminology.metrics.highConfidenceCorrections, mediumCandidates: segmentTerminology.metrics.mediumCandidates, correctionRejected: segmentTerminology.metrics.correctionRejected });
        this.recentTranscript.push(`${segment.source === "remote" ? "面试官" : "我"}：${segment.text}`);
        while (this.recentTranscript.length > 12) this.recentTranscript.shift();
        if (segment.source === "mic") {
          this.sessionEvidence.recordCandidateStatement({
            sessionId: this.activeInterviewId,
            questionId: this.activeAnswerQuestion?.id ?? this.currentQuestion?.id,
            text: segment.text,
            createdAt: receivedAt,
            confidence: segment.confidence
          });
        }
      }
      // A candidate answer marks a hard turn boundary for the pending remote
      // question draft. Flush and analyze the remote turn before starting the
      // candidate answer; previously this flush discarded the last question.
      if (segment.final && segment.source === "mic") {
        this.clearRemoteAssemblyTimer();
        this.flushRemoteUtterances();
      }
      if (segment.source !== "remote") return;
      // CanonicalRemoteTurnAssembler is the only ASR-to-turn state owner.
      // Neither partial nor provider-final fragments enter QuestionDetector.
      if (!segment.final) {
        // The renderer may still show a non-actionable draft for feedback, but
        // this preview is deliberately emitted without passing through the
        // question detector or creating a schedulable runtime question.
        const preview: QuestionCandidate = {
          id: `partial-${segment.id}`,
          text: segment.text,
          rawText: rawSegment.text,
          normalizedText: segment.text,
          confidence: "low",
          score: 0,
          source: "rules",
          detectedAt: receivedAt,
          status: "candidate",
          final: false,
          triggerReason: "canonical-assembly-preview",
          shouldAnswer: false,
          answerable: false
        };
        this.emitEvent({ type: "question", event: { type: "question_candidate", question: preview } });
        this.recordRuntimeTrace("QUESTION_DRAFT_UPDATED", { textLength: segment.text.length, previewOnly: true }, { reasonCode: "canonical-assembly-preview" });
      }
      const anchor = this.anchorStore.snapshot(receivedAt);
      const overdue = this.canonicalRemoteTurnAssembler.flushDue(receivedAt, "interviewer");
      if (overdue.length > 0) {
        this.clearRemoteAssemblyTimer();
        overdue.forEach((turn) => this.enqueueFinalUtterance(turn));
      }
      const assembled = this.canonicalRemoteTurnAssembler.push(segment, receivedAt, {
        currentTopic: anchor.currentTopic,
        latestAnchor: anchor.latestAnchor,
        pendingCodeContext: Boolean(anchor.pendingCodeContext),
        memory: this.memory.snapshot(),
        recentTranscript: this.recentTranscript.slice(0, -1),
        now: receivedAt
      }, rawSegment.text);
      const semantic = assembled.semantic ?? assembled.current?.semantic;
      if (segment.final && semantic && !semantic.shouldAnswer && ["TOPIC_ANCHOR", "TOPIC_ANNOUNCEMENT"].includes(semantic.sourceSpeechAct)) {
        this.stageSemanticTopicAnchor(segment.text, semantic, receivedAt);
      }
      this.recordRuntimeTrace("TRANSCRIPT_ASSEMBLED", {
        merged: assembled.merged,
        reason: assembled.reason,
        fragmentCount: assembled.current?.fragments.length ?? 0,
        textLength: assembled.current?.text.length ?? 0,
        rawTextLength: assembled.current?.rawText?.length ?? segment.text.length,
        dependency: semantic?.dependency,
        completeness: semantic?.completeness,
        speechAct: semantic?.speechAct,
        sourceSpeechAct: semantic?.sourceSpeechAct,
        classificationSpeechAct: semantic?.classification.speechAct,
        shouldAnswer: semantic?.shouldAnswer,
        canonicalReady: Boolean(segment.final && assembled.current)
      }, { reasonCode: assembled.reason });
      for (const completed of assembled.completed) {
        this.clearRemoteAssemblyTimer();
        this.enqueueFinalUtterance(completed);
      }
      if (segment.final && assembled.current) this.scheduleRemoteAssembly(assembled.current, segment);
    });
    this.asr.on("message", (message: RealtimeServerMessage) => {
      if (!this.activeInterviewId || this.runtimeSessionState !== "running") {
        this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "realtime-message", type: message.type }, { reasonCode: "inactive-session" });
        return;
      }
      this.emitEvent({ type: "realtime_message", message });
    });
    this.asr.on("diagnostic", (message: string) => this.emitDiagnostic(message));
  }

  private emitQuestion(inputEvent: QuestionEvent): QuestionEvent {
    if ("question" in inputEvent) {
      const existing = this.runtimeQuestions.get(inputEvent.question.id);
      if (existing && existing.state !== "detected") {
        this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "duplicate-question", textLength: inputEvent.question.text.length }, { questionId: inputEvent.question.id, reasonCode: "duplicate-question-id" });
        const duplicate: QuestionEvent = { type: "question_diagnostic", text: inputEvent.question.text, questionScore: inputEvent.question.score, confidence: inputEvent.question.score, candidate: true, confirmed: false, reason: "duplicate-question-id", category: inputEvent.question.category, detectionType: inputEvent.question.detectionType, speechAct: inputEvent.question.speechAct, fingerprint: inputEvent.question.fingerprint, ignoredReason: "duplicate" };
        this.emitEvent({ type: "question", event: duplicate });
        return duplicate;
      }
      if (inputEvent.type === "question_candidate") {
        this.markQuestionState(inputEvent.question, "detected");
        this.recordRuntimeTrace("QUESTION_DETECTED", { textLength: inputEvent.question.text.length }, { questionId: inputEvent.question.id });
      }
    }
    let event = this.linkQuestionThread(inputEvent);
    if (event.type === "question_confirmed" || event.type === "question_superseded") {
      const turn = event.question.turnId
        ? this.turns.get(event.question.turnId)
        : event.question.utteranceId
          ? this.turns.get(event.question.utteranceId)
          : undefined;
      const groupResult = this.questionGroups.add({
        turn: turn ?? this.turnBuilder.build({ id: event.question.turnId ?? event.question.utteranceId, text: event.question.text, receivedAt: event.question.detectedAt }),
        question: event.question,
        now: this.now(),
        ...(event.type === "question_superseded" ? { relationType: "ASR_REVISION" as const } : this.pendingTopicTransition ? { relationType: "NEW_TOPIC" as const } : {})
      });
      const groupedQuestion = this.pendingTopicTransition
        ? { ...groupResult.item.question, relationType: "NEW_TOPIC" as const, contextRelation: "standalone" as const, parentQuestionId: undefined, rootQuestionId: undefined }
        : groupResult.item.question;
      const anchorEligibility = evaluateSubstantiveAnchorEligibility(groupedQuestion);
      event = { ...event, question: groupedQuestion };
      this.emitQuestionGroupResult(groupResult);
      const embeddedDimension = groupedQuestion.text.match(/空间大小[^？?。！？!；;]*/u)?.[0]?.trim();
      if (embeddedDimension && groupedQuestion.groupId) this.attachContextFragment(groupedQuestion, turn ?? this.turnBuilder.build({ id: groupedQuestion.turnId, text: groupedQuestion.text, receivedAt: groupedQuestion.detectedAt }), embeddedDimension, "embedded-dimension");
      this.pendingTopicTransition = false;
      this.markQuestionState(event.question, "confirmed");
      this.recordRuntimeTrace("QUESTION_CONFIRMED", { textLength: event.question.text.length }, { questionId: event.question.id, reasonCode: event.type });
      if (groupResult.displayable && anchorEligibility.eligible) this.currentQuestion = event.question;
      const trace = this.pendingQuestionTrace ?? new QuestionTrace({ questionTraceId: `question-trace-${event.question.id}`, questionScore: event.question.score, questionType: event.question.detectionType, followUp: event.question.speechAct === "FOLLOW_UP", projectId: this.activeProjectId, jobTargetId: this.activeOptions?.jobTargetId });
      const traceSnapshot = trace.snapshot();
      this.runtimeLatency.start(event.question.id, traceSnapshot.asrFinalReceivedAt ?? this.now());
      if (trace.snapshot().questionDetectedAt === undefined) trace.mark("questionDetected", this.now());
      const confirmedAt = this.now();
      trace.mark("questionConfirmed", confirmedAt);
      this.markLatency(event.question.id, "questionConfirmedAt", confirmedAt);
      this.currentQuestionTrace = trace;
      this.pendingQuestionTrace = undefined;
      if (anchorEligibility.eligible) {
        this.memory.recordQuestion(event.question.text, { questionId: event.question.id, parentQuestionId: event.question.parentQuestionId, rootQuestionId: event.question.rootQuestionId, groupId: event.question.groupId, relationType: event.question.relationType, createdAt: event.question.detectedAt });
        this.anchorStore.recordConfirmedQuestion({ id: event.question.id, text: event.question.text, confidence: event.question.score, topic: event.question.topic, createdAt: event.question.detectedAt });
        this.interviewMemo.recordQuestion(event.question.canonicalText ?? event.question.text);
        this.interviewMemo.setTopic(event.question.topic ?? this.anchorStore.snapshot(this.now()).currentTopic);
        this.writtenProblemState.setCurrentQuestion(event.question.canonicalText ?? event.question.text);
        this.interviewTelemetry.record({ questionRelation: event.question.relationType ?? event.question.contextRelation, activeProjectId: this.activeProjectId, activeProjectConfidence: this.activeProject?.confidence, topic: event.question.topic }, confirmedAt);
      } else {
        this.recordRuntimeTrace("QUESTION_MERGED", { anchorEligibility: anchorEligibility.reason }, { questionId: event.question.id, reasonCode: "non-substantive-confirmed-question" });
      }
      if (this.activeInterviewId) {
        const stored = this.history.addQuestion({
          interviewId: this.activeInterviewId,
          text: event.question.text,
          confidence: event.question.confidence,
          source: event.question.source,
          detectedAt: event.question.detectedAt,
          status: event.question.status,
          rawTranscript: event.question.rawText,
          normalizedQuestion: event.question.normalizedText,
          canonicalQuestion: event.question.canonicalText ?? event.question.canonicalQuestion,
          contextRelation: event.question.contextRelation,
          inheritedTopic: event.question.inheritedTopic,
          topic: event.question.topic,
           terminologyCorrections: event.question.terminologyCorrections,
           semanticFrame: event.question.semanticFrame,
           ...(event.question.groupId ? { groupId: event.question.groupId } : {}),
           ...(event.question.relationType ? { relationType: event.question.relationType } : {}),
           ...(event.question.threadItemType ? { threadItemType: event.question.threadItemType } : {}),
          ...(event.question.parentQuestionId ? { parentQuestionId: this.historyQuestionIds.get(event.question.parentQuestionId) } : {}),
          ...(event.question.rootQuestionId ? { rootQuestionId: this.historyQuestionIds.get(event.question.rootQuestionId) } : {})
        });
        this.historyQuestionIds.set(event.question.id, stored.id);
        this.questionConfirmedAt.set(event.question.id, this.now());
      }
      if (event.type === "question_superseded") {
        const previousId = this.historyQuestionIds.get(event.previousQuestionId);
        const relationIsRevision = event.question.relationType === "ASR_REVISION";
        const revisionCanReplace = relationIsRevision && this.answerScheduler.canCancel("asr_revision");
        // A detector supersede is a relationship signal, not permission to
        // tear down a visible answer. Only an explicit ASR revision before
        // effective output may replace the active answer; follow-ups and
        // augmentations remain in the scheduler queue.
        if (revisionCanReplace && this.activeAnswerQuestion?.id === event.previousQuestionId) {
          this.cancelAnswer("superseded", "asr-revision-before-output");
        } else if (!this.activeAnswerQuestion || this.activeAnswerQuestion.id !== event.previousQuestionId) {
          if (previousId) this.history.updateQuestionStatus?.(previousId, "superseded");
          this.detector.markSuperseded(event.previousQuestionId);
          this.markQuestionGroup(event.previousQuestionId, "cancelled");
          this.markQuestionStateById(event.previousQuestionId, "cancelled");
          this.recordRuntimeTrace("QUESTION_CANCELLED", {}, { questionId: event.previousQuestionId, reasonCode: relationIsRevision ? "asr-revision" : "superseded" });
        }
      }
    }
    this.emitEvent({ type: "question", event });
    return event;
  }

  private linkQuestionThread(event: QuestionEvent): QuestionEvent {
    if (event.type !== "question_confirmed" && event.type !== "question_superseded") return event;
    const previous = this.currentQuestion;
    const isFollowUp = !this.pendingTopicTransition
      && event.question.relationType !== "NEW_TOPIC"
      && event.question.contextRelation !== "standalone"
      && (event.question.speechAct === "FOLLOW_UP"
      || event.question.detectionType === "follow_up"
      || event.question.category === "followup"
      || event.question.contextRelation === "follow_up"
      || event.question.contextRelation === "continuation");
    if (!isFollowUp || !previous || previous.id === event.question.id) return event;
    return {
      ...event,
      question: {
        ...event.question,
        parentQuestionId: event.question.parentQuestionId ?? previous.id,
        rootQuestionId: event.question.rootQuestionId ?? previous.rootQuestionId ?? previous.id
      }
    };
  }

  private enqueueFinalUtterance(utterance: TranscriptUtterance): void {
    const parts = splitIntraSegmentQuestions(utterance.rawText ?? utterance.text);
    if (parts.length > 1) {
      const duration = Math.max(1, utterance.endMs - utterance.startMs);
      parts.forEach((part, index) => {
        const startRatio = part.startOffset / Math.max(1, (utterance.rawText ?? utterance.text).length);
        const endRatio = part.endOffset / Math.max(1, (utterance.rawText ?? utterance.text).length);
        this.enqueueFinalUtterance({
          ...utterance,
          id: `${utterance.id}:part-${index + 1}`,
          text: part.text,
          rawText: part.text,
          segmentIds: [...utterance.segmentIds, `${utterance.id}:part-${index + 1}`],
          startMs: utterance.startMs + Math.round(duration * startRatio),
          endMs: utterance.startMs + Math.round(duration * endRatio)
        });
      });
      this.recordRuntimeTrace("QUESTION_DRAFT_UPDATED", { splitParts: parts.length, segmentLength: utterance.text.length }, { reasonCode: "intra-segment-question-split" });
      return;
    }
    const sessionGeneration = this.sessionGeneration;
    // Keep final utterances serialized when the local classifier is enabled.
    // This prevents a later short fragment from overtaking the assembled
    // question while ONNX classification is still running.
    if (!this.detector2.hasLocalClassifier) {
      this.trackQuestionTask(this.observeFinalQuestion(utterance, sessionGeneration).catch((error) => this.emitDiagnostic(`Question 2.0 analysis failed: ${String(error)}`)));
      return;
    }
    const run = () => this.observeFinalQuestion(utterance, sessionGeneration);
    const next = this.finalQuestionQueue ? this.finalQuestionQueue.then(run) : run();
    const tracked = next.catch((error) => this.emitDiagnostic(`Question 2.0 analysis failed: ${String(error)}`));
    this.finalQuestionQueue = tracked;
    void tracked.then(
      () => { if (this.finalQuestionQueue === tracked) this.finalQuestionQueue = undefined; },
      () => { if (this.finalQuestionQueue === tracked) this.finalQuestionQueue = undefined; }
    );
    this.trackQuestionTask(tracked);
  }

  private flushRemoteUtterances(): void {
    for (const utterance of this.canonicalRemoteTurnAssembler.flush("interviewer", this.now())) this.enqueueFinalUtterance(utterance);
  }

  private scheduleRemoteAssembly(turn: CanonicalRemoteTurn, _latest: TranscriptSegment): void {
    this.runtimeTimers.clear("remote-assembly");
    const text = turn.text.trim();
    const semantic = turn.semantic;
    const endpointSignaled = Boolean(_latest.endpoint || _latest.speechFinal || _latest.utteranceEnd || _latest.endOfTurn);
    const delay = endpointSignaled ? Math.min(120, Math.max(0, turn.commitDelayMs)) : Math.max(0, Math.min(2_500, turn.commitDelayMs));
    this.recordRuntimeTrace("TURN_COMPLETION_STARTED", { textLength: text.length, dependency: semantic.dependency, completeness: semantic.completeness, speechAct: semantic.speechAct, recommendedWaitMs: delay, asrFinalIsTurnFinal: false }, { reasonCode: "canonical-turn-assembly" });
    this.interviewTelemetry.record({ questionDebounceMs: delay }, this.now());
    this.runtimeTimers.set("remote-assembly", () => {
      this.recordRuntimeTrace("TURN_COMPLETION_COMPLETED", { completeness: semantic.completeness, dependency: semantic.dependency, speechAct: semantic.speechAct, waitMs: delay, asrFinalIsTurnFinal: false }, { reasonCode: "canonical-turn-ready" });
      this.flushRemoteUtterances();
    }, delay);
  }

  private clearRemoteAssemblyTimer(): void {
    this.runtimeTimers.clear("remote-assembly");
  }

  private stageSemanticTopicAnchor(text: string, semantic: { classification: { confidence: number; topic?: string; entities: string[]; codeContext?: boolean }; sourceSpeechAct: string }, createdAt: number): void {
    const normalizedText = text.trim();
    const existing = this.anchorStore.snapshot(createdAt).latestAnchor;
    const anchorSpeechAct = "TOPIC_ANCHOR" as const;
    if (existing?.speechAct === anchorSpeechAct && existing.text === normalizedText) return;
    const anchor = this.anchorStore.addAnchor({
      text: normalizedText,
      speechAct: anchorSpeechAct,
      confidence: semantic.classification.confidence,
      topic: semantic.classification.topic,
      entities: semantic.classification.entities,
      createdAt,
      ttlMs: 7_000
    });
    this.observeProjectContext(normalizedText, "interviewer", createdAt, semantic.classification.entities, semantic.classification.topic ? [semantic.classification.topic] : []);
    this.memory.recordQuestion(anchor.text, { questionId: anchor.id, topic: anchor.topic, createdAt: anchor.createdAt });
  }

  private handleQuestionEvent(event: QuestionEvent): void {
    const effectiveEvent = this.emitQuestion(event);
    if ((effectiveEvent.type === "question_confirmed" || effectiveEvent.type === "question_superseded") && this.activeOptions?.automationMode === "AUTO") {
      const question = effectiveEvent.question;
      if (question.answerable === true && question.shouldAnswer !== false) {
        this.scheduleAnswer(question);
      } else if (question.groupId && question.threadItemType !== "TOPIC_FRAGMENT" && question.threadItemType !== "ASR_REVISION" && (this.answerScheduler.active?.groupId === question.groupId || this.visibleAnswerGroups.has(question.groupId))) {
        // Constraints/examples are not standalone questions. They update the
        // active plan before the provider request. After request/visible
        // output they remain group metadata and never create a second request.
        const active = this.answerScheduler.active;
        if (active?.groupId === question.groupId && active.canMergeBeforeRequest) void this.trackAnswerTask(this.answer(question));
        else this.recordRuntimeTrace("QUESTION_MERGED", { schedulerAction: "record-only", groupId: question.groupId }, { questionId: question.id, reasonCode: "provider-request-already-sent" });
      }
    }
  }

  private async observeFinalQuestion(utterance: TranscriptUtterance, sessionGeneration = this.sessionGeneration): Promise<void> {
    if (sessionGeneration !== this.sessionGeneration || !this.activeInterviewId) return;
    const turn = this.turnBuilder.build(utterance);
    this.turns.set(turn.id, turn);
    const detectionStartedAt = this.now();
    const canonicalTurn = utterance as Partial<CanonicalRemoteTurn>;
    const rawSegments = canonicalTurn.rawSegments?.map((fragment) => fragment.text.slice(0, 240)).slice(0, 32) ?? [utterance.rawText ?? utterance.text].map((text) => text.slice(0, 240));
    const trace = new QuestionTrace({
      questionTraceId: `question-trace-${utterance.id}`,
      asrFinalReceivedAt: utterance.lastFinalReceivedAt ?? detectionStartedAt,
      utteranceFinalizedAt: utterance.finalizedAt ?? detectionStartedAt,
      rawSegments,
      assembledTurn: utterance.text.slice(0, 640),
      dependency: canonicalTurn.semantic?.dependency,
      semanticCompleteness: canonicalTurn.semantic?.completeness,
      shouldAnswer: canonicalTurn.semantic?.shouldAnswer,
      commitReason: "canonical-turn-ready",
      projectId: this.activeProjectId,
      jobTargetId: this.activeOptions?.jobTargetId
    }).mark("questionDetectionStarted", detectionStartedAt);
    this.pendingQuestionTrace = trace;
    // Rules remain the first signal. When the local classifier is configured,
    // the async call adds the CPU-local ONNX speech-act signal. Test and
    // third-party integrations without that optional model retain the old
    // synchronous fast path.
    // The current final segment is already in recentTranscript; exclude it so
    // a short standalone question is not mistaken for a follow-up to itself.
    const previousTranscript = this.recentTranscript.slice(0, -1);
    const contextText = this.memory.contextText(previousTranscript);
    const anchorSnapshot = this.anchorStore.snapshot(detectionStartedAt);
      const terminology = this.sessionTerminologyNormalizer.normalizeTranscript(utterance.rawText ?? utterance.text, {
      contextText,
      previousQuestion: anchorSnapshot.lastConfirmedQuestion?.text,
      currentTopic: anchorSnapshot.currentTopic,
      legacyLexicon: this.sessionTerminologyLexicon
    });
      const correctedText = terminology.canonicalText;
      const rawAsrText = utterance.rawText ?? correctedText;
      const forceUnresolvedRaw = /(?:非二G|二G的时里)/iu.test(rawAsrText);
      const assembledSemantic = canonicalTurn.semantic;
      let semanticTurn = assembledSemantic ?? this.semanticTurnGate.decide(correctedText, {
        memory: this.memory.snapshot(),
        recentTranscript: previousTranscript,
        currentTopic: anchorSnapshot.currentTopic,
        latestAnchor: anchorSnapshot.latestAnchor,
        pendingCodeContext: Boolean(anchorSnapshot.pendingCodeContext),
        previousInterviewerTurn: anchorSnapshot.latestAnchor?.text,
        now: detectionStartedAt
      });
      if (this.ambiguousSemanticResolver.shouldResolve(semanticTurn.confidence)) {
        try {
          const resolvedAmbiguity = await this.ambiguousSemanticResolver.resolve({
            previousInterviewerTurns: previousTranscript.filter((item) => item.startsWith("面试官：")).slice(-3),
            pendingFragments: rawSegments,
            previousCandidateAnswer: this.memory.snapshot().recentAnswers.at(-1) ?? "",
            activeTopic: anchorSnapshot.currentTopic ?? "",
            activeProject: this.activeProject?.projectName ?? "",
            activeEntity: semanticTurn.classification.entities[0] ?? ""
          }, semanticTurn.confidence);
          if (resolvedAmbiguity) {
            semanticTurn = {
              ...semanticTurn,
              speechAct: resolvedAmbiguity.speechAct,
              completeness: resolvedAmbiguity.complete ? "COMPLETE" : "INCOMPLETE",
              dependency: resolvedAmbiguity.relation === "FOLLOW_UP" ? "DEPENDS_ON_PREVIOUS" : semanticTurn.dependency,
              shouldAnswer: resolvedAmbiguity.shouldAnswer,
              confidence: Math.min(semanticTurn.confidence, resolvedAmbiguity.confidence),
              reason: `${semanticTurn.reason}+ambiguous-resolver`
            };
            this.recordRuntimeTrace("SEMANTIC_TURN_DECISION", {
              dependency: semanticTurn.dependency,
              completeness: semanticTurn.completeness,
              speechAct: semanticTurn.speechAct,
              shouldAnswer: semanticTurn.shouldAnswer,
              confidence: semanticTurn.confidence,
              resolver: "ambiguous-json"
            }, { reasonCode: "ambiguous-semantic-resolved" });
          }
        } catch (error) {
          this.emitDiagnostic(`Ambiguous semantic resolver failed: ${String(error)}`);
        }
      }
      trace.update({
        assembledTurn: correctedText.slice(0, 640),
        dependency: semanticTurn.dependency,
        semanticCompleteness: semanticTurn.completeness,
        shouldAnswer: semanticTurn.shouldAnswer,
        commitReason: semanticTurn.shouldAnswer ? "semantic-answerable" : undefined,
        discardReason: semanticTurn.shouldAnswer ? undefined : semanticTurn.reason
      });
      this.recordRuntimeTrace("SEMANTIC_TURN_DECISION", {
        dependency: semanticTurn.dependency,
        completeness: semanticTurn.completeness,
        speechAct: semanticTurn.speechAct,
        shouldAnswer: semanticTurn.shouldAnswer,
        confidence: semanticTurn.confidence,
        rawSegmentCount: rawSegments.length,
        assembledTextLength: correctedText.length,
        activeQuestionId: this.activeQuestionAnchor()?.id,
        activeQuestionGroupId: this.activeQuestionAnchor()?.groupId
      }, { reasonCode: semanticTurn.reason });
      this.writtenProblemState.addSpokenProblem(correctedText);
      this.interviewTelemetry.record({ speechAct: semanticTurn.speechAct, utteranceCompleteness: semanticTurn.completeness, activeProjectId: this.activeProjectId, activeProjectConfidence: this.activeProject?.confidence, topic: anchorSnapshot.currentTopic }, detectionStartedAt);
      trace.update({
        speechAct: semanticTurn.speechAct,
        speechActReason: semanticTurn.reason,
        turnCompletionState: semanticTurn.completeness,
        turnCompletionConfidence: semanticTurn.confidence,
        turnCompletionReason: semanticTurn.reason,
        terminologyCorrectionCount: terminology.corrections.length,
      terminologyPossibleTerms: terminology.possibleTerms.map((item) => item.value),
      terminologyConfidence: terminology.confidence,
      unresolvedAsr: false
    });
    if (forceUnresolvedRaw) {
      const asrUnderstanding = this.unresolvedAsrGate.assess(rawAsrText, { ...terminology, corrections: [], possibleTerms: [] });
      this.emitTelemetry("ASR_UNDERSTANDING_QUALITY", {
        quality: asrUnderstanding.quality,
        confidence: asrUnderstanding.confidence,
        reason: asrUnderstanding.reason,
        text: correctedText.slice(0, 120)
      });
      trace.update({ unresolvedAsr: true, asrUnderstandingQuality: asrUnderstanding.quality, finalScore: 0, decision: "reject", decisionReason: asrUnderstanding.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      this.emitQuestionTrace();
      return;
    }
    this.recordRuntimeTrace("QUESTION_LOCAL_ANALYSIS_STARTED", { textLength: correctedText.length }, { reasonCode: "final-utterance" });
    this.emitTelemetry("TERMINOLOGY_METRICS", { mode: terminology.mode, durationMs: terminology.normalizationMs, correctionsApplied: terminology.metrics.correctionsApplied, highConfidenceCorrections: terminology.metrics.highConfidenceCorrections, mediumCandidates: terminology.metrics.mediumCandidates, correctionRejected: terminology.metrics.correctionRejected });
    const canResolveWithPendingTopic = Boolean(anchorSnapshot.pendingTopicAnchor && semanticTurn.dependency === "DEPENDS_ON_PREVIOUS");
    if ((!semanticTurn.shouldAnswer || ["BACKCHANNEL", "ASR_NOISE", "INCOMPLETE", "STATEMENT"].includes(semanticTurn.speechAct)) && !forceUnresolvedRaw && !canResolveWithPendingTopic) {
      if (["TOPIC_ANCHOR", "TOPIC_ANNOUNCEMENT"].includes(semanticTurn.sourceSpeechAct)) {
        const topicClassification = semanticTurn.classification;
        const existing = this.anchorStore.snapshot(detectionStartedAt).latestAnchor;
        if (!(existing?.speechAct === "TOPIC_ANCHOR" && existing.text === correctedText)) {
          const anchor = this.anchorStore.addAnchor({
            text: correctedText,
            speechAct: "TOPIC_ANCHOR",
            confidence: topicClassification.confidence,
            topic: topicClassification.topic,
            entities: topicClassification.entities,
            createdAt: detectionStartedAt,
            ttlMs: 7_000
          });
          this.observeProjectContext(correctedText, "interviewer", detectionStartedAt, topicClassification.entities, topicClassification.topic ? [topicClassification.topic] : []);
          this.memory.recordQuestion(anchor.text, { questionId: anchor.id, topic: anchor.topic, createdAt: anchor.createdAt });
        }
      }
      if (semanticTurn.sourceSpeechAct === "TOPIC_TRANSITION") this.pendingTopicTransition = true;
      const isConstraintFragment = /(?:只说|只讲|越具体|越详细|包括|涵盖|还要|同时|从.+角度|角度也说|比如|例如|举个|空间大小|常见风险|两件事)/iu.test(correctedText);
      const activeQuestion = this.activeQuestionAnchor();
      if (activeQuestion?.groupId && isConstraintFragment) {
        this.attachContextFragments(activeQuestion, utterance, turn, correctedText);
      } else if (isConstraintFragment) {
        this.stageQuestionContext(utterance, turn, correctedText, "INSTRUCTION_MODIFIER");
      } else if (["TOPIC_ANCHOR", "TOPIC_ANNOUNCEMENT", "INSTRUCTION_MODIFIER"].includes(semanticTurn.sourceSpeechAct)) {
        if (semanticTurn.sourceSpeechAct === "INSTRUCTION_MODIFIER" && activeQuestion?.groupId) this.attachContextFragments(activeQuestion, utterance, turn, correctedText);
        else this.stageQuestionContext(utterance, turn, correctedText, semanticTurn.sourceSpeechAct as QuestionCandidate["speechAct"]);
      }
      trace.update({ finalScore: 0, decision: "reject", decisionReason: semanticTurn.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      this.emitQuestionTrace();
      return;
    }
    if (semanticTurn.completeness === "INCOMPLETE" && !canResolveWithPendingTopic) {
      trace.update({ finalScore: 0, decision: "reject", decisionReason: semanticTurn.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      this.emitQuestionTrace();
      return;
    }
    // Keep an uncorrected garbled phrase visible to the ASR guard. A
    // terminology correction may legitimately turn “电炉环” into “电流环”,
    // but an unrepaired raw fragment such as “非二G的时里” must not be
    // hidden by the canonical text path.
    const unresolvedInput = forceUnresolvedRaw ? rawAsrText : terminology.corrections.length > 0 ? correctedText : rawAsrText;
    const unresolvedResolution = forceUnresolvedRaw ? { ...terminology, corrections: [], possibleTerms: [] } : terminology;
    const asrUnderstanding = this.unresolvedAsrGate.assess(unresolvedInput, unresolvedResolution, {
      acousticConfidence: utterance.confidence,
      terminologyConfidence: terminology.confidence,
      currentTopic: anchorSnapshot.currentTopic,
      recentInterviewerTurns: previousTranscript.filter((item) => item.startsWith("面试官：")).slice(-4),
      knownTerms: this.sessionTerminologyNormalizer.listTerms().flatMap((term) => [term.canonical, ...term.aliases]),
      syntaxComplete: semanticTurn.shouldAnswer || canResolveWithPendingTopic,
      contextConsistent: true,
      plausible: semanticTurn.speechAct !== "ASR_NOISE"
    });
    const asrAssessment = asrUnderstanding.assessment;
    trace.update({
      asrUnderstandingQuality: asrUnderstanding.quality,
      unresolvedAsr: !asrUnderstanding.shouldAnswer,
      asrTrustConfidence: asrAssessment?.confidence,
      asrTrustDecision: asrAssessment?.decision,
      unresolvedTerms: asrAssessment?.unresolvedTerms,
      suspiciousTerms: asrAssessment?.suspiciousTerms,
      contextConsistent: asrAssessment?.contextConsistent
    });
    this.recordRuntimeTrace("ASR_TRUST_ASSESSMENT", {
      confidence: asrAssessment?.confidence,
      decision: asrAssessment?.decision,
      unresolvedTermCount: asrAssessment?.unresolvedTerms.length ?? 0,
      suspiciousTermCount: asrAssessment?.suspiciousTerms.length ?? 0,
      contextConsistent: asrAssessment?.contextConsistent
    }, { reasonCode: asrUnderstanding.reason });
    if (!asrUnderstanding.shouldAnswer) {
      this.emitTelemetry("ASR_UNDERSTANDING_QUALITY", {
        quality: asrUnderstanding.quality,
        confidence: asrUnderstanding.confidence,
        reason: asrUnderstanding.reason,
        text: correctedText.slice(0, 120)
      });
      trace.update({ unresolvedAsr: true, asrUnderstandingQuality: asrUnderstanding.quality, finalScore: 0, decision: "reject", decisionReason: asrUnderstanding.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      this.emitQuestionTrace();
      return;
    }
    const speech = semanticTurn.classification;
    trace.update({
      source: utterance.source,
      ...questionTraceTextMetadata(utterance.text),
      speechAct: speech.speechAct,
      speechActReason: speech.reason,
      contextTopic: anchorSnapshot.currentTopic,
      terminologyCorrectionCount: terminology.corrections.length,
      terminologyConfidence: terminology.confidence,
      projectAnchorAvailable: Boolean(this.activeProjectId),
      isFollowUp: semanticTurn.speechAct === "FOLLOW_UP_REQUEST"
    });
    const promotesStatement = speech.speechAct === "STATEMENT" && Boolean(speech.topic || speech.entities.length);
    if (speech.speechAct === "TOPIC_ANCHOR" || promotesStatement) {
      const anchor = this.anchorStore.addAnchor({
        text: correctedText,
        speechAct: speech.codeContext ? "CODE_CONTEXT" : "TOPIC_ANCHOR",
        confidence: speech.confidence,
        topic: speech.topic,
        entities: speech.entities,
        createdAt: detectionStartedAt,
        ttlMs: speech.codeContext ? 12_000 : 7_000
      });
    this.observeProjectContext(correctedText, "interviewer", detectionStartedAt, speech.entities, speech.topic ? [speech.topic] : []);
      this.memory.recordQuestion(anchor.text, { questionId: anchor.id, topic: anchor.topic, createdAt: anchor.createdAt });
    }
    if (!(["QUESTION", "ANSWER_REQUEST", "FOLLOW_UP_REQUEST"].includes(semanticTurn.speechAct)) || shouldHardRejectSpeechAct(speech)) {
      if (speech.speechAct === "TOPIC_TRANSITION") {
        // Keep the boundary as coordinator state. The marker must not enter
        // QuestionGroupManager, otherwise the overlay gets a fake answerable
        // group titled “下一个问题”.
        this.pendingTopicTransition = true;
      } else if (speech.speechAct === "TOPIC_ANNOUNCEMENT" || speech.speechAct === "INSTRUCTION_MODIFIER") {
        this.stageQuestionContext(utterance, turn, correctedText, speech.speechAct);
      }
      trace.update({ finalScore: 0, decision: "reject", decisionReason: speech.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      this.emitQuestionTrace();
      return;
    }
    const understanding = this.questionUnderstanding.understand({
      text: correctedText,
      fragments: canonicalTurn.rawSegments?.map((fragment) => fragment.text),
      semantic: semanticTurn,
      anchors: anchorSnapshot,
      activeProject: this.activeProject,
      currentModule: anchorSnapshot.currentTopic,
      previousQuestion: anchorSnapshot.lastConfirmedQuestion?.text,
      previousAnswer: this.memory.snapshot().recentAnswers.at(-1),
      spokenProblem: this.writtenProblemState.promptContext()
    });
    const resolved = this.pendingTopicTransition
      ? {
        ...understanding,
        canonicalQuestion: understanding.canonicalQuestion,
        contextRelation: "standalone" as const,
        parentQuestionId: undefined,
        rootQuestionId: undefined,
        inheritedTopic: undefined,
        anchorUsed: undefined,
        reason: "pending-topic-transition"
      }
      : understanding;
    const topicBoundaryRelation = resolved.contextRelation === "standalone"
      ? (resolved.explicitTopic && anchorSnapshot.currentTopic && resolved.explicitTopic.toLowerCase() !== anchorSnapshot.currentTopic.toLowerCase() ? "NEW_TOPIC" : "SAME_OR_NEW_TOPIC")
      : resolved.contextRelation === "continuation" ? "RELATED_TOPIC" : "SAME_TOPIC";
    trace.update({
      explicitTopic: resolved.explicitTopic,
      topicBoundaryRelation,
      subQuestions: resolved.subQuestions,
      primaryQuestion: resolved.primaryQuestion,
      contextTopic: resolved.topic ?? anchorSnapshot.currentTopic,
      projectResolutionStatus: this.activeProjectResolver.state.status,
      projectResolutionReason: this.activeProjectResolver.state.lastReason
    });
    this.recordRuntimeTrace("TOPIC_BOUNDARY_DECISION", {
      relation: topicBoundaryRelation,
      explicitTopic: resolved.explicitTopic,
      previousTopic: anchorSnapshot.currentTopic,
      confidence: resolved.explicitTopic ? 0.96 : 0.7
    }, { reasonCode: resolved.explicitTopic ? "explicit-topic-evaluated" : "inherited-topic-evaluated" });
    if (anchorSnapshot.pendingTopicAnchor) this.anchorStore.consumePendingTopicAnchor(detectionStartedAt);
    const canonicalQuestion = resolved.canonicalQuestion;
    const compactCanonicalQuestion = canonicalQuestion.replace(/[\s，。！？、,.!?；;:：]/gu, "");
    const hasIndependentTopicEntity = /(?:IIC|I2C|SPI|UART|CAN|RTOS|FOC|DMA|ADC|中断|总线|系统|项目|模块|架构|内存|HardFault|看门狗|电机|协议|锁|任务|采样|volatile|Flash|CRC)/iu.test(compactCanonicalQuestion);
    const shouldMergeShortDependentTail = Boolean(
      this.activeQuestionAnchor()?.groupId
      && compactCanonicalQuestion.length <= 12
      && !hasIndependentTopicEntity
      && /(?:假活真死|假活|真死)/iu.test(compactCanonicalQuestion)
      && !/^(?:换个话题|下一个问题|下一题|再问一个)/iu.test(compactCanonicalQuestion)
    );
    if (shouldMergeShortDependentTail) {
      this.attachContextFragment(this.activeQuestionAnchor()!, turn, canonicalQuestion, `dependent-tail-${utterance.id}`);
      trace.update({ finalScore: 0, decision: "reject", decisionReason: "short-dependent-tail-merged" }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      this.emitQuestionTrace();
      return;
    }
    this.recordRuntimeTrace("QUESTION_COMMIT_DECISION", {
      shouldAnswer: semanticTurn.shouldAnswer,
      dependency: semanticTurn.dependency,
      completeness: semanticTurn.completeness,
      canonicalTextLength: canonicalQuestion.length,
      relation: resolved.contextRelation
    }, { reasonCode: "canonical-question-ready" });
    const detectionContext = {
      memory: this.memory.snapshot(),
      recentTranscript: previousTranscript,
      latestAnchor: anchorSnapshot.latestAnchor,
      pendingCodeContext: Boolean(anchorSnapshot.pendingCodeContext),
      semanticTurnDecision: semanticTurn
    };
    let analysis = this.detector2.hasLocalClassifier
      ? await this.detector2.analyze(canonicalQuestion, contextText, true, detectionContext)
      : this.detector2.analyzeSync(canonicalQuestion, contextText, true, detectionContext);
    analysis = {
      ...analysis,
      text: canonicalQuestion,
      rawText: utterance.rawText ?? utterance.text,
      normalizedText: correctedText,
      canonicalText: canonicalQuestion,
      semanticFrame: classifyQuestionSemanticFrame(canonicalQuestion, analysis.type),
      contextRelation: resolved.contextRelation,
      inheritedTopic: resolved.inheritedTopic,
      topic: resolved.topic,
      terminologyCorrections: terminology.corrections,
      type: analysis.isQuestion
        ? speech.speechAct === "FOLLOW_UP" ? "follow_up" : analysis.type
        : "not_question",
      speechAct: analysis.isQuestion && (resolved.contextRelation === "follow_up" || resolved.contextRelation === "continuation")
        ? "FOLLOW_UP"
        : analysis.isQuestion ? speech.speechAct : analysis.speechAct,
      normalizedQuestion: canonicalQuestion,
      anchorUsedId: resolved.anchorUsed?.id,
      shouldAnswer: analysis.shouldAnswer,
      primaryQuestion: resolved.primaryQuestion,
      subQuestions: [...resolved.subQuestions],
      nuclei: resolved.nuclei.map((nucleus) => ({ ...nucleus })),
      questionDecomposition: { ...resolved.questionDecomposition, slots: resolved.questionDecomposition.slots.map((slot) => ({ ...slot })) },
      explicitTopic: resolved.explicitTopic,
      reason: `${speech.reason}+${resolved.reason}`,
      ...(speech.codeContext ? { codeContext: true } : {})
    };
    if (canResolveWithPendingTopic && !analysis.isQuestion) {
      analysis = {
        ...analysis,
        isQuestion: true,
        shouldAnswer: true,
        type: "technical",
        speechAct: "QUESTION",
        confidence: Math.max(analysis.confidence, semanticTurn.confidence),
        normalizedQuestion: canonicalQuestion,
        answerabilityState: "CONTEXT_DEPENDENT",
        score: {
          ...analysis.score,
          semanticScore: Math.max(analysis.score.semanticScore, semanticTurn.confidence),
          finalScore: Math.max(analysis.score.finalScore, semanticTurn.confidence, 0.86)
        },
        reason: `${analysis.reason}+pending-topic-anchor`
      };
    }
    // InterviewBrain retains a compatibility rescue for short implicit
    // follow-ups. The local semantic gate is authoritative for live turns so
    // a bare request/setup/dangling tail cannot be promoted back into an
    // answerable question by that rescue.
    if (analysis.answerabilityState && !["ANSWERABLE", "CONTEXT_DEPENDENT"].includes(analysis.answerabilityState) && !canResolveWithPendingTopic) {
      trace.update({ finalScore: 0, decision: "reject", decisionReason: analysis.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      this.emitQuestionTrace();
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      return;
    }
    let decision = this.brain.analyze({ text: canonicalQuestion, analysis, memory: detectionContext.memory, recentTranscript: previousTranscript });
    this.recordRuntimeTrace("QUESTION_LOCAL_ANALYSIS_COMPLETED", { question: decision.isQuestion, score: analysis.score.finalScore }, { reasonCode: analysis.reason });
    trace.update({
      speechAct: analysis.speechAct,
      ruleScore: analysis.score.ruleScore,
      semanticScore: analysis.score.semanticScore,
      ...(analysis.score.localClassifierScore !== undefined ? { localClassifierScore: analysis.score.localClassifierScore } : {}),
      llmScore: analysis.score.llmScore,
      speechActReason: analysis.reason,
      finalScore: analysis.score.finalScore,
      contextTopic: anchorSnapshot.currentTopic,
      contextRelation: resolved.contextRelation,
      topicRelation: resolved.contextRelation === "standalone" ? "NEW_TOPIC" : resolved.contextRelation === "continuation" ? "RELATED_TOPIC" : "SAME_TOPIC",
      semanticFrame: analysis.semanticFrame,
      ...(resolved.parentQuestionId ? { parentQuestionId: resolved.parentQuestionId } : {}),
      isFollowUp: analysis.speechAct === "FOLLOW_UP"
    });
    // Elliptical follow-ups such as “好，说说” are promoted by
    // InterviewBrain immediately when a topic exists in memory.
    if (!decision.isQuestion || !this.activeInterviewId || sessionGeneration !== this.sessionGeneration) {
      if (promotesStatement || speech.speechAct === "TOPIC_ANCHOR") this.stageQuestionContext(utterance, turn, canonicalQuestion, speech.speechAct);
      trace.update({ decision: "reject", decisionReason: decision.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      this.emitQuestionTrace();
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      return;
    }
    const observed = { ...utterance, text: canonicalQuestion };
    const effectiveAnalysis = analysis.isQuestion
      ? analysis
      : {
        ...analysis,
        isQuestion: true,
        type: decision.type,
        speechAct: decision.type === "follow_up" ? "FOLLOW_UP" as const : "QUESTION" as const,
        confidence: Math.max(analysis.confidence, decision.confidence),
        normalizedQuestion: decision.normalizedQuestion,
        reason: decision.reason,
        score: { ...analysis.score, finalScore: Math.max(analysis.score.finalScore, decision.confidence), semanticScore: Math.max(analysis.score.semanticScore, decision.confidence) }
      };
    trace.update({
      decision: "answer",
      decisionReason: decision.reason,
      finalScore: effectiveAnalysis.score.finalScore,
      speechAct: effectiveAnalysis.speechAct,
      questionScore: effectiveAnalysis.score.finalScore,
      questionType: effectiveAnalysis.type,
      followUp: effectiveAnalysis.speechAct === "FOLLOW_UP"
    }).mark("questionDetected", this.now());
    const enrichEvent = (event: QuestionEvent): QuestionEvent => {
      if (!("question" in event)) return event;
      return {
        ...event,
        question: {
          ...event.question,
          text: canonicalQuestion,
          canonicalQuestion,
          rawText: utterance.rawText ?? utterance.text,
          normalizedText: correctedText,
          canonicalText: canonicalQuestion,
          semanticFrame: classifyQuestionSemanticFrame(canonicalQuestion, effectiveAnalysis.type),
          contextRelation: resolved.contextRelation,
          inheritedTopic: resolved.inheritedTopic,
          topic: resolved.topic,
          terminologyCorrections: terminology.corrections,
          primaryQuestion: resolved.primaryQuestion,
          subQuestions: [...resolved.subQuestions],
          nuclei: resolved.nuclei.map((nucleus) => ({ ...nucleus })),
          questionDecomposition: { ...resolved.questionDecomposition, slots: resolved.questionDecomposition.slots.map((slot) => ({ ...slot })) },
          explicitTopic: resolved.explicitTopic,
          utteranceId: utterance.id,
          segmentIds: [...utterance.segmentIds],
          turnId: turn.id,
          ...(this.pendingTopicTransition ? { relationType: "NEW_TOPIC" as const, contextRelation: "standalone" as const, parentQuestionId: undefined, rootQuestionId: undefined } : {}),
          ...(resolved.parentQuestionId ? { parentQuestionId: resolved.parentQuestionId } : {}),
          ...(resolved.rootQuestionId ? { rootQuestionId: resolved.rootQuestionId } : {}),
          ...(resolved.anchorUsed ? { anchorId: resolved.anchorUsed.id } : {})
        }
      } as QuestionEvent;
    };
    const observedEvents = this.detector.observe({ ...observed, utteranceId: utterance.id, analysis: effectiveAnalysis }, this.now()).map(enrichEvent);
    observedEvents.forEach((event) => this.handleQuestionEvent(event));
    // The remote assembly timer already represents an end-of-speech silence.
    // Flush the temporal detector immediately after the assembled utterance
    // is classified instead of adding another 280ms debounce to every answer.
    const normalizedLength = utterance.text.replace(/[\s，。！？、,.!?；;:：]/g, "").length;
    const shortFollowUp = effectiveAnalysis.speechAct === "FOLLOW_UP" && normalizedLength <= 8;
    // Remote assembly has already waited for the end-of-speech gap. For an
    // elliptical follow-up, use that completed assembly delay as the hold and
    // flush with the detector's completeness horizon immediately; adding a
    // second timer here would make a confirmed short follow-up feel stale.
    const flushAt = this.now() + this.questionSilenceMs + (shortFollowUp ? 220 : 0);
    const flushedEvents = this.detector.flush(flushAt).map(enrichEvent);
    flushedEvents.forEach((event) => this.handleQuestionEvent(event));
    const confirmed = [...observedEvents, ...flushedEvents].find((event): event is Extract<QuestionEvent, { type: "question_confirmed" | "question_superseded" }> => (event.type === "question_confirmed" || event.type === "question_superseded") && "question" in event);
    if (confirmed) this.handleCanonicalContextFragments(confirmed.question, utterance, turn);
  }

  private scheduleAnswer(question: QuestionCandidate): void {
    if (question.answerable !== true || question.shouldAnswer !== true) return;
    const isCoveredEllipticalFollowUp = /^(?:你会(?:更)?倾向于?用?哪(?:一个|个)|哪一个|这两个|前者|后者|其中|然后呢|还有(?:吗|呢)?|具体(?:呢)?)[？?。！!\s]*$/iu.test(question.text.trim());
    const questionClauses = question.text.split(/[？?。！!；;]/u).map((clause) => clause.trim()).filter(Boolean);
    const hasMultipleQuestionClauses = questionClauses.filter((clause) => /(?:为什么|为何|怎么|如何|怎样|哪些|哪个|什么|是否|有没有|能不能|可不可以|吗|呢|作用|原理|区别|排查|定位|设计|实现|验证|解决|优化)/iu.test(clause)).length > 1;
    if (question.answerabilityState === "CONTEXT_DEPENDENT" && (isCoveredEllipticalFollowUp || hasMultipleQuestionClauses) && question.groupId && (this.visibleAnswerGroups.has(question.groupId) || this.answerScheduler.active?.groupId === question.groupId)) {
      this.recordRuntimeTrace("QUESTION_MERGED", { schedulerAction: "ignore", groupId: question.groupId, reason: "context-follow-up-already-covered" }, { questionId: question.id, reasonCode: "context-follow-up-already-covered" });
      return;
    }
    const sessionGeneration = this.sessionGeneration;
    // Completeness has already been established by the temporal detector.
    // Do not add another post-confirmation delay, especially for short but
    // complete follow-ups such as “为什么这样设计？”.
    if (sessionGeneration === this.sessionGeneration && this.activeInterviewId && this.runtimeSessionState === "running") {
      this.launchAnswer(question);
      return;
    }
    this.pendingAnswerQuestion = question;
    this.runtimeTimers.set("answer-trigger", () => {
      this.answerTriggerTimer = undefined;
      const pending = this.pendingAnswerQuestion;
      this.pendingAnswerQuestion = undefined;
      if (!pending || sessionGeneration !== this.sessionGeneration || !this.activeInterviewId || this.runtimeSessionState !== "running") {
        if (pending) this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "answer-trigger" }, { questionId: pending.id, reasonCode: "stale-answer-trigger" });
        return;
      }
      this.launchAnswer(pending);
    }, 0);
  }

  private contextFragmentTexts(utterance: TranscriptUtterance, fallbackText: string, includeFirst = false): string[] {
    const canonical = utterance as Partial<CanonicalRemoteTurn>;
    const fragments = canonical.rawSegments?.slice(includeFirst ? 0 : 1).map((fragment) => (fragment.rawText ?? fragment.text).trim()).filter((text) => text && /(?:只说|只讲|越具体|越详细|包括|涵盖|还要|同时|从.+角度|角度也说|比如|例如|举个|空间大小|常见风险|两件事)/iu.test(text)) ?? [];
    return fragments.length ? fragments : [fallbackText.trim()];
  }

  private handleCanonicalContextFragments(question: QuestionCandidate, utterance: TranscriptUtterance, turn: InterviewTurn): void {
    if (!question.groupId) return;
    const canonical = utterance as Partial<CanonicalRemoteTurn>;
    const fragments = canonical.rawSegments?.slice(1).map((fragment) => (fragment.rawText ?? fragment.text).trim()).filter((text) => text && /(?:只说|只讲|越具体|越详细|包括|涵盖|还要|同时|从.+角度|角度也说|比如|例如|举个|空间大小|常见风险|两件事)/iu.test(text)) ?? [];
    if (fragments.length) {
      fragments.forEach((text, index) => this.attachContextFragment(question, turn, text, `canonical-fragment-${index + 1}`));
      return;
    }
    // If a detector race only leaves the canonical text, retain the explicit
    // dimension clause as a group item instead of losing it with the raw
    // fragment metadata.
    const fallback = question.text.match(/空间大小[^？?。！？!；;]*/u)?.[0]?.trim();
    if (fallback) this.attachContextFragment(question, turn, fallback, "canonical-dimension-fallback");
  }

  private attachContextFragments(question: QuestionCandidate, utterance: TranscriptUtterance, turn: InterviewTurn, fallbackText: string): void {
    if (!question.groupId) return;
    this.contextFragmentTexts(utterance, fallbackText, true).forEach((text, index) => this.attachContextFragment(question, turn, text, `late-context-${index + 1}`));
  }

  private attachContextFragment(question: QuestionCandidate, turn: InterviewTurn, text: string, sourceId: string): void {
    if (!question.groupId || !text.trim()) return;
    this.recordRuntimeTrace("LATE_CONSTRAINT_RECEIVED", { role: "ANSWER_CONSTRAINT", textLength: text.length }, { questionId: question.id, reasonCode: "canonical-context-fragment" });
    const candidate: QuestionCandidate = {
      id: `late-constraint-${question.id}-${sourceId}`,
      text: text.trim(),
      rawText: text.trim(),
      normalizedText: text.trim(),
      canonicalText: text.trim(),
      confidence: "high",
      score: 1,
      source: "rules",
      detectedAt: this.now(),
      status: "confirmed",
      final: true,
      answerable: false,
      shouldAnswer: false,
      groupId: question.groupId,
      turnId: question.turnId,
      utteranceId: `late-${question.id}-${sourceId}`,
      segmentIds: [sourceId],
      relationType: "ANSWER_CONSTRAINT",
      threadItemType: "ANSWER_CONSTRAINT",
      contextRelation: "continuation",
      ...(question.topic ? { topic: question.topic } : {})
    };
    const groupResult = this.questionGroups.add({ turn, question: candidate, now: this.now(), relationType: "ANSWER_CONSTRAINT" });
    if (groupResult.group.id !== question.groupId) {
      this.recordRuntimeTrace("LATE_CONSTRAINT_DROPPED", { role: "ANSWER_CONSTRAINT", textLength: text.length }, { questionId: question.id, reasonCode: "question-group-mismatch" });
      return;
    }
    this.emitQuestionGroupResult(groupResult);
    this.recordRuntimeTrace("LATE_CONSTRAINT_MERGED", { role: "ANSWER_CONSTRAINT", groupId: question.groupId }, { questionId: question.id, reasonCode: "same-question-group" });
    this.recordRuntimeTrace("QUESTION_MERGED", { schedulerAction: "record-only", groupId: question.groupId, role: "ANSWER_CONSTRAINT" }, { questionId: question.id, reasonCode: "canonical-context-fragment" });
  }

  private clearAnswerTrigger(): void {
    this.runtimeTimers.clear("answer-trigger");
    this.answerTriggerTimer = undefined;
    this.pendingAnswerQuestion = undefined;
  }

  private cancelAnswer(reason: "user" | "superseded" | "timeout", traceReasonCode: string = reason): void {
    const schedulerReason = reason === "timeout" ? "provider_timeout" : reason === "superseded" ? "asr_revision" : "user";
    const schedulerCancellation = this.answerScheduler.cancel(schedulerReason);
    if (reason === "superseded" && !schedulerCancellation.cancelled) return;
    this.answerGeneration += 1;
    const activeOperation = [...this.runtimeAnswers.values()].find((answer) => answer.controller === this.answerController);
    const answerId = this.answerId;
    const questionId = this.answerQuestionId;
    const inFlight = Boolean(answerId || this.answerController || this.answerStartedAt !== undefined || this.accumulatedAnswerText);
    const persistedQuestion = this.activeAnswerQuestion;
    const persistedQuestionId = questionId ?? (inFlight ? this.activeAnswerQuestion?.id : undefined);
    const now = this.now();
    this.answerController?.abort();
    if (activeOperation && !activeOperation.detached) {
      this.runtimeTimers.clear(`answer-total:${activeOperation.operationId}`);
      this.runtimeTimers.clear(`answer-first-token:${activeOperation.operationId}`);
      const terminalState: RuntimeAnswerState = reason === "timeout" ? "failed" : "cancelled";
      const wasActive = !["committed", "cancelled", "failed"].includes(activeOperation.state);
      activeOperation.state = terminalState;
      if (wasActive) {
        this.recordRuntimeTrace(
          terminalState === "cancelled" ? "PROVIDER_STREAM_CANCELLED" : "PROVIDER_STREAM_FAILED",
          {},
          { questionId: activeOperation.questionId, answerId: activeOperation.answerId, providerRequestId: activeOperation.providerRequestId, reasonCode: traceReasonCode }
        );
      }
      const questionState: RuntimeQuestionState = reason === "timeout" ? "failed" : "cancelled";
      this.markQuestionStateById(activeOperation.questionId, questionState);
      this.recordRuntimeTrace(
        questionState === "cancelled" ? "QUESTION_CANCELLED" : "QUESTION_FAILED",
        {},
        { questionId: activeOperation.questionId, answerId: activeOperation.answerId, providerRequestId: activeOperation.providerRequestId, reasonCode: traceReasonCode }
      );
    }
    this.answerController = undefined;
    this.activeAnswerQuestion = undefined;
    this.answerId = undefined;
    if (answerId) this.emitAnswerCancelled(answerId, reason);
    // Persist cancellation even if the provider was aborted between request
    // creation and the first answer_start event. The old answerId-only guard
    // dropped exactly that in-flight record during window-close shutdown.
    if (persistedQuestionId && inFlight) {
      this.activeQuestionTrace?.mark("answerEnded", now);
      this.emitQuestionTrace(this.activeQuestionTrace);
          this.history.addAnswer({ questionId: this.historyQuestionIds.get(persistedQuestionId) ?? persistedQuestionId, text: this.accumulatedAnswerText, model: this.answerModel ?? "unknown", mode: this.answerMode, startedAt: this.answerStartedAt ?? now, firstTokenAt: this.answerFirstTokenAt, finishedAt: now, latencyFirstToken: this.answerFirstTokenAt === undefined ? undefined : this.answerFirstTokenAt - (this.questionConfirmedAt.get(persistedQuestionId) ?? now), latencyTotal: now - (this.questionConfirmedAt.get(persistedQuestionId) ?? now), cancelReason: reason, telemetry: this.buildAnswerTelemetry(this.currentQuestion?.id === persistedQuestionId ? this.currentQuestion : { id: persistedQuestionId, text: "" } as QuestionCandidate), ...(persistedQuestion?.groupId ? { groupId: persistedQuestion.groupId } : {}), ...(persistedQuestion ? { relation: answerRelationForQuestion(persistedQuestion) } : {}), answerRunId: activeOperation?.operationId, createdAt: now });
    }
    this.answerQuestionId = undefined;
    this.answerMode = undefined;
    this.answerModel = undefined;
    this.answerStartedAt = undefined;
    this.answerFirstTokenAt = undefined;
    this.accumulatedAnswerText = "";
  }

  private emitAnswerCancelled(answerId: string, reason: "user" | "superseded" | "timeout"): void {
    this.emitRealtimeMessage({ type: "answer_cancelled", answerId, reason });
  }

  private emitQuestionTrace(selectedTrace?: QuestionTrace): void {
    const trace = selectedTrace ?? this.currentQuestionTrace;
    if (!trace) return;
    this.emitTelemetry("QUESTION_TRACE", { ...trace.snapshot() });
    if (this.currentQuestionTrace === trace) this.currentQuestionTrace = undefined;
    if (this.activeQuestionTrace === trace) this.activeQuestionTrace = undefined;
  }

  private failInterview(message: string): void {
    this.emitDiagnostic(message);
    if (this.activeInterviewId) this.history.endInterview(this.activeInterviewId, "error", this.now());
    if (this.options.session.canTransition("ERROR")) this.transition("ERROR");
    this.activeInterviewId = undefined;
    this.setRuntimeState("failed");
    this.clearRuntimeTimers();
    this.runtimeAbortControllers.abortAll();
    this.clearRuntimeRegistries();
    this.answerTasks.clear();
    this.questionTasks.clear();
    this.anchorStore.reset();
    this.memory.reset();
    this.recordRuntimeTrace("RUNTIME_CLEANUP_COMPLETED", {}, { reasonCode: "start-failed" });
    if (this.isRuntimeIdle()) this.recordRuntimeTrace("RUNTIME_IDLE", {}, { reasonCode: "start-failed" });
  }

  private transition(state: SessionState): void {
    this.options.session.transition(state);
    this.emitEvent({ type: "session_state", state });
  }

  private emitEvent(event: InterviewCoordinatorEvent): void {
    this.emit("event", event);
  }

  private emitQuestionGroupUpdate(group: QuestionGroup): void {
    if (!group.displayable || !group.primaryQuestion) return;
    this.emitRealtimeMessage({
      type: "question_group_updated",
      groupId: group.id,
      title: group.title,
      primaryQuestion: group.primaryQuestion,
      displayable: true,
      hasAnswerableQuestion: group.items.some((item) => item.answerable),
      status: group.status,
      items: group.items.map((item) => ({ id: item.question.id, questionId: item.question.id, text: item.question.text, type: item.itemType, answerable: item.answerable, state: item.state })),
      slots: group.slots.map((slot) => ({ id: slot.id, text: slot.text, status: slot.status })),
      updatedAt: group.updatedAt
    });
  }

  private emitQuestionGroupResult(result: ReturnType<QuestionGroupManager["add"]>): void {
    if (result.closedGroup) this.emitQuestionGroupUpdate(result.closedGroup);
    this.emitQuestionGroupUpdate(result.group);
  }

  private activeQuestionAnchor(): QuestionCandidate | undefined {
    if (this.currentQuestion?.groupId) return this.currentQuestion;
    const group = this.questionGroups.list().reverse().find((item) => item.displayable && item.primaryQuestion);
    if (!group) return undefined;
    return group.items.find((item) => item.question.id === group.primaryQuestionId)?.question
      ?? group.items.find((item) => item.answerable)?.question;
  }

  private stageQuestionContext(utterance: TranscriptUtterance, turn: InterviewTurn, text: string, speechAct?: QuestionCandidate["speechAct"]): void {
    const id = `question-context-${utterance.id}`;
    const fragment: QuestionCandidate = {
      id,
      text: text.trim(),
      confidence: "medium",
      score: 0,
      source: "extractor",
      detectedAt: this.now(),
      status: "confirmed",
      utteranceId: utterance.id,
      segmentIds: [...utterance.segmentIds],
      turnId: turn.id,
      ...(speechAct ? { speechAct } : {})
    };
    const result = this.questionGroups.add({ turn, question: fragment, now: this.now() });
    // A context fragment may decorate an already visible group (for example
    // an example after the primary question), but a pending fragment never
    // emits a visible group on its own.
    if (result.displayable) this.emitQuestionGroupResult(result);
    if (result.displayable && speechAct === "INSTRUCTION_MODIFIER" && this.activeOptions?.automationMode === "AUTO") {
      const active = this.answerScheduler.active;
      if (active && active.groupId === result.item.question.groupId && active.canMergeBeforeRequest) {
        void this.trackAnswerTask(this.answer(result.item.question));
      } else {
        this.recordRuntimeTrace("QUESTION_MERGED", { schedulerAction: "record-only", groupId: result.item.question.groupId }, { questionId: result.item.question.id, reasonCode: "modifier-after-provider-request" });
      }
    }
  }

  private markQuestionGroup(questionId: string, state: Parameters<QuestionGroupManager["mark"]>[1]): void {
    this.questionGroups.mark(questionId, state);
    const group = this.questionGroups.getGroupForQuestion(questionId);
    if (group) this.emitQuestionGroupUpdate(group);
  }

  private emitRealtimeMessage(message: RealtimeServerMessage): void {
    const messageWithIds = message as RealtimeServerMessage & { questionId?: string; answerId?: string };
    const screenshotAnswer = typeof messageWithIds.answerId === "string"
      ? [...this.runtimeAnswers.values()].find((answer) => answer.answerId === messageWithIds.answerId && answer.screenshotRequestId)
      : undefined;
    const screenshotRequestId = screenshotAnswer?.screenshotRequestId;
    const ids = {
      ...(typeof messageWithIds.questionId === "string" ? { questionId: messageWithIds.questionId } : {}),
      ...(typeof messageWithIds.answerId === "string" ? { answerId: messageWithIds.answerId } : {})
    };
    const latencyQuestionId = ids.questionId
      ?? (typeof messageWithIds.answerId === "string" ? [...this.runtimeAnswers.values()].find((answer) => answer.answerId === messageWithIds.answerId)?.questionId : undefined)
      ?? this.activeAnswerQuestion?.id;
    if (message.type === "answer_delta" && latencyQuestionId) this.runtimeLatency.markOnce(latencyQuestionId, "answerDeltaAt", this.now());
    if (screenshotRequestId && message.type === "answer_end") {
      this.recordScreenshotTrace("VISION_OVERLAY_UPDATE_REQUESTED", screenshotRequestId, { providerRequestId: screenshotAnswer.providerRequestId, answerId: messageWithIds.answerId, status: "completed" });
    }
    this.recordRuntimeTrace("OVERLAY_UPDATE_REQUESTED", { messageType: message.type }, ids);
    this.emitEvent({ type: "realtime_message", message });
    // Renderer delivery is best effort. There is deliberately no renderer
    // acknowledgement in the answer/session completion barrier.
    this.recordRuntimeTrace("OVERLAY_UPDATED", { messageType: message.type }, ids);
    if (message.type === "answer_delta" && latencyQuestionId) this.runtimeLatency.markOnce(latencyQuestionId, "overlayVisibleAt", this.now());
    if (screenshotRequestId && message.type === "answer_end") {
      this.recordScreenshotTrace("VISION_OVERLAY_UPDATED", screenshotRequestId, { providerRequestId: screenshotAnswer.providerRequestId, answerId: messageWithIds.answerId, status: "completed" });
    }
  }

  private emitDiagnostic(message: string): void {
    this.emitEvent({ type: "diagnostic", message });
  }

  private buildAnswerTelemetry(question: QuestionCandidate, extra: Partial<AnswerTelemetry> = {}): AnswerTelemetry {
    const projectQuestionRequested = /项目|简历|经历|负责|做过|成果|业绩|个人|你的实现|你的方案/.test(question.text)
      && !/^(?:那)?(?:volatile|c\+\+|c语言|c\/c\+\+|rtos|freertos|can|adc|dma|pwm|tcp|udp|mqtt|虚函数|优先级反转|三次握手|系统设计|数据结构|操作系统|网络协议)/i.test(question.text.trim());
    const trace = this.activeQuestionTrace?.snapshot();
    const latency = this.runtimeLatency.snapshot().find((sample) => sample.id === question.id);
    const activeProject = this.activeProject;
    const runtimeTelemetry = this.interviewTelemetry.snapshot();
    const elapsed = (end?: number, start?: number): number | undefined => end === undefined || start === undefined ? undefined : Math.max(0, end - start);
    const nucleus = analyzeQuestionNucleus(question.canonicalText ?? question.text);
    return {
      rawText: question.rawText,
      normalizedText: question.normalizedText ?? question.text,
      canonicalText: question.canonicalText ?? question.text,
      terminologyCorrectionCount: question.terminologyCorrections?.length ?? 0,
      terminologyPossibleTerms: trace?.terminologyPossibleTerms,
      terminologyConfidence: question.terminologyCorrections?.length ? Math.min(...question.terminologyCorrections.map((item) => item.confidence ?? 0.9)) : 1,
      unresolvedAsr: trace?.unresolvedAsr ?? false,
      asrUnderstandingQuality: trace?.asrUnderstandingQuality ?? "resolved",
      speechAct: question.speechAct,
      speechActReason: trace?.speechActReason,
      turnCompletionState: trace?.turnCompletionState,
      turnCompletionConfidence: trace?.turnCompletionConfidence,
      turnCompletionReason: trace?.turnCompletionReason,
      questionNucleus: nucleus.nucleus,
      semanticFrame: question.semanticFrame,
      contextRelation: question.contextRelation,
      topicRelation: question.relationType,
      parentQuestionId: question.parentQuestionId,
      rootQuestionId: question.rootQuestionId,
      projectAnchorAvailable: Boolean(this.activeProjectId),
      projectQuestionRequested,
      utteranceCompleteness: runtimeTelemetry.utteranceCompleteness,
      activeProjectId: activeProject?.projectId,
      activeProjectConfidence: activeProject?.confidence,
      topic: question.topic ?? runtimeTelemetry.topic,
      questionRelation: question.relationType ?? question.contextRelation,
      projectQaMatch: extra.projectQaMatch ?? runtimeTelemetry.projectQaMatch,
      projectFactCount: extra.projectFactCount ?? runtimeTelemetry.projectFactCount,
      sessionEvidenceCount: extra.sessionEvidenceCount ?? this.sessionEvidence.snapshot().length,
      firstTokenMs: extra.firstTokenMs ?? elapsed(latency?.providerFirstTokenAt, latency?.questionConfirmedAt),
      answerTotalMs: extra.answerTotalMs ?? elapsed(this.now(), latency?.questionConfirmedAt),
      questionDebounceMs: extra.questionDebounceMs ?? runtimeTelemetry.questionDebounceMs,
      historyRevision: this.activeInterviewId ? this.history.getRevision?.(this.activeInterviewId) : undefined,
      asrFinalToQuestionConfirmedMs: elapsed(latency?.questionConfirmedAt, latency?.asrFinalReceivedAt),
      questionConfirmedToProviderRequestMs: elapsed(latency?.providerRequestStartedAt, latency?.questionConfirmedAt),
      providerRequestToFirstTokenMs: elapsed(latency?.providerFirstTokenAt, latency?.providerRequestStartedAt),
      providerFirstTokenMs: elapsed(latency?.providerFirstTokenAt, latency?.providerRequestStartedAt),
      asrFinalToFirstTokenMs: elapsed(latency?.providerFirstTokenAt, latency?.asrFinalReceivedAt),
      asrFinalToFirstVisibleTokenMs: elapsed(latency?.firstVisibleTokenAt, latency?.asrFinalReceivedAt),
      fastContextMs: elapsed(latency?.fastContextCompletedAt, latency?.fastContextStartedAt),
      claimGateMs: latency?.claimGateMs,
      timings: {
        aggregationWaitMs: trace?.metrics.asrFinalToUtteranceMs,
        terminologyMs: undefined,
        questionDetectionMs: trace?.metrics.utteranceToDetectionMs,
        topicBoundaryMs: undefined,
        semanticFrameMs: undefined,
        coreQaRouteMs: undefined,
        projectQaRouteMs: undefined,
        retrievalMs: this.activeQuestionTrace?.snapshot().metrics.retrievalMs,
        firstTokenMs: this.activeQuestionTrace?.snapshot().metrics.llmFirstTokenMs,
        answerTotalMs: this.activeQuestionTrace?.snapshot().metrics.answerTotalMs,
        totalAnswerMs: this.activeQuestionTrace?.snapshot().metrics.answerTotalMs
      },
      ...extra
    };
  }

  private recordInterviewTelemetry(question: QuestionCandidate, telemetry: AnswerTelemetry, now: number): void {
    this.interviewTelemetry.record({
      speechAct: telemetry.speechAct,
      utteranceCompleteness: telemetry.utteranceCompleteness,
      activeProjectId: telemetry.activeProjectId,
      activeProjectConfidence: telemetry.activeProjectConfidence,
      topic: telemetry.topic,
      questionRelation: telemetry.questionRelation,
      answerSourceMode: telemetry.answerSourceMode,
      projectQaMatch: telemetry.projectQaMatch,
      projectFactCount: telemetry.projectFactCount,
      sessionEvidenceCount: telemetry.sessionEvidenceCount,
      claimGateDecision: telemetry.claimGateDecision,
      blockedClaimCount: telemetry.blockedClaimCount ?? telemetry.blockedPersonalClaimCount,
      firstTokenMs: telemetry.firstTokenMs,
      answerTotalMs: telemetry.answerTotalMs,
      questionDebounceMs: telemetry.questionDebounceMs
    }, now);
    this.emitTelemetry("RUNTIME_INTERVIEW_TELEMETRY", { questionId: question.id, ...this.interviewTelemetry.snapshot() });
  }

  private emitTelemetry(name: string, fields: Record<string, unknown>): void {
    this.emitEvent({ type: "telemetry", name, fields });
  }
}
