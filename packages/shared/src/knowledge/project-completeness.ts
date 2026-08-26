import { calculateProjectDataHealth, type ProjectDataHealthResult } from "./project-data-health";
import { isFactEligible, isFactUserActionRequired } from "./project-fact-eligibility";
import { listConflictGroups, listUserActions } from "./project-actions";
import { normalizeProjectOwnershipMode } from "./project-technical-memory";
import type { ProjectFact, ProjectFactType, ProjectMemoryModule, ProjectMemoryProject, ProjectProblem, ProjectInterviewQuestion, ProjectOwnershipMode } from "./types";

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
  conflictGroups: number;
  userActions: number;
  questionCoverage: number;
  verificationScore: number;
  interviewReadinessScore: number;
  projectFamiliarityScore: number;
  technicalCoverageScore: number;
  parameterCoverageScore: number;
  decisionCoverageScore: number;
  problemCoverageScore: number;
  familiarityDimensions: ProjectFamiliarityDimension[];
  dimensions: ProjectCompletenessDimension[];
  missingFactTypes: ProjectFactType[];
  weakEvidence: string[];
  conflicts: string[];
  staleQuestions: string[];
  sourceCoverage: number;
  dataHealth: ProjectDataHealthResult;
}

export interface ProjectFamiliarityDimension {
  key: string;
  label: string;
  weight: number;
  score: number;
  factCount: number;
  eligibleFactCount: number;
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

const FAMILIARITY_DIMENSIONS: Array<{ key: string; label: string; weight: number; factTypes: ProjectFactType[] }> = [
  { key: "background", label: "背景", weight: 8, factTypes: ["background", "goal"] },
  { key: "architecture", label: "架构", weight: 12, factTypes: ["architecture"] },
  { key: "hardware", label: "硬件", weight: 10, factTypes: ["hardware"] },
  { key: "technology", label: "技术", weight: 18, factTypes: ["technology", "software"] },
  { key: "modules", label: "模块", weight: 12, factTypes: ["module"] },
  { key: "parameters", label: "关键参数", weight: 12, factTypes: ["parameter"] },
  { key: "decisions", label: "技术决策", weight: 10, factTypes: ["technical_decision", "decision"] },
  { key: "problems", label: "问题", weight: 12, factTypes: ["challenge", "cause", "solution"] },
  { key: "results", label: "结果", weight: 6, factTypes: ["result", "metric"] }
];

function relevantFacts(facts: ProjectFact[], types: ProjectFactType[]): ProjectFact[] { return facts.filter((fact) => types.includes(fact.type) && !fact.stale && fact.status !== "rejected"); }
function hasEvidence(fact: ProjectFact): boolean { return Boolean(fact.evidence?.some((item) => item.quote.trim() && item.sourceId)); }
function isNotMeasured(fact: ProjectFact): boolean { return fact.evidenceLevel === "not-measured" || /未测量|未测试|没有正式 benchmark|无正式 benchmark/i.test(fact.content); }

function coverageValue(status: ProjectSourceCoverageStatus, missingKind?: ProjectMissingKind): number {
  if (missingKind === "not_measured") return 0;
  return status === "covered" ? 1 : status === "weak" || status === "conflicting" ? 0.5 : 0;
}

function familiarityValue(facts: ProjectFact[]): number {
  if (facts.some((fact) => fact.status === "conflicting" || fact.conflictStatus === "conflicting")) return 25;
  if (!facts.length) return 0;
  const eligible = facts.filter(isFactEligible).length;
  return eligible ? Math.round(eligible / facts.length * 100) : 50;
}

function weightedFamiliarityScore(dimensions: ProjectFamiliarityDimension[], keys: string[]): number {
  const selected = dimensions.filter((dimension) => keys.includes(dimension.key));
  const total = selected.reduce((sum, dimension) => sum + dimension.weight, 0);
  return total ? Math.round(selected.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) / total) : 0;
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
  const conflictGroups = listConflictGroups(facts);
  const ownershipMode: ProjectOwnershipMode = normalizeProjectOwnershipMode(input.project.ownershipMode);
  // Responsibility remains a compatibility dimension, but it is not part of
  // personal/reference technical familiarity or trust. Team/partial projects
  // keep the boundary signal in their critical review score.
  const trustDimensions = dimensions.filter((dimension) => dimension.key !== "responsibility" || ownershipMode === "team" || ownershipMode === "partial");
  const trustWeight = trustDimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const trustScore = Math.round((trustDimensions.reduce((sum, dimension) => sum + (relevantFacts(facts, dimension.factTypes).some(isFactEligible) ? dimension.weight : 0), 0) / trustWeight) * 100);
  const userActions = listUserActions(facts, input.project.id, ownershipMode);
  const criticalKeys = new Set(userActions.map((action) => action.id));
  const unresolvedCritical = new Set(userActions.filter((action) => action.status === "pending").map((action) => action.id));
  const userActionFactIds = new Set(userActions.flatMap((action) => action.factIds));
  // not-measured is an explicit, resolved absence of a benchmark. It affects
  // measurement coverage, but must not be counted as unresolved work.
  for (const fact of facts.filter((item) => isFactUserActionRequired(item, ownershipMode))) {
    if (fact.evidenceLevel === "not-measured") continue;
    if (userActionFactIds.has(fact.id)) continue;
    const key = fact.conflictGroupId && (fact.status === "conflicting" || fact.conflictStatus === "conflicting") ? `conflict:${fact.conflictGroupId}` : `fact:${fact.id}`;
    if (!criticalKeys.has(key) && !fact.conflictGroupId) { criticalKeys.add(key); unresolvedCritical.add(key); }
  }
  if ((ownershipMode === "team" || ownershipMode === "partial") && !facts.some((fact) => fact.type === "responsibility")) { criticalKeys.add("responsibility:missing"); unresolvedCritical.add("responsibility:missing"); }
  const criticalReviewScore = criticalKeys.size ? Math.round(((criticalKeys.size - unresolvedCritical.size) / criticalKeys.size) * 100) : 100;
  const familiarityDimensions = FAMILIARITY_DIMENSIONS.map((dimension) => {
    const matches = relevantFacts(facts, dimension.factTypes);
    return { ...dimension, score: familiarityValue(matches), factCount: matches.length, eligibleFactCount: matches.filter(isFactEligible).length };
  });
  const technicalCoverageScore = weightedFamiliarityScore(familiarityDimensions, ["background", "architecture", "hardware", "technology", "modules"]);
  const parameterCoverageScore = weightedFamiliarityScore(familiarityDimensions, ["parameters"]);
  const decisionCoverageScore = weightedFamiliarityScore(familiarityDimensions, ["decisions"]);
  const problemCoverageScore = weightedFamiliarityScore(familiarityDimensions, ["problems"]);
  const projectFamiliarityScore = Math.round(technicalCoverageScore * 0.30 + parameterCoverageScore * 0.20 + decisionCoverageScore * 0.15 + problemCoverageScore * 0.20 + trustScore * 0.15);
  const interviewReadinessScore = Math.round(projectFamiliarityScore * 0.75 + questionCoverage * 0.15 + criticalReviewScore * 0.10);
  const missingFactTypes = [...new Set(dimensions.filter((dimension) => dimension.missing || dimension.missingKind === "not_measured").flatMap((dimension) => dimension.factTypes))]
    .filter((type) => type !== "responsibility" || ownershipMode === "team" || ownershipMode === "partial");
  const legacySourceCoverage = facts.length ? Math.round((facts.filter(hasEvidence).length / facts.length) * 100) : 0;
  return {
    projectId: input.project.id,
    completeness: interviewReadinessScore,
    sourceCoverageScore,
    trustScore,
    criticalReviewScore,
    conflictGroups: conflictGroups.filter((group) => !group.resolved).length,
    userActions: userActions.length,
    questionCoverage,
    verificationScore,
    interviewReadinessScore,
    projectFamiliarityScore,
    technicalCoverageScore,
    parameterCoverageScore,
    decisionCoverageScore,
    problemCoverageScore,
    familiarityDimensions,
    dimensions,
    missingFactTypes,
    weakEvidence: facts.filter((fact) => !hasEvidence(fact) || fact.confidence < 0.65 || fact.evidenceLevel === "inferred" || fact.evidenceLevel === "risk").map((fact) => fact.id),
    conflicts: facts.filter((fact) => fact.status === "conflicting" || fact.conflictStatus === "conflicting").map((fact) => fact.id),
    staleQuestions,
    sourceCoverage: legacySourceCoverage,
    dataHealth: calculateProjectDataHealth(input.project)
  };
}
