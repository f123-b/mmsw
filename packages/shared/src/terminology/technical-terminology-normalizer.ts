import { resolveContextualTerminology, type DynamicTechnicalLexicon } from "../terminology";
import { CandidateGenerator } from "./candidate-generator";
import { ConfidenceGate } from "./confidence-gate";
import { ContextScorer } from "./context-scorer";
import { buildSessionTerminologyContext, type DynamicLexiconInput } from "./dynamic-lexicon-builder";
import { DomainRouter } from "./domain-router";
import { normalizeTerminologyToken } from "./token-normalizer";
import type { SessionTerminologyContext, TechnicalTerm, TerminologyCandidate, TerminologyMetrics, TerminologyNormalizationOptions, TerminologyRolloutMode, TechnicalTerminologyResolution } from "./terminology-types";

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function sourceForCorrection(source: TechnicalTerm["source"]): import("../terminology").TerminologySource {
  return source === "resume" ? "resume" : source === "job" ? "job" : source === "user" ? "user" : source === "session" ? "session" : source;
}

function applyCandidate(text: string, candidate: TerminologyCandidate): string {
  if (!candidate.raw || normalizeTerminologyToken(candidate.raw) === normalizeTerminologyToken(candidate.canonical)) return text;
  const pattern = new RegExp(escapeRegex(candidate.raw), "giu");
  return text.replace(pattern, candidate.canonical);
}

function uniqueCandidates(candidates: readonly TerminologyCandidate[]): TerminologyCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.raw.toLocaleLowerCase()}\n${candidate.canonical}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface TechnicalTerminologyNormalizerOptions {
  context?: SessionTerminologyContext;
  mode?: TerminologyRolloutMode;
  now?: () => number;
}

/**
 * Compatibility facade: legacy rules remain first-class, while this layer
 * adds domain-aware candidates and a conservative rollout gate around them.
 */
export class TechnicalTerminologyNormalizer {
  private readonly candidateGenerator = new CandidateGenerator();
  private readonly contextScorer = new ContextScorer();
  private readonly confidenceGate = new ConfidenceGate();
  private readonly router = new DomainRouter();
  private contextValue: SessionTerminologyContext;
  private modeValue: TerminologyRolloutMode;
  private readonly now: () => number;

  constructor(options: TechnicalTerminologyNormalizerOptions = {}) {
    this.contextValue = options.context ?? buildSessionTerminologyContext();
    this.modeValue = options.mode ?? "high_confidence";
    this.now = options.now ?? (() => performance.now());
  }

  get context(): SessionTerminologyContext { return this.contextValue; }
  get mode(): TerminologyRolloutMode { return this.modeValue; }
  setContext(context: SessionTerminologyContext): void { this.contextValue = context; }
  setMode(mode: TerminologyRolloutMode): void { this.modeValue = mode; }

  buildSessionLexicon(input: DynamicLexiconInput): SessionTerminologyContext {
    const context = buildSessionTerminologyContext(input);
    this.setContext(context);
    return context;
  }

  suggestCorrections(text: string, options: TerminologyNormalizationOptions = {}): TerminologyCandidate[] {
    const route = this.router.route({ currentTopic: options.currentTopic, project: options.contextText, jd: options.previousQuestion });
    return uniqueCandidates(this.candidateGenerator.generate(text, this.contextValue.terms).map((candidate) => {
      const term = this.contextValue.terms.find((item) => item.id === candidate.termId) ?? this.contextValue.terms.find((item) => item.canonical === candidate.canonical);
      return term ? this.contextScorer.score({ candidate, term, route, contextText: [options.contextText, options.previousQuestion].filter(Boolean).join(" "), currentTopic: options.currentTopic }) : candidate;
    }));
  }

  normalizeTranscript(rawText: string, options: TerminologyNormalizationOptions & { legacyLexicon?: DynamicTechnicalLexicon } = {}): TechnicalTerminologyResolution {
    const startedAt = this.now();
    const legacy = resolveContextualTerminology(rawText, {
      contextText: options.contextText,
      previousQuestion: options.previousQuestion,
      topics: options.currentTopic ? [options.currentTopic] : [],
      lexicon: options.legacyLexicon
    });
    const candidates = this.suggestCorrections(legacy.normalizedText, options);
    let canonicalText = legacy.text;
    const applied: TerminologyCandidate[] = [];
    const medium: TerminologyCandidate[] = [];
    let rejected = 0;
    if (this.modeValue !== "legacy" && this.modeValue !== "shadow" && !options.partial) {
      for (const candidate of candidates) {
        const gate = this.confidenceGate.evaluate(candidate);
        if (gate.decision === "apply") {
          canonicalText = applyCandidate(canonicalText, candidate);
          applied.push(candidate);
        } else if (gate.decision === "candidate") medium.push(candidate);
        else rejected += 1;
      }
    } else {
      for (const candidate of candidates) {
        const gate = this.confidenceGate.evaluate(candidate);
        if (gate.decision === "candidate") medium.push(candidate);
        if (gate.decision === "reject") rejected += 1;
      }
    }
    const corrections = [
      ...legacy.corrections,
      ...applied.map((candidate) => ({ raw: candidate.raw, canonical: candidate.canonical, source: sourceForCorrection(candidate.source), confidence: candidate.confidence, reason: `technical-layer:${candidate.reason}`, context: options.contextText?.slice(0, 160) }))
    ];
    const rawTermsSeen = candidates.length;
    const metrics: TerminologyMetrics = {
      rawTermsSeen,
      correctionsApplied: applied.length + legacy.corrections.length,
      highConfidenceCorrections: applied.length,
      mediumCandidates: medium.length,
      correctionRejected: rejected,
      userCorrections: applied.filter((candidate) => candidate.source === "user").length,
      falseNormalizations: rejected,
      domainHits: candidates.filter((candidate) => candidate.reason.includes("domain")).length,
      projectTermHits: candidates.filter((candidate) => candidate.source === "project").length,
      durationMs: Math.max(0, this.now() - startedAt)
    };
    const possibleTerms = medium.map((candidate) => ({ value: candidate.canonical, score: candidate.confidence }));
    return {
      rawText,
      normalizedText: legacy.normalizedText,
      canonicalText: canonicalText.trim(),
      text: canonicalText.trim(),
      corrections,
      candidates: [...candidates],
      metrics,
      mode: this.modeValue,
      normalizationMs: metrics.durationMs,
      confidence: possibleTerms.length ? Math.min(0.64, ...possibleTerms.map((item) => item.score)) : 1,
      possibleTerms
    };
  }

  normalize(text: string, options: TerminologyNormalizationOptions & { legacyLexicon?: DynamicTechnicalLexicon } = {}): TechnicalTerminologyResolution {
    return this.normalizeTranscript(text, options);
  }

  testNormalization(text: string): TechnicalTerminologyResolution { return this.normalizeTranscript(text); }
  listTerms(): TechnicalTerm[] { return this.contextValue.terms.map((item) => ({ ...item, aliases: [...item.aliases], domains: [...item.domains] })); }
  getDiagnostics(): { mode: TerminologyRolloutMode; domains: string[]; sessionLexiconSize: number; sourceCounts: Readonly<Record<string, number>> } { return { mode: this.modeValue, domains: [...this.contextValue.primaryDomains, ...this.contextValue.secondaryDomains], sessionLexiconSize: this.contextValue.terms.length, sourceCounts: this.contextValue.sourceCounts }; }
}

export function createTechnicalTerminologyNormalizer(options: TechnicalTerminologyNormalizerOptions = {}): TechnicalTerminologyNormalizer {
  return new TechnicalTerminologyNormalizer(options);
}
