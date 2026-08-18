import type { TranscriptSegment, TranscriptSource } from "@interview-copilot/protocol";

export interface TranscriptUtterance {
  id: string;
  source: TranscriptSource;
  text: string;
  segmentIds: string[];
  startMs: number;
  endMs: number;
  final: true;
  confidence?: number;
}

export interface TranscriptAggregatorOptions {
  /** Final ASR segments separated by less than this are one spoken turn. */
  maxGapMs?: number;
  /** A terminal punctuation mark starts the next utterance. */
  punctuationBoundary?: boolean;
}

const TERMINAL_PUNCTUATION = /[?？!！。；;]$/;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function mergeText(left: string, right: string): string {
  const a = normalize(left);
  const b = normalize(right);
  if (!a) return b;
  if (!b) return a;
  return `${a}${/^[，。！？、,.!?；;：:]/.test(b) ? "" : " "}${b}`;
}

export class TranscriptAggregator {
  private readonly current: Partial<Record<TranscriptSource, TranscriptUtterance>> = {};
  private readonly maxGapMs: number;
  private readonly punctuationBoundary: boolean;

  constructor(options: TranscriptAggregatorOptions = {}) {
    this.maxGapMs = options.maxGapMs ?? 1_800;
    this.punctuationBoundary = options.punctuationBoundary ?? true;
  }

  /**
   * Only final segments are emitted. Partials are intentionally left to the
   * stabilizer/UI so the question detector never answers on unstable text.
   */
  push(segment: TranscriptSegment): TranscriptUtterance | undefined {
    if (!segment.final) return undefined;
    const text = normalize(segment.text);
    if (!text) return undefined;
    const previous = this.current[segment.source];
    const canMerge = Boolean(
      previous &&
      segment.startMs - previous.endMs <= this.maxGapMs &&
      (!this.punctuationBoundary || !TERMINAL_PUNCTUATION.test(previous.text))
    );
    if (canMerge && previous) {
      previous.text = mergeText(previous.text, text);
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      previous.segmentIds.push(segment.id);
      if (segment.confidence !== undefined) previous.confidence = segment.confidence;
      return { ...previous, segmentIds: [...previous.segmentIds] };
    }
    const utterance: TranscriptUtterance = {
      id: `utterance-${segment.source}-${segment.id}`,
      source: segment.source,
      text,
      segmentIds: [segment.id],
      startMs: segment.startMs,
      endMs: segment.endMs,
      final: true,
      ...(segment.confidence !== undefined ? { confidence: segment.confidence } : {})
    };
    this.current[segment.source] = utterance;
    return { ...utterance, segmentIds: [...utterance.segmentIds] };
  }

  flush(source?: TranscriptSource): TranscriptUtterance[] {
    if (source) {
      const value = this.current[source];
      delete this.current[source];
      return value ? [{ ...value, segmentIds: [...value.segmentIds] }] : [];
    }
    const values = (Object.keys(this.current) as TranscriptSource[]).flatMap((item) => this.flush(item));
    return values;
  }

  clear(): void {
    delete this.current.mic;
    delete this.current.remote;
  }
}
