import { describe, expect, it } from "vitest";
import { extractProjectFacts, ProjectFactConflictResolver, ProjectFactValidator } from "./project-facts";
import { buildDeterministicProjectMemory } from "./project-memory";

describe("project facts", () => {
  it("extracts only evidence-backed atomic entities from a scoped project", () => {
    const facts = extractProjectFacts({ projectId: "foc", projectName: "FOC", sources: [{ id: "foc-doc", kind: "project-document", title: "FOC.md", text: "项目背景：实现 PMSM 矢量控制\n个人职责：负责电流环和 SVPWM\n技术栈：STM32F405、FOC、SVPWM、DMA\n其他项目技术：MQTT、Linux\n" }] });
    expect(facts.some((fact) => fact.type === "responsibility" && fact.content === "负责电流环和 SVPWM")).toBe(true);
    expect(facts.filter((fact) => fact.type === "technology").map((fact) => fact.title)).toEqual(expect.arrayContaining(["FOC", "SVPWM", "DMA"]));
    expect(facts.some((fact) => fact.title === "MQTT" || fact.title === "Linux")).toBe(false);
    expect(facts.every((fact) => fact.evidence?.every((item) => item.sourceId === "foc-doc" && item.quote))).toBe(true);
  });

  it("rejects resume-field leakage and facts without evidence", () => {
    expect(ProjectFactValidator.validateProjectName("FOC 负责人 | 2026 技术栈：C++").status).toBe("rejected");
    expect(ProjectFactValidator.validateRole("负责固件\n技术栈：C++").status).toBe("rejected");
    expect(ProjectFactValidator.validate({ id: "x", projectId: "p", type: "technology", title: "STM32", content: "STM32", confidence: 1, verified: false, sourceIds: [] }).status).toBe("rejected");
  });

  it("does not turn reference material into project facts", () => {
    const snapshot = buildDeterministicProjectMemory({ projectId: "foc", projectName: "FOC", sources: [{ id: "freertos-manual", kind: "project-document", sourceRole: "reference", title: "FreeRTOS 官方说明.md", text: "技术栈：FreeRTOS\n个人职责：负责任务划分" }] });
    expect(snapshot.facts).toEqual([]);
    expect(snapshot.projects).toEqual([]);
  });

  it("keeps conflicting high-quality facts pending review", () => {
    const resolver = new ProjectFactConflictResolver();
    const result = resolver.resolve([
      { id: "a", projectId: "p", type: "hardware", title: "MCU", content: "STM32F405", confidence: 0.9, verified: false, sourceIds: ["resume"], evidence: [{ sourceId: "resume", quote: "STM32F405" }] },
      { id: "b", projectId: "p", type: "hardware", title: "MCU", content: "STM32G431", confidence: 0.9, verified: false, sourceIds: ["doc"], evidence: [{ sourceId: "doc", quote: "STM32G431" }] }
    ], [
      { id: "resume", kind: "resume-section", title: "Resume", text: "" },
      { id: "doc", kind: "project-document", title: "project.md", text: "" }
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("pending_review");
  });
});
