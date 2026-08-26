import { isFactEligible } from "./project-fact-eligibility";
import type { ProjectFact, ProjectMemoryProject } from "./types";

/** Derives display fields from facts so the Project View has one source of truth. */
export function deriveProjectView(project: ProjectMemoryProject, facts: ProjectFact[]): ProjectMemoryProject {
  const eligible = facts.filter((fact) => fact.projectId === project.id && isFactEligible(fact));
  const values = (types: ProjectFact["type"][]) => [...new Set(eligible.filter((fact) => types.includes(fact.type)).flatMap((fact) => fact.type === "technology" || fact.type === "hardware" || fact.type === "software" ? [fact.title || fact.content] : []))];
  const text = (types: ProjectFact["type"][], limit = 800) => eligible.filter((fact) => types.includes(fact.type)).map((fact) => fact.content.trim()).filter(Boolean).join("；").slice(0, limit);
  const responsibility = eligible.find((fact) => fact.type === "responsibility" && fact.ownership === "self")?.content?.trim() ?? "";
  const description = text(["background", "goal"]);
  const hardware = values(["hardware"]);
  const software = values(["software"]);
  const technologyStack = values(["technology", "technical_decision"]);
  const timeline = text(["timeline"], 200);
  return {
    ...project,
    description,
    role: responsibility,
    hardware,
    software,
    technologyStack,
    ...(timeline ? { time: timeline } : { time: undefined }),
    sourceIds: [...new Set(eligible.flatMap((fact) => fact.sourceIds))],
    confidence: eligible.length ? Math.max(...eligible.map((fact) => fact.confidence)) : 0
  };
}
