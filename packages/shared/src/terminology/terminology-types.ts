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
  "motor_control",
  "control_algorithm",
  "robotics",
  "ros",
  "ai_application",
  "llm",
  "computer_vision",
  "computer_architecture",
  "verification",
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
  /** Optional direction metadata; absent contexts retain the legacy route contract. */
  domainContext?: InterviewDomainContext;
}

export type InterviewDirectionMode = "auto" | "manual" | "hybrid";
export type InterviewDirectionId = string;

export interface InterviewDirectionSelection {
  /** Optional for backward compatibility; new saved selections default to hybrid. */
  mode?: InterviewDirectionMode;
  /** Exactly one preferred direction after normalization. */
  primaryDirectionId?: InterviewDirectionId;
  /** Zero or more supporting directions, ordered by user preference. */
  secondaryDirectionIds?: InterviewDirectionId[];
  /** Additive convenience field accepted from older UI drafts. */
  selectedDirectionIds?: InterviewDirectionId[];
  /** Used when the custom direction preset is selected. */
  customDomains?: TechnicalDomain[];
  /** Hybrid mode may supplement selected directions with JD/resume/project routing. */
  allowAutoSecondary?: boolean;
}

export interface InterviewDirectionPreset {
  id: InterviewDirectionId;
  label: string;
  description: string;
  category: "general" | "software" | "hardware" | "ai" | "custom";
  primaryDomains: readonly TechnicalDomain[];
  secondaryDomains: readonly TechnicalDomain[];
  terminologyPackIds?: readonly string[];
}

export type InterviewDomainWeightSource = "current_topic" | "current_project" | "primary" | "secondary" | "job" | "resume" | "project" | "auto";

export interface InterviewDomainWeight {
  domain: TechnicalDomain;
  weight: number;
  source: InterviewDomainWeightSource;
  directionId?: InterviewDirectionId;
}

export interface InterviewDomainContext {
  mode: InterviewDirectionMode;
  primaryDirectionId?: InterviewDirectionId;
  secondaryDirectionIds: readonly InterviewDirectionId[];
  primaryDomains: readonly TechnicalDomain[];
  secondaryDomains: readonly TechnicalDomain[];
  autoPrimaryDomains: readonly TechnicalDomain[];
  autoSecondaryDomains: readonly TechnicalDomain[];
  effectiveDomains: readonly InterviewDomainWeight[];
  selectedDirectionIds: readonly InterviewDirectionId[];
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
