export const TECHNICAL_DOMAINS = [
  "common_cs",
  "c_cpp",
  "embedded",
  "linux",
  "network",
  "database",
  "java",
  "backend",
  "frontend",
  "algorithm",
  "ai_cv",
  "fpga_ic",
  "devops",
  "project",
  "resume",
  "job"
] as const;

export type TechnicalDomain = typeof TECHNICAL_DOMAINS[number];
export type TechnicalTermSource = "builtin" | "resume" | "job" | "project" | "user" | "session";
export type TerminologyRolloutMode = "legacy" | "shadow" | "high_confidence" | "dynamic";

export interface TechnicalTerm {
  id: string;
  canonical: string;
  aliases: string[];
  phoneticAliases?: string[];
  domains: TechnicalDomain[];
  source: TechnicalTermSource;
  priority: number;
  tags?: string[];
}

export interface TerminologyCandidate {
  raw: string;
  canonical: string;
  confidence: number;
  source: TechnicalTermSource;
  domains: TechnicalDomain[];
  reason: string;
  termId: string;
}

export interface TechnicalTerminologyCorrection {
  raw: string;
  canonical: string;
  confidence: number;
  source: TechnicalTermSource;
  domain?: TechnicalDomain;
  reason: string;
}

export interface TerminologyMetrics {
  rawTermsSeen: number;
  correctionsApplied: number;
  highConfidenceCorrections: number;
  mediumCandidates: number;
  correctionRejected: number;
  userCorrections: number;
  falseNormalizations: number;
  domainHits: number;
  projectTermHits: number;
  durationMs: number;
}

export interface DomainRoute {
  primaryDomains: TechnicalDomain[];
  secondaryDomains: TechnicalDomain[];
  cacheKey: string;
}

export interface SessionTerminologyContext {
  terms: readonly TechnicalTerm[];
  primaryDomains: readonly TechnicalDomain[];
  secondaryDomains: readonly TechnicalDomain[];
  sourceCounts: Readonly<Record<TechnicalTermSource, number>>;
  builtAt: number;
}

export interface TerminologyNormalizationOptions {
  contextText?: string;
  previousQuestion?: string;
  currentTopic?: string;
  partial?: boolean;
}

export interface TechnicalTerminologyResolution {
  rawText: string;
  normalizedText: string;
  canonicalText: string;
  text: string;
  corrections: import("../terminology").TerminologyCorrection[];
  candidates: TerminologyCandidate[];
  metrics: TerminologyMetrics;
  mode: TerminologyRolloutMode;
  normalizationMs: number;
  confidence: number;
  possibleTerms: Array<{ value: string; score: number }>;
}
