import { calculateProjectDataHealth, type ProjectDataHealthResult } from "./project-data-health";
import { isFactEligible } from "./project-fact-eligibility";
import type { ProjectFact, ProjectFactType, ProjectMemoryModule, ProjectMemoryProject, ProjectProblem, ProjectInterviewQuestion } from "./types";

export type ProjectSourceCoverageStatus = "covered" | "weak" | "missing" | "conflicting";
export type ProjectVerificationStatus = "confirmed" | "pending" | "missing" | "conflicting";
export type ProjectMissingKind = "missing" | "unknown" | "not_measured" | "pending" | "conflicting";

export interface ProjectCompletenessDimension {
  key: string;
  label: string;
  weight: number;
  status: "confirmed" | "pending" | "conflicting" | "missing";
  sourceStatus: ProjectSourceCoverageStatus;
  verificationStatus: ProjectVerificationStatus;
  missingKind?: ProjectMissingKind;
  missing: boolean;
  factTypes: ProjectFactType[];
}

export interface ProjectCompletenessResult {
  projectId: string;
  /** Compatibility alias. New UI should prefer interviewReadinessScore. */
  completeness: number;
  sourceCoverageScore: number;
  /** Percentage of weighted core dimensions backed by answer-eligible facts. */
  trustScore: number;
  /** Percentage of critical review items resolved; compatibility verificationScore is retained separately. */
  criticalReviewScore: number;
  questionCoverage: number;
  verificationScore: number;
  interviewReadinessScore: number;
  dimensions: ProjectCompletenessDimension[];
  missingFactTypes: ProjectFactType[];
  weakEvidence: string[];
  conflicts: string[];
  staleQuestions: string[];
  sourceCoverage: number;
  dataHealth: ProjectDataHealthResult;
}

const DIMENSIONS: Array<{ key: string; label: string; weight: number; factTypes: ProjectFactType[] }> = [
  { key: "background", label: "项目背景", weight: 10, factTypes: ["background", "goal"] },
  { key: "responsibility", label: "个人职责", weight: 15, factTypes: ["responsibility"] },
  { key: "technology", label: "技术实现", weight: 15, factTypes: ["technology", "technical_decision", "architecture", "hardware", "software"] },
  { key: "modules", label: "核心模块", weight: 10, factTypes: ["module"] },
  { key: "challenge", label: "真实难点", weight: 10, factTypes: ["challenge", "cause"] },
  { key: "solution", label: "解决方案", weight: 10, factTypes: ["solution", "decision"] },
  { key: "result", label: "项目结果", weight: 10, factTypes: ["result"] },
  { key: "measurement", label: "量化测试", weight: 10, factTypes: ["metric"] },
  { key: "application", label: "应用场景", weight: 10, factTypes: ["application"] }
];

function relevantFacts(facts: ProjectFact[], types: ProjectFactType[]): ProjectFact[] { return facts.filter((fact) => types.includes(fact.type) && !fact.stale && fact.status !== "rejected"); }
function hasEvidence(fact: ProjectFact): boolean { return Boolean(fact.evidence?.some((item) => item.quote.trim() && item.sourceId)); }
function isNotMeasured(fact: ProjectFact): boolean { return fact.evidenceLevel === "not-measured" || /未测量|未测试|没有正式 benchmark|无正式 benchmark/i.test(fact.content); }

function coverageValue(status: ProjectSourceCoverageStatus, missingKind?: ProjectMissingKind): number {
  if (missingKind === "not_measured") return 0;
  return status === "covered" ? 1 : status === "weak" || status === "conflicting" ? 0.5 : 0;
}

export function calculateProjectCompleteness(input: { project: ProjectMemoryProject; facts: ProjectFact[]; modules?: ProjectMemoryModule[]; problems?: ProjectProblem[]; questions?: ProjectInterviewQuestion[] }): ProjectCompletenessResult {
  // Runtime completeness is a trust report, so legacy project columns and
  // stale/rejected facts never count as evidence or coverage.
  const facts = input.facts.filter((fact) => fact.projectId === input.project.id && !fact.stale && fact.status !== "rejected");
  const dimensions = DIMENSIONS.map((dimension) => {
    const matches = relevantFacts(facts, dimension.factTypes);
    const conflicts = matches.some((fact) => fact.status === "conflicting" || fact.conflictStatus === "conflicting");
    const evidenced = matches.filter(hasEvidence);
    const hasContent = matches.length > 0;
    const notMeasured = dimension.key === "measurement" && matches.some(isNotMeasured);
    const sourceStatus: ProjectSourceCoverageStatus = conflicts ? "conflicting" : evidenced.length > 0 ? "covered" : hasContent ? "weak" : "missing";
    const verificationStatus: ProjectVerificationStatus = conflicts ? "conflicting" : matches.some(isFactEligible) ? "confirmed" : hasContent ? "pending" : "missing";
    const missingKind: ProjectMissingKind | undefined = conflicts ? "conflicting" : notMeasured ? "not_measured" : !hasContent ? "missing" : matches.some((fact) => fact.evidenceLevel === "pending") ? "pending" : sourceStatus === "weak" ? "unknown" : undefined;
    const status = conflicts ? "conflicting" : verificationStatus === "confirmed" ? "confirmed" : hasContent ? "pending" : "missing";
    return { ...dimension, status, sourceStatus, verificationStatus, ...(missingKind ? { missingKind } : {}), missing: sourceStatus === "missing", factTypes: dimension.factTypes } satisfies ProjectCompletenessDimension;
  });
  const totalWeight = DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0);
  const sourceCoverageScore = Math.round((dimensions.reduce((sum, dimension) => sum + coverageValue(dimension.sourceStatus, dimension.missingKind) * dimension.weight, 0) / totalWeight) * 100);
  const trustScore = Math.round((dimensions.reduce((sum, dimension) => sum + (relevantFacts(facts, dimension.factTypes).some(isFactEligible) ? dimension.weight : 0), 0) / totalWeight) * 100);
  const reviewableFacts = facts.filter(hasEvidence);
  // Compatibility only: callers that still display this field can see the
  // old manual-click ratio, but the readiness score no longer uses it.
  const verificationScore = reviewableFacts.length ? Math.round((reviewableFacts.filter((fact) => fact.verified && fact.status !== "conflicting").length / reviewableFacts.length) * 100) : 0;
  const questions = (input.questions ?? []).filter((question) => question.projectId === input.project.id);
  const usableQuestions = questions.filter((question) => Boolean(question.factIds?.length) && !question.stale && question.factIds?.every((factId) => facts.some((fact) => fact.id === factId && isFactEligible(fact))));
  const questionCoverage = questions.length ? Math.round((usableQuestions.length / questions.length) * 100) : 0;
  const staleQuestions = questions.filter((question) => Boolean(question.stale || question.factIds?.some((factId) => {
    const fact = input.facts.find((item) => item.id === factId);
    return !fact || fact.stale || fact.status === "rejected" || !isFactEligible(fact);
  }))).map((question) => question.id);
  const criticalKeys = new Set<string>();
  const unresolvedCritical = new Set<string>();
  for (const fact of facts) {
    const critical = fact.type === "responsibility" || fact.type === "result" || fact.type === "metric" || fact.evidenceLevel === "risk" || (fact.evidenceLevel === "inferred" && ["responsibility", "result", "metric"].includes(fact.type)) || fact.status === "conflicting" || fact.conflictStatus === "conflicting";
    if (!critical) continue;
    const key = fact.conflictGroupId && (fact.status === "conflicting" || fact.conflictStatus === "conflicting") ? `conflict:${fact.conflictGroupId}` : `fact:${fact.id}`;
    criticalKeys.add(key);
    if (!isFactEligible(fact)) unresolvedCritical.add(key);
  }
  if (!facts.some((fact) => fact.type === "responsibility")) { criticalKeys.add("responsibility:missing"); unresolvedCritical.add("responsibility:missing"); }
  const criticalReviewScore = criticalKeys.size ? Math.round(((criticalKeys.size - unresolvedCritical.size) / criticalKeys.size) * 100) : 100;
  const interviewReadinessScore = Math.round(sourceCoverageScore * 0.35 + trustScore * 0.35 + criticalReviewScore * 0.20 + questionCoverage * 0.10);
  const missingFactTypes = [...new Set(dimensions.filter((dimension) => dimension.missing || dimension.missingKind === "not_measured").flatMap((dimension) => dimension.factTypes))];
  const legacySourceCoverage = facts.length ? Math.round((facts.filter(hasEvidence).length / facts.length) * 100) : 0;
  return {
    projectId: input.project.id,
    completeness: interviewReadinessScore,
    sourceCoverageScore,
    trustScore,
    criticalReviewScore,
    questionCoverage,
    verificationScore,
    interviewReadinessScore,
    dimensions,
    missingFactTypes,
    weakEvidence: facts.filter((fact) => !hasEvidence(fact) || fact.confidence < 0.65 || fact.evidenceLevel === "inferred" || fact.evidenceLevel === "risk").map((fact) => fact.id),
    conflicts: facts.filter((fact) => fact.status === "conflicting" || fact.conflictStatus === "conflicting").map((fact) => fact.id),
    staleQuestions,
    sourceCoverage: legacySourceCoverage,
    dataHealth: calculateProjectDataHealth(input.project)
  };
}
