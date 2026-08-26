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

  it("treats an explicit not-measured metric as resolved review work", () => {
    const result = calculateProjectCompleteness({
      project: { id: "p-2", name: "项目", description: "背景", role: "职责", hardware: [], software: [], technologyStack: [], sourceIds: [], confidence: 1 },
      facts: [
        { id: "role", projectId: "p-2", type: "responsibility", title: "职责", content: "负责控制", confidence: 1, verified: true, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: "负责控制" }], evidenceLevel: "confirmed-user", ownership: "self", status: "active", conflictStatus: "confirmed" },
        { id: "metric", projectId: "p-2", type: "metric", title: "性能指标", content: "没有正式 benchmark", confidence: 1, verified: false, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: "没有正式 benchmark" }], evidenceLevel: "not-measured", status: "active", conflictStatus: "confirmed" }
      ]
    });
    expect(result.criticalReviewScore).toBe(100);
    expect(result.dimensions.find((dimension) => dimension.key === "measurement")?.missingKind).toBe("not_measured");
  });
});
