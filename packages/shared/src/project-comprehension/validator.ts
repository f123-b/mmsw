import type { ProjectUnderstanding } from "./types";

export interface ProjectUnderstandingValidationResult {
  valid: boolean;
  issues: string[];
}

export class ProjectUnderstandingValidator {
  validate(input: ProjectUnderstanding): ProjectUnderstandingValidationResult {
    const issues: string[] = [];
    if (!input.projectId.trim()) issues.push("project-id-missing");
    if (!input.identity.name.trim()) issues.push("identity-name-missing");
    if (input.summary.trim().length < 40 || input.summary.trim().length > 220) issues.push("summary-length-invalid");
    if (input.architecture.components.length === 0) issues.push("components-missing");
    if (input.runtimeFlows.length + input.dataFlows.length + input.controlFlows.length === 0 && !input.unknowns.some((unknown) => unknown.category === "flow")) issues.push("flows-missing");
    const refs = new Set(input.evidenceRefs.map((ref) => ref.id));
    for (const relationship of input.architecture.relationships) if (relationship.evidenceRefs.some((ref) => !refs.has(ref))) issues.push(`relationship-evidence-invalid:${relationship.from}:${relationship.to}`);
    for (const flow of [...input.runtimeFlows, ...input.dataFlows, ...input.controlFlows]) if ((flow.evidenceRefs ?? []).some((ref) => !refs.has(ref))) issues.push(`flow-evidence-invalid:${flow.id}`);
    return { valid: issues.length === 0, issues };
  }
}
