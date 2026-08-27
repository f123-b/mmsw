import { describe, expect, it } from "vitest";
import { ProjectGroundingService } from "./grounding";
import type { ProjectUnderstanding } from "./types";

describe("ProjectUnderstanding grounding", () => {
  it("keeps only claims with known evidence references and records the gap", () => {
    const value = { projectId: "grounding-project", schemaVersion: 1, status: "synthesizing", identity: { name: "Grounding" }, summary: "这是一个用于测试项目理解 Grounding 的摘要，声明必须能够回到证据。", architecture: { components: [{ id: "c", name: "Core", kind: "other", description: "core", confidence: 0.9, evidenceRefs: ["ref"] }], relationships: [{ from: "c", to: "x", relation: "calls", evidenceRefs: ["missing"] }] }, runtimeFlows: [{ id: "flow", name: "Unsupported Flow", kind: "runtime", description: "unknown", steps: [], evidenceRefs: ["missing"] }], dataFlows: [], controlFlows: [], technologies: [], parameters: [], decisions: [], problems: [], interfaces: [], protections: [], tests: [], results: [], limitations: [], unknowns: [], evidenceRefs: [{ id: "ref", sourceId: "source", quote: "core", kind: "code", confidence: 0.9 }], quality: { architectureCoverage: 10, flowCoverage: 10, parameterCoverage: 0, decisionCoverage: 0, problemCoverage: 0, groundingCoverage: 0, sufficient: false }, trace: { toolCalls: 1, filesRead: 1, modelTurns: 0, elapsedMs: 1, stages: ["synthesizing"] } } as ProjectUnderstanding;
    const result = new ProjectGroundingService().ground(value);
    expect(result.understanding.architecture.relationships).toHaveLength(0);
    expect(result.understanding.runtimeFlows).toHaveLength(0);
    expect(result.ungroundedClaims).toBeGreaterThan(0);
    expect(result.understanding.unknowns.some((unknown) => unknown.category === "general")).toBe(true);
  });
});

