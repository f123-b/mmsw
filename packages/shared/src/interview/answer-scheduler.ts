import type { QuestionRelationType } from "./turn-builder";

export type AnswerCancellationReason = "user" | "asr_revision" | "provider_timeout" | "session_stop";
export type AnswerSchedulerAction = "start" | "queue" | "merge" | "ignore";

export interface AnswerSchedulerQuestion {
  id: string;
  text: string;
  groupId?: string;
  relationType?: QuestionRelationType;
}

export interface AnswerSchedulerActive extends AnswerSchedulerQuestion {
  startedAt: number;
  visibleText: string;
  hasVisibleOutput: boolean;
}

export interface AnswerSchedulerRequestOptions {
  now?: number;
  relationType?: QuestionRelationType;
  groupId?: string;
}

export interface AnswerSchedulerDecision {
  action: AnswerSchedulerAction;
  question: AnswerSchedulerQuestion;
  reason: string;
  queueDepth: number;
  active?: AnswerSchedulerActive;
}

const EFFECTIVE_OUTPUT_MIN_LENGTH = 8;

function cloneQuestion(question: AnswerSchedulerQuestion): AnswerSchedulerQuestion {
  return { ...question };
}

function hasEffectiveOutput(text: string): boolean {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length >= EFFECTIVE_OUTPUT_MIN_LENGTH;
}

/**
 * Serializes answer plans for one interview session. New questions never
 * cancel an active answer. The only exception is an explicit ASR revision
 * before a valid answer token has become visible; all other cancellation
 * reasons are explicit lifecycle/provider boundaries.
 */
export class AnswerScheduler {
  private activeAnswer: AnswerSchedulerActive | undefined;
  private readonly queuedAnswers: AnswerSchedulerQuestion[] = [];

  get active(): AnswerSchedulerActive | undefined {
    return this.activeAnswer ? { ...this.activeAnswer } : undefined;
  }

  get queue(): AnswerSchedulerQuestion[] {
    return this.queuedAnswers.map(cloneQuestion);
  }

  get queueDepth(): number { return this.queuedAnswers.length; }

  reset(): void {
    this.activeAnswer = undefined;
    this.queuedAnswers.length = 0;
  }

  request(question: AnswerSchedulerQuestion, options: AnswerSchedulerRequestOptions = {}): AnswerSchedulerDecision {
    const enriched: AnswerSchedulerQuestion = {
      ...question,
      ...(options.groupId ? { groupId: options.groupId } : {}),
      ...(options.relationType ? { relationType: options.relationType } : {})
    };
    if (this.activeAnswer?.id === enriched.id || this.queuedAnswers.some((candidate) => candidate.id === enriched.id)) {
      return { action: "ignore", question: cloneQuestion(enriched), reason: "duplicate-question", queueDepth: this.queueDepth, ...(this.active ? { active: this.active } : {}) };
    }
    if (!this.activeAnswer) {
      this.activeAnswer = {
        ...enriched,
        startedAt: options.now ?? Date.now(),
        visibleText: "",
        hasVisibleOutput: false
      };
      return { action: "start", question: cloneQuestion(enriched), reason: "scheduler-idle", queueDepth: 0, active: this.active };
    }
    // An augmentation can be represented by the same answer plan in a caller
    // that supports plan mutation. This scheduler intentionally queues it as
    // well so no sub-question is lost when the provider is already running.
    const action: AnswerSchedulerAction = enriched.relationType === "SAME_QUESTION_AUGMENTATION" && !this.activeAnswer.hasVisibleOutput ? "merge" : "queue";
    this.queuedAnswers.push(enriched);
    return { action, question: cloneQuestion(enriched), reason: action === "merge" ? "augmentation-kept-with-active-plan" : "active-answer-protected", queueDepth: this.queueDepth, active: this.active };
  }

  observeOutput(delta: string): void {
    if (!this.activeAnswer) return;
    this.activeAnswer.visibleText += delta;
    this.activeAnswer.hasVisibleOutput = hasEffectiveOutput(this.activeAnswer.visibleText);
  }

  markVisibleOutput(text = ""): void {
    if (!this.activeAnswer) return;
    this.activeAnswer.visibleText += text;
    this.activeAnswer.hasVisibleOutput = true;
  }

  canCancel(reason: AnswerCancellationReason): boolean {
    if (!this.activeAnswer) return false;
    if (reason === "asr_revision") return !this.activeAnswer.hasVisibleOutput;
    return true;
  }

  cancel(reason: AnswerCancellationReason): { cancelled: boolean; next?: AnswerSchedulerQuestion; reason: string } {
    if (!this.activeAnswer || !this.canCancel(reason)) {
      return { cancelled: false, reason: reason === "asr_revision" ? "effective-output-protected" : "no-active-answer" };
    }
    this.activeAnswer = undefined;
    return { cancelled: true, next: undefined, reason };
  }

  complete(questionId: string, options: { activateNext?: boolean } = {}): AnswerSchedulerQuestion | undefined {
    if (this.activeAnswer?.id !== questionId) return undefined;
    this.activeAnswer = undefined;
    const next = this.queuedAnswers.shift();
    if (next && options.activateNext !== false) {
      this.activeAnswer = { ...next, startedAt: Date.now(), visibleText: "", hasVisibleOutput: false };
    }
    return next ? cloneQuestion(next) : undefined;
  }
}
