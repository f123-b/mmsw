import { describe, expect, it } from "vitest";
import { calculateProjectCompleteness } from "./project-completeness";

describe("Project completeness", () => {
  it("uses deterministic weighted dimensions and reports missing evidence", () => {
    const result = calculateProjectCompleteness({
      project: { id: "p-1", name: "FOC", description: "电机控制", role: "负责固件", hardware: ["STM32"], software: ["FreeRTOS"], technologyStack: ["FOC"], sourceIds: [], confidence: 0.8 },
      facts: [{ id: "f-1", projectId: "p-1", type: "responsibility", title: "职责", content: "负责固件", confidence: 0.9, verified: true, sourceIds: ["doc-1"], evidence: [{ sourceId: "doc-1", quote: "负责固件" }] }]
    });
    expect(result.completeness).toBeGreaterThan(0);
    expect(result.completeness).toBeLessThan(100);
    expect(result.missingFactTypes).toContain("result");
    expect(result.sourceCoverage).toBe(100);
  });
});
