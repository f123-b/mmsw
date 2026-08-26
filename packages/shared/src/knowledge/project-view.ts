import { isFactEligible } from "./project-fact-eligibility";
import { buildTechnologyTaxonomy, normalizeTechnologies } from "./project-taxonomy";
import type { ProjectFact, ProjectMemoryProject } from "./types";

const OVERVIEW_META = /根据.*(?:代码|文档|仓库).*确认|考察点|已知可答|项目根目录|源文件|是否适合|回答依据|README\s*中|仓库中|证据如下|面试官/i;

export function isGoodOverviewFact(fact: ProjectFact): boolean {
  if (fact.type !== "background" && fact.type !== "goal") return false;
  const content = fact.content.trim();
  return Boolean(content) && !OVERVIEW_META.test(content) && !/^项目(?:背景|目标|介绍)?\s*[:：]?$/.test(content);
}

function cleanOverviewText(value: string): string {
  return value.replace(/^\s*(?:项目背景|项目介绍|项目目标|项目目的|background|goal)\s*[:：|]?\s*/i, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function overviewQuality(fact: ProjectFact): number {
  const evidence = fact.evidence?.filter((item) => item.quote.trim() && item.relation !== "refute").length ?? 0;
  return fact.confidence * 10 + evidence * 2 + Math.min(8, fact.content.length / 40);
}

/** Deterministic 10-second project card summary; it never calls an LLM. */
export function deriveProjectSummary(facts: ProjectFact[]): string {
  const candidates = facts.filter(isGoodOverviewFact).sort((left, right) => overviewQuality(right) - overviewQuality(left) || left.id.localeCompare(right.id));
  const background = candidates.find((fact) => fact.type === "background");
  const goal = candidates.find((fact) => fact.type === "goal");
  const values = [background, goal].map((fact) => fact ? cleanOverviewText(fact.content) : "").filter(Boolean);
  const unique = values.filter((value, index) => !values.slice(0, index).some((previous) => previous === value || previous.includes(value) || value.includes(previous)));
  return unique.join("；").slice(0, 180);
}

function factValues(facts: ProjectFact[], types: ProjectFact["type"][]): string[] {
  return normalizeTechnologies(facts.filter((fact) => types.includes(fact.type)).map((fact) => fact.title || fact.content));
}

/** Derives display fields from eligible facts; legacy project columns are never a fallback. */
export function deriveProjectView(project: ProjectMemoryProject, facts: ProjectFact[]): ProjectMemoryProject {
  const eligible = facts.filter((fact) => fact.projectId === project.id && isFactEligible(fact));
  const hardware = factValues(eligible, ["hardware"]);
  const software = factValues(eligible, ["software"]);
  const technologyFacts = eligible.filter((fact) => ["technology", "hardware", "software"].includes(fact.type));
  const technologyStack = factValues(eligible, ["technology", "technical_decision"]);
  const responsibilities = eligible.filter((fact) => fact.type === "responsibility" && fact.ownership === "self").map((fact) => cleanOverviewText(fact.content)).filter(Boolean).slice(0, 5);
  const timeline = eligible.find((fact) => fact.type === "timeline" && fact.title === "项目时间")?.content.trim();
  return {
    ...project,
    description: deriveProjectSummary(eligible),
    role: responsibilities.join("；"),
    hardware,
    software,
    technologyStack,
    technologyTaxonomy: buildTechnologyTaxonomy(technologyFacts),
    ...(timeline ? { time: timeline } : { time: undefined }),
    sourceIds: [...new Set(eligible.flatMap((fact) => fact.sourceIds))],
    confidence: eligible.length ? Math.max(...eligible.map((fact) => fact.confidence)) : 0
  };
}
