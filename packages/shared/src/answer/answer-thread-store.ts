import type { QuestionCandidate } from "../index";

export type OverlayAnswerRelation = "PRIMARY" | "AUGMENTATION" | "FOLLOW_UP" | "PARALLEL_SUBQUESTION";
export type OverlayAnswerStatus = "queued" | "generating" | "complete" | "failed" | "cancelled";

export interface OverlayAnswerItem {
  answerId: string;
  questionId: string;
  groupId: string;
  questionText: string;
  answerText: string;
  relation: OverlayAnswerRelation;
  status: OverlayAnswerStatus;
  visible: boolean;
  startedAt: number;
  finishedAt?: number;
}

export interface AnswerThread {
  groupId: string;
  questionId: string;
  title: string;
  answers: OverlayAnswerItem[];
  createdAt: number;
  updatedAt: number;
}

export interface AnswerThreadStartInput {
  answerId: string;
  questionId: string;
  groupId?: string;
  title?: string;
  questionText: string;
  relation?: OverlayAnswerRelation;
  startedAt?: number;
}

export interface AnswerThreadMetrics {
  answerOverwriteRate: number;
  visibleAnswerRetentionRate: number;
  sameGroupDuplicateAnswerRate: number;
  visibleAnswerCount: number;
  answerCount: number;
}

function copyAnswer(answer: OverlayAnswerItem): OverlayAnswerItem { return { ...answer }; }
function copyThread(thread: AnswerThread): AnswerThread { return { ...thread, answers: thread.answers.map(copyAnswer) }; }

function hasVisibleText(text: string): boolean {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length > 0;
}

export function answerRelationForQuestion(question: Pick<QuestionCandidate, "relationType" | "threadItemType">): OverlayAnswerRelation {
  const type = question.threadItemType;
  if (type === "FOLLOW_UP" || question.relationType === "FOLLOW_UP") return "FOLLOW_UP";
  if (type === "PARALLEL_SUBQUESTION" || question.relationType === "PARALLEL_SUBQUESTION") return "PARALLEL_SUBQUESTION";
  if (type === "ANSWER_CONSTRAINT" || type === "EXAMPLE" || type === "SAME_QUESTION_AUGMENTATION" || question.relationType === "ANSWER_CONSTRAINT" || question.relationType === "EXAMPLE" || question.relationType === "SAME_QUESTION_AUGMENTATION") return "AUGMENTATION";
  return "PRIMARY";
}

/**
 * Incremental store for the realtime overlay. It deliberately keeps all
 * visible cards; compatibility fields such as answerText may still point to
 * the newest card, but never own the retention policy.
 */
export class AnswerThreadStore {
  private readonly threads = new Map<string, AnswerThread>();
  private readonly answerToThread = new Map<string, string>();
  private overwrittenAnswerCount = 0;

  reset(): void {
    this.threads.clear();
    this.answerToThread.clear();
    this.overwrittenAnswerCount = 0;
  }

  start(input: AnswerThreadStartInput): OverlayAnswerItem {
    const now = input.startedAt ?? Date.now();
    const groupId = input.groupId ?? `question-group-${input.questionId}`;
    let thread = this.threads.get(groupId);
    if (!thread) {
      thread = { groupId, questionId: input.questionId, title: input.title ?? input.questionText, answers: [], createdAt: now, updatedAt: now };
      this.threads.set(groupId, thread);
    }
    const existing = thread.answers.find((answer) => answer.answerId === input.answerId);
    if (existing) return copyAnswer(existing);
    const answer: OverlayAnswerItem = {
      answerId: input.answerId,
      questionId: input.questionId,
      groupId,
      questionText: input.questionText,
      answerText: "",
      relation: input.relation ?? "PRIMARY",
      status: "generating",
      visible: false,
      startedAt: now
    };
    thread.answers.push(answer);
    thread.updatedAt = now;
    this.answerToThread.set(input.answerId, groupId);
    return copyAnswer(answer);
  }

  delta(answerId: string, delta: string): OverlayAnswerItem | undefined {
    const answer = this.findAnswer(answerId);
    if (!answer) return undefined;
    answer.answerText += delta;
    answer.status = "generating";
    answer.visible ||= hasVisibleText(answer.answerText);
    this.touch(answer.groupId);
    return copyAnswer(answer);
  }

  complete(answerId: string, text: string, finishedAt = Date.now()): OverlayAnswerItem | undefined {
    const answer = this.findAnswer(answerId);
    if (!answer) return undefined;
    answer.answerText = text || answer.answerText;
    answer.status = "complete";
    answer.visible ||= hasVisibleText(answer.answerText);
    answer.finishedAt = finishedAt;
    this.touch(answer.groupId, finishedAt);
    return copyAnswer(answer);
  }

  fail(answerId: string, finishedAt = Date.now()): OverlayAnswerItem | undefined {
    const answer = this.findAnswer(answerId);
    if (!answer) return undefined;
    answer.status = "failed";
    answer.finishedAt = finishedAt;
    this.touch(answer.groupId, finishedAt);
    return copyAnswer(answer);
  }

  cancel(answerId: string, finishedAt = Date.now()): OverlayAnswerItem | undefined {
    const answer = this.findAnswer(answerId);
    if (!answer) return undefined;
    answer.status = "cancelled";
    answer.finishedAt = finishedAt;
    // A cancelled visible answer remains visible by invariant.
    this.touch(answer.groupId, finishedAt);
    return copyAnswer(answer);
  }

  list(): AnswerThread[] {
    return [...this.threads.values()].map(copyThread).sort((left, right) => left.createdAt - right.createdAt);
  }

  get(groupId: string): AnswerThread | undefined {
    const thread = this.threads.get(groupId);
    return thread ? copyThread(thread) : undefined;
  }

  metrics(): AnswerThreadMetrics {
    const answers = this.list().flatMap((thread) => thread.answers);
    const visible = answers.filter((answer) => answer.visible);
    const duplicateCount = this.list().reduce((sum, thread) => sum + Math.max(0, thread.answers.length - new Set(thread.answers.map((answer) => answer.questionId)).size), 0);
    return {
      answerOverwriteRate: answers.length ? this.overwrittenAnswerCount / answers.length : 0,
      visibleAnswerRetentionRate: visible.length ? visible.filter((answer) => this.findAnswer(answer.answerId) !== undefined).length / visible.length : 1,
      sameGroupDuplicateAnswerRate: answers.length ? duplicateCount / answers.length : 0,
      visibleAnswerCount: visible.length,
      answerCount: answers.length
    };
  }

  private findAnswer(answerId: string): OverlayAnswerItem | undefined {
    const groupId = this.answerToThread.get(answerId);
    const thread = groupId ? this.threads.get(groupId) : undefined;
    return thread?.answers.find((answer) => answer.answerId === answerId);
  }

  private touch(groupId: string, at = Date.now()): void {
    const thread = this.threads.get(groupId);
    if (thread) thread.updatedAt = at;
  }
}
