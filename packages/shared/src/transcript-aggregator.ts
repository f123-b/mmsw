import type { TranscriptSegment, TranscriptSource } from "@interview-copilot/protocol";
import { normalizeTechnicalTerms } from "./terminology";

export interface TranscriptUtterance {
  id: string;
  source: TranscriptSource;
  text: string;
  segmentIds: string[];
  startMs: number;
  endMs: number;
  final: true;
  confidence?: number;
  /** Runtime receipt time of the first final segment in this turn. */
  firstSegmentReceivedAt?: number;
  /** Runtime receipt time of the latest final/revision in this turn. */
  lastFinalReceivedAt?: number;
  /** Runtime time at which the turn was closed by a boundary or flush. */
  finalizedAt?: number;
}

export interface TranscriptAggregatorOptions {
  /** Final ASR segments separated by less than this are one spoken turn. */
  maxGapMs?: number;
  /** A terminal punctuation mark starts the next utterance. */
  punctuationBoundary?: boolean;
}

const TERMINAL_PUNCTUATION = /[?？!！。；;]$/;
const CONTINUATION_START = /^(关键字|关键点|作用|影响|导致|决定|以及|并且|而且|尤其|包括|比如|例如|具体|分别|常见|十五秒|只讲|简单说|先说|你会|你准备|用一句话|急速|抖动|当时|接着|最后|然后|隔离|硬件|软件|故障|可观测|验证|排查|定位|设计|实现|考虑|在|其中|同时|关于|针对|有什么)/;
const INCOMPLETE_TAIL = /(?:比如|例如|包括|以及|并且|而且|尤其|关于|针对|问题是|最后|然后|怎么|如何|哪些|什么|是否|能否)[。！？?！；;，,、\s]*$/;
const INCOMPLETE_GRAMMAR_TAIL = /(?:的|跟|和|与|以及|或者|还有|包括)[。！？?！；;，,、\s]*$/;
const STANDALONE_ACKNOWLEDGEMENT = /^(?:好|好的|那|嗯+|呃+|啊+|哦+|对|明白了?|知道了?|行|可以)[。！？?！\s，,、]*$/i;
const STANDALONE_REPAIR_QUESTION = /^(?:你觉得(?:呢)?|怎么(?:回答|答|说)|答案(?:是什么|呢))[。！？?！\s]*$/i;
const STANDALONE_TRANSITION = /^(?:还有(?:一个)?问题|下一个(?:问题)?|再问(?:一个)?|接下来(?:问)?)[。！？?！\s，,、]*$/i;
const NEW_QUESTION_START = /^(?:那如果|那么|为什么|为何|什么是|哪些|哪种|怎么|如何|请问|能否|是否|介绍一下|解释一下|说说|讲讲)/;
const QUESTION_SHAPE = /(?:什么|为什么|为何|怎么|如何|哪些|哪种|区别|原理|介绍|解释|能否|是否|吗|呢)/;

function normalize(text: string): string {
  return normalizeTechnicalTerms(text);
}

function mergeText(left: string, right: string): string {
  const a = normalize(left);
  const b = normalize(right);
  if (!a) return b;
  if (!b) return a;
  // Mandarin ASR sometimes finalizes the interrogative shell before its
  // complement: “还有什么因素？” + “影响 MCU 的性能。”  Reorder it into a
  // self-contained question so the context resolver will not borrow the
  // previous topic (for example “内存泄漏”).
  if (/^(?:还有|哪些|什么).*(?:因素|原因)[？?。]$/.test(a) && /^(?:影响|导致|决定)/.test(b)) {
    return `${a.replace(/[？?。]+$/, "")}${b.replace(/[。！!；;]+$/, "")}？`;
  }
  return `${a}${/^[，。！？、,.!?；;：:]/.test(b) ? "" : " "}${b}`;
}

function shouldMergeAfterPunctuation(previous: string, next: string): boolean {
  if (!TERMINAL_PUNCTUATION.test(previous)) return true;
  const nextText = normalize(next);
  // Acknowledgements and meta prompts are new speech acts, not continuations
  // of the previous interview question. Keeping them separate prevents a
  // complete technical question from being replaced by “那。你觉得呢？”。
  if (
    STANDALONE_ACKNOWLEDGEMENT.test(previous.trim())
    || STANDALONE_ACKNOWLEDGEMENT.test(nextText)
    || STANDALONE_REPAIR_QUESTION.test(nextText)
    || STANDALONE_TRANSITION.test(nextText)
  ) return false;
  // ASR punctuation is frequently inserted at a segment endpoint. A phrase
  // such as “比如。” or “最后。” is not a semantic end of the prompt.
  if (INCOMPLETE_TAIL.test(previous.trim()) || INCOMPLETE_GRAMMAR_TAIL.test(previous.trim())) return true;
  // ASR often closes each partial final with a full stop even though the
  // interviewer is continuing the same prompt: “请解释 volatile。” →
  // “关键字的作用。” → “以及常见误区”。 Keep those fragments together.
  return CONTINUATION_START.test(nextText);
}

function startsNewQuestion(previous: string, next: string): boolean {
  const previousText = normalize(previous).trim();
  const nextText = normalize(next).trim();
  if (previousText.length < 8 || !NEW_QUESTION_START.test(nextText)) return false;
  if (INCOMPLETE_TAIL.test(previousText) || STANDALONE_ACKNOWLEDGEMENT.test(nextText)) return false;
  // ASR sometimes omits punctuation between two interviewer questions. A
  // strong question opener after a complete-looking prompt is a semantic
  // boundary even when the time gap is still below maxGapMs.
  return /[？?！!]$/.test(previousText) || QUESTION_SHAPE.test(previousText);
}

export class TranscriptAggregator {
  private readonly current: Partial<Record<TranscriptSource, TranscriptUtterance>> = {};
  private readonly completed: Partial<Record<TranscriptSource, TranscriptUtterance[]>> = {};
  private readonly parts: Partial<Record<TranscriptSource, Map<string, string>>> = {};
  private readonly maxGapMs: number;
  private readonly punctuationBoundary: boolean;

  constructor(options: TranscriptAggregatorOptions = {}) {
    this.maxGapMs = options.maxGapMs ?? 1_800;
    this.punctuationBoundary = options.punctuationBoundary ?? true;
  }

  get pendingCount(): number {
    return Object.values(this.current).filter(Boolean).length
      + Object.values(this.completed).reduce((total, items) => total + (items?.length ?? 0), 0);
  }

  /**
   * Only final segments are emitted. Partials are intentionally left to the
   * stabilizer/UI so the question detector never answers on unstable text.
   */
  push(segment: TranscriptSegment, receivedAt = Date.now()): TranscriptUtterance | undefined {
    if (!segment.final) return undefined;
    const text = normalize(segment.text);
    if (!text) return undefined;
    const previous = this.current[segment.source];

    // Some ASR providers revise a final segment using the same id. Replace
    // that segment instead of appending a duplicate copy to the utterance.
    if (previous?.segmentIds.includes(segment.id)) {
      this.parts[segment.source]?.set(segment.id, text);
      previous.startMs = Math.min(previous.startMs, segment.startMs);
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      previous.lastFinalReceivedAt = receivedAt;
      if (segment.confidence !== undefined) previous.confidence = segment.confidence;
      previous.text = this.rebuildText(segment.source, previous.segmentIds);
      return { ...previous, segmentIds: [...previous.segmentIds] };
    }
    const canMerge = Boolean(
      previous &&
      segment.startMs - previous.endMs <= this.maxGapMs &&
      !startsNewQuestion(previous.text, text) &&
      (!this.punctuationBoundary || shouldMergeAfterPunctuation(previous.text, text))
    );
    if (canMerge && previous) {
      this.parts[segment.source] ??= new Map<string, string>();
      this.parts[segment.source]?.set(segment.id, text);
      previous.text = this.rebuildText(segment.source, [...previous.segmentIds, segment.id]);
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      previous.segmentIds.push(segment.id);
      previous.lastFinalReceivedAt = receivedAt;
      if (segment.confidence !== undefined) previous.confidence = segment.confidence;
      return { ...previous, segmentIds: [...previous.segmentIds] };
    }
    if (previous) this.enqueueCompleted(segment.source, previous, receivedAt);
    const parts = new Map<string, string>([[segment.id, text]]);
    this.parts[segment.source] = parts;
    const utterance: TranscriptUtterance = {
      id: `utterance-${segment.source}-${segment.id}`,
      source: segment.source,
      text,
      segmentIds: [segment.id],
      startMs: segment.startMs,
      endMs: segment.endMs,
      final: true,
      firstSegmentReceivedAt: receivedAt,
      lastFinalReceivedAt: receivedAt,
      ...(segment.confidence !== undefined ? { confidence: segment.confidence } : {})
    };
    this.current[segment.source] = utterance;
    return { ...utterance, segmentIds: [...utterance.segmentIds] };
  }

  /**
   * Returns utterances that were closed by a later segment starting a new
   * speech turn. The current turn is intentionally left open until flush().
   */
  drainCompleted(source: TranscriptSource): TranscriptUtterance[] {
    const values = this.completed[source] ?? [];
    delete this.completed[source];
    return values.map((value) => ({ ...value, segmentIds: [...value.segmentIds] }));
  }

  flush(source?: TranscriptSource, finalizedAt = Date.now()): TranscriptUtterance[] {
    if (source) {
      const value = this.current[source];
      const completed = this.drainCompleted(source);
      delete this.current[source];
      delete this.parts[source];
      return value ? [...completed, { ...value, finalizedAt, segmentIds: [...value.segmentIds] }] : completed;
    }
    const values = (Object.keys(this.current) as TranscriptSource[]).flatMap((item) => this.flush(item));
    return values;
  }

  clear(): void {
    delete this.current.mic;
    delete this.current.remote;
    delete this.completed.mic;
    delete this.completed.remote;
    delete this.parts.mic;
    delete this.parts.remote;
  }

  private enqueueCompleted(source: TranscriptSource, utterance: TranscriptUtterance, finalizedAt: number): void {
    const queue = this.completed[source] ?? [];
    queue.push({ ...utterance, finalizedAt, segmentIds: [...utterance.segmentIds] });
    this.completed[source] = queue;
  }

  private rebuildText(source: TranscriptSource, segmentIds: string[]): string {
    const parts = this.parts[source];
    if (!parts) return "";
    return segmentIds.reduce((text, id) => mergeText(text, parts.get(id) ?? ""), "");
  }
}
