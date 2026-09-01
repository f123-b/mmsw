import type { QuestionRelationType } from "./turn-builder";

export type AnswerCancellationReason = "user" | "asr_revision" | "provider_timeout" | "session_stop";
export type AnswerSchedulerAction = "start" | "queue" | "merge" | "ignore";
export type AnswerSchedulerState = "ASSEMBLING" | "READY" | "CONTEXT_BUILDING" | "REQUEST_SENT" | "STREAMING" | "COMPLETED";

export interface AnswerMergePlan {
  question: string;
  constraints: string[];
  examples: string[];
  subQuestions: string[];
}

export interface AnswerSchedulerQuestion {
  id: string;
  text: string;
  groupId?: string;
  relationType?: QuestionRelationType;
}

export interface AnswerSchedulerActive extends AnswerSchedulerQuestion {
  startedAt: number;
  state: AnswerSchedulerState;
  visibleText: string;
  hasVisibleOutput: boolean;
  /** True once the provider request has left the process. */
  requestSent: boolean;
  plan: AnswerMergePlan;
  canMergeBeforeRequest: boolean;
  canSupplementAfterRequest: boolean;
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
  /** Explicit marker for telemetry/UI; this is a plan patch, not a second answer. */
  planPatch?: "PATCH_ACTIVE_PLAN";
}

export interface AnswerSchedulerMetrics {
  answerPlanMergeRate: number;
  requestCount: number;
  mergeCount: number;
  queueCount: number;
}

const EFFECTIVE_OUTPUT_MIN_LENGTH = 8;

function cloneQuestion(question: AnswerSchedulerQuestion): AnswerSchedulerQuestion {
  return { ...question };
}

function clonePlan(plan: AnswerMergePlan): AnswerMergePlan {
  return { ...plan, constraints: [...plan.constraints], examples: [...plan.examples], subQuestions: [...plan.subQuestions] };
}

function hasEffectiveOutput(text: string): boolean {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").length >= EFFECTIVE_OUTPUT_MIN_LENGTH;
}

function initialPlan(question: AnswerSchedulerQuestion): AnswerMergePlan {
  return { question: question.text, constraints: [], examples: [], subQuestions: [] };
}

function questionKey(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

function mergeableRelation(relationType?: QuestionRelationType): boolean {
  return relationType === "SAME_QUESTION_AUGMENTATION"
    || relationType === "ANSWER_CONSTRAINT"
    || relationType === "EXAMPLE"
    || relationType === "PARALLEL_SUBQUESTION";
}

function mergePlan(plan: AnswerMergePlan, question: AnswerSchedulerQuestion): AnswerMergePlan {
  const text = question.text.trim();
  if (!text) return clonePlan(plan);
  if (/^(?:比如|例如|举例|像是|像)\s*/.test(text)) return { ...clonePlan(plan), examples: [...plan.examples, text] };
  if (question.relationType === "ANSWER_CONSTRAINT") return { ...clonePlan(plan), constraints: [...plan.constraints, text] };
  if (question.relationType === "EXAMPLE") return { ...clonePlan(plan), examples: [...plan.examples, text] };
  if (question.relationType === "PARALLEL_SUBQUESTION") return { ...clonePlan(plan), subQuestions: [...plan.subQuestions, text] };
  return { ...clonePlan(plan), constraints: [...plan.constraints, text] };
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
  private requestCount = 0;
  private mergeCount = 0;
  private queueCount = 0;
  private lastState: AnswerSchedulerState = "COMPLETED";

  get state(): AnswerSchedulerState { return this.activeAnswer?.state ?? this.lastState; }
  get canMergeBeforeRequest(): boolean { return Boolean(this.activeAnswer && !this.activeAnswer.requestSent && !this.activeAnswer.hasVisibleOutput); }
  get canSupplementAfterRequest(): boolean { return Boolean(this.activeAnswer?.requestSent); }

  get active(): AnswerSchedulerActive | undefined {
    if (!this.activeAnswer) return undefined;
    return {
      ...this.activeAnswer,
      plan: clonePlan(this.activeAnswer.plan),
      canMergeBeforeRequest: this.canMergeBeforeRequest,
      canSupplementAfterRequest: this.canSupplementAfterRequest
    };
  }

  get queue(): AnswerSchedulerQuestion[] {
    return this.queuedAnswers.map(cloneQuestion);
  }

  get queueDepth(): number { return this.queuedAnswers.length; }

  reset(): void {
    this.activeAnswer = undefined;
    this.lastState = "COMPLETED";
    this.queuedAnswers.length = 0;
    this.requestCount = 0;
    this.mergeCount = 0;
    this.queueCount = 0;
  }

  metrics(): AnswerSchedulerMetrics {
    return {
      answerPlanMergeRate: this.requestCount ? this.mergeCount / this.requestCount : 0,
      requestCount: this.requestCount,
      mergeCount: this.mergeCount,
      queueCount: this.queueCount
    };
  }

  request(question: AnswerSchedulerQuestion, options: AnswerSchedulerRequestOptions = {}): AnswerSchedulerDecision {
    const enriched: AnswerSchedulerQuestion = {
      ...question,
      ...(options.groupId ? { groupId: options.groupId } : {}),
      ...(options.relationType ? { relationType: options.relationType } : {})
    };
    this.requestCount += 1;
    if (this.activeAnswer?.id === enriched.id || this.queuedAnswers.some((candidate) => candidate.id === enriched.id)) {
      return { action: "ignore", question: cloneQuestion(enriched), reason: "duplicate-question", queueDepth: this.queueDepth, ...(this.active ? { active: this.active } : {}) };
    }
    const enrichedKey = questionKey(enriched.text);
    if (enriched.groupId && enrichedKey && ((this.activeAnswer?.groupId === enriched.groupId && questionKey(this.activeAnswer.text) === enrichedKey)
      || this.queuedAnswers.some((candidate) => candidate.groupId === enriched.groupId && questionKey(candidate.text) === enrichedKey))) {
      return { action: "ignore", question: cloneQuestion(enriched), reason: "duplicate-question-same-group", queueDepth: this.queueDepth, ...(this.active ? { active: this.active } : {}) };
    }
    if (!this.activeAnswer) {
      this.activeAnswer = {
        ...enriched,
        startedAt: options.now ?? Date.now(),
        state: "ASSEMBLING",
        visibleText: "",
        hasVisibleOutput: false,
        requestSent: false,
        plan: initialPlan(enriched),
        canMergeBeforeRequest: true,
        canSupplementAfterRequest: false
      };
      this.lastState = "ASSEMBLING";
      return { action: "start", question: cloneQuestion(enriched), reason: "scheduler-idle", queueDepth: 0, active: this.active };
    }
    if (mergeableRelation(enriched.relationType) && this.canMergeBeforeRequest && enriched.groupId === this.activeAnswer.groupId) {
      this.activeAnswer.plan = mergePlan(this.activeAnswer.plan, enriched);
      this.mergeCount += 1;
      return { action: "merge", question: cloneQuestion(enriched), reason: "augmentation-merged-before-request", queueDepth: this.queueDepth, active: this.active, planPatch: "PATCH_ACTIVE_PLAN" };
    }
    const action: AnswerSchedulerAction = "queue";
    this.queuedAnswers.push(enriched);
    this.queueCount += 1;
    return { action, question: cloneQuestion(enriched), reason: "active-answer-protected", queueDepth: this.queueDepth, active: this.active };
  }

  observeOutput(delta: string): void {
    if (!this.activeAnswer) return;
    this.activeAnswer.visibleText += delta;
    this.activeAnswer.hasVisibleOutput = hasEffectiveOutput(this.activeAnswer.visibleText);
    if (this.activeAnswer.hasVisibleOutput) this.activeAnswer.state = "STREAMING";
  }

  markVisibleOutput(text = ""): void {
    if (!this.activeAnswer) return;
    this.activeAnswer.visibleText += text;
    this.activeAnswer.hasVisibleOutput = true;
    this.activeAnswer.state = "STREAMING";
  }

  markContextBuilding(questionId: string): boolean {
    if (this.activeAnswer?.id !== questionId) return false;
    this.activeAnswer.state = "CONTEXT_BUILDING";
    return true;
  }

  markReady(questionId: string): boolean {
    if (this.activeAnswer?.id !== questionId) return false;
    this.activeAnswer.state = "READY";
    return true;
  }

  markRequestSent(questionId: string): boolean {
    if (this.activeAnswer?.id !== questionId) return false;
    this.activeAnswer.requestSent = true;
    this.activeAnswer.state = "REQUEST_SENT";
    return true;
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
    this.lastState = "COMPLETED";
    return { cancelled: true, next: undefined, reason };
  }

  complete(questionId: string, options: { activateNext?: boolean } = {}): AnswerSchedulerQuestion | undefined {
    if (this.activeAnswer?.id !== questionId) return undefined;
    this.activeAnswer = undefined;
    const next = this.queuedAnswers.shift();
    if (next && options.activateNext !== false) {
      this.activeAnswer = { ...next, startedAt: Date.now(), state: "ASSEMBLING", visibleText: "", hasVisibleOutput: false, requestSent: false, plan: initialPlan(next), canMergeBeforeRequest: true, canSupplementAfterRequest: false };
      this.lastState = "ASSEMBLING";
    }
    return next ? cloneQuestion(next) : undefined;
  }
}
