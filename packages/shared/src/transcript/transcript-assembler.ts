import type { TranscriptSegment } from "@interview-copilot/protocol";
import { normalizeTechnicalTerms } from "../terminology";
import { fragmentFromSegment, type TranscriptFragment, type TranscriptSpeaker, type TranscriptUtterance } from "./transcript-segment";

export interface TranscriptAssemblerOptions {
  /** Same-speaker fragments inside this gap are eligible for assembly. */
  maxGapMs?: number;
  /** Prevent an open utterance from growing without bound. */
  maxChars?: number;
  /** Prevent a single utterance from spanning an entire interview answer. */
  maxDurationMs?: number;
}

export interface TranscriptAssemblerUpdate {
  current?: TranscriptUtterance;
  completed: TranscriptUtterance[];
  merged: boolean;
  reason: "partial" | "started" | "merged" | "revised" | "speaker-boundary" | "semantic-boundary" | "time-boundary" | "length-boundary";
}

const TERMINAL = /[？?!！。；;]$/u;
const OPEN_TAIL = /(?:如果|假设|若|比如|例如|包括|以及|并且|而且|尤其|关于|针对|和|与|跟|的|然后|最后|怎么|如何|哪些|什么|时候|情况下)[。！？?！；;，,、\s]*$/iu;
const STRONG_QUESTION_START = /^(?:那如果|那么|为什么|为何|什么是|哪些|哪种|哪个|怎么|如何|请问|能否|是否|介绍一下|解释一下|说说|讲讲)/iu;
const ACK = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|行|可以|还有)[。！？?！\s，,、]*$/iu;
const TOPIC_SWITCH = /^(?:换个话题|换个方向|另一个问题|下一个问题|下一题|再问一个|接下来问)/iu;

function clean(value: string): string {
  return normalizeTechnicalTerms(value).replace(/\s+/g, " ").trim();
}

function join(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left}${/^[，。！？、,.!?；;：:]/u.test(right) ? "" : " "}${right}`;
}

function copy(value: TranscriptUtterance): TranscriptUtterance {
  return { ...value, fragments: [...value.fragments], segmentIds: [...value.segmentIds] };
}

function semanticBoundary(previous: string, next: string): boolean {
  if (ACK.test(next) || TOPIC_SWITCH.test(next)) return true;
  if (OPEN_TAIL.test(previous)) return false;
  if (TERMINAL.test(previous) && STRONG_QUESTION_START.test(next)) return true;
  return false;
}

/**
 * Provider-independent transcript assembly. It owns only speaker-separated
 * temporal material; semantic question classification remains downstream.
 */
export class TranscriptAssembler {
  private readonly current = new Map<TranscriptSpeaker, TranscriptUtterance>();
  private readonly partials = new Map<TranscriptSpeaker, TranscriptFragment>();
  private readonly maxGapMs: number;
  private readonly maxChars: number;
  private readonly maxDurationMs: number;

  constructor(options: TranscriptAssemblerOptions = {}) {
    this.maxGapMs = Math.max(250, options.maxGapMs ?? 2_000);
    this.maxChars = Math.max(80, options.maxChars ?? 640);
    this.maxDurationMs = Math.max(1_000, options.maxDurationMs ?? 12_000);
  }

  get pending(): TranscriptUtterance[] { return [...this.current.values()].map(copy); }

  push(input: TranscriptSegment | TranscriptFragment, receivedAt = Date.now(), rawText?: string): TranscriptAssemblerUpdate {
    const fragment = "speaker" in input ? { ...input } : fragmentFromSegment(input, rawText ?? input.text);
    const text = clean(fragment.text);
    if (!fragment.final) {
      this.partials.set(fragment.speaker, { ...fragment, text });
      const current = this.current.get(fragment.speaker);
      return { ...(current ? { current: copy(current) } : {}), completed: [], merged: false, reason: "partial" };
    }
    if (!text) return { completed: [], merged: false, reason: "partial" };
    this.partials.delete(fragment.speaker);
    const previous = this.current.get(fragment.speaker);
    if (previous && previous.segmentIds.includes(fragment.id)) {
      const index = previous.segmentIds.indexOf(fragment.id);
      previous.fragments[index] = text;
      previous.segmentIds[index] = fragment.id;
      previous.text = previous.fragments.reduce(join, "");
      previous.rawText = previous.segmentIds.map((id, itemIndex) => id === fragment.id ? (fragment.rawText ?? fragment.text) : previous.fragments[itemIndex] ?? "").reduce(join, "");
      previous.startTs = Math.min(previous.startTs, fragment.startTs);
      previous.endTs = Math.max(previous.endTs, fragment.endTs);
      return { current: copy(previous), completed: [], merged: true, reason: "revised" };
    }
    const gap = previous ? fragment.startTs - previous.endTs : Number.POSITIVE_INFINITY;
    const duration = previous ? fragment.endTs - previous.startTs : 0;
    const exceedsLength = Boolean(previous && (previous.text.length + text.length > this.maxChars || duration > this.maxDurationMs));
    const canMerge = Boolean(previous
      && gap >= 0
      && gap <= this.maxGapMs
      && !exceedsLength
      && !semanticBoundary(previous.text, text));
    if (canMerge && previous) {
      previous.fragments.push(text);
      previous.segmentIds.push(fragment.id);
      previous.text = join(previous.text, text);
      previous.rawText = join(previous.rawText, fragment.rawText ?? fragment.text);
      previous.endTs = Math.max(previous.endTs, fragment.endTs);
      if (fragment.confidence !== undefined) previous.confidence = fragment.confidence;
      return { current: copy(previous), completed: [], merged: true, reason: "merged" };
    }
    const completed = previous ? [{ ...copy(previous), finalized: true }] : [];
    const reason = !previous ? "started" : gap > this.maxGapMs ? "time-boundary" : exceedsLength ? "length-boundary" : semanticBoundary(previous.text, text) ? "semantic-boundary" : "speaker-boundary";
    const utterance: TranscriptUtterance = {
      id: `utterance-${fragment.speaker}-${fragment.utteranceId ?? fragment.id}`,
      speaker: fragment.speaker,
      text,
      rawText: fragment.rawText ?? fragment.text,
      startTs: fragment.startTs,
      endTs: fragment.endTs,
      fragments: [text],
      segmentIds: [fragment.id],
      finalized: false,
      ...(fragment.confidence !== undefined ? { confidence: fragment.confidence } : {})
    };
    this.current.set(fragment.speaker, utterance);
    void receivedAt;
    return { current: copy(utterance), completed, merged: false, reason: reason as TranscriptAssemblerUpdate["reason"] };
  }

  flush(speaker?: TranscriptSpeaker): TranscriptUtterance[] {
    const speakers = speaker ? [speaker] : [...this.current.keys()];
    return speakers.flatMap((item) => {
      const value = this.current.get(item);
      if (!value) return [];
      this.current.delete(item);
      return [{ ...copy(value), finalized: true }];
    });
  }

  clear(): void {
    this.current.clear();
    this.partials.clear();
  }
}
