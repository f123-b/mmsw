import type { TranscriptSource } from "@interview-copilot/protocol";
import type { QuestionCandidate } from "../index";

export type QuestionRelationType =
  | "ASR_REVISION"
  | "SAME_QUESTION_AUGMENTATION"
  | "PARALLEL_SUBQUESTION"
  | "FOLLOW_UP"
  | "NEW_TOPIC";

export interface InterviewTurnInput {
  id?: string;
  source?: TranscriptSource;
  text: string;
  segmentIds?: readonly string[];
  startMs?: number;
  endMs?: number;
  finalizedAt?: number;
  receivedAt?: number;
}

export interface InterviewTurn {
  id: string;
  source: TranscriptSource;
  text: string;
  segmentIds: string[];
  startMs: number;
  endMs: number;
  finalizedAt?: number;
  questionTexts: string[];
}

export interface QuestionRelationContext {
  previousQuestion?: Pick<QuestionCandidate, "id" | "text" | "speechAct" | "detectionType" | "category" | "utteranceId" | "segmentIds" | "turnId">;
  currentQuestion?: Pick<QuestionCandidate, "id" | "text" | "speechAct" | "detectionType" | "category" | "utteranceId" | "segmentIds" | "turnId">;
  previousTurn?: Pick<InterviewTurn, "id" | "text" | "startMs" | "endMs">;
  currentTurn?: Pick<InterviewTurn, "id" | "text" | "startMs" | "endMs">;
}

const QUESTION_BOUNDARY = /(?<=[？?！!；;])\s*/;
const FOLLOW_UP_PREFIX = /^(?:那|那么|然后|还有|这个|它|这里|其中|接下来|再|具体|如果|假如|对于这个|针对这个)/;
const AUGMENTATION_PREFIX = /^(?:以及|并且|而且|尤其|包括|比如|例如|最后|同时|另外|补充|具体来说|分别)/;
const NEW_TOPIC_PREFIX = /^(?:换个话题|另一个问题|下一个问题|接下来问|再问一个|说到另一个|关于另一个)/;

function compact(text: string): string {
  return text.toLowerCase().replace(/[\s，。！？、,.!?；;：:"“”‘’（）()\[\]{}]+/g, "");
}

function tokenSet(text: string): Set<string> {
  return new Set(compact(text).match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []);
}

function similarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size && !b.size) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  const containment = intersection / Math.max(1, Math.min(a.size, b.size));
  return Math.max(intersection / Math.max(1, union), containment * 0.96);
}

function isFollowUp(question?: Pick<QuestionCandidate, "text" | "speechAct" | "detectionType" | "category">): boolean {
  if (!question) return false;
  return question.speechAct === "FOLLOW_UP"
    || question.detectionType === "follow_up"
    || question.category === "followup"
    || FOLLOW_UP_PREFIX.test(question.text.trim());
}

function isAugmentation(text: string): boolean {
  return AUGMENTATION_PREFIX.test(text.trim())
    || /(?:还包括|补充一点|再补充|最后说一下)/.test(text);
}

/**
 * Creates one stable runtime turn from final ASR material. The existing
 * TranscriptAggregator remains responsible for deciding when material is
 * final; this builder only gives the turn a durable identity and exposes
 * explicit sub-question boundaries for grouping and tests.
 */
export class TurnBuilder {
  build(input: InterviewTurnInput): InterviewTurn {
    const source = input.source ?? "remote";
    const text = input.text.trim();
    const startMs = input.startMs ?? input.receivedAt ?? 0;
    const endMs = input.endMs ?? startMs;
    return {
      id: input.id ?? `turn-${source}-${startMs}-${endMs}`,
      source,
      text,
      segmentIds: [...(input.segmentIds ?? [])],
      startMs,
      endMs,
      ...(input.finalizedAt !== undefined ? { finalizedAt: input.finalizedAt } : {}),
      questionTexts: this.splitQuestionTexts(text)
    };
  }

  splitQuestionTexts(text: string): string[] {
    return text
      .split(QUESTION_BOUNDARY)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  classifyRelation(context: QuestionRelationContext): { type: QuestionRelationType; confidence: number; reason: string } {
    const previous = context.previousQuestion;
    const current = context.currentQuestion;
    if (!previous || !current) return { type: "NEW_TOPIC", confidence: 0.45, reason: "no-previous-question" };

    const sameUtterance = Boolean(
      (previous.utteranceId && current.utteranceId && previous.utteranceId === current.utteranceId)
      || (previous.turnId && current.turnId && previous.turnId === current.turnId)
    );
    const sameSegments = Boolean(
      previous.segmentIds?.length
      && current.segmentIds?.length
      && previous.segmentIds.some((segmentId) => current.segmentIds?.includes(segmentId))
    );
    const similar = similarity(previous.text, current.text);
    if (sameUtterance && (sameSegments || similar >= 0.72 || compact(current.text).length <= compact(previous.text).length)) {
      return { type: "ASR_REVISION", confidence: Math.max(0.86, similar), reason: "same-utterance-revision" };
    }
    if (NEW_TOPIC_PREFIX.test(current.text.trim())) {
      return { type: "NEW_TOPIC", confidence: 0.98, reason: "explicit-topic-transition" };
    }
    if (isFollowUp(current)) {
      return { type: "FOLLOW_UP", confidence: 0.94, reason: "follow-up-speech-act" };
    }
    if (similar >= 0.88 && (context.currentTurn?.startMs ?? 0) - (context.previousTurn?.endMs ?? 0) <= 1_200) {
      return { type: "ASR_REVISION", confidence: similar, reason: "near-identical-final-revision" };
    }
    if (isAugmentation(current.text)) {
      return { type: "SAME_QUESTION_AUGMENTATION", confidence: 0.86, reason: "same-turn-continuation" };
    }
    if (sameUtterance || context.currentTurn?.id === context.previousTurn?.id) {
      return { type: "PARALLEL_SUBQUESTION", confidence: 0.9, reason: "same-turn-question-boundary" };
    }
    return { type: "NEW_TOPIC", confidence: 0.68, reason: "independent-question" };
  }
}

export function classifyQuestionRelation(context: QuestionRelationContext): { type: QuestionRelationType; confidence: number; reason: string } {
  return new TurnBuilder().classifyRelation(context);
}
