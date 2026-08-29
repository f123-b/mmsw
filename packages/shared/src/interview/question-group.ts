import type { QuestionCandidate } from "../index";
import { TurnBuilder, type InterviewTurn, type QuestionRelationContext, type QuestionRelationType } from "./turn-builder";

export type QuestionItemState = "pending" | "queued" | "answering" | "answered" | "cancelled" | "ignored";

export interface QuestionRelation {
  id: string;
  sourceQuestionId: string;
  targetQuestionId: string;
  type: QuestionRelationType;
  confidence: number;
  reason: string;
  createdAt: number;
}

export interface QuestionItem {
  question: QuestionCandidate;
  ordinal: number;
  state: QuestionItemState;
  relationFromPrevious?: QuestionRelation;
}

export interface QuestionGroup {
  id: string;
  turnId: string;
  startedAt: number;
  endedAt?: number;
  items: QuestionItem[];
}

export interface AddQuestionInput {
  turn: InterviewTurn;
  question: QuestionCandidate;
  now?: number;
  relationType?: QuestionRelationType;
}

export interface AddQuestionResult {
  group: QuestionGroup;
  item: QuestionItem;
  relation?: QuestionRelation;
  isNewGroup: boolean;
}

function copyGroup(group: QuestionGroup): QuestionGroup {
  return {
    ...group,
    items: group.items.map((item) => ({
      ...item,
      question: { ...item.question },
      ...(item.relationFromPrevious ? { relationFromPrevious: { ...item.relationFromPrevious } } : {})
    }))
  };
}

/**
 * Maintains the conversation-level grouping that the temporal detector
 * intentionally does not own. A group can contain parallel sub-questions,
 * augmentations, and follow-ups; a new topic starts a new group while keeping
 * the relation edge for traceability.
 */
export class QuestionGroupManager {
  private readonly turnBuilder: TurnBuilder;
  private readonly groups = new Map<string, QuestionGroup>();
  private readonly questionToGroup = new Map<string, string>();
  private sequence = 0;

  constructor(turnBuilder = new TurnBuilder()) {
    this.turnBuilder = turnBuilder;
  }

  reset(): void {
    this.groups.clear();
    this.questionToGroup.clear();
    this.sequence = 0;
  }

  add(input: AddQuestionInput): AddQuestionResult {
    const now = input.now ?? input.question.detectedAt;
    const previous = this.latestQuestion();
    const previousTurn = previous ? this.turnFor(previous) : undefined;
    const relationResult = previous
      ? this.turnBuilder.classifyRelation({ previousQuestion: previous, currentQuestion: input.question, previousTurn, currentTurn: input.turn })
      : undefined;
    const relation = previous && relationResult
      ? this.makeRelation(previous, input.question, input.relationType ?? relationResult.type, input.relationType ? 0.99 : relationResult.confidence, input.relationType ? "detector-reported-revision" : relationResult.reason, now)
      : undefined;
    const sameGroup = Boolean(
      this.currentGroup()
      && relation
      && relation.type !== "NEW_TOPIC"
      && (input.turn.id === this.currentGroup()?.turnId || relation.type === "FOLLOW_UP" || relation.type === "SAME_QUESTION_AUGMENTATION")
    );
    const group = sameGroup
      ? this.groups.get(this.currentGroup()!.id)!
      : this.createGroup(input.turn, now);
    const item: QuestionItem = {
      question: {
        ...input.question,
        turnId: input.turn.id,
        groupId: group.id,
        ...(relation ? { relationType: relation.type } : {})
      },
      ordinal: group.items.length,
      state: "pending",
      ...(relation ? { relationFromPrevious: relation } : {})
    };
    group.items.push(item);
    this.questionToGroup.set(input.question.id, group.id);
    return { group: copyGroup(group), item: { ...item, question: { ...item.question }, ...(relation ? { relationFromPrevious: { ...relation } } : {}) }, ...(relation ? { relation } : {}), isNewGroup: !sameGroup };
  }

  getGroup(groupId: string): QuestionGroup | undefined {
    const group = this.groups.get(groupId);
    return group ? copyGroup(group) : undefined;
  }

  getGroupForQuestion(questionId: string): QuestionGroup | undefined {
    const groupId = this.questionToGroup.get(questionId);
    return groupId ? this.getGroup(groupId) : undefined;
  }

  list(): QuestionGroup[] {
    return [...this.groups.values()].map(copyGroup);
  }

  mark(questionId: string, state: QuestionItemState): void {
    const groupId = this.questionToGroup.get(questionId);
    const group = groupId ? this.groups.get(groupId) : undefined;
    const item = group?.items.find((candidate) => candidate.question.id === questionId);
    if (item) item.state = state;
  }

  private createGroup(turn: InterviewTurn, startedAt: number): QuestionGroup {
    const group: QuestionGroup = { id: `question-group-${++this.sequence}`, turnId: turn.id, startedAt, items: [] };
    this.groups.set(group.id, group);
    return group;
  }

  private currentGroup(): QuestionGroup | undefined {
    return [...this.groups.values()].at(-1);
  }

  private latestQuestion(): QuestionCandidate | undefined {
    return this.currentGroup()?.items.at(-1)?.question;
  }

  private turnFor(question: QuestionCandidate): InterviewTurn | undefined {
    const group = this.getGroupForQuestion(question.id);
    if (!group) return undefined;
    return {
      id: group.turnId,
      source: "remote",
      text: group.items.map((item) => item.question.text).join(" "),
      segmentIds: [],
      startMs: group.startedAt,
      endMs: group.startedAt,
      questionTexts: group.items.map((item) => item.question.text)
    };
  }

  private makeRelation(source: QuestionCandidate, target: QuestionCandidate, type: QuestionRelationType, confidence: number, reason: string, createdAt: number): QuestionRelation {
    return { id: `question-relation-${source.id}-${target.id}`, sourceQuestionId: source.id, targetQuestionId: target.id, type, confidence, reason, createdAt };
  }
}

export type { InterviewTurn, QuestionRelationContext, QuestionRelationType } from "./turn-builder";
