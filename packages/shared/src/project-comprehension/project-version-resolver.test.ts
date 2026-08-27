import { describe, expect, it } from "vitest";
import { ProjectVersionResolver } from "./version-resolver";

describe("Project version resolver", () => {
  it("prefers current code/config evidence while retaining historical documentation", () => {
    const result = new ProjectVersionResolver().resolve([
      { semanticKey: "pwm.control_frequency", name: "PWM 控制频率", value: 32, unit: "kHz", sourceIds: ["readme"], evidenceRefs: ["readme-ref"], sourceRole: "overview", filePath: "README.md" },
      { semanticKey: "pwm.control_frequency", name: "PWM 控制频率", value: 20, unit: "kHz", sourceIds: ["code"], evidenceRefs: ["code-ref"], sourceRole: "code", filePath: "src/control.c", isCode: true },
    ]);
    expect(result.status).toBe("current");
    expect(result.current?.value).toBe(20);
    expect(result.historical).toHaveLength(0);
    expect(result.alternatives?.[0]?.value).toBe(32);
  });

  it("does not collapse semantically different ADC and diagnostic numbers", () => {
    const values = new ProjectVersionResolver().resolveAll([
      { semanticKey: "adc.peripheral_clock", name: "ADC 外设时钟", value: 80, unit: "MHz", sourceIds: ["code"], evidenceRefs: ["1"], sourceRole: "code", isCode: true },
      { semanticKey: "adc.control_trigger_frequency", name: "ADC 控制触发频率", value: 20, unit: "kHz", sourceIds: ["code"], evidenceRefs: ["2"], sourceRole: "code", isCode: true },
      { semanticKey: "diagnostic.sample_frequency", name: "诊断采样频率", value: 1, unit: "kHz", sourceIds: ["debug"], evidenceRefs: ["3"], sourceRole: "debug" },
    ]);
    expect(values.size).toBe(3);
    expect(values.get("adc.peripheral_clock")?.current?.value).toBe(80);
    expect(values.get("adc.control_trigger_frequency")?.current?.value).toBe(20);
    expect(values.get("diagnostic.sample_frequency")?.current?.value).toBe(1);
  });
});
