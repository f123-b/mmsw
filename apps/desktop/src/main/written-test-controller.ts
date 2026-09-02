import { EventEmitter } from "node:events";
import type { RealtimeServerMessage } from "@interview-copilot/protocol";
import { AnswerAgent, createFallbackDiagram, normalizeTechnicalTerms, parseWrittenTestResult, repairWrittenAnswer, renderWrittenAnswer, resolveWrittenProblemRelation, WrittenAnswerPlanner, type AnswerContextInput, type AnswerMode, type WrittenAnswerDocument, type WrittenProblemFrame, type WrittenProblemRelation, type WrittenTestQuestion, type WrittenTestScreenshot, type WrittenTestSession, type WrittenTestSessionDetail } from "@interview-copilot/shared";
import { SqliteWrittenTestHistoryRepository } from "./written-test-history-repository";

export interface WrittenTestStartOptions { profileId: string; answerMode: AnswerMode; }

export interface WrittenTestState {
  running: boolean;
  profileId?: string;
  sessionId?: string;
  answerMode: AnswerMode;
  screenshotStatus: "IDLE" | "CAPTURING" | "ANALYZING" | "SOLVING" | "SUCCESS" | "ERROR";
  questionCount: number;
  screenshotCount: number;
  currentQuestion?: WrittenTestQuestion;
  currentProblem?: WrittenProblemFrame;
  currentAnswer?: WrittenAnswerDocument;
  currentRelation?: WrittenProblemRelation;
  lastError?: string;
}

export type WrittenTestControllerEvent =
  | { type: "state"; state: WrittenTestState }
  | { type: "realtime_message"; message: RealtimeServerMessage }
  | { type: "document"; question: WrittenTestQuestion; problem: WrittenProblemFrame }
  | { type: "answer_mode"; mode: AnswerMode }
  | { type: "diagnostic"; message: string };

export interface WrittenTestControllerOptions {
  answerAgent: AnswerAgent;
  repository?: SqliteWrittenTestHistoryRepository;
  contextProvider?: (question: { id: string; text: string }, profileId: string) => AnswerContextInput | Promise<AnswerContextInput>;
  now?: () => number;
  initialAnswerMode?: AnswerMode;
}

interface ArchivedScreenshotInput extends WrittenTestScreenshot { dataUrl: string; }

/** Screenshot-only written-test runtime; it deliberately never touches the interview ASR pipeline. */
export class WrittenTestController extends EventEmitter {
  private readonly now: () => number;
  private readonly contextProvider: NonNullable<WrittenTestControllerOptions["contextProvider"]>;
  private readonly planner = new WrittenAnswerPlanner();
  private answerModeValue: AnswerMode;
  private activeProfileId: string | undefined;
  private activeSession: WrittenTestSession | undefined;
  private status: WrittenTestState["screenshotStatus"] = "IDLE";
  private activeQuestion: WrittenTestQuestion | undefined;
  private activeProblem: WrittenProblemFrame | undefined;
  private activeAnswer: WrittenAnswerDocument | undefined;
  private activeRelation: WrittenProblemRelation | undefined;
  private lastError: string | undefined;
  private answerController: AbortController | undefined;

  constructor(private readonly options: WrittenTestControllerOptions) {
    super();
    this.now = options.now ?? (() => Date.now());
    this.contextProvider = options.contextProvider ?? (() => ({}));
    this.answerModeValue = options.initialAnswerMode ?? "NORMAL";
  }

  get running(): boolean { return Boolean(this.activeProfileId); }
  get profileId(): string | undefined { return this.activeProfileId; }
  get sessionId(): string | undefined { return this.activeSession?.id; }
  get answerMode(): AnswerMode { return this.answerModeValue; }
  get state(): WrittenTestState {
    return { running: this.running, profileId: this.activeProfileId, sessionId: this.activeSession?.id, answerMode: this.answerModeValue, screenshotStatus: this.status, questionCount: this.activeSession?.questionCount ?? 0, screenshotCount: this.activeSession?.screenshotCount ?? 0, ...(this.activeQuestion ? { currentQuestion: this.activeQuestion } : {}), ...(this.activeProblem ? { currentProblem: this.activeProblem } : {}), ...(this.activeAnswer ? { currentAnswer: this.activeAnswer } : {}), ...(this.activeRelation ? { currentRelation: this.activeRelation } : {}), ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  start(options: WrittenTestStartOptions): void {
    if (this.running) this.stop();
    this.activeProfileId = options.profileId;
    this.answerModeValue = options.answerMode;
    this.activeSession = this.options.repository?.createSession({ profileId: options.profileId, answerMode: options.answerMode });
    this.status = "IDLE";
    this.activeQuestion = undefined;
    this.activeProblem = undefined;
    this.activeAnswer = undefined;
    this.activeRelation = undefined;
    this.lastError = undefined;
    this.emitState();
  }

  stop(): void {
    this.cancelAnswer();
    if (this.activeSession) this.options.repository?.updateSession(this.activeSession.id, { status: "COMPLETED", endedAt: this.now() });
    this.activeProfileId = undefined;
    this.activeSession = undefined;
    this.activeQuestion = undefined;
    this.activeProblem = undefined;
    this.activeAnswer = undefined;
    this.activeRelation = undefined;
    this.status = "IDLE";
    this.emitState();
  }

  setAnswerMode(mode: AnswerMode): void {
    this.answerModeValue = mode;
    if (this.activeSession) this.activeSession = this.options.repository?.updateSession(this.activeSession.id, { answerMode: mode }) ?? this.activeSession;
    this.emitEvent({ type: "answer_mode", mode });
    this.emitState();
  }

  markCapturing(): void { if (this.running) { this.status = "CAPTURING"; this.emitState(); } }

  async answerScreenshot(dataUrl: string, archived?: ArchivedScreenshotInput): Promise<void> {
    if (!this.running) { this.emitEvent({ type: "diagnostic", message: "笔试模式尚未启动" }); return; }
    if (!dataUrl?.startsWith("data:image/")) { this.fail("截图数据无效，请重试"); return; }
    if (!this.options.repository) { await this.answerLegacyScreenshot(dataUrl); return; }
    if (!this.activeSession || !archived) { this.fail("截图未完成归档，已阻止继续分析"); return; }
    this.cancelAnswer();
    this.status = "ANALYZING";
    this.lastError = undefined;
    this.emitState();
    const storedScreenshot = this.options.repository.addScreenshot(archived);
    this.activeSession = this.options.repository.getSession(this.activeSession.id) ?? this.activeSession;
    const startedAt = this.now();
    const questionId = `written-test-question-${startedAt}`;
    const question = { id: questionId, text: "请读取截图中的完整笔试题，建立题目框架，判断题型，并按要求返回结构化答案。" };
    const controller = new AbortController();
    this.answerController = controller;
    try {
      const providerContext = await this.contextProvider(question, this.activeProfileId ?? "");
      const context = { ...providerContext, recentTranscript: providerContext.recentTranscript ?? [] };
      let raw = "";
      let answerId = questionId;
      let model = "written-test";
      for await (const event of this.options.answerAgent.stream(question, this.answerModeValue, context, controller.signal, {
        hasScreenshot: true,
        attachments: [{ mimeType: "image/png", dataUrl }],
        maxOutputTokens: this.answerModeValue === "FAST" ? 2_000 : this.answerModeValue === "DEEP" ? 5_000 : 3_200,
        emitDeltas: false,
        formatAnswer: false,
        allowQualityRepair: false,
        instruction: "你是笔试题理解与作答引擎。只根据截图事实作答。必须返回单个 JSON 对象，不要 Markdown 包裹，字段为 problem 与 answer。problem 需包含 rawText、canonicalQuestion、questionType、language、requirements、inputs、outputs、constraints、codeContext、formulas、requestedArtifacts、confidence。answer 需包含 questionType、finalAnswer、steps、code、equations、table、diagram、explanation、complexity、warnings、confidence。题型必须从 SINGLE_CHOICE、MULTIPLE_CHOICE、SHORT_ANSWER、CALCULATION、ALGORITHM、PROGRAMMING、CODE_READING、CODE_DEBUGGING、DIGITAL_LOGIC、FLOWCHART、STATE_MACHINE、SEQUENCE_DIAGRAM、SYSTEM_DESIGN、DATABASE_SQL、NETWORK、OPERATING_SYSTEM、C_CPP、EMBEDDED、UNKNOWN 中选择。代码题必须给完整代码；计算题必须给已知、公式、代入、结果；需要图时只输出 DiagramSpec，不要 ASCII 图。"
      })) {
        if (controller.signal.aborted) return;
        if (event.type === "answer_start") { answerId = event.answerId; model = event.model; this.status = "SOLVING"; this.emitRealtime({ type: "answer_start", answerId, questionId, groupId: `written-test-group-${this.activeSession.id}`, relation: "PRIMARY", mode: event.mode, model }); }
        if (event.type === "answer_end") raw = event.text;
      }
      const parsed = parseWrittenTestResult(raw, "截图中的笔试题目");
      const plan = this.planner.plan(parsed.problem);
      const repaired = repairWrittenAnswer(parsed.problem, { ...parsed.answer, ...(plan.requiresDiagram && !parsed.answer.diagram ? { diagram: createFallbackDiagram(parsed.problem.questionType, parsed.problem.canonicalQuestion) } : {}) });
      const answerText = renderWrittenAnswer(repaired.answer);
      const relation = resolveWrittenProblemRelation(parsed.problem, this.activeProblem, this.activeQuestion?.screenshotIds.length ?? 0);
      const sequence = this.activeSession.questionCount + 1;
      const savedQuestion = this.activeQuestion && relation !== "NEW_QUESTION"
        ? (this.options.repository.attachScreenshotToQuestion(this.activeQuestion.id, storedScreenshot.id), this.options.repository.updateQuestionFrame(this.activeQuestion.id, { rawQuestionText: parsed.problem.rawText, normalizedQuestion: normalizeTechnicalTerms(parsed.problem.canonicalQuestion), questionType: parsed.problem.questionType, requirements: parsed.problem.requirements, confidence: parsed.problem.confidence }) ?? this.activeQuestion)
        : this.options.repository.createQuestion({ sessionId: this.activeSession.id, sequence, screenshotIds: [storedScreenshot.id], rawQuestionText: parsed.problem.rawText, normalizedQuestion: normalizeTechnicalTerms(parsed.problem.canonicalQuestion), questionType: parsed.problem.questionType, requirements: parsed.problem.requirements, confidence: parsed.problem.confidence });
      const completed = this.options.repository.completeQuestion(savedQuestion.id, repaired.answer, answerText, model, this.now() - startedAt, Math.min(parsed.problem.confidence, repaired.answer.confidence));
      this.activeSession = this.options.repository.getSession(this.activeSession.id) ?? this.activeSession;
      this.activeQuestion = completed ?? savedQuestion;
      this.activeProblem = parsed.problem;
      this.activeAnswer = repaired.answer;
      this.activeRelation = relation;
      this.status = "SUCCESS";
      this.emitRealtime({ type: "answer_delta", answerId, delta: answerText });
      this.emitRealtime({ type: "answer_end", answerId, text: answerText });
      this.emitEvent({ type: "document", question: this.activeQuestion, problem: parsed.problem });
      this.emitState();
    } catch (error) {
      if (!controller.signal.aborted) this.fail(`笔试题分析失败：${String(error)}`);
    } finally {
      if (this.answerController === controller) this.answerController = undefined;
    }
  }

  getSessionDetail(sessionId = this.sessionId): WrittenTestSessionDetail | undefined { return sessionId && this.options.repository ? this.options.repository.getSessionDetail(sessionId) : undefined; }
  private async answerLegacyScreenshot(dataUrl: string): Promise<void> {
    const question = { id: `written-test-question-${this.now()}`, text: "题型：technical。请识别截图中的题目并给出完整答案。" };
    const controller = new AbortController();
    this.answerController = controller;
    try {
      const providerContext = await this.contextProvider(question, this.activeProfileId ?? "");
      let answerId = question.id;
      let text = "";
      for await (const event of this.options.answerAgent.stream(question, this.answerModeValue, { ...providerContext, recentTranscript: providerContext.recentTranscript ?? [] }, controller.signal, { hasScreenshot: true, attachments: [{ mimeType: "image/png", dataUrl }], maxOutputTokens: 2_400, emitDeltas: true, instruction: "这是笔试模式的截图题。请以图片内容为准，按题型给出完整答案；代码题必须输出完整代码，代码块和解释都要完整结束。" })) {
        if (event.type === "answer_start") { answerId = event.answerId; this.emitRealtime({ type: "question_group_updated", groupId: `written-test-group-${question.id}`, title: "笔试截图题", primaryQuestion: "截图识别题（以图片为准）", items: [{ id: question.id, questionId: question.id, text: "截图识别题（以图片为准）", type: "NEW_TOPIC", answerable: true, state: "answering" }], slots: [{ id: `question-slot-${question.id}`, text: "截图识别题（以图片为准）", status: "covered" }], updatedAt: this.now() }); this.emitRealtime({ type: "answer_start", answerId, questionId: question.id, groupId: `written-test-group-${question.id}`, relation: "PRIMARY", mode: event.mode, model: event.model }); }
        if (event.type === "answer_delta") { text += event.delta; this.emitRealtime({ type: "answer_delta", answerId: event.answerId, delta: event.delta }); }
        if (event.type === "answer_end") { text = event.text; this.emitRealtime({ type: "answer_end", answerId: event.answerId, text }); }
      }
    } finally { if (this.answerController === controller) this.answerController = undefined; }
  }
  private fail(message: string): void { this.status = "ERROR"; this.lastError = message; this.emitEvent({ type: "diagnostic", message }); this.emitState(); }
  private cancelAnswer(): void { this.answerController?.abort(); this.answerController = undefined; }
  private emitState(): void { this.emitEvent({ type: "state", state: this.state }); }
  private emitRealtime(message: RealtimeServerMessage): void { this.emitEvent({ type: "realtime_message", message }); }
  private emitEvent(event: WrittenTestControllerEvent): void { this.emit("event", event); }
}
