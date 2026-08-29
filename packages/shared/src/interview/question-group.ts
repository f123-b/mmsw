import type { QuestionCandidate } from "../index";
import { TurnBuilder, type InterviewTurn, type QuestionRelationContext, type QuestionRelationType } from "./turn-builder";

export type QuestionItemState = "pending" | "queued" | "answering" | "answered" | "cancelled" | "ignored";

export type QuestionThreadItemType =
  | "TOPIC_FRAGMENT"
  | "QUESTION_NUCLEUS"
  | "ANSWER_CONSTRAINT"
  | "EXAMPLE"
  | "SAME_QUESTION_AUGMENTATION"
  | "PARALLEL_SUBQUESTION"
  | "FOLLOW_UP"
  | "NEW_TOPIC"
  | "ASR_REVISION";

export type QuestionSlotStatus = "pending" | "covered" | "answered" | "merged" | "skipped";

export interface QuestionRelation {
  id: string;
  sourceQuestionId: string;
  targetQuestionId: string;
  type: QuestionRelationType;
  confidence: number;
  reason: string;
  createdAt: number;
}

export interface QuestionSlot {
  id: string;
  text: string;
  status: QuestionSlotStatus;
  questionIds: string[];
  createdAt: number;
  coveredAt?: number;
}

export interface QuestionSlotCoverage {
  total: number;
  covered: number;
  answered: number;
  pending: number;
  rate: number;
}

export interface QuestionItem {
  question: QuestionCandidate;
  ordinal: number;
  state: QuestionItemState;
  itemType: QuestionThreadItemType;
  answerable: boolean;
  displayText?: string;
  slotIds: string[];
  relationFromPrevious?: QuestionRelation;
}

export interface QuestionGroup {
  id: string;
  turnId: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status: "collecting" | "answering" | "active" | "closed";
  title: string;
  topic?: string;
  primaryQuestionId?: string;
  primaryQuestion?: string;
  constraints: string[];
  examples: string[];
  subQuestions: string[];
  items: QuestionItem[];
  slots: QuestionSlot[];
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

export interface OverlayQuestionGroupView {
  id: string;
  title: string;
  primaryQuestion: string;
  followUps: Array<{ id: string; text: string; type: "FOLLOW_UP" | "PARALLEL_SUBQUESTION"; status: QuestionItemState }>;
  status: QuestionGroup["status"];
  updatedAt: number;
}

function copySlot(slot: QuestionSlot): QuestionSlot {
  return { ...slot, questionIds: [...slot.questionIds] };
}

function copyItem(item: QuestionItem): QuestionItem {
  return {
    ...item,
    question: { ...item.question, ...(item.question.questionSlotIds ? { questionSlotIds: [...item.question.questionSlotIds] } : {}) },
    slotIds: [...item.slotIds],
    ...(item.relationFromPrevious ? { relationFromPrevious: { ...item.relationFromPrevious } } : {})
  };
}

function copyGroup(group: QuestionGroup): QuestionGroup {
  return {
    ...group,
    constraints: [...group.constraints],
    examples: [...group.examples],
    subQuestions: [...group.subQuestions],
    items: group.items.map(copyItem),
    slots: group.slots.map(copySlot)
  };
}

function sentenceEnd(text: string): string {
  return text.trim().replace(/[。.!！?？；;]+$/g, "");
}

function isExplicitNewTopic(question: QuestionCandidate): boolean {
  return question.speechAct === "TOPIC_ANNOUNCEMENT"
    || /^(?:换个话题|另一个问题|下一个问题|接下来问|再问一个|说到另一个|关于另一个)/.test(question.text.trim());
}

function isTopicFragment(question: QuestionCandidate): boolean {
  const text = question.text.trim();
  if (isExplicitNewTopic(question) || /[？?!！]/.test(text)) return false;
  if (question.speechAct === "TOPIC_ANNOUNCEMENT" || question.speechAct === "TOPIC_ANCHOR") return true;
  return /(?:语言里|语言中|项目里|项目中|简历里|关于|围绕)/.test(text)
    || /^(?:如果|当|要是|假设)/.test(text)
    || /^(?:C\+\+?|Java|Python|Linux|RTOS|CAN|UART|SPI|I2C|嵌入式)\s*(?:里|中)?[，,:：]/i.test(text);
}

function isInstructionModifier(question: QuestionCandidate): boolean {
  const text = question.text.trim();
  return question.speechAct === "INSTRUCTION_MODIFIER"
    || /^(?:从|围绕|包括|展开|具体一点|具体来说|请(?:你)?(?:重点)?(?:讲|说明|展开)|说说你的策略)/.test(text)
    || /(?:空间大小|常见风险|分配方式|释放方式|生命周期|访问速度).*(?:说|讲|考虑|角度)/.test(text);
}

function isExample(question: QuestionCandidate): boolean {
  return /^(?:比如|例如|举例|像是|像)\s*/.test(question.text.trim());
}

function isQuestionNucleus(question: QuestionCandidate, previous?: QuestionItem): boolean {
  const text = question.text.trim();
  if (previous?.itemType !== "TOPIC_FRAGMENT") return false;
  return /(?:有什么区别|区别是什么|怎么|如何|为什么|有哪些|是什么|吗[？?]|呢[？?])|^(?:define|const)\b/i.test(text);
}

function itemTypeFor(question: QuestionCandidate, previous?: QuestionItem, detectedRelation?: QuestionRelationType): QuestionThreadItemType {
  if (isExplicitNewTopic(question)) return "NEW_TOPIC";
  if (question.relationType === "ASR_REVISION" || detectedRelation === "ASR_REVISION") return "ASR_REVISION";
  if (isInstructionModifier(question)) return "ANSWER_CONSTRAINT";
  if (isExample(question)) return "EXAMPLE";
  if (isQuestionNucleus(question, previous)) return "QUESTION_NUCLEUS";
  if (isTopicFragment(question)) return "TOPIC_FRAGMENT";
  if (question.speechAct === "FOLLOW_UP" || question.detectionType === "follow_up" || question.category === "followup" || /^(?:那|那么|然后|还有|这个|它|这里|其中|接下来|再|如果|假如|具体)\b/.test(question.text.trim())) return "FOLLOW_UP";
  return "PARALLEL_SUBQUESTION";
}

function relationForType(type: QuestionThreadItemType, fallback?: QuestionRelationType): QuestionRelationType | undefined {
  if (type === "ANSWER_CONSTRAINT") return "ANSWER_CONSTRAINT";
  if (type === "EXAMPLE") return "EXAMPLE";
  if (type === "SAME_QUESTION_AUGMENTATION" || type === "QUESTION_NUCLEUS") return "SAME_QUESTION_AUGMENTATION";
  if (type === "FOLLOW_UP") return "FOLLOW_UP";
  if (type === "PARALLEL_SUBQUESTION") return fallback ?? "PARALLEL_SUBQUESTION";
  if (type === "ASR_REVISION") return "ASR_REVISION";
  if (type === "NEW_TOPIC") return "NEW_TOPIC";
  return fallback;
}

function isAnswerable(type: QuestionThreadItemType, question: QuestionCandidate): boolean {
  if (type === "TOPIC_FRAGMENT" || type === "ANSWER_CONSTRAINT" || type === "EXAMPLE" || type === "ASR_REVISION") return false;
  if (type === "NEW_TOPIC" && !/[？?]/.test(question.text) && !/(?:什么|为什么|为何|怎么|如何|哪些|哪个|是否|有没有|介绍一下|说说|讲一下)/.test(question.text)) return false;
  return true;
}

function combinedPrimary(topic: string | undefined, text: string): string {
  if (!topic) return text.trim();
  const left = sentenceEnd(topic);
  const right = text.trim();
  const separator = /[\u4e00-\u9fff]$/.test(left) && /^[\u4e00-\u9fff]/.test(right) ? "" : " ";
  return `${left}${separator}${right}`.replace(/\s+/g, " ");
}

/**
 * Conversation-level Question Group state. The detector may still emit a
 * candidate for every final ASR fragment; this layer assigns a semantic item
 * type, joins topic+nucleus fragments, and tracks explicit answer slots.
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
    const current = this.currentGroup();
    const previousItem = current?.items.at(-1);
    const previous = previousItem?.question;
    const previousTurn = previous ? this.turnFor(previous) : undefined;
    const relationResult = previous
      ? this.turnBuilder.classifyRelation({ previousQuestion: previous, currentQuestion: input.question, previousTurn, currentTurn: input.turn })
      : undefined;
    const type = itemTypeFor(input.question, previousItem, input.relationType ?? relationResult?.type);
    const resolvedRelationType = type === "QUESTION_NUCLEUS" ? "SAME_QUESTION_AUGMENTATION" : relationForType(type, input.relationType ?? relationResult?.type);
    const forcedTopicJoin = Boolean(current && previousItem?.itemType === "TOPIC_FRAGMENT" && type === "QUESTION_NUCLEUS");
    const relation = current && previous && resolvedRelationType && !forcedTopicJoin
      ? this.makeRelation(previous, input.question, resolvedRelationType, input.relationType ? 0.99 : relationResult?.confidence ?? 0.8, input.relationType ? "detector-reported-relation" : relationResult?.reason ?? "semantic-thread-relation", now)
      : current && previous && forcedTopicJoin
        ? this.makeRelation(previous, input.question, "SAME_QUESTION_AUGMENTATION", 0.95, "topic-fragment-plus-question-nucleus", now)
        : undefined;
    const sameGroup = Boolean(current && type !== "NEW_TOPIC" && type !== "TOPIC_FRAGMENT" && (forcedTopicJoin || (relation && relation.type !== "NEW_TOPIC") || input.turn.id === current.turnId));
    const group = sameGroup ? current! : this.createGroup(input.turn, now, type === "TOPIC_FRAGMENT" ? sentenceEnd(input.question.text) : input.question.text);
    if (type === "TOPIC_FRAGMENT" && !group.topic) group.topic = sentenceEnd(input.question.text);

    const answerable = isAnswerable(type, input.question);
    const primaryText = type === "QUESTION_NUCLEUS" ? combinedPrimary(group.topic, input.question.text) : group.primaryQuestion;
    const shouldBecomePrimary = !group.primaryQuestion && answerable && type !== "QUESTION_NUCLEUS" && type !== "ANSWER_CONSTRAINT" && type !== "EXAMPLE";
    const nextPrimary = shouldBecomePrimary ? input.question.text.trim() : primaryText;
    if (nextPrimary) {
      group.primaryQuestion = nextPrimary;
      group.primaryQuestionId = type === "QUESTION_NUCLEUS" || shouldBecomePrimary ? input.question.id : group.primaryQuestionId;
    }
    if (type === "ANSWER_CONSTRAINT") group.constraints.push(input.question.text.trim());
    if (type === "EXAMPLE") group.examples.push(input.question.text.trim());
    if (type === "PARALLEL_SUBQUESTION") group.subQuestions.push(input.question.text.trim());
    const slotIds: string[] = [];
    if (answerable && type !== "TOPIC_FRAGMENT") {
      const slotText = type === "QUESTION_NUCLEUS" ? (group.primaryQuestion ?? input.question.text) : input.question.text.trim();
      const slot: QuestionSlot = { id: `question-slot-${input.question.id}`, text: slotText, status: "pending", questionIds: [input.question.id], createdAt: now };
      group.slots.push(slot);
      slotIds.push(slot.id);
    }
    const effectiveText = type === "QUESTION_NUCLEUS" ? (group.primaryQuestion ?? input.question.text) : input.question.text;
    const enrichedQuestion: QuestionCandidate = {
      ...input.question,
      text: effectiveText,
      ...(group.primaryQuestion ? { primaryQuestion: group.primaryQuestion } : {}),
      groupTitle: group.title,
      threadItemType: type,
      answerable,
      ...(slotIds.length ? { questionSlotIds: slotIds } : {}),
      ...(resolvedRelationType ? { relationType: resolvedRelationType } : {}),
      turnId: input.turn.id,
      groupId: group.id
    };
    const item: QuestionItem = {
      question: enrichedQuestion,
      ordinal: group.items.length,
      state: answerable ? "pending" : "ignored",
      itemType: type,
      answerable,
      ...(type !== "TOPIC_FRAGMENT" && type !== "ANSWER_CONSTRAINT" && type !== "EXAMPLE" ? { displayText: effectiveText } : {}),
      slotIds,
      ...(relation ? { relationFromPrevious: relation } : {})
    };
    group.items.push(item);
    group.updatedAt = now;
    if (answerable) group.status = "active";
    this.questionToGroup.set(input.question.id, group.id);
    return { group: copyGroup(group), item: copyItem(item), ...(relation ? { relation } : {}), isNewGroup: !sameGroup };
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

  views(): OverlayQuestionGroupView[] {
    return this.list().map((group) => ({
      id: group.id,
      title: group.title,
      primaryQuestion: group.primaryQuestion ?? group.title,
      followUps: group.items.filter((item) => item.answerable && (item.itemType === "FOLLOW_UP" || item.itemType === "PARALLEL_SUBQUESTION")).map((item) => ({ id: item.question.id, text: item.question.text, type: item.itemType as "FOLLOW_UP" | "PARALLEL_SUBQUESTION", status: item.state })),
      status: group.status,
      updatedAt: group.updatedAt
    }));
  }

  mark(questionId: string, state: QuestionItemState): void {
    const groupId = this.questionToGroup.get(questionId);
    const group = groupId ? this.groups.get(groupId) : undefined;
    const item = group?.items.find((candidate) => candidate.question.id === questionId);
    if (!item) return;
    item.state = state;
    const now = Date.now();
    item.slotIds.forEach((slotId) => {
      const slot = group?.slots.find((candidate) => candidate.id === slotId);
      if (!slot) return;
      if (state === "answered") { slot.status = "answered"; slot.coveredAt = now; }
      else if (state === "answering" || state === "queued") { slot.status = "covered"; slot.coveredAt ??= now; }
      else if (state === "cancelled") slot.status = "skipped";
    });
    if (group) { group.updatedAt = now; if (state === "answering") group.status = "answering"; }
  }

  slotCoverage(groupId?: string): QuestionSlotCoverage {
    const groups = groupId ? [this.groups.get(groupId)].filter((group): group is QuestionGroup => Boolean(group)) : [...this.groups.values()];
    const slots = groups.flatMap((group) => group.slots);
    const covered = slots.filter((slot) => slot.status !== "pending").length;
    const answered = slots.filter((slot) => slot.status === "answered").length;
    return { total: slots.length, covered, answered, pending: slots.length - covered, rate: slots.length ? covered / slots.length : 1 };
  }

  private createGroup(turn: InterviewTurn, startedAt: number, title: string): QuestionGroup {
    const group: QuestionGroup = { id: `question-group-${++this.sequence}`, turnId: turn.id, startedAt, updatedAt: startedAt, status: "collecting", title: sentenceEnd(title), constraints: [], examples: [], subQuestions: [], items: [], slots: [] };
    this.groups.set(group.id, group);
    return group;
  }

  private currentGroup(): QuestionGroup | undefined {
    return [...this.groups.values()].at(-1);
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
      endMs: group.updatedAt,
      questionTexts: group.items.map((item) => item.question.text)
    };
  }

  private makeRelation(source: QuestionCandidate, target: QuestionCandidate, type: QuestionRelationType, confidence: number, reason: string, createdAt: number): QuestionRelation {
    return { id: `question-relation-${source.id}-${target.id}`, sourceQuestionId: source.id, targetQuestionId: target.id, type, confidence, reason, createdAt };
  }
}

export type { InterviewTurn, QuestionRelationContext, QuestionRelationType } from "./turn-builder";
