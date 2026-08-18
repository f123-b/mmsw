import { EventEmitter } from "node:events";
import type { ClientControlMessage, RealtimeServerMessage, TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerAgent,
  InterviewHistoryStore,
  QuestionDetector,
  SessionStateMachine,
  TranscriptAggregator,
  type AnswerContextInput,
  type AnswerMode,
  type QuestionCandidate,
  type QuestionEvent,
  type SessionState
} from "@interview-copilot/shared";
import type { AudioStartOptions } from "./audio-manager";
import type { RealtimeConnectOptions, RealtimeConnectionState } from "./realtime-session";

export interface InterviewAudioPort {
  start(options: AudioStartOptions): void;
  stop(): void;
  on(event: "pcm-packet" | "event" | "diagnostic", listener: (...args: any[]) => void): this;
}

export interface InterviewRealtimePort {
  connect(options: RealtimeConnectOptions): void;
  disconnect(): void;
  sendAudio(packet: Uint8Array): void;
  sendControl(message: ClientControlMessage): void;
  on(event: "state" | "transcript" | "message" | "diagnostic", listener: (...args: any[]) => void): this;
}

export interface InterviewStartOptions extends Omit<RealtimeConnectOptions, "autoReconnect"> {
  profileId: string;
  inputDeviceId?: string;
  outputDeviceId?: string;
  automationMode: "MANUAL" | "AUTO";
  answerMode: AnswerMode;
  language?: string;
}

export interface InterviewCoordinatorOptions {
  audio: InterviewAudioPort;
  realtime: InterviewRealtimePort;
  session: SessionStateMachine;
  answerAgent: AnswerAgent;
  detector?: QuestionDetector;
  aggregator?: TranscriptAggregator;
  history?: InterviewHistoryStore;
  contextProvider?: (question: QuestionCandidate) => AnswerContextInput | Promise<AnswerContextInput>;
  now?: () => number;
}

export type InterviewCoordinatorEvent =
  | { type: "session_state"; state: SessionState }
  | { type: "transcript"; snapshot: unknown; segment: TranscriptSegment }
  | { type: "question"; event: QuestionEvent }
  | { type: "realtime_message"; message: RealtimeServerMessage }
  | { type: "realtime_state"; state: RealtimeConnectionState }
  | { type: "diagnostic"; message: string };

export class InterviewCoordinator extends EventEmitter {
  private readonly detector: QuestionDetector;
  private readonly aggregator: TranscriptAggregator;
  private readonly history: InterviewHistoryStore;
  private readonly now: () => number;
  private readonly contextProvider: (question: QuestionCandidate) => AnswerContextInput | Promise<AnswerContextInput>;
  private activeInterviewId: string | undefined;
  private activeOptions: InterviewStartOptions | undefined;
  private currentQuestion: QuestionCandidate | undefined;
  private answerController: AbortController | undefined;
  private answerId: string | undefined;
  private readonly historyQuestionIds = new Map<string, string>();
  private questionFlushTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: InterviewCoordinatorOptions) {
    super();
    this.detector = options.detector ?? new QuestionDetector();
    this.aggregator = options.aggregator ?? new TranscriptAggregator();
    this.history = options.history ?? new InterviewHistoryStore();
    this.now = options.now ?? (() => Date.now());
    this.contextProvider = options.contextProvider ?? (() => ({}));
    this.bindPorts();
  }

  get interviewId(): string | undefined { return this.activeInterviewId; }
  get running(): boolean { return Boolean(this.activeInterviewId); }

  async start(startOptions: InterviewStartOptions): Promise<string> {
    if (!startOptions.url.trim()) throw new Error("ASR WebSocket URL is required");
    if (this.running) await this.stop("user");
    this.transition("CREATING");
    const startedAt = this.now();
    const record = this.history.createInterview({
      profileId: startOptions.profileId,
      startedAt,
      status: "running",
      language: startOptions.language ?? "zh-CN",
      automationMode: startOptions.automationMode
    }, startedAt);
    this.activeInterviewId = record.id;
    this.activeOptions = { ...startOptions };
    this.currentQuestion = undefined;
    this.historyQuestionIds.clear();
    this.aggregator.clear();
    this.transition("CONNECTING");
    try {
      // The real interview path deliberately omits meterOnly so PCM reaches ASR.
      this.options.realtime.connect({ url: startOptions.url, ticket: startOptions.ticket, autoReconnect: true });
      this.options.audio.start({ inputDeviceId: startOptions.inputDeviceId, outputDeviceId: startOptions.outputDeviceId, meterOnly: false, autoRecover: true });
    } catch (error) {
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
    this.options.audio.stop();
    this.options.realtime.disconnect();
    if (this.options.session.canTransition("ENDING")) this.transition("ENDING");
    this.history.endInterview(interviewId, reason === "error" ? "error" : "ended", this.now());
    if (this.options.session.canTransition("ENDED")) this.transition("ENDED");
    this.activeInterviewId = undefined;
    this.activeOptions = undefined;
    this.currentQuestion = undefined;
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

  async answer(question: QuestionCandidate, mode = this.activeOptions?.answerMode ?? "NORMAL"): Promise<void> {
    if (!this.running) {
      this.emitDiagnostic("Interview is not running");
      return;
    }
    this.cancelAnswer("superseded");
    this.currentQuestion = question;
    this.detector.markAnswering(question.id);
    const controller = new AbortController();
    this.answerController = controller;
    const startedAt = this.now();
    try {
      const context = await this.contextProvider(question);
      for await (const event of this.options.answerAgent.stream({ id: question.id, text: question.text }, mode, context, controller.signal)) {
        if (controller.signal.aborted) return;
        if (event.type === "answer_start") {
          this.answerId = event.answerId;
          this.emit("event", { type: "realtime_message", message: { type: "answer_start", answerId: event.answerId, questionId: event.questionId, mode: event.mode } });
        } else if (event.type === "answer_delta") {
          this.emit("event", { type: "realtime_message", message: { type: "answer_delta", answerId: event.answerId, delta: event.delta } });
        } else {
          this.emit("event", { type: "realtime_message", message: { type: "answer_end", answerId: event.answerId, text: event.text } });
          this.history.addAnswer({ questionId: this.historyQuestionIds.get(question.id) ?? question.id, text: event.text, model: "configured", mode, latencyFirstToken: undefined, latencyTotal: this.now() - startedAt, createdAt: this.now() });
          this.detector.markAnswered(question.id);
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
      if (segment.final) this.history.addTranscript({ interviewId: this.activeInterviewId, source: segment.source, text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true, confidence: segment.confidence });
      if (segment.source !== "remote") return;
      const utterance = this.aggregator.push(segment);
      if (!utterance) return;
      this.detector.observe(utterance, this.now()).forEach((event) => this.emitQuestion(event));
      if (this.questionFlushTimer) clearTimeout(this.questionFlushTimer);
      this.questionFlushTimer = setTimeout(() => {
        this.questionFlushTimer = undefined;
        this.detector.flush(this.now()).forEach((event) => {
          this.emitQuestion(event);
          if (event.type === "question_confirmed" && this.activeOptions?.automationMode === "AUTO") void this.answer(event.question);
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
      }
    }
    this.emitEvent({ type: "question", event });
  }

  private cancelAnswer(reason: "user" | "superseded" | "timeout"): void {
    const answerId = this.answerId;
    this.answerController?.abort();
    this.answerController = undefined;
    this.answerId = undefined;
    if (answerId) this.emitAnswerCancelled(answerId, reason);
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
