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
    const report = { projectId: benchmarkInput.projectId, repoFiles: result.repoMap.files.length, filesRead: understanding.trace.filesRead, toolCalls: understanding.trace.toolCalls, modelTurns: understanding.trace.modelTurns, elapsedMs: Math.round((performance.now() - started) * 100) / 100, components: understanding.architecture.components.length, relationships: understanding.architecture.relationships.length, flows: understanding.runtimeFlows.length + understanding.dataFlows.length + understanding.controlFlows.length, groundedClaims: Math.round(understanding.quality.groundingCoverage) };
    console.info("PROJECT_COMPREHENSION_BENCHMARK", JSON.stringify(report));
    expect(report.repoFiles).toBeGreaterThanOrEqual(5);
    expect(report.components).toBeGreaterThanOrEqual(4);
    expect(report.flows).toBeGreaterThanOrEqual(1);
    expect(report.groundedClaims).toBeGreaterThanOrEqual(50);
  });
});
