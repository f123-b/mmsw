import { calculateProjectDataHealth, type ProjectDataHealthResult } from "./project-data-health";
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

function relevantFacts(facts: ProjectFact[], types: ProjectFactType[]): ProjectFact[] { return facts.filter((fact) => types.includes(fact.type) && fact.status !== "rejected"); }
function hasEvidence(fact: ProjectFact): boolean { return Boolean(fact.evidence?.some((item) => item.quote.trim() && item.sourceId)); }
function isNotMeasured(fact: ProjectFact): boolean { return fact.evidenceLevel === "not-measured" || /未测量|未测试|没有正式 benchmark|无正式 benchmark/i.test(fact.content); }
function fallbackPresent(key: string, input: { project: ProjectMemoryProject; modules?: ProjectMemoryModule[]; problems?: ProjectProblem[] }): boolean {
  if (key === "background") return input.project.description.trim().length >= 15 && input.project.description !== "资料未明确记录";
  if (key === "responsibility") return input.project.role.trim().length >= 4 && input.project.role !== "资料未明确记录";
  if (key === "technology") return Boolean(input.project.technologyStack.length || input.project.hardware.length || input.project.software.length);
  if (key === "modules") return Boolean(input.modules?.some((item) => item.projectId === input.project.id));
  if (key === "challenge") return Boolean(input.problems?.some((item) => item.projectId === input.project.id));
  return false;
}

function coverageValue(status: ProjectSourceCoverageStatus, missingKind?: ProjectMissingKind): number {
  if (missingKind === "not_measured") return 0;
  return status === "covered" ? 1 : status === "weak" || status === "conflicting" ? 0.5 : 0;
}

export function calculateProjectCompleteness(input: { project: ProjectMemoryProject; facts: ProjectFact[]; modules?: ProjectMemoryModule[]; problems?: ProjectProblem[]; questions?: ProjectInterviewQuestion[] }): ProjectCompletenessResult {
  const facts = input.facts.filter((fact) => fact.projectId === input.project.id && fact.status !== "rejected");
  const dimensions = DIMENSIONS.map((dimension) => {
    const matches = relevantFacts(facts, dimension.factTypes);
    const fallback = fallbackPresent(dimension.key, input);
    const conflicts = matches.some((fact) => fact.status === "conflicting" || fact.conflictStatus === "conflicting");
    const evidenced = matches.filter(hasEvidence);
    const hasContent = matches.length > 0 || fallback;
    const notMeasured = dimension.key === "measurement" && matches.some(isNotMeasured);
    const sourceStatus: ProjectSourceCoverageStatus = conflicts ? "conflicting" : evidenced.length > 0 ? "covered" : hasContent ? "weak" : "missing";
    const verificationStatus: ProjectVerificationStatus = conflicts ? "conflicting" : matches.some((fact) => fact.verified && hasEvidence(fact)) ? "confirmed" : hasContent ? "pending" : "missing";
    const missingKind: ProjectMissingKind | undefined = conflicts ? "conflicting" : notMeasured ? "not_measured" : !hasContent ? "missing" : matches.some((fact) => fact.evidenceLevel === "pending") ? "pending" : sourceStatus === "weak" ? "unknown" : undefined;
    const status = conflicts ? "conflicting" : verificationStatus === "confirmed" ? "confirmed" : hasContent ? "pending" : "missing";
    return { ...dimension, status, sourceStatus, verificationStatus, ...(missingKind ? { missingKind } : {}), missing: sourceStatus === "missing", factTypes: dimension.factTypes } satisfies ProjectCompletenessDimension;
  });
  const totalWeight = DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0);
  const sourceCoverageScore = Math.round((dimensions.reduce((sum, dimension) => sum + coverageValue(dimension.sourceStatus, dimension.missingKind) * dimension.weight, 0) / totalWeight) * 100);
  const reviewableFacts = facts.filter(hasEvidence);
  const verificationScore = reviewableFacts.length ? Math.round((reviewableFacts.filter((fact) => fact.verified && fact.status !== "conflicting").length / reviewableFacts.length) * 100) : 0;
  const questionCoverage = input.questions?.filter((question) => question.projectId === input.project.id && question.factIds?.some((factId) => facts.some((fact) => fact.id === factId))).length ?? 0;
  const questionScore = Math.min(1, questionCoverage / 3);
  const interviewReadinessScore = Math.round(sourceCoverageScore * 0.72 + verificationScore * 0.18 + questionScore * 10);
  const staleQuestions = (input.questions ?? []).filter((question) => question.projectId === input.project.id && question.factIds?.some((factId) => facts.find((fact) => fact.id === factId)?.status === "rejected" || facts.find((fact) => fact.id === factId)?.verified === false)).map((question) => question.id);
  const missingFactTypes = [...new Set(dimensions.filter((dimension) => dimension.missing || dimension.missingKind === "not_measured").flatMap((dimension) => dimension.factTypes))];
  const legacySourceCoverage = facts.length ? Math.round((facts.filter(hasEvidence).length / facts.length) * 100) : 0;
  return {
    projectId: input.project.id,
    completeness: interviewReadinessScore,
    sourceCoverageScore,
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
