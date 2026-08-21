import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ClientControlMessage, RealtimeServerMessage, TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerAgent,
  InterviewBrain,
  InterviewMemory,
  InterviewHistoryStore,
  QuestionDetector,
  QuestionDetector2,
  SessionStateMachine,
  TranscriptAggregator,
  type AnswerContextInput,
  type AnswerMode,
  type AnswerRecord,
  type AsrLanguage,
  type InterviewRecord,
  type QuestionRecord,
  type QuestionCandidate,
  type QuestionEvent,
  type SessionState,
  type TranscriptRecord
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
  inputDeviceId?: string;
  outputDeviceId?: string;
  automationMode?: "MANUAL" | "AUTO";
  answerMode: AnswerMode;
  language?: string;
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
  contextProvider?: (question: QuestionCandidate, profileId: string, recentTranscript: string[]) => AnswerContextInput | Promise<AnswerContextInput>;
  asrSettingsProvider?: (profileId: string) => Pick<RealtimeConnectOptions, "providerType" | "providerName" | "model" | "language" | "url">;
  interviewBrain?: InterviewBrain;
  now?: () => number;
  initialAutomationMode?: "MANUAL" | "AUTO";
}

export type InterviewCoordinatorEvent =
  | { type: "session_state"; state: SessionState }
  | { type: "transcript"; snapshot: unknown; segment: TranscriptSegment }
  | { type: "question"; event: QuestionEvent }
  | { type: "realtime_message"; message: RealtimeServerMessage }
  | { type: "realtime_state"; state: RealtimeConnectionState }
  | { type: "automation_mode"; mode: "MANUAL" | "AUTO" }
  | { type: "answer_mode"; mode: AnswerMode }
  | { type: "diagnostic"; message: string };

export class InterviewCoordinator extends EventEmitter {
  private readonly detector: QuestionDetector;
  private readonly detector2: QuestionDetector2;
  private readonly brain: InterviewBrain;
  private readonly memory: InterviewMemory;
  private readonly aggregator: TranscriptAggregator;
  private readonly history: InterviewHistoryPort;
  private readonly now: () => number;
  private readonly contextProvider: (question: QuestionCandidate, profileId: string, recentTranscript: string[]) => AnswerContextInput | Promise<AnswerContextInput>;
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
  private finalQuestionSequence = 0;
  private finalQuestionQueue: Promise<void> | undefined;

  constructor(private readonly options: InterviewCoordinatorOptions) {
    super();
    this.asr = options.asrManager ?? options.realtime ?? (() => { throw new Error("ASRManager is required"); })();
    this.detector = options.detector ?? new QuestionDetector();
    this.detector2 = options.questionDetector2 ?? new QuestionDetector2();
    this.brain = options.interviewBrain ?? new InterviewBrain();
    this.memory = options.memory ?? new InterviewMemory(10);
    this.aggregator = options.aggregator ?? new TranscriptAggregator();
    this.history = options.history ?? new InterviewHistoryStore();
    this.now = options.now ?? (() => Date.now());
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
      startedAt,
      status: "running",
      language: startOptions.language ?? "zh-CN",
      automationMode
    }, startedAt);
    this.activeInterviewId = record.id;
    this.activeOptions = { ...startOptions, automationMode };
    this.activeProfileId = startOptions.profileId;
    this.detector.reset();
    this.memory.reset();
    this.currentQuestion = undefined;
    this.historyQuestionIds.clear();
    this.questionConfirmedAt.clear();
    this.recentTranscript.length = 0;
    this.memory.reset();
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
    if (this.questionFlushTimer) clearTimeout(this.questionFlushTimer);
    this.questionFlushTimer = undefined;
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
    const clean = text.trim();
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
    this.currentQuestion = question;
    this.detector.markAnswering(question.id);
    this.options.history?.updateQuestionStatus?.(this.historyQuestionIds.get(question.id) ?? question.id, "answering");
    const controller = new AbortController();
    this.answerController = controller;
    const startedAt = this.now();
    this.accumulatedAnswerText = "";
    try {
      const providerContext = await this.contextProvider(question, this.activeProfileId ?? "", [...this.recentTranscript]);
      const context = { ...providerContext, recentTranscript: providerContext.recentTranscript ?? [...this.recentTranscript], interviewMemory: this.memory.snapshot() };
      for await (const event of this.options.answerAgent.stream({ id: question.id, text: question.text }, mode, context, controller.signal, streamOptions)) {
        if (controller.signal.aborted) return;
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
          this.emit("event", { type: "realtime_message", message: { type: "answer_delta", answerId: event.answerId, delta: event.delta } });
        } else {
          const finishedAt = this.now();
          const answerText = event.text || this.accumulatedAnswerText;
          this.emit("event", { type: "realtime_message", message: { type: "answer_end", answerId: event.answerId, text: answerText, quality: event.quality } });
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
    this.asr.on("transcript", (snapshot: unknown, segment: TranscriptSegment) => {
      this.emit("event", { type: "transcript", snapshot, segment });
      if (!this.activeInterviewId) return;
      if (segment.final) {
        this.history.addTranscript({ interviewId: this.activeInterviewId, source: segment.source, text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true, confidence: segment.confidence });
        this.recentTranscript.push(`${segment.source === "remote" ? "面试官" : "我"}：${segment.text}`);
        while (this.recentTranscript.length > 12) this.recentTranscript.shift();
      }
      // A candidate answer marks a hard turn boundary for the remote
      // aggregator. Without this, two unrelated interviewer prompts inside
      // the 1.8s ASR window can be merged into one question.
      if (segment.final && segment.source === "mic") this.aggregator.flush("remote");
      if (segment.source !== "remote") return;
      // Partials are used for early classification only. They never confirm
      // or answer by themselves; the final segment still owns confirmation.
      if (!segment.final) {
        this.detector.observe(segment, this.now()).forEach((event) => this.handleQuestionEvent(event));
        this.scheduleQuestionFlush();
        return;
      }
      const utterance = this.aggregator.push(segment);
      if (!utterance) return;
      const sequence = ++this.finalQuestionSequence;
      // The synchronous compatibility path must start immediately so the
      // 500ms debounce timer is scheduled against the same clock tick used by
      // the ASR event. Only the real local/remote classifier path needs the
      // serialized async queue below.
      if (!this.detector2.hasLocalClassifier) {
        void this.observeFinalQuestion(utterance, sequence).catch((error) => this.emitDiagnostic(`Question 2.0 analysis failed: ${String(error)}`));
        return;
      }
      const run = () => this.observeFinalQuestion(utterance, sequence);
      const next = this.finalQuestionQueue ? this.finalQuestionQueue.then(run) : run();
      const tracked = next.catch((error) => this.emitDiagnostic(`Question 2.0 analysis failed: ${String(error)}`));
      this.finalQuestionQueue = tracked;
      void tracked.then(
        () => { if (this.finalQuestionQueue === tracked) this.finalQuestionQueue = undefined; },
        () => { if (this.finalQuestionQueue === tracked) this.finalQuestionQueue = undefined; }
      );
    });
    this.asr.on("message", (message: RealtimeServerMessage) => this.emitEvent({ type: "realtime_message", message }));
    this.asr.on("diagnostic", (message: string) => this.emitDiagnostic(message));
  }

  private emitQuestion(event: QuestionEvent): void {
      if (event.type === "question_confirmed" || event.type === "question_superseded") {
      this.currentQuestion = event.question;
      this.memory.recordQuestion(event.question.text, { createdAt: event.question.detectedAt });
      if (this.activeInterviewId) {
        const stored = this.history.addQuestion({ interviewId: this.activeInterviewId, text: event.question.text, confidence: event.question.confidence, source: event.question.source, detectedAt: event.question.detectedAt, status: event.question.status });
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
  }

  private handleQuestionEvent(event: QuestionEvent): void {
    this.emitQuestion(event);
    if ((event.type === "question_confirmed" || event.type === "question_superseded") && this.activeOptions?.automationMode === "AUTO") void this.answer(event.question);
  }

  private async observeFinalQuestion(utterance: { text: string; startMs: number; endMs: number; final: true; confidence?: number }, sequence: number): Promise<void> {
    // Rules remain the first signal. When the local classifier is configured,
    // the async call adds the CPU-local ONNX speech-act signal. Test and
    // third-party integrations without that optional model retain the old
    // synchronous fast path.
    // The current final segment is already in recentTranscript; exclude it so
    // a short standalone question is not mistaken for a follow-up to itself.
    const previousTranscript = this.recentTranscript.slice(0, -1);
    const contextText = this.memory.contextText(previousTranscript);
    const detectionContext = { memory: this.memory.snapshot(), recentTranscript: previousTranscript };
    let analysis = this.detector2.analyzeSync(utterance.text, contextText, true, detectionContext);
    let decision = this.brain.analyze({ text: utterance.text, analysis, memory: detectionContext.memory, recentTranscript: previousTranscript });
    if (this.detector2.hasLocalClassifier || (!decision.isQuestion && analysis.score.finalScore >= 0.5)) {
      analysis = await this.detector2.analyze(utterance.text, contextText, true, detectionContext);
      decision = this.brain.analyze({ text: utterance.text, analysis, memory: detectionContext.memory, recentTranscript: previousTranscript });
    }
    // Elliptical follow-ups such as “好，说说” are promoted by
    // InterviewBrain immediately when a topic exists in memory.
    if (!decision.isQuestion || !this.activeInterviewId) return;
    const observed = decision.normalizedQuestion && decision.normalizedQuestion !== utterance.text ? { ...utterance, text: decision.normalizedQuestion } : utterance;
    if (sequence !== this.finalQuestionSequence && this.finalQuestionSequence - sequence > 1) return;
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
    this.detector.observe({ ...observed, analysis: effectiveAnalysis }, this.now()).forEach((event) => this.handleQuestionEvent(event));
    this.scheduleQuestionFlush();
  }

  private scheduleQuestionFlush(): void {
    if (this.questionFlushTimer) clearTimeout(this.questionFlushTimer);
    this.questionFlushTimer = setTimeout(() => {
      this.questionFlushTimer = undefined;
      this.detector.flush(this.now()).forEach((event) => this.handleQuestionEvent(event));
    }, 500);
  }

  private cancelAnswer(reason: "user" | "superseded" | "timeout"): void {
    const answerId = this.answerId;
    const questionId = this.answerQuestionId;
    const now = this.now();
    this.answerController?.abort();
    this.answerController = undefined;
    this.answerId = undefined;
    if (answerId) {
      this.emitAnswerCancelled(answerId, reason);
      if (questionId) this.history.addAnswer({ questionId: this.historyQuestionIds.get(questionId) ?? questionId, text: this.accumulatedAnswerText, model: this.answerModel ?? "unknown", mode: this.answerMode, startedAt: this.answerStartedAt, firstTokenAt: this.answerFirstTokenAt, finishedAt: now, latencyFirstToken: this.answerFirstTokenAt === undefined ? undefined : this.answerFirstTokenAt - (this.questionConfirmedAt.get(questionId) ?? now), latencyTotal: now - (this.questionConfirmedAt.get(questionId) ?? now), cancelReason: reason, createdAt: now });
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

  private failInterview(message: string): void {
    this.emitDiagnostic(message);
    if (this.activeInterviewId) this.history.endInterview(this.activeInterviewId, "error", this.now());
    if (this.options.session.canTransition("ERROR")) this.transition("ERROR");
    this.activeInterviewId = undefined;
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
}
