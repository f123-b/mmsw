import { describe, expect, it } from "vitest";
import type { ProjectFact } from "../knowledge/types";
import { auditProjectQaEvidence, selectProjectQaGenerationFacts } from "./project-qa-evidence";

const fact = (patch: Partial<ProjectFact> = {}): ProjectFact => ({ id: "adc", projectId: "foc", type: "technology", title: "同步采样", content: "PWM 以20kHz触发ADC采样，DMA搬运数据。", confidence: 1, verified: false, sourceIds: ["source"], evidence: [{ sourceId: "source", quote: "PWM 以20kHz触发ADC采样，DMA搬运数据。" }], evidenceLevel: "confirmed-code", ownership: "project", status: "active", ...patch });
const audit = (answer: string, facts: ProjectFact[] = [fact()], factIds = facts.map((item) => item.id)) => auditProjectQaEvidence({ projectId: "foc", answer, factIds, facts });

describe("project QA evidence preflight", () => {
  it.each([
    ["pending", { status: "pending_review" }], ["conflicting", { conflictStatus: "conflicting" }],
    ["stale", { stale: true }], ["rejected", { status: "rejected" }],
    ["unquoted", { evidence: [] }], ["refuted", { evidence: [{ sourceId: "source", quote: "not true", relation: "refute" }] }],
    ["inferred", { evidenceLevel: "inferred" }], ["other project", { projectId: "esp32" }],
    ["unmeasured result", { type: "metric", evidenceLevel: "not-measured" }]
  ] satisfies Array<[string, Partial<ProjectFact>]>)("excludes %s facts from generation and blocks linked confirmation", (_name, patch) => {
    const source = fact(patch);
    expect(selectProjectQaGenerationFacts([source], "foc")).toEqual([]);
    expect(audit("项目使用同步采样。", [source])).toMatchObject({ blocked: true, issues: [expect.objectContaining({ code: "invalid-fact" })] });
  });

  it("balances technical types and sections instead of losing later modules to an 80-fact prefix", () => {
    const input = Array.from({ length: 90 }, (_, index) => fact({ id: `adc-${index}` }));
    const decision = fact({ id: "decision", type: "decision" });
    const laterModule = fact({ id: "can", sectionPath: ["CAN"] });
    const selected = selectProjectQaGenerationFacts([...input, decision, laterModule], "foc");
    expect(selected).toHaveLength(80);
    expect(selected.slice(0, 3).map((item) => item.id)).toEqual(["adc-0", "decision", "can"]);
    expect(input[0].id).toBe("adc-0");
    expect(selectProjectQaGenerationFacts(input, "foc", 0)).toEqual([]);
  });

  it.each(["项目采样频率为20kHz。", "项目采样频率为20000Hz。", "项目采样频率为 20 kHz。", "项目使用DMA搬运数据。"])("keeps supported text pending human review: %s", (answer) => {
    expect(audit(answer)).toMatchObject({ blocked: false, requiresHumanReview: true, issues: [] });
  });

  it.each(["项目采样频率为30kHz。", "CPU占用降低了30%。", "项目延迟为20ms。", "项目有20人。", "测量耗时为0.2秒。"])("blocks invented quantities and unit substitutions: %s", (answer) => {
    expect(audit(answer)).toMatchObject({ blocked: true, issues: expect.arrayContaining([expect.objectContaining({ code: "unsupported-quantity" })]) });
  });

  it("supports measured unit conversion but not a number from another unreferenced fact", () => {
    expect(audit("延迟为1毫秒。", [fact({ content: "延迟为1000微秒。" })]).blocked).toBe(false);
    expect(audit("频率30kHz。", [fact(), fact({ id: "not-cited", content: "30kHz" })], ["adc"]).blocked).toBe(true);
  });

  it("does not confuse model numbers with measurements", () => {
    expect(audit("STM32F405 使用DMA2。", [fact()]).blocked).toBe(false);
  });

  it("requires explicit personal evidence, and does not upgrade participation to leadership", () => {
    expect(audit("我负责DMA搬运模块。").issues).toContainEqual(expect.objectContaining({ code: "unconfirmed-ownership" }));
    const self = fact({ id: "role", type: "responsibility", content: "我参与DMA模块开发。", ownership: "self", evidenceLevel: "confirmed-user", verified: true });
    expect(audit("我参与DMA模块开发。", [self]).blocked).toBe(false);
    expect(audit("我独立完成DMA模块开发。", [self]).issues).toContainEqual(expect.objectContaining({ code: "inflated-ownership" }));
    expect(audit("我主导DMA模块开发。", [self]).blocked).toBe(true);
  });

  it("keeps unlinked imports reviewable without falsely certifying their content", () => {
    expect(audit("这是我负责的实现。", [], [])).toMatchObject({ blocked: false, requiresHumanReview: true, issues: [{ code: "missing-facts", severity: "warning", message: expect.any(String) }] });
  });

  it("rejects missing links even when one valid link is present", () => {
    expect(audit("项目使用DMA搬运数据。", [fact()], ["adc", "missing"]).blocked).toBe(true);
  });
});
