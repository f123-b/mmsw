import { describe, expect, it } from "vitest";
import { extractResumeProjectSections, resolveProjectAssignment, resolveProjectIdentity } from "./project-identity";

describe("project identity and source assignment", () => {
  it("prefers a clean filename over resume-like body text", () => {
    const identity = resolveProjectIdentity({ id: "foc", kind: "project-document", title: "基于STM32F405的实时FOC电机控制系统.md", text: "项目名称：基于 STM32F405 的实时 FOC 电机控制系统\n负责人 | 2026.03 - 2026.06 技术栈：C++、STM32" });
    expect(identity.name).toBe("基于STM32F405的实时FOC电机控制系统");
    expect(identity.name).not.toContain("负责人");
  });

  it("splits resume project sections and does not return the whole resume", () => {
    const sections = extractResumeProjectSections("教育背景\n本科\n\n基于 STM32F405 的实时 FOC 电机控制系统 负责人 | 2026.03 - 2026.06 技术栈：C++、STM32\n个人职责：负责电流环与 SVPWM\n\n求职方向\n嵌入式开发", "resume-1");
    expect(sections).toHaveLength(1);
    expect(sections[0]?.projectName).toBe("基于 STM32F405 的实时 FOC 电机控制系统");
    expect(sections[0]?.text).toContain("电流环");
    expect(sections[0]?.text).not.toContain("教育背景");
    expect(sections[0]?.text).not.toContain("求职方向");
  });

  it("requires explicit assignment when two projects are ambiguous", () => {
    const result = resolveProjectAssignment(
      { id: "doc", kind: "project-document", title: "系统说明.md", text: "技术方案\n控制模块" },
      [{ id: "p1", name: "控制系统" }, { id: "p2", name: "控制平台" }]
    );
    expect(result.status).toBe("needs_assignment");
  });
});
