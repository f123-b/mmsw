import { describe, expect, it } from "vitest";
import { ResumeAnalyzer, validateResumeAnalysisEvidence } from "./analyzer";
import { extractResumeProjects } from "./section-parser";
import type { ResumeDocument } from "./types";

const fixture: ResumeDocument = {
  sourceId: "resume-fixture",
  filename: "candidate.txt",
  rawText: [
    "姓名：林工",
    "项目经历",
    "普通短句",
    "智能电机控制平台 | 2023.01 - 2024.02 | 角色：固件负责人",
    "- 使用 C++、FOC 和 DMA 完成控制环路",
    "工作经历",
    "某公司 · 嵌入式工程师",
    "项目说明不是标题"
  ].join("\n")
};

const regressionFixtures: Array<{ name: string; document: ResumeDocument; projects: number }> = [
  { name: "中文项目头", document: fixture, projects: 1 },
  { name: "英文项目头", document: { sourceId: "resume-en", filename: "resume-en.txt", rawText: ["Projects", "Telemetry Gateway | 2021.02 - 2022.03 | Role: Firmware Engineer", "- Built CAN and FreeRTOS diagnostics", "Skills", "C++ · CAN · FreeRTOS"].join("\n") }, projects: 1 },
  { name: "显式项目名称", document: { sourceId: "resume-labelled", filename: "resume-labelled.txt", rawText: ["项目经历", "项目名称：车载网关", "- 使用 C++ 开发诊断服务"].join("\n") }, projects: 1 },
  { name: "拒绝模糊短句", document: { sourceId: "resume-strict", filename: "resume-strict.txt", rawText: ["项目经历", "普通短句", "2024.01 - 2024.02", "职责：负责测试", "项目说明不是标题"].join("\n") }, projects: 0 }
];

describe("ResumeAnalysis V2", () => {
  it.each(regressionFixtures)("regression fixture: $name", ({ document, projects }) => {
    expect(extractResumeProjects(document)).toHaveLength(projects);
  });

  it("only treats explicit project headers as project blocks", () => {
    const projects = extractResumeProjects(fixture);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe("智能电机控制平台");
    expect(projects[0]?.evidence.rawExcerpt).toContain("智能电机控制平台");
    expect(projects[0]?.evidence.sourceId).toBe(fixture.sourceId);
  });

  it("drops model projects whose evidence is not in the current Resume", () => {
    const fallback = new ResumeAnalyzer().analyze(fixture);
    const validated = validateResumeAnalysisEvidence({
      ...fallback,
      analysisQuality: "structured",
      projects: [...fallback.projects, { ...fallback.projects[0]!, id: "forged", name: "岗位 JD 项目", evidence: { sourceId: fixture.sourceId, startOffset: 0, endOffset: 4, rawExcerpt: "岗位 JD" } }]
    }, fixture);
    expect(validated.projects.map((project) => project.id)).toEqual([fallback.projects[0]?.id]);
    expect(validated.warnings.at(-1)).toContain("丢弃");
  });
});
