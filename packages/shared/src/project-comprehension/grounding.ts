import type { ProjectUnderstanding } from "./types";

function validRefs(understanding: ProjectUnderstanding, refs: string[]): string[] {
  const available = new Set(understanding.evidenceRefs.map((ref) => ref.id));
  return [...new Set(refs.filter((ref) => available.has(ref)))];
}

export interface ProjectGroundingResult {
  understanding: ProjectUnderstanding;
  groundedClaims: number;
  ungroundedClaims: number;
}

/**
 * Grounding is deliberately separate from comprehension. It only accepts
 * evidence references already found by the explorer and never writes Facts.
 */
export class ProjectGroundingService {
  ground(input: ProjectUnderstanding): ProjectGroundingResult {
    const components = input.architecture.components.filter((item) => validRefs(input, item.evidenceRefs ?? []).length > 0).map((item) => ({ ...item, evidenceRefs: validRefs(input, item.evidenceRefs ?? []) }));
    const relationships = input.architecture.relationships.filter((item) => validRefs(input, item.evidenceRefs).length > 0).map((item) => ({ ...item, evidenceRefs: validRefs(input, item.evidenceRefs) }));
    const allFlows = [...input.runtimeFlows, ...input.dataFlows, ...input.controlFlows];
    const flows = allFlows.filter((flow) => validRefs(input, flow.evidenceRefs ?? []).length > 0).map((flow) => ({ ...flow, evidenceRefs: validRefs(input, flow.evidenceRefs ?? []), steps: flow.steps.map((step) => ({ ...step, ...(step.evidenceRefs ? { evidenceRefs: validRefs(input, step.evidenceRefs) } : {}) })) }));
    const parameters = input.parameters.filter((item) => validRefs(input, item.evidenceRefs).length > 0).map((item) => ({ ...item, evidenceRefs: validRefs(input, item.evidenceRefs) }));
    const decisions = input.decisions.filter((item) => validRefs(input, item.evidenceRefs).length > 0).map((item) => ({ ...item, evidenceRefs: validRefs(input, item.evidenceRefs) }));
    const problems = input.problems.filter((item) => validRefs(input, item.evidenceRefs).length > 0).map((item) => ({ ...item, evidenceRefs: validRefs(input, item.evidenceRefs) }));
    const groundedClaims = components.length + relationships.length + flows.length + parameters.length + decisions.length + problems.length;
    const totalClaims = input.architecture.components.length + input.architecture.relationships.length + allFlows.length + input.parameters.length + input.decisions.length + input.problems.length;
    const unknowns = [...input.unknowns];
    if (totalClaims > groundedClaims) unknowns.push({ id: `unknown-grounding-${input.projectId}`, claim: "部分项目理解声明缺少可定位证据", reason: "探索范围或资料不足，不能升级为已确认事实。", category: "general", evidenceRefs: [] });
    const next: ProjectUnderstanding = {
      ...input,
      status: "completed",
      architecture: { ...input.architecture, components, relationships },
      runtimeFlows: flows.filter((flow) => input.runtimeFlows.some((candidate) => candidate.id === flow.id)),
      dataFlows: flows.filter((flow) => input.dataFlows.some((candidate) => candidate.id === flow.id)),
      controlFlows: flows.filter((flow) => input.controlFlows.some((candidate) => candidate.id === flow.id)),
      parameters,
      decisions,
      problems,
      unknowns,
      quality: { ...input.quality, groundingCoverage: totalClaims === 0 ? 0 : Math.round((groundedClaims / totalClaims) * 100) }
    };
    return { understanding: next, groundedClaims, ungroundedClaims: Math.max(0, totalClaims - groundedClaims) };
  }
}

export function groundProjectUnderstanding(input: ProjectUnderstanding): ProjectGroundingResult {
  return new ProjectGroundingService().ground(input);
}
