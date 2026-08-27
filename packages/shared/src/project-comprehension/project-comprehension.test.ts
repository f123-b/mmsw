import { describe, expect, it } from "vitest";
import { ProjectComprehensionAgent } from "./agent";
import { ProjectGroundingService } from "./grounding";
import { SourceProjectExplorer } from "./repo-explorer";
import { buildProjectRepoMap } from "./repo-map";
import type { ProjectComprehensionInput, ProjectUnderstanding } from "./types";

const fixture = `文件：src/main.c
// FOC motor control entry point
void motor_task(void) { adc_trigger(); encoder_update(); current_loop(); speed_loop(); }
int main(void) { pwm_init(); motor_task(); return 0; }

---

文件：src/adc.c
// ADC peripheral clock = 80 MHz\n// ADC control trigger frequency = 20 kHz\n// diagnostic sample frequency = 1 kHz\nvoid adc_trigger(void) { dma_start(); }

---

文件：src/control.c
// FOC current loop, Clarke Park, current PI and SVPWM\n// PWM control frequency = 20 kHz\n// current loop frequency = 20 kHz\n// speed loop frequency = 1 kHz\nvoid current_loop(void) { svpwm_update(); }

---

文件：src/encoder.c
// ABZ encoder provides electrical angle and position.\n// velocity estimator converts sparse ABZ pulses into speed.\nvoid encoder_update(void) { velocity_estimator(); }

---

文件：src/communication.c
// CAN communication publishes status and receives commands.\nvoid can_service(void) { can_send(); }

---

文件：src/protection.c
// overcurrent fault handler disables PWM and latches the fault.\nvoid fault_handler(void) { pwm_disable(); }

---

文件：tests/control.test.c
// passed: current loop error < 2%\n// benchmark result: latency 20 us\nvoid test_current_loop(void) { }

---

文件：README.md
用于机器人电机控制，采用中心对齐 PWM，并在稳定采样窗口触发 ADC。\n低速 ABZ 脉冲稀疏导致速度反馈抖动，速度估算量化后 PI 抖动；通过 delta + frame rebase 优化后稳定。\n`;

function input(): ProjectComprehensionInput {
  return { projectId: "project-foc", projectName: "FOC Robot Drive", sources: [{ id: "repo-1", kind: "repository", title: "repository.txt", filePath: "repository.txt", projectId: "project-foc", sourceRole: "code", text: fixture }] };
}

describe("Project Comprehension Engine", () => {
  it("builds a repository map and respects excluded paths and traversal boundaries", () => {
    const explorer = new SourceProjectExplorer([{ id: "repo", kind: "repository", title: "repo", text: `${fixture}\n文件：node_modules/secret.js\napi_key=should-not-read` }], { maxResults: 20 });
    const tree = explorer.listTree();
    const map = buildProjectRepoMap({ projectId: "p", tree });
    expect(tree.some((file) => file.path === "node_modules/secret.js")).toBe(false);
    expect(map.entryPoints).toContain("src/main.c");
    expect(map.likelyCoreFiles).toContain("src/control.c");
    expect(() => explorer.readFile("../secret.txt")).toThrow("PROJECT_EXPLORER_PATH_OUTSIDE_ROOT");
  });

  it("uses bounded exploration, builds understanding, and emits trace events", async () => {
    const events: string[] = [];
    const result = await new ProjectComprehensionAgent({
      trace: (event) => events.push(event),
      now: () => Date.now(),
    }).comprehend({ ...input(), options: { maxToolCalls: 24, maxFilesRead: 12, maxResults: 8, timeoutMs: 2_000 } });
    const names = result.understanding.architecture.components.map((component) => component.name);
    expect(names).toEqual(expect.arrayContaining(["Motor Control", "Current Sampling", "Encoder Feedback", "Velocity Estimator", "Communication", "Protection"]));
    expect(result.understanding.status).toBe("completed");
    expect(result.understanding.summary.length).toBeGreaterThanOrEqual(40);
    expect(result.understanding.summary).not.toContain("src/");
    expect(result.understanding.parameters.map((parameter) => parameter.semanticKey)).toEqual(expect.arrayContaining(["adc.peripheral_clock", "adc.control_trigger_frequency", "diagnostic.sample_frequency"]));
    expect(result.understanding.architecture.relationships.length).toBeGreaterThan(0);
    expect(result.understanding.runtimeFlows.length + result.understanding.dataFlows.length + result.understanding.controlFlows.length).toBeGreaterThan(0);
    expect(events).toEqual(expect.arrayContaining(["PROJECT_COMPREHENSION_STARTED", "PROJECT_REPO_MAPPED", "PROJECT_PLAN_CREATED", "PROJECT_TOOL_CALL", "PROJECT_SYNTHESIS_COMPLETED", "PROJECT_GROUNDING_COMPLETED", "PROJECT_COMPREHENSION_COMPLETED"]));
    expect(result.understanding.trace.toolCalls).toBeLessThanOrEqual(24);
    expect(result.understanding.trace.filesRead).toBeLessThanOrEqual(12);
  });

  it("turns unsupported claims into unknowns during grounding", () => {
    const base = { ...input(), options: { maxToolCalls: 4, maxFilesRead: 2 } };
    const evidence: ProjectUnderstanding = {
      projectId: base.projectId,
      schemaVersion: 1,
      status: "synthesizing",
      identity: { name: base.projectName },
      summary: "这是一个用于验证 Grounding 行为的项目理解摘要，所有未知声明都应保留边界。",
      architecture: { components: [{ id: "c", name: "Core", kind: "other", description: "core", confidence: 0.5 }], relationships: [{ from: "c", to: "missing", relation: "calls", evidenceRefs: ["not-found"] }] },
      runtimeFlows: [{ id: "f", name: "Flow", kind: "runtime", description: "flow", steps: [], evidenceRefs: ["not-found"] }], dataFlows: [], controlFlows: [], technologies: [], parameters: [], decisions: [], problems: [], interfaces: [], protections: [], tests: [], results: [], limitations: [], unknowns: [], evidenceRefs: [], quality: { architectureCoverage: 10, flowCoverage: 10, parameterCoverage: 0, decisionCoverage: 0, problemCoverage: 0, groundingCoverage: 0, sufficient: false }, trace: { toolCalls: 1, filesRead: 1, modelTurns: 0, elapsedMs: 1, stages: ["synthesizing"] }
    };
    const grounded = new ProjectGroundingService().ground(evidence).understanding;
    expect(grounded.architecture.relationships).toHaveLength(0);
    expect(grounded.runtimeFlows).toHaveLength(0);
    expect(grounded.unknowns.some((unknown) => unknown.id.startsWith("unknown-grounding-"))).toBe(true);
  });

  it("understands document-only project sources when no repository archive is present", async () => {
    const projectSources = [
      ["PROJECT_OVERVIEW.md", "项目背景：在 STM32F405 上实现单轴 FOC 电机控制。个人职责：负责电流环、ADC 与 PWM 同步实现。技术栈：STM32F405、FreeRTOS、FOC、CAN、DMA。"],
      ["PROJECT_ARCHITECTURE.md", "控制系统由采样、控制算法和通信模块组成。采用 PWM 中心对齐，用于稳定 ADC 采样时刻。技术决策：选择：PWM 中心对齐；原因：方便在稳定采样窗口采 ADC。"],
      ["PROJECT_TECHNICAL_DETAILS.md", "PWM频率：20kHz\n电流环频率：20kHz\n速度环频率：1kHz\nCAN 波特率：1Mbps"],
      ["PROJECT_DEBUG.md", "问题：低速抖动。现象：ABZ 低速脉冲稀疏。原因：低速量化明显。解决：增量 delta + frame rebase。结果：速度反馈结构修复。"],
      ["PROJECT_RESULTS.md", "测试结果：低速运行稳定。性能指标：稳态误差 1%。限制：尚未完成正式 benchmark。"],
    ].map(([title, text], index) => ({ id: `doc-${index}`, kind: "project-document" as const, title, sourceRole: index === 0 ? "overview" as const : index === 1 ? "architecture" as const : index === 3 ? "debug" as const : index === 4 ? "test" as const : "architecture" as const, text }));
    const result = await new ProjectComprehensionAgent().comprehend({ projectId: "project-docs", projectName: "E2E FOC 电机控制项目", sources: projectSources });
    expect(result.understanding.status).toBe("completed");
    expect(result.understanding.architecture.components.map((item) => item.name)).toEqual(expect.arrayContaining(["Motor Control", "Current Sampling"]));
    expect(result.understanding.runtimeFlows.length + result.understanding.dataFlows.length + result.understanding.controlFlows.length).toBeGreaterThan(0);
  });
});
