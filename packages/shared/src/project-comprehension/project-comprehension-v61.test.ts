import { describe, expect, it } from "vitest";
import { ProjectComprehensionAgent } from "./agent";
import { ProjectVersionResolver } from "./version-resolver";

function repository(text: string) { return { id: "repo", kind: "repository" as const, title: "repo.zip", sourceRole: "code" as const, text }; }

describe("Project Comprehension Agent V6.1", () => {
  it("lets the model adapt the next tool to a newly discovered symbol", async () => {
    const decisions = [
      { action: "readFile", target: "src/main.c", reason: "读取入口", priority: "critical" },
      { action: "searchText", query: "gateway_init", reason: "沿入口符号调查", priority: "high" },
      { action: "readFile", target: "src/databus.cpp", reason: "读取搜索到的实现", priority: "high" },
      { action: "synthesize", reason: "关键链路已覆盖", priority: "normal" },
    ];
    let plannerCalls = 0;
    const seen: string[] = [];
    const model = { async generate(input: { purpose?: string }) { if (input.purpose === "plan") { seen.push(String(input.purpose)); return JSON.stringify(decisions[plannerCalls++]); } return "{}"; } };
    const result = await new ProjectComprehensionAgent({ model, trace: (event, fields) => { if (event === "PROJECT_AGENT_DECISION") seen.push(String(fields.action)); } }).comprehend({ projectId: "gateway", projectName: "Gateway", options: { maxToolCalls: 8, maxFilesRead: 5 }, sources: [repository("文件：src/main.c\nvoid main(){ gateway_init(); }\n\n---\n\n文件：src/databus.cpp\nvoid gateway_init(){}\n") ] });
    expect(seen).toEqual(["plan", "readFile", "plan", "searchText", "plan", "readFile", "plan", "synthesize"]);
    expect(result.understanding.trace.modelTurns).toBeGreaterThanOrEqual(4);
  });

  it("discovers a gateway without emitting embedded-control components", async () => {
    const result = await new ProjectComprehensionAgent().comprehend({ projectId: "gateway", projectName: "Generic Gateway", sources: [repository("文件：src/modbus.cpp\n// Modbus publishes DataBus\nvoid publish(){ databus_publish(); }\n\n---\n\n文件：src/databus.cpp\n// DataBus feeds MQTT and UI\nvoid publish(){ mqtt_publish(); ui_update(); }\n\n---\n\n文件：src/socketcan.cpp\n// SocketCAN publishes DataBus\nvoid receive(){ databus_publish(); }\n\n---\n\n文件：src/mqtt.cpp\nvoid mqtt_publish(){}\n\n---\n\n文件：src/ui.cpp\nvoid ui_update(){}") ] });
    const names = result.understanding.architecture.components.map((component) => component.name);
    expect(names).toEqual(expect.arrayContaining(["DataBus", "Modbus", "SocketCAN", "MQTT", "UI"]));
    expect(names).not.toEqual(expect.arrayContaining(["Motor Control", "Encoder Feedback", "Current Sampling"]));
    expect(result.understanding.architecture.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "Modbus", to: "DataBus", relation: "publishes", verificationStatus: "confirmed" }),
      expect.objectContaining({ from: "DataBus", to: "MQTT", relation: "feeds", verificationStatus: "confirmed" }),
    ]));
  });

  it("rejects PWM/ADC co-occurrence and accepts an explicit trigger config", async () => {
    const falsePositive = await new ProjectComprehensionAgent().comprehend({ projectId: "false", projectName: "Peripheral Fixture", sources: [repository("文件：src/pwm.c\nvoid pwm_init(){}\n\n---\n\n文件：src/adc.c\nvoid adc_init(){}") ] });
    expect(falsePositive.understanding.architecture.relationships.some((item) => item.from.includes("PWM") && item.to.includes("ADC"))).toBe(false);
    const direct = await new ProjectComprehensionAgent().comprehend({ projectId: "direct", projectName: "Peripheral Fixture", sources: [repository("文件：src/pwm.c\nvoid pwm_init(){ TIM1->TRGO = ENABLE; }\n\n---\n\n文件：src/adc.c\nADC1->ExternalTrigger = ADC_EXTERNALTRIGCONV_T1_TRGO;") ] });
    expect(direct.understanding.architecture.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ relation: "triggers", evidenceStrength: "direct", verificationStatus: "confirmed" })]));
  });

  it("marks a flow partial when one confirmed link is missing", async () => {
    const result = await new ProjectComprehensionAgent().comprehend({ projectId: "partial", projectName: "Partial Fixture", sources: [repository("文件：src/adc.c\nADC -> DMA\n\n---\n\n文件：src/dma.c\nDMA -> Buffer\n\n---\n\n文件：src/control.c\nvoid current_loop(){}") ] });
    expect(result.understanding.dataFlows).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Sampling Flow", partial: true, missingLinks: ["Buffer → Current Loop"] })]));
  });

  it("distinguishes Git-confirmed history from a no-Git preferred current value", () => {
    const resolver = new ProjectVersionResolver();
    const candidates = [
      { semanticKey: "pwm.control_frequency", name: "PWM", value: 32, unit: "kHz", sourceIds: ["readme"], evidenceRefs: ["r"], sourceRole: "overview" },
      { semanticKey: "pwm.control_frequency", name: "PWM", value: 20, unit: "kHz", sourceIds: ["code"], evidenceRefs: ["c"], sourceRole: "code", isCode: true },
    ];
    expect(resolver.resolve(candidates).currentStatus).toBe("preferred_current");
    expect(resolver.resolve(candidates, [{ hash: "b", subject: "change PWM from 32 kHz to 20 kHz", changedPaths: ["src/pwm.c"] }]).currentStatus).toBe("confirmed_current");
    expect(resolver.resolve(candidates, [{ hash: "b", subject: "change PWM from 32 kHz to 20 kHz", changedPaths: ["src/pwm.c"] }]).historical[0]?.value).toBe(32);
  });

  it("keeps working when the comprehension model fails", async () => {
    const model = { async generate() { throw new Error("MODEL_TIMEOUT"); } };
    const result = await new ProjectComprehensionAgent({ model }).comprehend({ projectId: "model-failure", projectName: "FOC Fixture", sources: [repository("文件：src/control.c\nFOC motor control with current loop, ADC sampling and PWM.")] });
    expect(result.understanding.status).toBe("completed");
    expect(result.understanding.architecture.components.map((item) => item.name)).toEqual(expect.arrayContaining(["Motor Control", "Current Sampling"]));
  });

  it("rejects a model relationship that has no supporting evidence", async () => {
    const model = { async generate(input: { purpose?: string }) {
      return input.purpose === "plan" ? JSON.stringify({ action: "synthesize", reason: "当前证据足够", priority: "normal" }) : JSON.stringify({ architecture: { relationships: [{ from: "MQTT", to: "Service", relation: "controls", description: "MQTT controls Service", evidenceRefs: [], confidence: 0.99 }] } });
    } };
    const result = await new ProjectComprehensionAgent({ model }).comprehend({ projectId: "model-grounding", projectName: "Gateway Fixture", sources: [repository("文件：src/service.cpp\nMQTT service receives messages.")] });
    expect(result.understanding.architecture.relationships.some((item) => item.from === "MQTT" && item.to === "Service" && item.verificationStatus === "confirmed")).toBe(false);
    expect(result.understanding.unknowns.some((item) => item.claim.includes("MQTT") && item.claim.includes("Service"))).toBe(true);
  });

  it("records evidence requirements while the agent follows a missing-trigger hypothesis", async () => {
    const decisions = [
      { action: "searchText", query: "ExternalTrigConv", reason: "验证 ADC 触发配置", priority: "critical", hypothesisId: "hyp-trigger", expectedInformation: "TIM1 TRGO 可能触发 ADC1" },
      { action: "readFile", target: "src/adc.c", reason: "读取 ADC 配置", priority: "critical", hypothesisId: "hyp-trigger" },
      { action: "findCallers", query: "ADC1", reason: "检查相关调用图", priority: "high", hypothesisId: "hyp-trigger" },
      { action: "readFile", target: "src/pwm.c", reason: "读取 TIM1 配置", priority: "high", hypothesisId: "hyp-trigger" },
      { action: "synthesize", reason: "触发证据已覆盖", priority: "normal" },
    ];
    let index = 0;
    const actions: string[] = [];
    const model = { async generate(input: { purpose?: string }) { if (input.purpose === "plan") { const decision = decisions[index++] ?? decisions.at(-1); actions.push(decision?.action ?? ""); return JSON.stringify(decision); } return "{}"; } };
    const result = await new ProjectComprehensionAgent({ model, trace: (event, fields) => { if (event === "PROJECT_AGENT_DECISION") actions.push(String(fields.action)); } }).comprehend({ projectId: "trigger", projectName: "Trigger Fixture", sources: [repository("文件：src/adc.c\nADC1->ExternalTrigger = ADC_EXTERNALTRIGCONV_T1_TRGO;\n\n---\n\n文件：src/pwm.c\nTIM1->TRGO = ENABLE;")] });
    expect(actions).toEqual(expect.arrayContaining(["searchText", "readFile", "findCallers", "synthesize"]));
    expect(result.state?.hypotheses.some((hypothesis) => hypothesis.id === "hyp-trigger" && hypothesis.evidenceRequirements?.some((item) => item.includes("config")))).toBe(true);
    expect(result.understanding.architecture.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ relation: "triggers", verificationStatus: "confirmed", source: "semantic" })]));
  });
});
