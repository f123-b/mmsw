import type { ProjectFact, ProjectFactType, ProjectMemoryModule, ProjectMemoryProject, ProjectProblem, ProjectInterviewQuestion } from "./types";

export interface ProjectCompletenessDimension {
  key: string;
  label: string;
  weight: number;
  status: "confirmed" | "pending" | "conflicting" | "missing";
  missing: boolean;
  factTypes: ProjectFactType[];
}

export interface ProjectCompletenessResult {
  projectId: string;
  completeness: number;
  dimensions: ProjectCompletenessDimension[];
  missingFactTypes: ProjectFactType[];
  weakEvidence: string[];
  conflicts: string[];
  staleQuestions: string[];
  sourceCoverage: number;
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

function relevantFacts(facts: ProjectFact[], types: ProjectFactType[]): ProjectFact[] {
  return facts.filter((fact) => types.includes(fact.type) && fact.status !== "rejected");
}

export function calculateProjectCompleteness(input: { project: ProjectMemoryProject; facts: ProjectFact[]; modules?: ProjectMemoryModule[]; problems?: ProjectProblem[]; questions?: ProjectInterviewQuestion[] }): ProjectCompletenessResult {
  const facts = input.facts.filter((fact) => fact.projectId === input.project.id && fact.status !== "rejected");
  const dimensions = DIMENSIONS.map((dimension) => {
    const matches = relevantFacts(facts, dimension.factTypes);
    const fallbackPresent = dimension.key === "background" ? Boolean(input.project.description.trim()) : dimension.key === "responsibility" ? Boolean(input.project.role.trim() && input.project.role !== "资料未明确记录") : dimension.key === "technology" ? Boolean(input.project.technologyStack.length || input.project.hardware.length || input.project.software.length) : dimension.key === "modules" ? Boolean(input.modules?.some((item) => item.projectId === input.project.id)) : dimension.key === "challenge" ? Boolean(input.problems?.some((item) => item.projectId === input.project.id)) : false;
    const hasContent = matches.length > 0 || fallbackPresent;
    const conflicting = matches.some((fact) => fact.status === "conflicting" || fact.conflictStatus === "conflicting");
    const confirmed = matches.some((fact) => fact.verified && fact.evidence?.length);
    const pending = matches.some((fact) => !fact.verified || !fact.evidence?.length) || (hasContent && !confirmed);
    return { ...dimension, status: conflicting ? "conflicting" : confirmed ? "confirmed" : pending ? "pending" : "missing", missing: !confirmed, factTypes: dimension.factTypes } satisfies ProjectCompletenessDimension;
  });
  const totalWeight = DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0);
  const score = dimensions.reduce((sum, dimension) => sum + (dimension.status === "confirmed" ? dimension.weight : dimension.status === "pending" ? dimension.weight * 0.5 : 0), 0);
  const allSourceIds = new Set(facts.flatMap((fact) => fact.evidence?.map((item) => item.sourceId) ?? fact.sourceIds));
  const withEvidence = facts.filter((fact) => (fact.evidence?.length ?? 0) > 0).length;
  const sourceCoverage = facts.length ? Math.round((withEvidence / facts.length) * 100) : allSourceIds.size ? 100 : 0;
  const staleQuestions = (input.questions ?? []).filter((question) => question.projectId === input.project.id && question.factIds?.some((factId) => facts.find((fact) => fact.id === factId)?.status === "rejected" || facts.find((fact) => fact.id === factId)?.verified === false)).map((question) => question.id);
  return {
    projectId: input.project.id,
    completeness: Math.round((score / totalWeight) * 100),
    dimensions,
    missingFactTypes: [...new Set(dimensions.filter((dimension) => dimension.missing).flatMap((dimension) => dimension.factTypes))],
    weakEvidence: facts.filter((fact) => !fact.evidence?.length || fact.confidence < 0.65).map((fact) => fact.id),
    conflicts: facts.filter((fact) => fact.status === "conflicting" || fact.conflictStatus === "conflicting").map((fact) => fact.id),
    staleQuestions,
    sourceCoverage
  };
}
