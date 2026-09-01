import { EventEmitter } from "node:events";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import { AnswerAgent, normalizeTechnicalTerms, type AnswerContextInput, type AnswerMode } from "@interview-copilot/shared";

export interface WrittenTestStartOptions {
  profileId: string;
  answerMode: AnswerMode;
}

export interface WrittenTestState {
  running: boolean;
  profileId?: string;
  answerMode: AnswerMode;
}

export type WrittenTestControllerEvent =
  | { type: "state"; state: WrittenTestState }
  | { type: "realtime_message"; message: RealtimeServerMessage }
  | { type: "answer_mode"; mode: AnswerMode }
  | { type: "diagnostic"; message: string };

export interface WrittenTestControllerOptions {
  answerAgent: AnswerAgent;
  contextProvider?: (question: { id: string; text: string }, profileId: string) => AnswerContextInput | Promise<AnswerContextInput>;
  now?: () => number;
  initialAnswerMode?: AnswerMode;
}

/**
 * Screenshot-only practice/test session. It deliberately does not own an
 * audio port, ASR connection, transcript aggregator, or question detector so
 * the existing InterviewCoordinator remains unchanged.
 */
export class WrittenTestController extends EventEmitter {
  private readonly now: () => number;
  private readonly contextProvider: NonNullable<WrittenTestControllerOptions["contextProvider"]>;
  private answerModeValue: AnswerMode;
  private activeProfileId: string | undefined;
  private answerController: AbortController | undefined;

  constructor(private readonly options: WrittenTestControllerOptions) {
    super();
    this.now = options.now ?? (() => Date.now());
    this.contextProvider = options.contextProvider ?? (() => ({}));
    this.answerModeValue = options.initialAnswerMode ?? "NORMAL";
  }

  get running(): boolean { return Boolean(this.activeProfileId); }
  get profileId(): string | undefined { return this.activeProfileId; }
  get answerMode(): AnswerMode { return this.answerModeValue; }

  get state(): WrittenTestState {
    return { running: this.running, profileId: this.activeProfileId, answerMode: this.answerModeValue };
  }

  start(options: WrittenTestStartOptions): void {
    if (this.running) this.stop();
    this.activeProfileId = options.profileId;
    this.answerModeValue = options.answerMode;
    this.emitEvent({ type: "state", state: this.state });
  }

  stop(): void {
    this.cancelAnswer("user");
    this.activeProfileId = undefined;
    this.emitEvent({ type: "state", state: this.state });
  }

  setAnswerMode(mode: AnswerMode): void {
    this.answerModeValue = mode;
    this.emitEvent({ type: "answer_mode", mode });
  }

  async answerScreenshot(dataUrl: string): Promise<void> {
    if (!this.running) {
      this.emitEvent({ type: "diagnostic", message: "笔试模式尚未启动" });
      return;
    }
    if (!dataUrl?.startsWith("data:image/")) {
      this.emitEvent({ type: "diagnostic", message: "截图数据无效，请重试" });
      return;
    }

    this.cancelAnswer("superseded");
    const question = {
      id: `written-test-question-${this.now()}`,
      text: normalizeTechnicalTerms("请识别截图中的题目，先判断题型，再直接给出完整、清晰、可执行的答案。")
    };
    const controller = new AbortController();
    this.answerController = controller;
    try {
      const providerContext = await this.contextProvider(question, this.activeProfileId ?? "");
      const context = { ...providerContext, recentTranscript: providerContext.recentTranscript ?? [] };
      for await (const event of this.options.answerAgent.stream(
        { id: question.id, text: question.text },
        this.answerModeValue,
        context,
        controller.signal,
        {
          hasScreenshot: true,
          attachments: [{ mimeType: "image/png", dataUrl }],
          maxOutputTokens: this.answerModeValue === "FAST" ? 1_600 : this.answerModeValue === "DEEP" ? 3_200 : 2_400,
          emitDeltas: true,
          instruction: "这是笔试模式的截图题。请以图片内容为准，不要等待语音转录；答案按识别出的题型组织，代码题必须输出完整代码，代码块和解释都要完整结束。"
        }
      )) {
        if (controller.signal.aborted) return;
        if (event.type === "answer_start") {
          const groupId = `written-test-screenshot-group-${question.id}`;
          this.emitEvent({ type: "realtime_message", message: { type: "question_group_updated", groupId, title: "笔试截图题", primaryQuestion: "截图识别题（以图片为准）", items: [{ id: question.id, questionId: question.id, text: "截图识别题（以图片为准）", type: "NEW_TOPIC", answerable: true, state: "answering" }], slots: [{ id: `question-slot-${question.id}`, text: "截图识别题（以图片为准）", status: "covered" }], updatedAt: this.now() } });
          this.emitEvent({ type: "realtime_message", message: { type: "answer_start", answerId: event.answerId, questionId: event.questionId, groupId, relation: "PRIMARY", mode: event.mode, model: event.model } });
        }
        else if (event.type === "answer_delta") this.emitEvent({ type: "realtime_message", message: { type: "answer_delta", answerId: event.answerId, delta: event.delta } });
        else if (event.type === "answer_end") this.emitEvent({ type: "realtime_message", message: { type: "answer_end", answerId: event.answerId, text: event.text, quality: event.quality } });
      }
    } catch (error) {
      if (!controller.signal.aborted) this.emitEvent({ type: "diagnostic", message: `LLM_FAILED: ${String(error)}` });
    } finally {
      if (this.answerController === controller) this.answerController = undefined;
    }
  }

  private cancelAnswer(reason: "user" | "superseded" | "timeout"): void {
    this.answerController?.abort();
    this.answerController = undefined;
    // AnswerAgent creates the answer id only after the provider starts. The
    // renderer safely ignores cancellation without an active answer id, so
    // this controller does not invent an id or leak stale answer state.
    void reason;
  }

  private emitEvent(event: WrittenTestControllerEvent): void {
    this.emit("event", event);
  }
}
