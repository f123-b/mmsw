import { describe, expect, it } from "vitest";
import { ProjectComprehensionRetriever } from "./retrieval";
import type { ProjectUnderstanding } from "./types";

function understanding(): ProjectUnderstanding {
  const refs = ["e1", "e2", "e3"];
  const component = (id: string, name: string) => ({ id, name, kind: "other" as const, description: `${name} module`, files: [`src/${name.toLowerCase()}.c`], symbols: [name.toLowerCase()], confidence: 0.9, evidenceRefs: refs });
  const relationship = (from: string, to: string, relation: "calls" | "feeds", id: string) => ({ from, to, relation, evidenceRefs: refs, confidence: 0.95, evidenceStrength: "direct" as const, verificationStatus: "confirmed" as const, semanticEdgeId: id, source: "semantic" as const });
  return { projectId: "retrieval", schemaVersion: 3, status: "completed", identity: { name: "Retrieval" }, summary: "一个用于验证语义图扩展与混合路由的最小项目理解摘要。", architecture: { components: [component("a", "Gateway"), component("b", "DataBus"), component("c", "MQTT")], relationships: [relationship("Gateway", "DataBus", "calls", "a"), relationship("DataBus", "MQTT", "feeds", "b")] }, runtimeFlows: [], dataFlows: [], controlFlows: [], technologies: [], parameters: [], decisions: [], problems: [], interfaces: [], protections: [], tests: [], results: [], limitations: [], unknowns: [], evidenceRefs: refs.map((id) => ({ id, sourceId: "repo", quote: id, kind: "code" as const, confidence: 0.9 })), quality: { architectureCoverage: 100, flowCoverage: 0, parameterCoverage: 0, decisionCoverage: 0, problemCoverage: 0, groundingCoverage: 100, sufficient: true }, trace: { toolCalls: 1, filesRead: 3, modelTurns: 0, elapsedMs: 1, stages: ["completed"] } };
}

describe("Project comprehension graph retrieval", () => {
  it("uses hybrid route and explains one-to-two-hop graph expansion", () => {
    const result = new ProjectComprehensionRetriever().search("DataBus 模块流程", understanding(), 8);
    expect(result.primaryRoute).toBe("flow");
    expect(result.secondaryRoutes).toContain("architecture");
    expect(result.hits.some((hit) => hit.title === "DataBus feeds MQTT" && hit.whyRetrieved?.includes("graph expansion"))).toBe(true);
    expect(result.hits.some((hit) => hit.title === "MQTT" && hit.hop === 1)).toBe(true);
  });
});
