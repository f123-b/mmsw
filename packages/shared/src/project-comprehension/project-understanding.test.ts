import { describe, expect, it } from "vitest";
import { ProjectComprehensionAgent } from "./agent";

describe("ProjectUnderstanding model", () => {
  it("represents components, relationships, flows and semantic parameters", async () => {
    const result = await new ProjectComprehensionAgent().comprehend({
      projectId: "understanding-project", projectName: "FOC Fixture",
      sources: [{ id: "repo", kind: "repository", title: "repo", text: "文件：src/main.c\nFOC motor_task pwm_init\n\n---\n\n文件：src/adc.c\nADC peripheral clock = 32 MHz; ADC control trigger frequency = 20 kHz; DMA current sample\n\n---\n\n文件：src/encoder.c\nABZ encoder velocity estimator speed PI\n\n---\n\n文件：src/protection.c\novercurrent fault handler disables PWM" }]
    });
    expect(result.understanding.architecture.components.map((item) => item.name)).toEqual(expect.arrayContaining(["Motor Control", "Current Sampling", "Encoder Feedback", "Velocity Estimator", "Protection"]));
    expect(result.understanding.architecture.relationships.length).toBeGreaterThan(0);
    expect(result.understanding.runtimeFlows.length + result.understanding.dataFlows.length + result.understanding.controlFlows.length).toBe(0);
    expect(result.understanding.unknowns.some((item) => item.category === "flow" || item.category === "missingFlowLink")).toBe(true);
    expect(result.understanding.parameters.map((item) => item.semanticKey)).toEqual(expect.arrayContaining(["adc.peripheral_clock", "adc.control_trigger_frequency"]));
  });
});
