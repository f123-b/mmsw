import { isFactEligible } from "./project-fact-eligibility";
import type { ProjectFact, ProjectMemoryProject } from "./types";

/** Derives display fields from facts so the Project View has one source of truth. */
export function deriveProjectView(project: ProjectMemoryProject, facts: ProjectFact[]): ProjectMemoryProject {
  const eligible = facts.filter((fact) => fact.projectId === project.id && isFactEligible(fact));
  const values = (types: ProjectFact["type"][]) => [...new Set(eligible.filter((fact) => types.includes(fact.type)).flatMap((fact) => fact.type === "technology" || fact.type === "hardware" || fact.type === "software" ? [fact.title || fact.content] : []))];
  const first = (types: ProjectFact["type"][]) => eligible.find((fact) => types.includes(fact.type))?.content?.trim() ?? "";
  const responsibility = eligible.find((fact) => fact.type === "responsibility" && fact.ownership === "self")?.content?.trim() ?? "";
  const description = first(["background", "goal"]) || project.description;
  const hardware = values(["hardware"]);
  const software = values(["software"]);
  const technologyStack = values(["technology"]);
  return {
    ...project,
    description,
    role: responsibility,
    // Existing legacy arrays are retained only as a migration fallback; every
    // subsequent analysis writes the same values back as atomic facts.
    hardware: project.hardware.length ? project.hardware : hardware,
    software: project.software.length ? project.software : software,
    technologyStack: project.technologyStack.length ? project.technologyStack : technologyStack,
    sourceIds: [...new Set([...project.sourceIds, ...eligible.flatMap((fact) => fact.sourceIds)])],
    confidence: eligible.length ? Math.max(...eligible.map((fact) => fact.confidence), project.confidence) : project.confidence
  };
}
