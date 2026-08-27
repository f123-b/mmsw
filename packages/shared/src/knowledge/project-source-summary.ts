import { isFactEligible } from "./project-fact-eligibility";
import type { ProjectFact } from "./types";

export interface ProjectSourceExtractionSummary {
  totalFacts: number;
  parameters: number;
  technologies: number;
  architecture: number;
  modules: number;
  decisions: number;
  challenges: number;
  causes: number;
  solutions: number;
  results: number;
  metrics: number;
  limitations: number;
}

/** A read-only, source-scoped count of eligible facts. */
export function deriveSourceExtractionSummary(sourceId: string, projectFacts: ProjectFact[]): ProjectSourceExtractionSummary {
  const facts = projectFacts.filter((fact) => fact.sourceIds.includes(sourceId) && isFactEligible(fact));
  const count = (...types: ProjectFact["type"][]): number => facts.filter((fact) => types.includes(fact.type)).length;
  const notMeasured = facts.filter((fact) => fact.evidenceLevel === "not-measured" || /未测量|未测试|没有正式 benchmark|无正式 benchmark|尚未完成正式 benchmark|未完成正式 benchmark/i.test(fact.content));
  return {
    totalFacts: facts.length,
    parameters: count("parameter"),
    technologies: count("technology", "hardware", "software"),
    architecture: count("architecture"),
    modules: count("module"),
    decisions: count("technical_decision", "decision"),
    challenges: count("challenge"),
    causes: count("cause"),
    solutions: count("solution"),
    results: count("result"),
    metrics: count("metric"),
    limitations: count("limitation") + notMeasured.filter((fact) => fact.type === "metric" || fact.type === "result").length
  };
}
