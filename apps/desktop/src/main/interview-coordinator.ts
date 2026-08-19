import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ClientControlMessage, RealtimeServerMessage, TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerAgent,
  InterviewHistoryStore,
  QuestionDetector,
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

export interface InterviewRealtimePort {
  connect(options: RealtimeConnectOptions): void;
  finalize?(timeoutMs?: number): Promise<void>;
  disconnect(): void;
  sendAudio(packet: Uint8Array): void;
  sendControl(message: ClientControlMessage): void;
  on(event: "state" | "transcript" | "message" | "diagnostic", listener: (...args: any[]) => void): this;
}

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
  realtime: InterviewRealtimePort;
  session: SessionStateMachine;
  answerAgent: AnswerAgent;
  detector?: QuestionDetector;
  aggregator?: TranscriptAggregator;
  history?: InterviewHistoryPort;
  contextProvider?: (question: QuestionCandidate, profileId: string, recentTranscript: string[]) => AnswerContextInput | Promise<AnswerContextInput>;
  asrSettingsProvider?: (profileId: string) => Pick<RealtimeConnectOptions, "providerType" | "providerName" | "model" | "language" | "url">;
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
  private readonly recentTranscript: string[] = [];
  private readonly historyQuestionIds = new Map<string, string>();
  private questionFlushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: InterviewCoordinatorOptions) {
    super();
    this.detector = options.detector ?? new QuestionDetector();
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
    this.currentQuestion = undefined;
    this.historyQuestionIds.clear();
    this.questionConfirmedAt.clear();
    this.recentTranscript.length = 0;
    this.aggregator.clear();
    this.transition("CONNECTING");
    try {
      // The real interview path deliberately omits meterOnly so PCM reaches ASR.
      this.options.realtime.connect({ ...startOptions, ...asrSettings, providerType, url: connectUrl, language: asrSettings?.language ?? (startOptions.language as AsrLanguage | undefined), autoReconnect: true });
      await this.options.audio.start({ inputDeviceId: startOptions.inputDeviceId, outputDeviceId: startOptions.outputDeviceId, meterOnly: false, autoRecover: true });
    } catch (error) {
      await Promise.resolve(this.options.audio.stop()).catch(() => undefined);
      this.options.realtime.disconnect();
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
    try { await this.options.realtime.finalize?.(1_000); } catch (error) { this.emitDiagnostic(`ASR finalize failed: ${String(error)}`); }
    try { this.options.realtime.disconnect(); } catch (error) { this.emitDiagnostic(`ASR disconnect failed: ${String(error)}`); }
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
    await this.answer(question, "NORMAL", { hasScreenshot: true, attachments: [{ mimeType: "image/png", dataUrl }] });
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
      const context = await this.contextProvider(question, this.activeProfileId ?? "", [...this.recentTranscript]);
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
          this.emit("event", { type: "realtime_message", message: { type: "answer_end", answerId: event.answerId, text: answerText } });
          const confirmedAt = this.questionConfirmedAt.get(question.id) ?? startedAt;
          this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: answerText, model: this.answerModel ?? "configured", mode: this.answerMode ?? mode, startedAt: this.answerStartedAt ?? startedAt, firstTokenAt: this.answerFirstTokenAt, finishedAt, latencyFirstToken: this.answerFirstTokenAt === undefined ? undefined : this.answerFirstTokenAt - confirmedAt, latencyTotal: finishedAt - confirmedAt, createdAt: finishedAt });
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
    this.options.audio.on("pcm-packet", (packet: Uint8Array) => this.options.realtime.sendAudio(packet));
    this.options.realtime.on("state", (state: RealtimeConnectionState) => {
      this.emitEvent({ type: "realtime_state", state });
      if (state === "connected" && this.options.session.canTransition("READY")) {
        this.transition("READY");
        if (this.options.session.canTransition("RUNNING")) this.transition("RUNNING");
      }
      if (state === "reconnecting" && this.options.session.canTransition("RECONNECTING")) this.transition("RECONNECTING");
      if (state === "error" && this.running) this.emitDiagnostic("ASR connection failed; reconnect is still enabled");
    });
    this.options.realtime.on("transcript", (snapshot: unknown, segment: TranscriptSegment) => {
      this.emit("event", { type: "transcript", snapshot, segment });
      if (!this.activeInterviewId) return;
      if (segment.final) {
        this.history.addTranscript({ interviewId: this.activeInterviewId, source: segment.source, text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true, confidence: segment.confidence });
        this.recentTranscript.push(`${segment.source === "remote" ? "面试官" : "我"}：${segment.text}`);
        while (this.recentTranscript.length > 12) this.recentTranscript.shift();
      }
      if (segment.source !== "remote") return;
      const utterance = this.aggregator.push(segment);
      if (!utterance) return;
      this.detector.observe(utterance, this.now()).forEach((event) => this.handleQuestionEvent(event));
      if (this.questionFlushTimer) clearTimeout(this.questionFlushTimer);
      this.questionFlushTimer = setTimeout(() => {
        this.questionFlushTimer = undefined;
        this.detector.flush(this.now()).forEach((event) => {
          this.handleQuestionEvent(event);
        });
      }, 500);
    });
    this.options.realtime.on("message", (message: RealtimeServerMessage) => this.emitEvent({ type: "realtime_message", message }));
    this.options.realtime.on("diagnostic", (message: string) => this.emitDiagnostic(message));
  }

  private emitQuestion(event: QuestionEvent): void {
    if (event.type === "question_confirmed" || event.type === "question_superseded") {
      this.currentQuestion = event.question;
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
