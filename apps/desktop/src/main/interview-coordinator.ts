import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ClientControlMessage, RealtimeServerMessage, TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerAgent,
  FollowUpContextResolver,
  InterviewBrain,
  InterviewMemory,
  InterviewHistoryStore,
  normalizeTechnicalTerms,
  resolveContextualTerminology,
  ContextAnchorResolver,
  ContextAnchorStore,
  SpeechActClassifier,
  QuestionTrace,
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
  type TranscriptUtterance
} from "@interview-copilot/shared";
import type { AudioStartOptions } from "./audio-manager";
import type { RealtimeConnectOptions, RealtimeConnectionState } from "./realtime-session";

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
  | { type: "telemetry"; name: string; fields: Record<string, unknown> };

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
  private activeModelSnapshot: ModelSnapshot | undefined;
  private sessionGeneration = 0;
  private pendingQuestionTrace: QuestionTrace | undefined;
  private currentQuestionTrace: QuestionTrace | undefined;

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
  get running(): boolean { return Boolean(this.activeInterviewId); }
  get automationMode(): "MANUAL" | "AUTO" { return this.activeOptions?.automationMode ?? this.defaultAutomationMode; }

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
    if (this.options.audio.configuredPath && !existsSync(this.options.audio.configuredPath)) throw new Error(`SIDECAR_NOT_FOUND: Audio Sidecar not found: ${this.options.audio.configuredPath}`);
    const asrSettings = this.options.asrSettingsProvider?.(startOptions.profileId);
    const providerType = asrSettings?.providerType ?? startOptions.providerType ?? "custom-gateway";
    const connectUrl = startOptions.url ?? asrSettings?.url ?? "";
    if (providerType === "custom-gateway" && !connectUrl.trim()) throw new Error("Custom ASR Gateway URL is required");
    if (this.running) await this.stop("user");
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
    this.activeOptions = { ...startOptions, automationMode };
    this.activeProfileId = startOptions.profileId;
    this.detector.reset();
    this.anchorStore.reset();
    this.memory.reset();
    this.clearAnswerTrigger();
    this.activeModelSnapshot = this.options.answerAgent.getModelSnapshot();
    this.pendingQuestionTrace = undefined;
    this.currentQuestionTrace = undefined;
    this.currentQuestion = undefined;
      this.historyQuestionIds.clear();
      this.pendingQuestionTrace = undefined;
      this.currentQuestionTrace = undefined;
    this.questionConfirmedAt.clear();
    this.recentTranscript.length = 0;
    this.memory.reset();
    this.clearRemoteAssemblyTimer();
    this.aggregator.clear();
    this.transition("CONNECTING");
    try {
      // The real interview path deliberately omits meterOnly so PCM reaches ASR.
      this.asr.connect({ ...startOptions, ...asrSettings, providerType, url: connectUrl, language: asrSettings?.language ?? (startOptions.language as AsrLanguage | undefined), autoReconnect: true });
      await this.options.audio.start({ inputDeviceId: startOptions.inputDeviceId, outputDeviceId: startOptions.outputDeviceId, meterOnly: false, autoRecover: true });
    } catch (error) {
      await Promise.resolve(this.options.audio.stop()).catch(() => undefined);
      this.asr.disconnect();
      this.failInterview(String(error));
      throw error;
    }
    return record.id;
  }

  async stop(reason: "user" | "error" = "user"): Promise<void> {
    const interviewId = this.activeInterviewId;
    if (!interviewId) return;
    this.clearQuestionFlushTimer();
    this.clearRemoteAssemblyTimer();
    this.cancelAnswer(reason === "error" ? "timeout" : "user");
    try { await Promise.resolve(this.options.audio.stop()); } catch (error) { this.emitDiagnostic(`Audio stop failed: ${String(error)}`); }
    try { await this.asr.finalize?.(1_000); } catch (error) { this.emitDiagnostic(`ASR finalize failed: ${String(error)}`); }
    try { this.asr.disconnect(); } catch (error) { this.emitDiagnostic(`ASR disconnect failed: ${String(error)}`); }
    if (!this.options.session.canTransition("ENDING") && this.options.session.canTransition("ERROR")) this.transition("ERROR");
    if (this.options.session.canTransition("ENDING")) this.transition("ENDING");
    this.history.endInterview(interviewId, reason === "error" ? "error" : "ended", this.now());
    if (this.options.session.canTransition("ENDED")) this.transition("ENDED");
    this.activeInterviewId = undefined;
    this.activeOptions = undefined;
    this.activeProfileId = undefined;
    this.currentQuestion = undefined;
    this.questionConfirmedAt.clear();
    this.recentTranscript.length = 0;
    this.aggregator.clear();
    this.sessionGeneration += 1;
    this.clearAnswerTrigger();
    this.finalQuestionQueue = undefined;
    this.detector.reset();
    this.anchorStore.reset();
    this.memory.reset();
    this.historyQuestionIds.clear();
    this.activeModelSnapshot = undefined;
  }

  async answerLatest(): Promise<void> {
    if (this.currentQuestion) {
      await this.answer(this.currentQuestion);
      return;
    }
    const latest = this.detector.lastConfirmed;
    if (latest) await this.answer(latest);
    else this.emitDiagnostic("No confirmed question is available");
  }

  async answerScreenshot(dataUrl: string): Promise<void> {
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
    await this.answer(question, mode, { hasScreenshot: true, attachments: [{ mimeType: "image/png", dataUrl }] });
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
    await this.answer(question);
  }

  async answer(question: QuestionCandidate, mode = this.activeOptions?.answerMode ?? "NORMAL", streamOptions: { hasScreenshot?: boolean; attachments?: Array<{ mimeType: string; dataUrl: string }> } = {}): Promise<void> {
    if (!this.running) {
      this.emitDiagnostic("Interview is not running");
      return;
    }
    this.cancelAnswer("superseded");
    const generation = this.answerGeneration;
    this.currentQuestion = question;
    this.detector.markAnswering(question.id);
    this.options.history?.updateQuestionStatus?.(this.historyQuestionIds.get(question.id) ?? question.id, "answering");
    const controller = new AbortController();
    this.answerController = controller;
    const startedAt = this.now();
    this.currentQuestionTrace?.mark("retrievalStarted", startedAt);
    this.accumulatedAnswerText = "";
    try {
      const providerContextResult = this.contextProvider(question, this.activeProfileId ?? "", [...this.recentTranscript], { projectId: this.activeOptions?.projectId, jobTargetId: this.activeOptions?.jobTargetId });
      // Keep the default synchronous context path truly synchronous. This
      // removes an avoidable microtask from consecutive-question handling;
      // async profile/knowledge retrieval still remains cancellable below.
      const isPromiseLike = (value: AnswerContextInput | Promise<AnswerContextInput>): value is Promise<AnswerContextInput> => Boolean(value && typeof (value as PromiseLike<AnswerContextInput>).then === "function");
      const providerContext: AnswerContextInput = isPromiseLike(providerContextResult)
        ? await providerContextResult
        : providerContextResult;
      this.currentQuestionTrace?.mark("retrievalEnded", this.now());
      if (controller.signal.aborted || generation !== this.answerGeneration) return;
      const isFollowUp = question.speechAct === "FOLLOW_UP" || question.detectionType === "follow_up" || question.category === "followup";
      const memorySnapshot = this.memory.snapshot();
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
      const preparedAnswer = providerContext.preparedAnswer;
      const isProjectQuestion = /项目|简历|经历|负责|做过|成果|业绩/.test(question.text);
      if (preparedAnswer && preparedAnswer.verified && preparedAnswer.score >= 0.88 && !streamOptions.hasScreenshot && !isProjectQuestion) {
        this.emitDiagnostic("QUESTION_BANK_DIRECT_HIT");
        const answerId = `question-bank-answer-${question.id}-${startedAt}`;
        const finishedAt = this.now();
        this.answerId = answerId;
        this.answerQuestionId = question.id;
        this.answerMode = mode;
        this.answerModel = "question-bank";
        this.answerStartedAt = startedAt;
        this.answerFirstTokenAt = finishedAt;
        this.emit("event", { type: "realtime_message", message: { type: "answer_start", answerId, questionId: question.id, mode, model: "question-bank" } });
        const preparedText = normalizeTechnicalTerms(preparedAnswer.content);
        this.emit("event", { type: "realtime_message", message: { type: "answer_end", answerId, text: preparedText } });
        const confirmedAt = this.questionConfirmedAt.get(question.id) ?? startedAt;
        this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: preparedText, model: "question-bank", mode, startedAt, firstTokenAt: finishedAt, finishedAt, latencyFirstToken: finishedAt - confirmedAt, latencyTotal: finishedAt - confirmedAt, createdAt: finishedAt });
        this.currentQuestionTrace?.mark("llmRequestStarted", startedAt).mark("firstToken", finishedAt).mark("answerEnded", finishedAt);
        this.emitQuestionTrace();
        this.memory.recordAnswer(preparedText, { question: question.text, createdAt: finishedAt });
        this.detector.markAnswered(question.id);
        this.options.history?.updateQuestionStatus?.(this.historyQuestionIds.get(question.id) ?? question.id, "answered");
        this.answerId = undefined;
        this.answerQuestionId = undefined;
        this.answerMode = undefined;
        this.answerModel = undefined;
        this.answerStartedAt = undefined;
        this.answerFirstTokenAt = undefined;
        return;
      }
      const context = { ...providerContext, recentTranscript: providerContext.recentTranscript ?? [...this.recentTranscript], interviewMemory: memorySnapshot, ...(followUpContext ? { followUpContext } : {}) };
      this.currentQuestionTrace?.mark("llmRequestStarted", this.now());
      for await (const event of this.options.answerAgent.stream({ id: question.id, text: question.text, ...(isFollowUp ? { kind: "follow-up" as const } : {}) }, mode, context, controller.signal, {
        ...streamOptions,
        // Expose provider deltas so the overlay can show the first useful
        // sentence immediately instead of waiting for the whole answer.
        directDisplay: false,
        emitDeltas: true,
        allowQualityRepair: false,
        formatAnswer: true,
        maxRetries: 1,
        preferFastRoute: this.activeOptions?.automationMode === "AUTO" && !streamOptions.hasScreenshot,
        modelOverride: this.activeModelSnapshot
      })) {
        if (controller.signal.aborted || generation !== this.answerGeneration) return;
        if (event.type === "answer_start") {
          this.answerId = event.answerId;
          this.answerQuestionId = question.id;
          this.answerMode = event.mode;
          this.answerModel = event.model;
          this.answerStartedAt = this.now();
          this.answerFirstTokenAt = undefined;
          this.emit("event", { type: "realtime_message", message: { type: "answer_start", answerId: event.answerId, questionId: event.questionId, mode: event.mode, model: event.model } });
        } else if (event.type === "answer_delta") {
          this.accumulatedAnswerText += event.delta;
          this.answerFirstTokenAt ??= this.now();
          this.currentQuestionTrace?.mark("firstToken", this.answerFirstTokenAt);
          this.emit("event", { type: "realtime_message", message: { type: "answer_delta", answerId: event.answerId, delta: event.delta } });
        } else {
          const finishedAt = this.now();
          const answerText = event.text || this.accumulatedAnswerText;
          // If a provider does not emit deltas, completion is still the first
          // visible response. Normal live providers stream through the branch
          // above and set answerFirstTokenAt when the first delta arrives.
          this.answerFirstTokenAt ??= finishedAt;
          this.currentQuestionTrace?.mark("answerEnded", finishedAt);
          if (event.quality?.issues.includes("QUALITY_UNGROUNDED_CLAIM")) this.emitDiagnostic("QUALITY_UNGROUNDED_CLAIM");
          this.emit("event", { type: "realtime_message", message: { type: "answer_end", answerId: event.answerId, text: answerText, quality: event.quality } });
          this.emitQuestionTrace();
          const confirmedAt = this.questionConfirmedAt.get(question.id) ?? startedAt;
          this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: answerText, model: this.answerModel ?? "configured", mode: this.answerMode ?? mode, startedAt: this.answerStartedAt ?? startedAt, firstTokenAt: this.answerFirstTokenAt, finishedAt, latencyFirstToken: this.answerFirstTokenAt === undefined ? undefined : this.answerFirstTokenAt - confirmedAt, latencyTotal: finishedAt - confirmedAt, createdAt: finishedAt });
          this.memory.recordAnswer(answerText, { question: question.text, createdAt: finishedAt });
          this.detector.markAnswered(question.id);
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
      if (controller.signal.aborted) return;
      // Always close the visible answer state on a provider failure. Without
      // this terminal event the overlay remains in “生成中” forever and the
      // next question can look as if it was ignored.
      this.cancelAnswer("timeout");
      this.emitDiagnostic(`LLM_FAILED: ${String(error)}`);
      this.emit("event", { type: "realtime_message", message: { type: "runtime_error", code: "LLM_FAILED", message: "答案生成失败，请检查模型配置后重试", recoverable: true } });
    } finally {
      if (this.answerController === controller) this.answerController = undefined;
    }
  }

  private bindPorts(): void {
    this.options.audio.on("pcm-packet", (packet: Uint8Array) => this.asr.sendAudio(packet));
    this.asr.on("state", (state: RealtimeConnectionState) => {
      this.emitEvent({ type: "realtime_state", state });
      if (state === "connected" && this.options.session.canTransition("READY")) {
        this.transition("READY");
        if (this.options.session.canTransition("RUNNING")) this.transition("RUNNING");
      }
      if (state === "reconnecting" && this.options.session.canTransition("RECONNECTING")) this.transition("RECONNECTING");
      if (state === "error" && this.running) this.emitDiagnostic("ASR connection failed; reconnect is still enabled");
    });
    this.asr.on("transcript", (snapshot: unknown, rawSegment: TranscriptSegment) => {
      const receivedAt = this.now();
      const segment: TranscriptSegment = { ...rawSegment, text: normalizeTechnicalTerms(rawSegment.text) };
      this.emit("event", { type: "transcript", snapshot, segment });
      if (!this.activeInterviewId) return;
      if (segment.final) {
        this.history.addTranscript({ interviewId: this.activeInterviewId, source: segment.source, text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true, confidence: segment.confidence });
        this.recentTranscript.push(`${segment.source === "remote" ? "面试官" : "我"}：${segment.text}`);
        while (this.recentTranscript.length > 12) this.recentTranscript.shift();
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
    this.asr.on("message", (message: RealtimeServerMessage) => this.emitEvent({ type: "realtime_message", message }));
    this.asr.on("diagnostic", (message: string) => this.emitDiagnostic(message));
  }

  private emitQuestion(inputEvent: QuestionEvent): QuestionEvent {
    const event = this.linkQuestionThread(inputEvent);
    if (event.type === "question_confirmed" || event.type === "question_superseded") {
      this.currentQuestion = event.question;
      const trace = this.pendingQuestionTrace ?? new QuestionTrace({ questionTraceId: `question-trace-${event.question.id}`, questionScore: event.question.score, questionType: event.question.detectionType, followUp: event.question.speechAct === "FOLLOW_UP", projectId: this.activeOptions?.projectId, jobTargetId: this.activeOptions?.jobTargetId });
      if (trace.snapshot().questionDetectedAt === undefined) trace.mark("questionDetected", this.now());
      trace.mark("questionConfirmed", this.now());
      this.currentQuestionTrace = trace;
      this.pendingQuestionTrace = undefined;
      this.memory.recordQuestion(event.question.text, { questionId: event.question.id, parentQuestionId: event.question.parentQuestionId, rootQuestionId: event.question.rootQuestionId, createdAt: event.question.detectedAt });
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
        if (previousId) this.history.updateQuestionStatus?.(previousId, "superseded");
        this.detector.markSuperseded(event.previousQuestionId);
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
      void this.observeFinalQuestion(utterance, sessionGeneration).catch((error) => this.emitDiagnostic(`Question 2.0 analysis failed: ${String(error)}`));
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
    if (this.remoteAssemblyTimer) clearTimeout(this.remoteAssemblyTimer);
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
    this.remoteAssemblyTimer = setTimeout(() => {
      this.remoteAssemblyTimer = undefined;
      this.remoteAssemblyStartedAt = undefined;
      this.flushRemoteUtterances();
    }, Math.min(delay, remaining));
  }

  private clearRemoteAssemblyTimer(): void {
    if (this.remoteAssemblyTimer) clearTimeout(this.remoteAssemblyTimer);
    this.remoteAssemblyTimer = undefined;
    this.remoteAssemblyStartedAt = undefined;
  }

  private clearQuestionFlushTimer(): void {
    if (this.questionFlushTimer) clearTimeout(this.questionFlushTimer);
    this.questionFlushTimer = undefined;
  }

  private handleQuestionEvent(event: QuestionEvent): void {
    const effectiveEvent = this.emitQuestion(event);
    if ((effectiveEvent.type === "question_confirmed" || effectiveEvent.type === "question_superseded") && this.activeOptions?.automationMode === "AUTO") this.scheduleAnswer(effectiveEvent.question);
  }

  private async observeFinalQuestion(utterance: TranscriptUtterance, sessionGeneration = this.sessionGeneration): Promise<void> {
    if (sessionGeneration !== this.sessionGeneration || !this.activeInterviewId) return;
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
      rawText: utterance.text,
      normalizedText: correctedText,
      speechAct: speech.speechAct,
      contextTopic: anchorSnapshot.currentTopic,
      isFollowUp: speech.speechAct === "FOLLOW_UP"
    });
    const promotesStatement = speech.speechAct === "STATEMENT" && Boolean(speech.topic || speech.entities.length);
    if (!speech.shouldAnswer) {
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
      normalizedText: decision.normalizedQuestion || canonicalQuestion,
      speechAct: analysis.speechAct,
      ruleScore: analysis.score.ruleScore,
      semanticScore: analysis.score.semanticScore,
      localClassifierScore: analysis.score.semanticScore,
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
    this.questionFlushTimer = setTimeout(() => {
      this.questionFlushTimer = undefined;
      if (sessionGeneration !== this.sessionGeneration || !this.activeInterviewId) return;
      // Use the scheduled due time as a lower bound. The production clock
      // normally advances with the timer, while deterministic integrations
      // may provide a manually controlled `now()` function.
      this.detector.flush(Math.max(this.now(), dueAt)).forEach((event) => this.handleQuestionEvent(event));
    }, delay);
  }

  private scheduleAnswer(question: QuestionCandidate): void {
    this.clearAnswerTrigger();
    const sessionGeneration = this.sessionGeneration;
    // Completeness has already been established by the temporal detector.
    // Do not add another post-confirmation delay, especially for short but
    // complete follow-ups such as “为什么这样设计？”.
    if (sessionGeneration === this.sessionGeneration && this.activeInterviewId) {
      void this.answer(question);
      return;
    }
    this.pendingAnswerQuestion = question;
    this.answerTriggerTimer = setTimeout(() => {
      this.answerTriggerTimer = undefined;
      const pending = this.pendingAnswerQuestion;
      this.pendingAnswerQuestion = undefined;
      if (!pending || sessionGeneration !== this.sessionGeneration || !this.activeInterviewId) return;
      void this.answer(pending);
    }, 0);
  }

  private clearAnswerTrigger(): void {
    if (this.answerTriggerTimer) clearTimeout(this.answerTriggerTimer);
    this.answerTriggerTimer = undefined;
    this.pendingAnswerQuestion = undefined;
  }

  private cancelAnswer(reason: "user" | "superseded" | "timeout"): void {
    this.answerGeneration += 1;
    const answerId = this.answerId;
    const questionId = this.answerQuestionId;
    const inFlight = Boolean(answerId || this.answerController || this.answerStartedAt !== undefined || this.accumulatedAnswerText);
    const persistedQuestionId = questionId ?? (inFlight ? this.currentQuestion?.id : undefined);
    const now = this.now();
    this.answerController?.abort();
    this.answerController = undefined;
    this.answerId = undefined;
    if (answerId) this.emitAnswerCancelled(answerId, reason);
    // Persist cancellation even if the provider was aborted between request
    // creation and the first answer_start event. The old answerId-only guard
    // dropped exactly that in-flight record during window-close shutdown.
    if (persistedQuestionId && inFlight) {
      this.currentQuestionTrace?.mark("answerEnded", now);
      this.emitQuestionTrace();
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
    this.emit("event", { type: "realtime_message", message: { type: "answer_cancelled", answerId, reason } });
  }

  private emitQuestionTrace(): void {
    const trace = this.currentQuestionTrace;
    if (!trace) return;
    this.emitTelemetry("QUESTION_TRACE", { ...trace.snapshot() });
    this.currentQuestionTrace = undefined;
  }

  private failInterview(message: string): void {
    this.emitDiagnostic(message);
    if (this.activeInterviewId) this.history.endInterview(this.activeInterviewId, "error", this.now());
    if (this.options.session.canTransition("ERROR")) this.transition("ERROR");
    this.activeInterviewId = undefined;
    this.anchorStore.reset();
    this.memory.reset();
  }

  private transition(state: SessionState): void {
    this.options.session.transition(state);
    this.emitEvent({ type: "session_state", state });
  }

  private emitEvent(event: InterviewCoordinatorEvent): void {
    this.emit("event", event);
  }

  private emitDiagnostic(message: string): void {
    this.emitEvent({ type: "diagnostic", message });
  }

  private emitTelemetry(name: string, fields: Record<string, unknown>): void {
    this.emitEvent({ type: "telemetry", name, fields });
  }
}
