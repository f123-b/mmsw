import { describe, expect, it } from "vitest";
import { ProjectComprehensionRetriever } from "./retrieval";
import type { ProjectUnderstanding } from "./types";

const understanding: ProjectUnderstanding = {
  projectId: "p", schemaVersion: 1, status: "completed", identity: { name: "Drive" }, summary: "一个由采样、控制和反馈组件组成的电机控制项目理解摘要。",
  architecture: { components: [{ id: "motor", name: "Motor Control", kind: "control", description: "电流环与 SVPWM", confidence: 0.9 }], relationships: [] },
  runtimeFlows: [{ id: "flow", name: "Sampling Flow", kind: "data", description: "PWM 触发 ADC，DMA 写入缓冲区", steps: [], evidenceRefs: ["ref"] }], dataFlows: [], controlFlows: [], technologies: [], parameters: [{ id: "param", name: "ADC 控制触发频率", semanticKey: "adc.control_trigger_frequency", value: 20, unit: "kHz", versionStatus: "current", sourceIds: ["s"], evidenceRefs: ["ref"], confidence: 0.9 }], decisions: [{ id: "decision", decision: "中心对齐 PWM", choice: "在稳定窗口触发 ADC", relatedComponents: ["Motor Control"], flowIds: ["flow"], evidenceRefs: ["ref"], confidence: 0.9 }], problems: [], interfaces: [], protections: [], tests: [], results: [], limitations: [], unknowns: [], evidenceRefs: [{ id: "ref", sourceId: "s", quote: "evidence", kind: "code", confidence: 0.9 }], quality: { architectureCoverage: 50, flowCoverage: 50, parameterCoverage: 20, decisionCoverage: 20, problemCoverage: 0, groundingCoverage: 100, sufficient: true }, trace: { toolCalls: 3, filesRead: 2, modelTurns: 0, elapsedMs: 3, stages: ["completed"] }
};

describe("Project comprehension retrieval", () => {
  it("routes flow and parameter questions before Fact-first grounding", () => {
    const retriever = new ProjectComprehensionRetriever();
    expect(retriever.search("PWM 如何触发 ADC，数据怎么运行", understanding).route).toBe("flow");
    expect(retriever.search("ADC 控制触发频率是多少", understanding).route).toBe("parameter");
    expect(retriever.search("为什么采用中心对齐 PWM", understanding).route).toBe("decision");
    expect(retriever.search("ADC 控制触发频率是多少", understanding).hits[0]?.id).toBe("param");
  });
});

