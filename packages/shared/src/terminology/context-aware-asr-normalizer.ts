import { TechnicalTerminologyNormalizer } from "./technical-terminology-normalizer";
import type { DynamicTechnicalLexicon } from "../terminology";
import type { SessionTerminologyContext, TerminologyRolloutMode, TechnicalTerminologyResolution } from "./terminology-types";

export interface ContextAwareAsrNormalizerInput {
  rawTranscript: string;
  projectLexicon?: DynamicTechnicalLexicon;
  technicalLexicon?: DynamicTechnicalLexicon;
  recentContext?: string[];
  previousQuestion?: string;
  currentTopic?: string;
  context?: SessionTerminologyContext;
  mode?: TerminologyRolloutMode;
}

export interface ContextAwareAsrNormalization {
  rawTranscript: string;
  normalizedTranscript: string;
  canonicalTranscript: string;
  corrections: TechnicalTerminologyResolution["corrections"];
  candidates: TechnicalTerminologyResolution["candidates"];
  confidence: number;
  normalizationMs: number;
}

/** Context-aware facade that keeps raw, normalized and canonical ASR text. */
export class ContextAwareAsrNormalizer {
  normalize(input: ContextAwareAsrNormalizerInput): ContextAwareAsrNormalization {
    const normalizer = new TechnicalTerminologyNormalizer({ context: input.context, mode: input.mode ?? "high_confidence" });
    const result = normalizer.normalizeTranscript(input.rawTranscript, {
      contextText: input.recentContext?.join("\n"),
      previousQuestion: input.previousQuestion,
      currentTopic: input.currentTopic,
      legacyLexicon: input.projectLexicon ?? input.technicalLexicon
    });
    return { rawTranscript: input.rawTranscript, normalizedTranscript: result.normalizedText, canonicalTranscript: result.canonicalText, corrections: [...result.corrections], candidates: [...result.candidates], confidence: result.confidence, normalizationMs: result.normalizationMs };
  }
}

export function normalizeContextAwareAsr(input: ContextAwareAsrNormalizerInput): ContextAwareAsrNormalization { return new ContextAwareAsrNormalizer().normalize(input); }
