import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDeterministicProjectMemory, ProjectMemoryAgent } from "./project-memory";
import { parseMarkdownProjectDocument } from "./project-document-parser";
import { calculateProjectCompleteness } from "./project-completeness";
import type { ProjectMemoryAnalysisInput } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/project-analysis/${name}`, import.meta.url)), "utf8");
}

function input(name: string, projectId: string, projectName: string): ProjectMemoryAnalysisInput {
  return { projectId, projectName, sources: [{ id: `${projectId}-doc`, kind: "project-document", title: name, projectId, projectName, text: fixture(name) }] };
}

describe("Project Memory real-document regression", () => {
  it("parses Markdown structure and tables before extracting facts", () => {
    const structure = parseMarkdownProjectDocument(fixture("foc-project.md"));
    expect(structure.title).toContain("STM32F405");
    expect(structure.sections.some((section) => section.title === "项目基本信息")).toBe(true);
    expect(structure.tables.some((table) => table.rows.some((row) => row["字段"] === "本人主要职责"))).toBe(true);
  });

  it("keeps FOC role, time and evidence semantics separated", () => {
    const snapshot = buildDeterministicProjectMemory(input("foc-project.md", "foc-project", "基于 STM32F405 的实时 FOC 电机控制系统"));
    const project = snapshot.projects[0];
    expect(project?.role).toContain("固件控制逻辑");
    expect(project?.role).not.toContain("原理图和 PCB");
    expect(project?.time).toBeUndefined();
    expect(snapshot.facts?.some((fact) => fact.title === "Git开发窗口" && fact.content.includes("2026-08-12"))).toBe(true);
    expect(project?.description).not.toBe("平台");
    expect(project?.hardware).toEqual(expect.arrayContaining(["STM32F405", "DRV8301", "MT6816"]));
    expect(project?.technologyStack).toEqual(expect.arrayContaining(["FOC", "SVPWM", "ADC", "DMA"]));
    expect(snapshot.problems[0]?.cause).toContain("采样时刻");
    expect(snapshot.problems[0]?.solution).toContain("PWM 中点");
  });

  it("does not turn ordinary RK3506 sentences into role or timeline fields", () => {
    const snapshot = buildDeterministicProjectMemory(input("rk3506-project.md", "rk3506-project", "基于 RK3506G Linux 的嵌入式环境监测与边缘数据网关"));
    const project = snapshot.projects[0];
    expect(project?.role).toContain("独立完成");
    expect(project?.role).not.toBe("划分");
    expect(project?.role).not.toContain("同步");
    expect(project?.time).toBeUndefined();
    expect(project?.description).not.toBe("平台");
    expect(project?.hardware).toContain("RK3506G");
    expect(project?.software).toEqual(expect.arrayContaining(["Linux", "C++", "CMake"]));
    expect(project?.technologyStack).toEqual(expect.arrayContaining(["Modbus RTU", "SocketCAN", "MQTT", "NTP", "OTA"]));
    expect(snapshot.problems[0]?.solution).toContain("幂等消息键");
    const completeness = calculateProjectCompleteness({ project: project as NonNullable<typeof project>, facts: snapshot.facts ?? [], modules: snapshot.modules, problems: snapshot.problems, questions: snapshot.interviewQuestions });
    expect(completeness.sourceCoverageScore).toBeGreaterThanOrEqual(70);
    expect(completeness.verificationScore).toBe(0);
    expect(completeness.interviewReadinessScore).toBeGreaterThan(0);
    expect(completeness.dimensions.find((dimension) => dimension.key === "measurement")?.missingKind).toBe("not_measured");
  });

  it("merges only LLM candidates whose quotes resolve back to the bound source", async () => {
    const projectInput = input("foc-project.md", "candidate-project", "FOC");
    const source = projectInput.sources[0];
    const agent = new ProjectMemoryAgent({ generate: async () => JSON.stringify({ facts: [
      { factType: "limitation", title: "没有长期 benchmark", content: "没有统一的长期 benchmark 数据", confidence: 0.7, sources: [{ sourceId: source?.id, quote: "没有统一的长期 benchmark 数据。" }] },
      { factType: "technology", title: "不可采信技术", content: "凭空生成", confidence: 0.99, sources: [{ sourceId: source?.id, quote: "这段内容不在项目资料中" }] }
    ] }) });
    const snapshot = await agent.build(projectInput);
    expect(snapshot.facts?.some((fact) => fact.title === "没有长期 benchmark")).toBe(true);
    expect(snapshot.facts?.some((fact) => fact.title === "不可采信技术")).toBe(false);
    expect(snapshot.projects[0]?.description).toContain("STM32F405");
  });
});
