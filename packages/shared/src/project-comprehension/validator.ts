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
    for (const component of input.architecture.components) {
      if (!(component.files?.length || component.symbols?.length) || !(component.evidenceRefs?.length)) issues.push(`component-grounding-missing:${component.name}`);
    }
    if (input.runtimeFlows.length + input.dataFlows.length + input.controlFlows.length === 0 && !input.unknowns.some((unknown) => unknown.category === "flow")) issues.push("flows-missing");
    const refs = new Set(input.evidenceRefs.map((ref) => ref.id));
    const components = new Set(input.architecture.components.map((component) => component.name));
    for (const relationship of input.architecture.relationships) {
      if (relationship.evidenceRefs.some((ref) => !refs.has(ref))) issues.push(`relationship-evidence-invalid:${relationship.from}:${relationship.to}`);
      if (relationship.verificationStatus === "confirmed" && !["direct", "strong"].includes(relationship.evidenceStrength ?? "unsupported")) issues.push(`relationship-not-grounded:${relationship.from}:${relationship.to}`);
      if (relationship.verificationStatus === "confirmed" && relationship.source === "semantic" && !relationship.semanticEdgeId) issues.push(`semantic-edge-id-missing:${relationship.from}:${relationship.to}`);
      if (relationship.verificationStatus === "confirmed" && relationship.source === "semantic" && input.semanticGraph && !input.semanticGraph.edges.some((edge) => edge.id === relationship.semanticEdgeId || `${edge.from}|${edge.to}|${edge.relation}|${edge.dataObjectId ?? ""}` === relationship.semanticEdgeId)) issues.push(`semantic-edge-missing:${relationship.from}:${relationship.to}`);
      if (!components.has(relationship.from) || !components.has(relationship.to)) issues.push(`relationship-component-missing:${relationship.from}:${relationship.to}`);
    }
    const semanticKeys = new Set<string>();
    for (const parameter of input.parameters) {
      if (semanticKeys.has(parameter.semanticKey)) issues.push(`parameter-semantic-duplicate:${parameter.semanticKey}`);
      semanticKeys.add(parameter.semanticKey);
      if (parameter.evidenceRefs.some((ref) => !refs.has(ref))) issues.push(`parameter-evidence-invalid:${parameter.id}`);
      if (parameter.value !== undefined && !parameter.context) issues.push(`parameter-context-missing:${parameter.id}`);
      if (parameter.versionStatus === "historical" && !parameter.historicalValues?.length) issues.push(`historical-git-evidence-missing:${parameter.id}`);
    }
    for (const flow of [...input.runtimeFlows, ...input.dataFlows, ...input.controlFlows]) {
      if ((flow.evidenceRefs ?? []).some((ref) => !refs.has(ref))) issues.push(`flow-evidence-invalid:${flow.id}`);
      for (const step of flow.steps) if (step.component && !components.has(step.component)) issues.push(`flow-component-missing:${flow.id}:${step.component}`);
      if (flow.partial && !(flow.missingLinks?.length)) issues.push(`partial-flow-missing-links:${flow.id}`);
    }
    return { valid: issues.length === 0, issues };
  }
}
