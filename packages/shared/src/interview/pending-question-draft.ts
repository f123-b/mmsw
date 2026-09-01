import type { TranscriptSegment } from "@interview-copilot/protocol";
import { normalizeTechnicalTerms } from "../terminology";
import { isDanglingQuestionTail, isStyleOnly, type AnswerabilityState } from "./semantic-answerability";

export type SegmentSemanticRole =
  | "SETUP"
  | "NUCLEUS"
  | "CONSTRAINT"
  | "OUTPUT_REQUIREMENT"
  | "EXAMPLE"
  | "SUBQUESTION"
  | "FILLER"
  | "OPEN_NUCLEUS"
  | "SUPPORTING_FRAGMENT";

export interface PendingQuestionRawSegment {
  segment: TranscriptSegment;
  /** Raw provider text kept beside the normalized processing segment. */
  rawText?: string;
  role: SegmentSemanticRole;
  receivedAt: number;
  answerabilityState?: AnswerabilityState;
  semanticReason?: string;
}

export interface PendingQuestionDraft {
  id: string;
  segmentIds: string[];
  rawSegments: PendingQuestionRawSegment[];
  setup: string[];
  nucleus: string[];
  constraints: string[];
  outputRequirements: string[];
  examples: string[];
  subQuestions: string[];
  openNuclei: string[];
  supportingFragments: string[];
  styleModifiers: string[];
  firstReceivedAt: number;
  lastReceivedAt: number;
  finalizedAt?: number;
}

export interface PendingQuestionDraftUpdate {
  role: SegmentSemanticRole;
  draft?: PendingQuestionDraft;
  completed?: PendingQuestionDraft;
  late: boolean;
  accepted: boolean;
  reason: string;
}

export interface PendingQuestionDraftSemanticContext {
  answerabilityState?: AnswerabilityState;
  semanticReason?: string;
  contextualFollowUp?: boolean;
  /** The coordinator already has a visible question group for this session. */
  activeQuestionGroup?: boolean;
  shouldBuffer?: boolean;
  shouldAttachToPrevious?: boolean;
  shouldAnswer?: boolean;
}

export interface PendingQuestionDraftOptions {
  lateConstraintWindowMs?: number;
  lateModifierWindowMs?: number;
  orphanSetupRetentionMs?: number;
  recentQuestionContextRetentionMs?: number;
  setupWaitMs?: number;
  nucleusWaitMs?: number;
  incompleteNucleusWaitMs?: number;
}

const FILLER = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|可以|行|那个|继续|继续说|另外(?:[，,、\s]*说说看)?|然后)[。！？?！\s，,、]*$/iu;
const SETUP = /^(?:假设|如果|若|当|在这个|在该|围绕|针对|关于|说说你做的|最后一个追问|好[，,、]?假设|我们先聊|接下来问一个)/iu;
const CONSTRAINT = /(?:不能(?:换|改|更换)|不得|不可|无需|仅限|只(?:需要|讲|说)|限制|硬件(?:保持)?不变|不换硬件|不改硬件|时间不超过|控制在\s*\d+\s*(?:秒|分钟)|具体(?:数值|数字)|map\s*文件|栈回溯|固定在|保持不变|不要展开|只比较|仅从)/iu;
const OUTPUT_REQUIREMENT = /^(?:请给(?:出|我)?|给(?:出|我)?|列出|需要覆盖|需要说明|还要说明|尽量结合|结合具体|分(?:成|为)?\s*\d+|说清楚|同时说明|最后说明|包括|涵盖)|^(?:请)?(?:简单|重点|分别|分别从).*(?:比较|对比|清单|速率|布线|可靠性|排查|同步)|(?:角度|风险|方案|计划|应对|速率|布线|可靠性|清单|排查|同步).*(?:说|讲|说明|覆盖|比较|对比|列|给|展开)/iu;
const EXAMPLE = /^(?:比如|例如|举例(?:来说)?|像是|举个)/iu;
const QUESTION_FORM = /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|是否|有没有|能不能|可不可以|多少|几个|吗|呢|请问|介绍|解释|说明|说说|讲讲|排查|定位|设计|优化|验证|解决)/iu;
const NEW_TOPIC = /^(?:换个话题|换个方向|另一个问题|下一个问题|下个问题|接下来问|再问一个)/iu;

function roleFromSemanticContext(context: PendingQuestionDraftSemanticContext & { hasNucleus?: boolean; hasSetup?: boolean }): SegmentSemanticRole | undefined {
  switch (context.answerabilityState) {
    case "FILLER":
    case "META_CONVERSATION":
      return "FILLER";
    case "TOPIC_ANNOUNCEMENT":
      return "FILLER";
    case "TOPIC_FRAGMENT":
    case "SETUP_ONLY":
      return "SETUP";
    case "STYLE_ONLY":
      return context.hasNucleus || context.hasSetup ? "SUPPORTING_FRAGMENT" : "SETUP";
    case "ANSWER_CONSTRAINT":
      return "CONSTRAINT";
    case "OPEN_PREDICATE":
    case "INCOMPLETE":
      return "OPEN_NUCLEUS";
    case "CONTEXT_DEPENDENT":
      return "SUBQUESTION";
    case "ANSWERABLE":
      return context.contextualFollowUp || context.shouldAttachToPrevious ? "SUBQUESTION" : "NUCLEUS";
    default:
      return undefined;
  }
}

function clean(value: string): string {
  return normalizeTechnicalTerms(value).replace(/\s+/g, " ").trim();
}

function key(value: string): string {
  return clean(value).replace(/[。！？?！；;，,、:：\s]+/g, "").toLowerCase();
}

function uniquePush(target: string[], value: string): void {
  const normalized = clean(value);
  if (!normalized || target.some((item) => key(item) === key(normalized))) return;
  target.push(normalized);
}

function joinFragments(values: string[]): string {
  return values.reduce((result, value) => {
    if (!result) return value;
    const left = result.trim();
    const right = value.trim();
    const separator = /[\u4e00-\u9fff]$/.test(left) && /^[\u4e00-\u9fff]/.test(right) ? "" : " ";
    return `${left}${separator}${right}`;
  }, "");
}

function withoutTerminalPunctuation(value: string): string {
  return value.trim().replace(/[。！？?！；;]+$/g, "");
}

function hasQuestionShape(value: string): boolean {
  const text = clean(value);
  return /[？?]/u.test(text) || /(?:吗|呢)[。！？?！\s]*$/u.test(text) || QUESTION_FORM.test(text);
}

export function classifySegmentRole(text: string, context: PendingQuestionDraftSemanticContext & { hasNucleus?: boolean; hasSetup?: boolean } = {}): SegmentSemanticRole {
  const normalized = clean(text);
  if (!normalized || FILLER.test(normalized)) return "FILLER";
  const semanticRole = roleFromSemanticContext(context);
  if (semanticRole) return semanticRole;
  if (isStyleOnly(normalized)) return context.hasNucleus || context.hasSetup ? "SUPPORTING_FRAGMENT" : "SETUP";
  // “来个基础的，你说说” is a request to start a question, not a question
  // nucleus. Keeping it in SETUP prevents the detector's lexical “说说” rule
  // from starting an answer on an empty subject.
  if (/^(?:(?:来个|给个|给我个)[^，,。！？?！]{0,12}[，,、\s]*)?(?:你\s*)?(?:说说|讲讲|说一下|讲一下|介绍一下|解释一下|展开说|展开讲)(?:吧|看)?[。！？?！\s]*$/iu.test(normalized)) return "SETUP";
  if (/^(?:如果|假设|若|要是|当)[^。！？?！]*(?:[。！？?！]|$)$/iu.test(normalized) && !/(?:怎么|如何|怎样|怎么办|会不会|是否|能不能|可不可以|吗|呢)/iu.test(normalized)) return "SETUP";
  if (CONSTRAINT.test(normalized)) return "CONSTRAINT";
  if (EXAMPLE.test(normalized)) return "EXAMPLE";
  if (OUTPUT_REQUIREMENT.test(normalized) || /(?:计划|风险|应对|覆盖哪些|包括哪些)/iu.test(normalized)) return "OUTPUT_REQUIREMENT";
  if (hasQuestionShape(normalized)) return context.hasNucleus ? "SUBQUESTION" : "NUCLEUS";
  if (SETUP.test(normalized)) return "SETUP";
  if (context.hasNucleus || context.hasSetup) return "SUPPORTING_FRAGMENT";
  return "SETUP";
}

/** Builds the detector-facing prompt without losing semantic slot order. */
export function buildCanonicalQuestion(draft: PendingQuestionDraft): string {
  const primary = [
    ...draft.setup,
    ...draft.constraints,
    ...draft.openNuclei,
    ...draft.nucleus,
    ...draft.supportingFragments,
    ...draft.subQuestions,
    ...draft.outputRequirements,
    ...draft.examples
  ].map(withoutTerminalPunctuation);
  const canonical = joinFragments(primary.filter(Boolean));
  const hasQuestionSignal = [...draft.openNuclei, ...draft.nucleus, ...draft.subQuestions].some((value) => /[？?]$/u.test(value.trim()) || /(?:吗|呢)[。！？?！\s]*$/u.test(value.trim()));
  return hasQuestionSignal && canonical && !/[？?]$/u.test(canonical) ? `${canonical}？` : canonical;
}

function copySegment(item: PendingQuestionRawSegment): PendingQuestionRawSegment {
  return { ...item, segment: { ...item.segment } };
}

function copyDraft(draft: PendingQuestionDraft): PendingQuestionDraft {
  return {
    ...draft,
    segmentIds: [...draft.segmentIds],
    rawSegments: draft.rawSegments.map(copySegment),
    setup: [...draft.setup],
    nucleus: [...draft.nucleus],
    constraints: [...draft.constraints],
    outputRequirements: [...draft.outputRequirements],
    examples: [...draft.examples],
    subQuestions: [...draft.subQuestions],
    openNuclei: [...draft.openNuclei],
    supportingFragments: [...draft.supportingFragments],
    styleModifiers: [...draft.styleModifiers]
  };
}

function hasNucleus(draft: PendingQuestionDraft | undefined): boolean {
  return Boolean(draft?.nucleus.length);
}

function hasAnswerableQuestion(draft: PendingQuestionDraft | undefined): boolean {
  // A short question nucleus can be classified as OPEN_NUCLEUS while it is
  // being assembled (for example, “有什么区别？”). Once finalized by the
  // coordinator it is still an answerable question and late constraints must
  // be able to attach to it.
  return Boolean(draft && (draft.nucleus.length > 0 || draft.subQuestions.length > 0 || draft.openNuclei.length > 0));
}

/**
 * Collects semantic ASR fragments before the question detector sees them.
 * ASR `final` means the provider will not revise that fragment; it does not
 * mean the interviewer has finished the turn. This object is intentionally
 * local/deterministic and has no provider or persistence dependency.
 */
export class PendingQuestionDraftAssembler {
  private activeDraft: PendingQuestionDraft | undefined;
  private recentFinalizedDraft: PendingQuestionDraft | undefined;
  private readonly lateModifierWindowMs: number;
  private readonly orphanSetupRetentionMs: number;
  private readonly recentQuestionContextRetentionMs: number;
  private readonly setupWaitMs: number;
  private readonly nucleusWaitMs: number;
  private readonly incompleteNucleusWaitMs: number;

  constructor(options: PendingQuestionDraftOptions = {}) {
    this.lateModifierWindowMs = Math.max(500, options.lateModifierWindowMs ?? options.lateConstraintWindowMs ?? 3_200);
    this.orphanSetupRetentionMs = Math.max(2_000, options.orphanSetupRetentionMs ?? 11_000);
    this.recentQuestionContextRetentionMs = Math.max(2_000, options.recentQuestionContextRetentionMs ?? 11_000);
    this.setupWaitMs = Math.max(300, options.setupWaitMs ?? 800);
    this.nucleusWaitMs = Math.max(80, options.nucleusWaitMs ?? 220);
    this.incompleteNucleusWaitMs = Math.max(this.nucleusWaitMs, options.incompleteNucleusWaitMs ?? 760);
  }

  get current(): PendingQuestionDraft | undefined { return this.activeDraft ? copyDraft(this.activeDraft) : undefined; }
  get recent(): PendingQuestionDraft | undefined { return this.recentFinalizedDraft ? copyDraft(this.recentFinalizedDraft) : undefined; }
  get waitMs(): number {
    if (!this.activeDraft) return this.setupWaitMs;
    if (!hasNucleus(this.activeDraft) && this.activeDraft.openNuclei.length) return this.incompleteNucleusWaitMs;
    if (hasNucleus(this.activeDraft) && this.activeDraft.openNuclei.length === 0 && isDanglingQuestionTail(this.canonicalText(this.activeDraft))) return this.incompleteNucleusWaitMs;
    // A complete contextual follow-up is stored in subQuestions rather than
    // nucleus, but it is still an answerable turn and should keep the short
    // confirmation horizon. Open predicates and setup-only drafts take the
    // longer waits above/below so they can collect their missing object.
    return hasAnswerableQuestion(this.activeDraft) ? this.nucleusWaitMs : this.setupWaitMs;
  }

  reset(): void {
    this.activeDraft = undefined;
    this.recentFinalizedDraft = undefined;
  }

  add(segment: TranscriptSegment, receivedAt: number, options: PendingQuestionDraftSemanticContext = {}): PendingQuestionDraftUpdate {
    if (!segment.final || !segment.text.trim()) return { role: "SUPPORTING_FRAGMENT", late: false, accepted: false, reason: "unstable-asr-segment" };
    const role = classifySegmentRole(segment.text, { ...options, hasNucleus: hasNucleus(this.activeDraft), hasSetup: Boolean(this.activeDraft?.setup.length || this.recentFinalizedDraft?.setup.length) });
    if (role === "FILLER") return { role, draft: this.current, late: false, accepted: false, reason: "filler-only" };

    const recent = this.recentFinalizedDraft;
    const recentAge = recent ? receivedAt - (recent.finalizedAt ?? recent.lastReceivedAt) : Number.POSITIVE_INFINITY;
    if (!this.activeDraft && recent && options.activeQuestionGroup && options.contextualFollowUp && hasAnswerableQuestion(recent) && recentAge <= this.recentQuestionContextRetentionMs && role === "SUBQUESTION") {
      this.start(segment, role, receivedAt, options);
      return { role, draft: this.current, late: false, accepted: true, reason: "active-question-follow-up-new-draft" };
    }
    if (!this.activeDraft && recent && options.activeQuestionGroup && !options.contextualFollowUp && hasAnswerableQuestion(recent) && recentAge <= this.lateModifierWindowMs && ["CONSTRAINT", "OUTPUT_REQUIREMENT", "EXAMPLE", "SUBQUESTION", "OPEN_NUCLEUS", "SUPPORTING_FRAGMENT"].includes(role)) {
      this.append(recent, segment, role, receivedAt, options);
      return { role, draft: copyDraft(recent), late: true, accepted: true, reason: "late-context-attached-to-active-question" };
    }
    if (!this.activeDraft && recent && options.contextualFollowUp && hasNucleus(recent) && recentAge <= this.recentQuestionContextRetentionMs) {
      this.activeDraft = recent;
      this.recentFinalizedDraft = undefined;
      const followUpRole = classifySegmentRole(segment.text, { ...options, hasNucleus: true, hasSetup: true });
      this.append(this.activeDraft, segment, followUpRole, receivedAt, options);
      return { role: followUpRole, draft: this.current, late: false, accepted: true, reason: "context-follow-up-reopened-recent-question" };
    }
    if (!this.activeDraft && recent && !hasNucleus(recent) && recentAge <= this.orphanSetupRetentionMs && this.canReopenOrphan(recent, role)) {
      this.activeDraft = recent;
      this.recentFinalizedDraft = undefined;
      this.append(this.activeDraft, segment, role, receivedAt, options);
      return { role, draft: this.current, late: false, accepted: true, reason: "orphan-setup-reopened" };
    }
    if (!this.activeDraft && recent && !options.contextualFollowUp && hasAnswerableQuestion(recent) && recentAge <= this.lateModifierWindowMs && ["CONSTRAINT", "OUTPUT_REQUIREMENT", "EXAMPLE", "SUBQUESTION", "OPEN_NUCLEUS", "SUPPORTING_FRAGMENT"].includes(role)) {
      this.append(recent, segment, role, receivedAt, options);
      return { role, draft: copyDraft(recent), late: true, accepted: true, reason: "late-context-attached-to-recent-question" };
    }

    if (this.activeDraft && hasNucleus(this.activeDraft) && role === "NUCLEUS" && (NEW_TOPIC.test(clean(segment.text)) || receivedAt - this.activeDraft.lastReceivedAt > this.lateModifierWindowMs)) {
      const completed = this.finalize(receivedAt);
      this.start(segment, role, receivedAt, options);
      return { role, draft: this.current, completed, late: false, accepted: true, reason: "new-question-boundary" };
    }

    if (!this.activeDraft) this.start(segment, role, receivedAt, options);
    else this.append(this.activeDraft, segment, role, receivedAt, options);
    return { role, draft: this.current, late: false, accepted: true, reason: "draft-updated" };
  }

  shouldFinalize(now: number): boolean {
    return Boolean(this.activeDraft && now - this.activeDraft.lastReceivedAt >= this.waitMs);
  }

  finalize(finalizedAt: number): PendingQuestionDraft | undefined {
    const draft = this.activeDraft;
    if (!draft) return undefined;
    draft.finalizedAt = finalizedAt;
    this.activeDraft = undefined;
    this.recentFinalizedDraft = draft;
    return copyDraft(draft);
  }

  canonicalText(draft: PendingQuestionDraft): string {
    return buildCanonicalQuestion(draft);
  }

  toUtterance(draft: PendingQuestionDraft, finalizedAt = draft.finalizedAt ?? draft.lastReceivedAt): {
    id: string;
    source: "remote";
    text: string;
    rawText: string;
    segmentIds: string[];
    startMs: number;
    endMs: number;
    final: true;
    firstSegmentReceivedAt: number;
    lastFinalReceivedAt: number;
    finalizedAt: number;
    confidence?: number;
  } {
    const rawText = joinFragments(draft.rawSegments.map((item) => item.rawText ?? item.segment.text));
    const confidenceValues = draft.rawSegments.map((item) => item.segment.confidence).filter((value): value is number => value !== undefined);
    return {
      id: `utterance-${draft.id}`,
      source: "remote",
      text: this.canonicalText(draft),
      rawText,
      segmentIds: [...draft.segmentIds],
      startMs: Math.min(...draft.rawSegments.map((item) => item.segment.startMs)),
      endMs: Math.max(...draft.rawSegments.map((item) => item.segment.endMs)),
      final: true,
      firstSegmentReceivedAt: draft.firstReceivedAt,
      lastFinalReceivedAt: draft.lastReceivedAt,
      finalizedAt,
      ...(confidenceValues.length ? { confidence: confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length } : {})
    };
  }

  private start(segment: TranscriptSegment, role: SegmentSemanticRole, receivedAt: number, semantic?: PendingQuestionDraftSemanticContext): void {
    const id = segment.id ?? `${segment.source ?? "remote"}-${segment.startMs}-${segment.endMs}`;
    this.activeDraft = {
      id,
      segmentIds: [],
      rawSegments: [],
      setup: [],
      nucleus: [],
      constraints: [],
      outputRequirements: [],
      examples: [],
      subQuestions: [],
      openNuclei: [],
      supportingFragments: [],
      styleModifiers: [],
      firstReceivedAt: receivedAt,
      lastReceivedAt: receivedAt
    };
    this.append(this.activeDraft, segment, role, receivedAt, semantic);
  }

  private append(draft: PendingQuestionDraft, segment: TranscriptSegment, role: SegmentSemanticRole, receivedAt: number, semantic?: PendingQuestionDraftSemanticContext): void {
    const id = segment.id ?? `${segment.source ?? "remote"}-${segment.startMs}-${segment.endMs}`;
    const existing = draft.rawSegments.find((item) => item.segment.id === id);
    if (existing) {
      existing.segment = { ...segment };
      existing.role = role;
      existing.receivedAt = receivedAt;
      existing.answerabilityState = semantic?.answerabilityState;
      existing.semanticReason = semantic?.semanticReason;
      draft.lastReceivedAt = receivedAt;
      return;
    }
    draft.segmentIds.push(id);
    draft.rawSegments.push({ segment: { ...segment, id }, ...(typeof (segment as TranscriptSegment & { rawText?: string }).rawText === "string" ? { rawText: (segment as TranscriptSegment & { rawText?: string }).rawText } : {}), role, receivedAt, ...(semantic?.answerabilityState ? { answerabilityState: semantic.answerabilityState } : {}), ...(semantic?.semanticReason ? { semanticReason: semantic.semanticReason } : {}) });
    draft.lastReceivedAt = receivedAt;
    const value = clean(segment.text);
    if (role === "SETUP") uniquePush(draft.setup, value);
    else if (role === "NUCLEUS") uniquePush(draft.nucleus, value);
    else if (role === "CONSTRAINT") uniquePush(draft.constraints, value);
    else if (role === "OUTPUT_REQUIREMENT") uniquePush(draft.outputRequirements, value);
    else if (role === "EXAMPLE") uniquePush(draft.examples, value);
    else if (role === "SUBQUESTION") uniquePush(draft.subQuestions, value);
    else if (role === "OPEN_NUCLEUS") uniquePush(draft.openNuclei, value);
    else if (role === "SUPPORTING_FRAGMENT" && !isStyleOnly(value)) uniquePush(draft.supportingFragments, value);
    if (isStyleOnly(value)) uniquePush(draft.styleModifiers, value);
  }

  private canReopenOrphan(draft: PendingQuestionDraft, role: SegmentSemanticRole): boolean {
    if (!(role === "NUCLEUS" || role === "OPEN_NUCLEUS" || role === "SUPPORTING_FRAGMENT" || role === "SETUP")) return false;
    if (draft.supportingFragments.length > 0) return true;
    return draft.setup.some((value) => /(?:在这个|在该|项目中|项目里|简历里|围绕|针对|关于|最后一个追问|如果|假设|若|当|情况下|出现|日志|系统|语言里|语言中|指针|数组|STL|C\+\+|C语言|RTOS|FOC|DMA|I2C|SPI|UART|CAN)/iu.test(value));
  }
}
