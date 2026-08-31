import type { TranscriptSegment } from "@interview-copilot/protocol";
import { normalizeTechnicalTerms } from "../terminology";

export type SegmentSemanticRole =
  | "SETUP"
  | "NUCLEUS"
  | "CONSTRAINT"
  | "OUTPUT_REQUIREMENT"
  | "EXAMPLE"
  | "SUBQUESTION"
  | "FILLER"
  | "SUPPORTING_FRAGMENT";

export interface PendingQuestionRawSegment {
  segment: TranscriptSegment;
  role: SegmentSemanticRole;
  receivedAt: number;
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
  supportingFragments: string[];
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

export interface PendingQuestionDraftOptions {
  lateConstraintWindowMs?: number;
  setupWaitMs?: number;
  nucleusWaitMs?: number;
}

const FILLER = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|可以|行|那个|继续|继续说|另外(?:[，,、\s]*说说看)?|然后)[。！？?！\s，,、]*$/iu;
const SETUP = /^(?:假设|如果|若|当|在这个|在该|围绕|针对|关于|说说你做的|最后一个追问|好[，,、]?假设|我们先聊|接下来问一个)/iu;
const CONSTRAINT = /(?:不能(?:换|改|更换)|不得|不可|无需|仅限|只(?:需要|讲|说)|限制|硬件(?:保持)?不变|不换硬件|不改硬件|时间不超过|控制在\s*\d+\s*(?:秒|分钟)|具体(?:数值|数字)|map\s*文件|栈回溯)/iu;
const OUTPUT_REQUIREMENT = /^(?:请给(?:出|我)?|给(?:出|我)?|列出|需要覆盖|需要说明|还要说明|尽量结合|结合具体|分(?:成|为)?\s*\d+|说清楚|同时说明|最后说明|包括|涵盖)|(?:角度|风险|方案|计划|应对).*(?:说|讲|说明|覆盖)/iu;
const EXAMPLE = /^(?:比如|例如|举例(?:来说)?|像是|举个)/iu;
const QUESTION_FORM = /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|是否|有没有|能不能|可不可以|多少|几个|吗|呢|请问|介绍|解释|说明|说说|讲讲|排查|定位|设计|优化|验证|解决)/iu;
const NEW_TOPIC = /^(?:换个话题|换个方向|另一个问题|下一个问题|下个问题|接下来问|再问一个)/iu;

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

export function classifySegmentRole(text: string, context: { hasNucleus?: boolean } = {}): SegmentSemanticRole {
  const normalized = clean(text);
  if (!normalized || FILLER.test(normalized)) return "FILLER";
  if (CONSTRAINT.test(normalized)) return "CONSTRAINT";
  if (EXAMPLE.test(normalized)) return "EXAMPLE";
  if (OUTPUT_REQUIREMENT.test(normalized) || /(?:计划|风险|应对|覆盖哪些|包括哪些)/iu.test(normalized)) return "OUTPUT_REQUIREMENT";
  if (hasQuestionShape(normalized)) return context.hasNucleus ? "SUBQUESTION" : "NUCLEUS";
  if (SETUP.test(normalized)) return "SETUP";
  if (context.hasNucleus) return "SUPPORTING_FRAGMENT";
  return "SETUP";
}

/** Builds the detector-facing prompt without losing semantic slot order. */
export function buildCanonicalQuestion(draft: PendingQuestionDraft): string {
  const primary = [
    ...draft.setup,
    ...draft.constraints,
    ...draft.nucleus,
    ...draft.supportingFragments,
    ...draft.subQuestions,
    ...draft.outputRequirements,
    ...draft.examples
  ].map(withoutTerminalPunctuation);
  const canonical = joinFragments(primary.filter(Boolean));
  const hasQuestionSignal = [...draft.nucleus, ...draft.subQuestions].some((value) => /[？?]$/u.test(value.trim()) || /(?:吗|呢)[。！？?！\s]*$/u.test(value.trim()));
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
    supportingFragments: [...draft.supportingFragments]
  };
}

function hasNucleus(draft: PendingQuestionDraft | undefined): boolean {
  return Boolean(draft?.nucleus.length);
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
  private readonly lateConstraintWindowMs: number;
  private readonly setupWaitMs: number;
  private readonly nucleusWaitMs: number;

  constructor(options: PendingQuestionDraftOptions = {}) {
    this.lateConstraintWindowMs = Math.max(500, options.lateConstraintWindowMs ?? 3_000);
    this.setupWaitMs = Math.max(300, options.setupWaitMs ?? 900);
    this.nucleusWaitMs = Math.max(80, options.nucleusWaitMs ?? 220);
  }

  get current(): PendingQuestionDraft | undefined { return this.activeDraft ? copyDraft(this.activeDraft) : undefined; }
  get recent(): PendingQuestionDraft | undefined { return this.recentFinalizedDraft ? copyDraft(this.recentFinalizedDraft) : undefined; }
  get waitMs(): number { return hasNucleus(this.activeDraft) ? this.nucleusWaitMs : this.setupWaitMs; }

  reset(): void {
    this.activeDraft = undefined;
    this.recentFinalizedDraft = undefined;
  }

  add(segment: TranscriptSegment, receivedAt: number): PendingQuestionDraftUpdate {
    if (!segment.final || !segment.text.trim()) return { role: "SUPPORTING_FRAGMENT", late: false, accepted: false, reason: "unstable-asr-segment" };
    const role = classifySegmentRole(segment.text, { hasNucleus: hasNucleus(this.activeDraft) });
    if (role === "FILLER") return { role, draft: this.current, late: false, accepted: false, reason: "filler-only" };

    const recent = this.recentFinalizedDraft;
    if (!this.activeDraft && recent && receivedAt - (recent.finalizedAt ?? recent.lastReceivedAt) <= this.lateConstraintWindowMs && ["CONSTRAINT", "OUTPUT_REQUIREMENT", "EXAMPLE", "SUBQUESTION", "SUPPORTING_FRAGMENT"].includes(role)) {
      this.append(recent, segment, role, receivedAt);
      return { role, draft: copyDraft(recent), late: true, accepted: true, reason: "late-context-attached-to-recent-question" };
    }

    if (this.activeDraft && hasNucleus(this.activeDraft) && role === "NUCLEUS" && (NEW_TOPIC.test(clean(segment.text)) || receivedAt - this.activeDraft.lastReceivedAt > this.lateConstraintWindowMs)) {
      const completed = this.finalize(receivedAt);
      this.start(segment, role, receivedAt);
      return { role, draft: this.current, completed, late: false, accepted: true, reason: "new-question-boundary" };
    }

    if (!this.activeDraft) this.start(segment, role, receivedAt);
    else this.append(this.activeDraft, segment, role, receivedAt);
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
    const rawText = joinFragments(draft.rawSegments.map((item) => item.segment.text));
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

  private start(segment: TranscriptSegment, role: SegmentSemanticRole, receivedAt: number): void {
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
      supportingFragments: [],
      firstReceivedAt: receivedAt,
      lastReceivedAt: receivedAt
    };
    this.append(this.activeDraft, segment, role, receivedAt);
  }

  private append(draft: PendingQuestionDraft, segment: TranscriptSegment, role: SegmentSemanticRole, receivedAt: number): void {
    const id = segment.id ?? `${segment.source ?? "remote"}-${segment.startMs}-${segment.endMs}`;
    const existing = draft.rawSegments.find((item) => item.segment.id === id);
    if (existing) {
      existing.segment = { ...segment };
      existing.role = role;
      existing.receivedAt = receivedAt;
      draft.lastReceivedAt = receivedAt;
      return;
    }
    draft.segmentIds.push(id);
    draft.rawSegments.push({ segment: { ...segment, id }, role, receivedAt });
    draft.lastReceivedAt = receivedAt;
    const value = clean(segment.text);
    if (role === "SETUP") uniquePush(draft.setup, value);
    else if (role === "NUCLEUS") uniquePush(draft.nucleus, value);
    else if (role === "CONSTRAINT") uniquePush(draft.constraints, value);
    else if (role === "OUTPUT_REQUIREMENT") uniquePush(draft.outputRequirements, value);
    else if (role === "EXAMPLE") uniquePush(draft.examples, value);
    else if (role === "SUBQUESTION") uniquePush(draft.subQuestions, value);
    else if (role === "SUPPORTING_FRAGMENT") uniquePush(draft.supportingFragments, value);
  }
}
