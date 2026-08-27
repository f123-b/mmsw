import { describe, expect, it } from "vitest";
import { ProjectComprehensionAgent } from "./agent";
import type { ProjectComprehensionInput } from "./types";

const benchmarkInput: ProjectComprehensionInput = {
  projectId: "benchmark-foc",
  projectName: "FOC Drive Benchmark",
  sources: [{ id: "benchmark-repo", kind: "repository", title: "repo.txt", sourceRole: "code", text: `文件：src/main.c\nint main(void) { pwm_init(); motor_task(); }\n\n---\n\n文件：src/control.c\nFOC current loop Clarke Park current PI SVPWM PWM frequency = 20 kHz\n\n---\n\n文件：src/adc.c\nADC peripheral clock = 80 MHz; ADC control trigger frequency = 20 kHz; DMA current sample\n\n---\n\n文件：src/encoder.c\nABZ encoder electrical angle velocity estimator speed\n\n---\n\n文件：src/communication.c\nCAN communication receives command and publishes status\n\n---\n\n文件：src/protection.c\novercurrent fault handler disables PWM\n\n---\n\n文件：tests/control.test.c\npassed benchmark result latency 20 us` }]
};

describe("Project comprehension benchmark", () => {
  it("reports bounded exploration and understanding coverage", async () => {
    const started = performance.now();
    const result = await new ProjectComprehensionAgent().comprehend(benchmarkInput);
    const understanding = result.understanding;
    const report = { projectId: benchmarkInput.projectId, repoFiles: result.repoMap.files.length, filesRead: understanding.trace.filesRead, toolCalls: understanding.trace.toolCalls, plannerModelTurns: understanding.trace.modelTurns, elapsedMs: Math.round((performance.now() - started) * 100) / 100, confirmedComponents: understanding.architecture.components.length, confirmedRelationships: understanding.architecture.relationships.filter((item) => item.verificationStatus === "confirmed").length, rejectedRelationships: understanding.unknowns.filter((item) => item.category === "flow" || item.category === "unverifiedRelationship").length, completeFlows: [...understanding.runtimeFlows, ...understanding.dataFlows, ...understanding.controlFlows].filter((flow) => !flow.partial).length, partialFlows: [...understanding.runtimeFlows, ...understanding.dataFlows, ...understanding.controlFlows].filter((flow) => flow.partial).length, parameters: understanding.parameters.length, decisions: understanding.decisions.length, problems: understanding.problems.length, unknowns: understanding.unknowns.length, groundingCoverage: Math.round(understanding.quality.groundingCoverage), falseRelationshipCount: understanding.architecture.relationships.filter((item) => item.verificationStatus === "confirmed" && item.source === "model" && !item.semanticEdgeId).length };
    console.info("PROJECT_COMPREHENSION_BENCHMARK", JSON.stringify(report));
    expect(report.repoFiles).toBeGreaterThanOrEqual(5);
    expect(report.confirmedComponents).toBeGreaterThanOrEqual(4);
    expect(report.completeFlows + report.partialFlows).toBeGreaterThanOrEqual(1);
    expect(report.groundingCoverage).toBeGreaterThanOrEqual(50);
    expect(report.falseRelationshipCount).toBe(0);
  });
});
