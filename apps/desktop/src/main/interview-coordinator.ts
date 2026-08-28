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
  resolveContextualTerminology,
  ContextAnchorResolver,
  ContextAnchorStore,
  AnswerScheduler,
  QuestionGroupManager,
  TurnBuilder,
  ContextLock,
  SessionEvidenceStore,
  requiresPersonalClaimEvidence,
  SpeechActClassifier,
  shouldHardRejectSpeechAct,
  QuestionTrace,
  questionTraceTextMetadata,
  QuestionDetector,
  QuestionDetector2,
  SessionStateMachine,
  TranscriptAggregator,
  type AnswerContextInput,
  type AnswerMode,
  type AnswerRecord,
  type AsrLanguage,
  type ModelSnapshot,
  type InterviewRecord,
  type QuestionRecord,
  type QuestionCandidate,
  type QuestionEvent,
  type SessionState,
  type TranscriptRecord,
  type TranscriptUtterance,
  type InterviewTurn,
  type EvidenceSnapshot,
  type CandidateStatementEvidence,
  type VisionInput
} from "@interview-copilot/shared";
import type { AudioStartOptions } from "./audio-manager";
import type { RealtimeConnectOptions, RealtimeConnectionState } from "./realtime-session";
import {
  RuntimeAbortRegistry,
  RuntimeTimerRegistry,
  RuntimeTraceBuffer,
  withRuntimeTimeout,
  type InterviewRuntimeDiagnostics,
  type RuntimeAnswerState,
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
  hasValidProbe?(options: Pick<AudioStartOptions, "inputDeviceId" | "outputDeviceId">): boolean;
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
}

export interface InterviewContextSelection {
  projectId?: string;
  jobTargetId?: string;
}

export interface InterviewHistoryPort {
  createInterview(input: Omit<InterviewRecord, "id" | "createdAt">, now?: number): InterviewRecord;
  endInterview(interviewId: string, status?: "ended" | "error", endedAt?: number): InterviewRecord;
  addTranscript(input: Omit<TranscriptRecord, "id" | "createdAt">, now?: number): TranscriptRecord | undefined;
  addQuestion(input: Omit<QuestionRecord, "id">): QuestionRecord;
  updateQuestionStatus?(questionId: string, status: QuestionRecord["status"]): QuestionRecord | undefined;
  addAnswer(input: Omit<AnswerRecord, "id">): AnswerRecord;
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
  aggregator?: TranscriptAggregator;
  history?: InterviewHistoryPort;
  contextProvider?: (question: QuestionCandidate, profileId: string, recentTranscript: string[], context?: InterviewContextSelection) => AnswerContextInput | Promise<AnswerContextInput>;
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
  private readonly aggregator: TranscriptAggregator;
  private readonly history: InterviewHistoryPort;
  private readonly now: () => number;
  private readonly speechActClassifier = new SpeechActClassifier();
  private readonly anchorResolver = new ContextAnchorResolver();
  private readonly anchorStore: ContextAnchorStore;
  private readonly turnBuilder = new TurnBuilder();
  private readonly questionGroups = new QuestionGroupManager(this.turnBuilder);
  private readonly answerScheduler = new AnswerScheduler();
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
  private questionFlushTimer: NodeJS.Timeout | undefined;
  private remoteAssemblyTimer: NodeJS.Timeout | undefined;
  private remoteAssemblyStartedAt: number | undefined;
  private finalQuestionQueue: Promise<void> | undefined;
  private readonly questionSilenceMs: number;
  private answerGeneration = 0;
  private answerTriggerTimer: NodeJS.Timeout | undefined;
  private pendingAnswerQuestion: QuestionCandidate | undefined;
  private readonly answerQueue: QuestionCandidate[] = [];
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
  private runtimeSessionState: RuntimeSessionState = "idle";
  private readonly runtimeTimers = new RuntimeTimerRegistry();
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
    // A short ASR pause is common inside an embedded question (for example
    // “堆和栈的区别”). Give the final transcript enough time to settle before
    // the detector starts an answer, while keeping the UI partial live.
    this.questionSilenceMs = Math.max(180, options.questionSilenceMs ?? 420);
    this.detector = options.detector ?? new QuestionDetector({ silenceMs: this.questionSilenceMs });
    this.detector2 = options.questionDetector2 ?? new QuestionDetector2();
    this.brain = options.interviewBrain ?? new InterviewBrain();
    this.memory = options.memory ?? new InterviewMemory(10);
    this.aggregator = options.aggregator ?? new TranscriptAggregator();
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
      transcriptQueueDepth: this.aggregator.pendingCount + this.questionTasks.size,
      answerQueueDepth: this.answerQueue.length,
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
      if (this.options.audio.hasValidProbe && !this.options.audio.hasValidProbe({ inputDeviceId: startOptions.inputDeviceId, outputDeviceId: startOptions.outputDeviceId })) throw new Error("AUDIO_PROBE_REQUIRED: a successful mic and system probe is required before formal capture");
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
      this.detector.reset();
      this.questionGroups.reset();
      this.answerScheduler.reset();
      this.contextLock.clear();
      this.sessionEvidence.reset();
      this.turns.clear();
      this.anchorStore.reset();
      this.memory.reset();
      this.clearAnswerTrigger();
      this.answerQueue.length = 0;
      this.answerContextSnapshots.clear();
      this.activeAnswerQuestion = undefined;
      this.activeModelSnapshot = this.options.answerAgent.getModelSnapshot();
      this.pendingQuestionTrace = undefined;
      this.currentQuestionTrace = undefined;
      this.activeQuestionTrace = undefined;
      this.currentQuestion = undefined;
      this.runtimeQuestions.clear();
      this.clearRuntimeTimers();
      this.clearRuntimeRegistries();
      this.answerTasks.clear();
      this.questionTasks.clear();
      this.answerGeneration += 1;
      this.historyQuestionIds.clear();
      this.questionConfirmedAt.clear();
      this.recentTranscript.length = 0;
      this.clearRemoteAssemblyTimer();
      this.aggregator.clear();
      this.recordRuntimeTrace("INTERVIEW_SESSION_STARTED", {}, { reasonCode: "session-created" });
      this.transition("CONNECTING");
      // The real interview path deliberately omits meterOnly so PCM reaches ASR.
      this.asr.connect({ ...startOptions, ...asrSettings, providerType, url: connectUrl, language: asrSettings?.language ?? (startOptions.language as AsrLanguage | undefined), autoReconnect: true });
      await this.options.audio.start({ inputDeviceId: startOptions.inputDeviceId, outputDeviceId: startOptions.outputDeviceId, meterOnly: false, autoRecover: true });
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
    this.clearQuestionFlushTimer();
    this.clearRemoteAssemblyTimer();
    this.clearAnswerTrigger();
    for (const question of this.answerQueue.splice(0)) {
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
    this.questionConfirmedAt.clear();
    this.recentTranscript.length = 0;
    this.aggregator.clear();
    this.clearRuntimeTimers();
    this.finalQuestionQueue = undefined;
    this.detector.reset();
    this.questionGroups.reset();
    this.answerScheduler.reset();
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
      this.emitQuestion({ type: "question_confirmed", question });
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
    const question: QuestionCandidate = {
      id: `manual-question-${this.now()}`,
      text: clean,
      confidence: "high",
      score: 1,
      source: "extractor",
      detectedAt: this.now(),
      status: "confirmed"
    };
    if (this.activeInterviewId) this.emitQuestion({ type: "question_confirmed", question });
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
      const alreadyQueued = this.answerQueue.some((queued) => queued.id === question.id);
      if (!alreadyQueued && schedulerDecision.action !== "ignore" && this.activeAnswerQuestion?.id !== question.id) {
        this.answerQueue.push(question);
        this.markQuestionState(question, "queued");
        this.questionGroups.mark(question.id, "queued");
        this.recordRuntimeTrace("QUESTION_QUEUED", { schedulerAction: schedulerDecision.action }, { questionId: question.id, reasonCode: schedulerDecision.reason });
        this.emitDiagnostic(`ANSWER_QUEUED: ${question.id} (${this.answerQueue.length})`);
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
    this.questionGroups.mark(question.id, "answering");
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
      this.recordRuntimeTrace("PROJECT_CONTEXT_STARTED", {}, { questionId: question.id, providerRequestId });
      const providerContextResult = this.contextProvider(question, this.activeProfileId ?? "", [...frozenContext.recentTranscript], { projectId: this.activeOptions?.projectId, jobTargetId: this.activeOptions?.jobTargetId });
      // Keep the default synchronous context path truly synchronous. This
      // removes an avoidable microtask from consecutive-question handling;
      // async profile/knowledge retrieval still remains cancellable below.
      const isPromiseLike = (value: AnswerContextInput | Promise<AnswerContextInput>): value is Promise<AnswerContextInput> => Boolean(value && typeof (value as PromiseLike<AnswerContextInput>).then === "function");
      const contextTimeoutMs = Math.max(50, this.options.contextTimeoutMs ?? this.options.answerTimeoutMs ?? 20_000);
      const providerContext: AnswerContextInput | undefined = isPromiseLike(providerContextResult)
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
      const memorySnapshot = frozenContext.memory;
      const evidenceSnapshot: EvidenceSnapshot = this.contextLock.lock({
        questionId: question.id,
        profileId: this.activeProfileId,
        projectId: this.activeOptions?.projectId,
        jobTargetId: this.activeOptions?.jobTargetId,
        profileSummary: providerContext.profileSummary,
        jobDescriptionSummary: providerContext.jobDescriptionSummary,
        profileInstructions: providerContext.profileInstructions,
        currentProject: providerContext.currentProject,
        currentModule: providerContext.currentModule,
        currentTopic: providerContext.currentTopic ?? frozenContext.memory.currentTopic,
        personalMemoryEvidence: providerContext.personalMemoryEvidence,
        experienceContext: providerContext.experienceContext,
        projectEvidence: providerContext.projectEvidence,
        verifiedResumeEvidence: providerContext.verifiedResumeEvidence,
        verifiedPersonalProjectFacts: providerContext.verifiedPersonalProjectFacts,
        retrievedKnowledge: providerContext.retrievedKnowledge,
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
        evidenceSnapshot
      };
      if (answerOperation) answerOperation.state = "provider_pending";
      this.recordRuntimeTrace("PROJECT_CONTEXT_READY", {}, { questionId: question.id, providerRequestId });
      const isFollowUp = question.speechAct === "FOLLOW_UP" || question.detectionType === "follow_up" || question.category === "followup";
      // A queued question must retain the topic and transcript that existed
      // when it was confirmed. Looking at global "latest" memory here caused
      // an older memory-leak question to inherit a later RS-485/RS-232 topic.
      const followUpContext = isFollowUp
        ? this.followUpContextResolver.resolve(
          { id: question.id, parentQuestionId: question.parentQuestionId, rootQuestionId: question.rootQuestionId, text: question.text },
          memorySnapshot,
          {
            relatedProject: /项目|简历|经历|负责|做过|成果|业绩/.test(question.text) ? this.activeOptions?.projectId : undefined,
            relatedTechnicalTopic: memorySnapshot.currentTopic
          }
        )
        : undefined;
      const preparedAnswer = lockedProviderContext.preparedAnswer;
      const answerKind = classifyAnswerQuestion(question.text, question.detectionType);
      const answerIntent = analyzeAnswerIntent({ question: question.text, kind: answerKind });
      const personalThreadText = `${followUpContext?.rootQuestion ?? ""}\n${followUpContext?.parentQuestion ?? ""}`;
      const isProjectQuestion = ["project", "behavioral"].includes(answerKind) || /项目|简历|经历|负责|做过|成果|业绩|你做的|你的实现|你的方案|在这个结构下/.test(question.text);
      const requiresPersonalGrounding = requiresPersonalClaimEvidence(answerIntent)
        || answerIntent.asksBehavioralEpisode
        || (isFollowUp && (/项目|简历|经历|负责|做过|成果|业绩/.test(personalThreadText) || (lockedProviderContext.sessionEvidence?.length ?? 0) > 0));
      if (preparedAnswer && preparedAnswer.verified && preparedAnswer.score >= 0.88 && !streamOptions.hasScreenshot && !isProjectQuestion && !answerIntent.requiresPersonalIdentity && !requiresPersonalGrounding) {
        this.emitDiagnostic("QUESTION_BANK_DIRECT_HIT");
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
        this.answerModel = "question-bank";
        this.answerStartedAt = startedAt;
        this.answerFirstTokenAt = finishedAt;
        this.emitRealtimeMessage({ type: "answer_start", answerId, questionId: question.id, mode, model: "question-bank" });
        const preparedText = normalizeTechnicalTerms(preparedAnswer.content);
        this.answerScheduler.markVisibleOutput(preparedText);
        const confirmedAt = this.questionConfirmedAt.get(question.id) ?? startedAt;
        this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: preparedText, model: "question-bank", mode, startedAt, firstTokenAt: finishedAt, finishedAt, latencyFirstToken: finishedAt - confirmedAt, latencyTotal: finishedAt - confirmedAt, createdAt: finishedAt });
        if (answerOperation) answerOperation.state = "committed";
        this.recordRuntimeTrace("ANSWER_COMMITTED", {}, { questionId: question.id, answerId, providerRequestId, reasonCode: "question-bank" });
        this.emitRealtimeMessage({ type: "answer_end", answerId, text: preparedText });
        answerTrace?.update({ answerSource: "question-bank" }).mark("answerLookupStarted", startedAt).mark("answerVisible", finishedAt).mark("answerEnded", finishedAt);
        this.emitQuestionTrace(answerTrace);
        this.memory.recordAnswer(preparedText, { question: question.text, questionId: question.id, groupId: question.groupId, createdAt: finishedAt });
        this.detector.markAnswered(question.id);
        this.questionGroups.mark(question.id, "answered");
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
      const context = { ...lockedProviderContext, recentTranscript: lockedProviderContext.recentTranscript ?? [...frozenContext.recentTranscript], interviewMemory: lockedProviderContext.interviewMemory ?? memorySnapshot, ...(followUpContext ? { followUpContext } : {}) };
      answerTrace?.update({ answerSource: "llm" }).mark("llmRequestStarted", this.now());
      this.recordRuntimeTrace("PROVIDER_STREAM_REQUESTED", {}, { questionId: question.id, providerRequestId });
      if (streamOptions.screenshotRequestId) {
        this.recordScreenshotTrace("VISION_PROVIDER_REQUEST_STARTED", streamOptions.screenshotRequestId, { providerRequestId, status: "provider_pending", messageShape: "multimodal" });
      }
      this.runtimeTimers.set(`answer-first-token:${operationId}`, () => {
        const answer = this.runtimeAnswers.get(operationId);
        if (!answer || answer.firstTokenAt !== undefined || controller.signal.aborted) return;
        this.emitDiagnostic(`PROVIDER_FIRST_TOKEN_TIMEOUT: ${question.id}`);
        this.cancelAnswer("timeout", "first-token-timeout");
      }, Math.max(50, this.options.providerFirstTokenTimeoutMs ?? 10_000));
      for await (const event of this.options.answerAgent.stream({ id: question.id, text: question.text, ...(isFollowUp ? { kind: "follow-up" as const } : {}) }, mode, context, controller.signal, {
        ...streamOptions,
        // Project answers are buffered until claim/evidence validation has
        // passed. Generic technical answers can still stream immediately.
        directDisplay: requiresPersonalGrounding,
        emitDeltas: !requiresPersonalGrounding,
        allowQualityRepair: requiresPersonalGrounding,
        strictPersonalGrounding: requiresPersonalGrounding,
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
          this.emitRealtimeMessage({ type: "answer_start", answerId: event.answerId, questionId: event.questionId, mode: event.mode, model: event.model });
        } else if (event.type === "answer_delta") {
          this.accumulatedAnswerText += event.delta;
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
            this.recordRuntimeTrace("PROVIDER_FIRST_TOKEN", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
            if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_FIRST_TOKEN", streamOptions.screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "streaming" });
          }
          answerTrace?.mark("firstToken", this.answerFirstTokenAt);
          this.emitRealtimeMessage({ type: "answer_delta", answerId: event.answerId, delta: event.delta });
        } else {
          const finishedAt = this.now();
          const answerText = event.text || this.accumulatedAnswerText;
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
            if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_FIRST_TOKEN", streamOptions.screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
          }
          this.recordRuntimeTrace("PROVIDER_STREAM_COMPLETED", {}, { questionId: question.id, answerId: event.answerId, providerRequestId });
          if (streamOptions.screenshotRequestId) this.recordScreenshotTrace("VISION_RESPONSE_COMPLETED", streamOptions.screenshotRequestId, { providerRequestId, answerId: event.answerId, status: "completed" });
          answerTrace?.mark("answerEnded", finishedAt);
          if (event.quality?.issues.includes("QUALITY_UNGROUNDED_CLAIM")) this.emitDiagnostic("QUALITY_UNGROUNDED_CLAIM");
          if (event.quality?.issues.includes("strict-grounding-fallback")) this.emitDiagnostic("STRICT_GROUNDING_FALLBACK");
          const confirmedAt = this.questionConfirmedAt.get(question.id) ?? startedAt;
          this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: answerText, model: this.answerModel ?? "configured", mode: this.answerMode ?? mode, startedAt: this.answerStartedAt ?? startedAt, firstTokenAt: this.answerFirstTokenAt, finishedAt, latencyFirstToken: this.answerFirstTokenAt === undefined ? undefined : this.answerFirstTokenAt - confirmedAt, latencyTotal: finishedAt - confirmedAt, createdAt: finishedAt });
          if (answerOperation) answerOperation.state = "committed";
          this.recordRuntimeTrace("ANSWER_COMMITTED", {}, { questionId: question.id, answerId: event.answerId, providerRequestId, reasonCode: "provider-completed" });
          this.emitRealtimeMessage({ type: "answer_end", answerId: event.answerId, text: answerText, quality: event.quality });
          this.emitQuestionTrace(answerTrace);
          this.memory.recordAnswer(answerText, { question: question.text, questionId: question.id, groupId: question.groupId, createdAt: finishedAt });
          this.detector.markAnswered(question.id);
          this.questionGroups.mark(question.id, "answered");
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
        this.answerScheduler.complete(question.id, { activateNext: false });
        const next = this.answerQueue.shift();
        if (next && this.running) this.launchAnswer(next);
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
      const segment: TranscriptSegment = { ...rawSegment, text: normalizeTechnicalTerms(rawSegment.text) };
      if (!this.activeInterviewId || this.runtimeSessionState !== "running") {
        this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "transcript", source: segment.source, final: segment.final, textLength: segment.text.length }, { reasonCode: "inactive-session" });
        return;
      }
      this.recordRuntimeTrace("TRANSCRIPT_RECEIVED", { source: segment.source, final: segment.final, textLength: segment.text.length });
      this.emit("event", { type: "transcript", snapshot, segment });
      if (segment.final) {
        this.history.addTranscript({ interviewId: this.activeInterviewId, source: segment.source, text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true, confidence: segment.confidence });
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
      // A candidate answer marks a hard turn boundary for the remote
      // aggregator. Flush and analyze the remote turn before starting the
      // candidate answer; previously this flush discarded the last question.
      if (segment.final && segment.source === "mic") {
        this.clearRemoteAssemblyTimer();
        this.flushRemoteUtterances();
      }
      if (segment.source !== "remote") return;
      // Partials are used for early classification only. They never confirm
      // or answer by themselves; the final segment still owns confirmation.
      if (!segment.final) {
        this.detector.observe(segment, this.now()).forEach((event) => this.handleQuestionEvent(event));
        this.scheduleQuestionFlush();
        return;
      }
      // A provider final marks a stable ASR segment, not necessarily the end
      // of the interviewer's sentence. Keep assembling until a short adaptive
      // silence expires, then analyze the complete utterance exactly once.
      const utterance = this.aggregator.push(segment, receivedAt);
      if (!utterance) return;
      this.clearQuestionFlushTimer();
      this.drainCompletedRemoteUtterances();
      this.scheduleRemoteAssembly(utterance, segment);
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
        ...(event.type === "question_superseded" ? { relationType: "ASR_REVISION" as const } : {})
      });
      event = { ...event, question: groupResult.item.question };
      this.markQuestionState(event.question, "confirmed");
      this.recordRuntimeTrace("QUESTION_CONFIRMED", { textLength: event.question.text.length }, { questionId: event.question.id, reasonCode: event.type });
      this.currentQuestion = event.question;
      const trace = this.pendingQuestionTrace ?? new QuestionTrace({ questionTraceId: `question-trace-${event.question.id}`, questionScore: event.question.score, questionType: event.question.detectionType, followUp: event.question.speechAct === "FOLLOW_UP", projectId: this.activeOptions?.projectId, jobTargetId: this.activeOptions?.jobTargetId });
      if (trace.snapshot().questionDetectedAt === undefined) trace.mark("questionDetected", this.now());
      trace.mark("questionConfirmed", this.now());
      this.currentQuestionTrace = trace;
      this.pendingQuestionTrace = undefined;
      this.memory.recordQuestion(event.question.text, { questionId: event.question.id, parentQuestionId: event.question.parentQuestionId, rootQuestionId: event.question.rootQuestionId, groupId: event.question.groupId, relationType: event.question.relationType, createdAt: event.question.detectedAt });
      this.anchorStore.recordConfirmedQuestion({ id: event.question.id, text: event.question.text, confidence: event.question.score, topic: this.memory.snapshot().currentTopic, createdAt: event.question.detectedAt });
      if (this.activeInterviewId) {
        const stored = this.history.addQuestion({
          interviewId: this.activeInterviewId,
          text: event.question.text,
          confidence: event.question.confidence,
          source: event.question.source,
          detectedAt: event.question.detectedAt,
          status: event.question.status,
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
          this.questionGroups.mark(event.previousQuestionId, "cancelled");
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
    const isFollowUp = event.question.speechAct === "FOLLOW_UP"
      || event.question.detectionType === "follow_up"
      || event.question.category === "followup";
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

  private drainCompletedRemoteUtterances(): number {
    const completed = this.aggregator.drainCompleted("remote");
    if (!completed.length) return 0;
    // The previous turn has now been closed by a semantic boundary. Do not
    // let its assembly timer fire against the new turn.
    this.clearRemoteAssemblyTimer();
    completed.forEach((utterance) => this.enqueueFinalUtterance(utterance));
    return completed.length;
  }

  private flushRemoteUtterances(): void {
    this.aggregator.flush("remote", this.now()).forEach((utterance) => this.enqueueFinalUtterance(utterance));
  }

  private scheduleRemoteAssembly(utterance: TranscriptUtterance, latest: TranscriptSegment): void {
    this.runtimeTimers.clear("remote-assembly");
    this.remoteAssemblyStartedAt ??= this.now();
    const elapsed = Math.max(0, this.now() - this.remoteAssemblyStartedAt);
    const remaining = Math.max(120, 1_800 - elapsed);
    const text = utterance.text.trim();
    const incomplete = /(?:比如|例如|包括|以及|并且|而且|尤其|关于|针对|问题是|最后|然后|怎么|如何|哪些|什么|是否|能否)[。！？?！；;，,、\s]*$/.test(text);
    const notPunctuated = !/[?？!！。；;]$/.test(text);
    // Completed questions stay fast; unfinished or continuation-shaped text
    // gets a little more time for the next stable ASR segment.
    const normalizedLength = text.replace(/[\s，。！？、,.!?；;:：]/g, "").length;
    const shortContinuation = normalizedLength <= 8 && /(?:为什么|为何|怎么|如何|什么|哪个|哪里|能否|是否|说说|展开|继续|然后|最后|好|那|行|可以|嗯)[?？。.!！]?$/i.test(text);
    const delay = shortContinuation
      ? 460
      : incomplete
        ? 600
      : /^(?:比如|例如|然后|最后|接着|隔离|以及|包括|在|其中)/.test(latest.text.trim())
        ? 480
        : notPunctuated ? 420 : 360;
    this.runtimeTimers.set("remote-assembly", () => {
      this.remoteAssemblyTimer = undefined;
      this.remoteAssemblyStartedAt = undefined;
      this.flushRemoteUtterances();
    }, Math.min(delay, remaining));
  }

  private clearRemoteAssemblyTimer(): void {
    this.runtimeTimers.clear("remote-assembly");
    this.remoteAssemblyTimer = undefined;
    this.remoteAssemblyStartedAt = undefined;
  }

  private clearQuestionFlushTimer(): void {
    this.runtimeTimers.clear("question-flush");
    this.questionFlushTimer = undefined;
  }

  private handleQuestionEvent(event: QuestionEvent): void {
    const effectiveEvent = this.emitQuestion(event);
    if ((effectiveEvent.type === "question_confirmed" || effectiveEvent.type === "question_superseded") && this.activeOptions?.automationMode === "AUTO") this.scheduleAnswer(effectiveEvent.question);
  }

  private async observeFinalQuestion(utterance: TranscriptUtterance, sessionGeneration = this.sessionGeneration): Promise<void> {
    if (sessionGeneration !== this.sessionGeneration || !this.activeInterviewId) return;
    const turn = this.turnBuilder.build(utterance);
    this.turns.set(turn.id, turn);
    const detectionStartedAt = this.now();
    const trace = new QuestionTrace({
      questionTraceId: `question-trace-${utterance.id}`,
      asrFinalReceivedAt: utterance.lastFinalReceivedAt ?? detectionStartedAt,
      utteranceFinalizedAt: utterance.finalizedAt ?? detectionStartedAt,
      projectId: this.activeOptions?.projectId,
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
    const terminology = resolveContextualTerminology(utterance.text, {
      contextText,
      entities: this.memory.snapshot().entities,
      topics: [anchorSnapshot.currentTopic].filter((topic): topic is string => Boolean(topic))
    });
    const correctedText = terminology.text;
    const speech = this.speechActClassifier.classify(correctedText, {
      memory: this.memory.snapshot(),
      recentTranscript: previousTranscript,
      currentTopic: anchorSnapshot.currentTopic,
      latestAnchor: anchorSnapshot.latestAnchor,
      pendingCodeContext: Boolean(anchorSnapshot.pendingCodeContext),
      now: detectionStartedAt
    });
    trace.update({
      source: utterance.source,
      ...questionTraceTextMetadata(utterance.text),
      speechAct: speech.speechAct,
      contextTopic: anchorSnapshot.currentTopic,
      isFollowUp: speech.speechAct === "FOLLOW_UP"
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
      this.memory.recordQuestion(anchor.text, { questionId: anchor.id, topic: anchor.topic, createdAt: anchor.createdAt });
    }
    if (shouldHardRejectSpeechAct(speech)) {
      trace.update({ finalScore: 0, decision: "reject", decisionReason: speech.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      this.emitQuestionTrace();
      return;
    }
    const resolved = this.anchorResolver.resolve({ text: correctedText, speechAct: speech.speechAct, anchors: anchorSnapshot });
    const canonicalQuestion = resolved.canonicalQuestion;
    const detectionContext = {
      memory: this.memory.snapshot(),
      recentTranscript: previousTranscript,
      latestAnchor: anchorSnapshot.latestAnchor,
      pendingCodeContext: Boolean(anchorSnapshot.pendingCodeContext)
    };
    let analysis = this.detector2.analyzeSync(canonicalQuestion, contextText, true, detectionContext);
    analysis = {
      ...analysis,
      text: canonicalQuestion,
      type: analysis.isQuestion
        ? speech.speechAct === "FOLLOW_UP" ? "follow_up" : analysis.type
        : "not_question",
      speechAct: analysis.isQuestion ? speech.speechAct : analysis.speechAct,
      normalizedQuestion: canonicalQuestion,
      anchorUsedId: resolved.anchorUsed?.id,
      shouldAnswer: analysis.shouldAnswer,
      reason: `${speech.reason}+${resolved.reason}`,
      ...(speech.codeContext ? { codeContext: true } : {})
    };
    let decision = this.brain.analyze({ text: canonicalQuestion, analysis, memory: detectionContext.memory, recentTranscript: previousTranscript });
    if (this.detector2.hasLocalClassifier || (!decision.isQuestion && analysis.score.finalScore >= 0.5)) {
      analysis = await this.detector2.analyze(canonicalQuestion, contextText, true, detectionContext);
      analysis = {
        ...analysis,
        text: canonicalQuestion,
        type: analysis.isQuestion
          ? speech.speechAct === "FOLLOW_UP" ? "follow_up" : analysis.type
          : "not_question",
        speechAct: analysis.isQuestion ? speech.speechAct : analysis.speechAct,
        normalizedQuestion: canonicalQuestion,
        anchorUsedId: resolved.anchorUsed?.id,
        shouldAnswer: analysis.shouldAnswer,
        reason: `${speech.reason}+${resolved.reason}`,
        ...(speech.codeContext ? { codeContext: true } : {})
      };
      decision = this.brain.analyze({ text: canonicalQuestion, analysis, memory: detectionContext.memory, recentTranscript: previousTranscript });
    }
    trace.update({
      speechAct: analysis.speechAct,
      ruleScore: analysis.score.ruleScore,
      semanticScore: analysis.score.semanticScore,
      ...(analysis.score.localClassifierScore !== undefined ? { localClassifierScore: analysis.score.localClassifierScore } : {}),
      llmScore: analysis.score.llmScore,
      finalScore: analysis.score.finalScore,
      contextTopic: anchorSnapshot.currentTopic,
      ...(resolved.parentQuestionId ? { parentQuestionId: resolved.parentQuestionId } : {}),
      isFollowUp: analysis.speechAct === "FOLLOW_UP"
    });
    // Elliptical follow-ups such as “好，说说” are promoted by
    // InterviewBrain immediately when a topic exists in memory.
    if (!decision.isQuestion || !this.activeInterviewId || sessionGeneration !== this.sessionGeneration) {
      trace.update({ decision: "reject", decisionReason: decision.reason }).mark("questionDetected", this.now());
      this.currentQuestionTrace = trace;
      this.emitQuestionTrace();
      if (this.pendingQuestionTrace === trace) this.pendingQuestionTrace = undefined;
      return;
    }
    const observed = { ...utterance, text: decision.normalizedQuestion || canonicalQuestion };
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
          utteranceId: utterance.id,
          segmentIds: [...utterance.segmentIds],
          turnId: turn.id,
          ...(resolved.parentQuestionId ? { parentQuestionId: resolved.parentQuestionId } : {}),
          ...(resolved.rootQuestionId ? { rootQuestionId: resolved.rootQuestionId } : {}),
          ...(resolved.anchorUsed ? { anchorId: resolved.anchorUsed.id } : {})
        }
      } as QuestionEvent;
    };
    this.detector.observe({ ...observed, utteranceId: utterance.id, analysis: effectiveAnalysis }, this.now()).map(enrichEvent).forEach((event) => this.handleQuestionEvent(event));
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
    this.detector.flush(flushAt).map(enrichEvent).forEach((event) => this.handleQuestionEvent(event));
  }

  private scheduleQuestionFlush(delay = this.questionSilenceMs, sessionGeneration = this.sessionGeneration): void {
    this.clearQuestionFlushTimer();
    const dueAt = this.now() + delay;
    this.runtimeTimers.set("question-flush", () => {
      this.questionFlushTimer = undefined;
      if (sessionGeneration !== this.sessionGeneration || !this.activeInterviewId || this.runtimeSessionState !== "running") {
        this.recordRuntimeTrace("STALE_RUNTIME_EVENT_DROPPED", { event: "question-flush" }, { reasonCode: "stale-question-timer" });
        return;
      }
      // Use the scheduled due time as a lower bound. The production clock
      // normally advances with the timer, while deterministic integrations
      // may provide a manually controlled `now()` function.
      this.detector.flush(Math.max(this.now(), dueAt)).forEach((event) => this.handleQuestionEvent(event));
    }, delay);
  }

  private scheduleAnswer(question: QuestionCandidate): void {
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
      this.history.addAnswer({ questionId: this.historyQuestionIds.get(persistedQuestionId) ?? persistedQuestionId, text: this.accumulatedAnswerText, model: this.answerModel ?? "unknown", mode: this.answerMode, startedAt: this.answerStartedAt ?? now, firstTokenAt: this.answerFirstTokenAt, finishedAt: now, latencyFirstToken: this.answerFirstTokenAt === undefined ? undefined : this.answerFirstTokenAt - (this.questionConfirmedAt.get(persistedQuestionId) ?? now), latencyTotal: now - (this.questionConfirmedAt.get(persistedQuestionId) ?? now), cancelReason: reason, createdAt: now });
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
    if (screenshotRequestId && message.type === "answer_end") {
      this.recordScreenshotTrace("VISION_OVERLAY_UPDATE_REQUESTED", screenshotRequestId, { providerRequestId: screenshotAnswer.providerRequestId, answerId: messageWithIds.answerId, status: "completed" });
    }
    this.recordRuntimeTrace("OVERLAY_UPDATE_REQUESTED", { messageType: message.type }, ids);
    this.emitEvent({ type: "realtime_message", message });
    // Renderer delivery is best effort. There is deliberately no renderer
    // acknowledgement in the answer/session completion barrier.
    this.recordRuntimeTrace("OVERLAY_UPDATED", { messageType: message.type }, ids);
    if (screenshotRequestId && message.type === "answer_end") {
      this.recordScreenshotTrace("VISION_OVERLAY_UPDATED", screenshotRequestId, { providerRequestId: screenshotAnswer.providerRequestId, answerId: messageWithIds.answerId, status: "completed" });
    }
  }

  private emitDiagnostic(message: string): void {
    this.emitEvent({ type: "diagnostic", message });
  }

  private emitTelemetry(name: string, fields: Record<string, unknown>): void {
    this.emitEvent({ type: "telemetry", name, fields });
  }
}
