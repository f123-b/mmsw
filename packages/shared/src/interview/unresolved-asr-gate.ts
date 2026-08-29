import type { TerminologyResolution } from "../terminology";

export type AsrUnderstandingQuality = "resolved" | "repairable" | "unresolved";

export interface UnresolvedAsrDecision {
  quality: AsrUnderstandingQuality;
  confidence: number;
  shouldAnswer: boolean;
  reason: string;
}

const GARBLED_ASR = /(?:非二G|二G的时里|时里|针头|电炉环|Woodloader)/iu;

/** Keeps low-quality ASR from becoming a high-confidence answer request. */
export class UnresolvedAsrGate {
  assess(text: string, resolution?: Pick<TerminologyResolution, "confidence" | "possibleTerms" | "corrections">): UnresolvedAsrDecision {
    const normalized = text.trim();
    const possibleTerms = resolution?.possibleTerms?.length ?? 0;
    const hasRepair = Boolean(resolution?.corrections?.length || possibleTerms);
    if (!normalized) return { quality: "unresolved", confidence: 0, shouldAnswer: false, reason: "empty-asr" };
    if (GARBLED_ASR.test(normalized) && !hasRepair) return { quality: "unresolved", confidence: 0.18, shouldAnswer: false, reason: "garbled-asr-without-repair" };
    if (possibleTerms > 0 || (resolution?.confidence ?? 1) < 0.7) return { quality: "repairable", confidence: resolution?.confidence ?? 0.64, shouldAnswer: false, reason: "ambiguous-terminology" };
    return { quality: "resolved", confidence: resolution?.confidence ?? 1, shouldAnswer: true, reason: "resolved" };
  }
}
