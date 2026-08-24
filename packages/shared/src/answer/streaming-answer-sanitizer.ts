const MODEL_OPENING = /^(?:这个问题(?:可以从以下几个方面回答|可以这样回答)|下面从以下几个方面回答)[：:，,、\s]*/;
const MODEL_OPENING_PREFIXES = ["这个问题可以从以下几个方面回答", "这个问题可以这样回答", "下面从以下几个方面回答"];

export function sanitizeStreamingAnswer(text: string): string {
  return text
    .replace(/###/g, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(MODEL_OPENING, "")
    .trimStart();
}

/** Deterministic stream cleanup; it never rewrites technical content. */
export class StreamingAnswerSanitizer {
  private raw = "";
  private emitted = "";
  private settled = false;

  push(delta: string): string {
    if (!delta) return "";
    this.raw += delta;
    // Hold only text that is still a prefix of a known model preamble. Normal
    // first sentences, including short answers, are released immediately so
    // cancellation and first-token latency do not lose useful content.
    const prefix = this.raw.trimStart();
    if (!this.settled && MODEL_OPENING_PREFIXES.some((opening) => opening.startsWith(prefix))) return "";
    this.settled = true;
    return this.release(sanitizeStreamingAnswer(this.raw));
  }

  finalize(): string {
    this.settled = true;
    const sanitized = sanitizeStreamingAnswer(this.raw);
    this.emitted = sanitized;
    return sanitized;
  }

  private release(sanitized: string): string {
    if (sanitized.startsWith(this.emitted)) {
      const delta = sanitized.slice(this.emitted.length);
      this.emitted = sanitized;
      return delta;
    }
    // A safe sanitizer can only remove text already emitted; it cannot ask
    // the HUD to retract a token, so keep the stream monotonic and let the
    // final answer carry the complete cleaned result.
    if (this.emitted.startsWith(sanitized)) return "";
    this.emitted = sanitized;
    return sanitized;
  }
}
