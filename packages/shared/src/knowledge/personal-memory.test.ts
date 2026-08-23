import { describe, expect, it } from "vitest";
import { analyzeCodeFile, buildKnowledgeGraph, inferSourceKind, normalizeImportedSource, ProjectAnalyzerAgent, buildDeterministicProjectMemory, PersonalAnswerValidator, ProjectMemoryRetriever, QuestionAnalyzer, routeKnowledge } from "./index";

describe("Personal Engineering Memory", () => {
  const input = {
    profileId: "profile-1",
    sources: [{ id: "project-1", kind: "project-document" as const, title: "STM32 FOC 项目", text: "项目背景：电机控制平台\n个人职责：负责电机控制固件开发\n硬件：STM32F405、PMSM\n技术栈：FOC、SVPWM、FreeRTOS\n技术点：PWM中心触发ADC，DMA搬运电流数据。\n问题：电机低速抖动，原因：ABZ速度量化噪声，后来通过速度观测器和低速补偿解决，结果：低速运行稳定。" }]
  };

  it("builds grounded projects, technical points, problems and interview questions", async () => {
    const snapshot = await new ProjectAnalyzerAgent().analyze(input);
    expect(snapshot.projects[0]).toMatchObject({ name: "STM32 FOC 项目", role: expect.stringContaining("电机控制") });
    expect(snapshot.technicalPoints.some((point) => point.topic === "ADC")).toBe(true);
    expect(snapshot.problems.some((problem) => problem.problem.includes("低速抖动"))).toBe(true);
    expect(snapshot.interviewQuestions.some((question) => question.question.includes("为什么这么设计"))).toBe(true);
  });

  it("routes project questions to personal memory first", () => {
    const analysis = new QuestionAnalyzer().analyze("你在STM32 FOC 项目里面为什么这么设计？", ["STM32 FOC 项目"]);
    expect(analysis.type).toBe("project");
    expect(routeKnowledge(analysis).useProjectMemory).toBe(true);
    expect(new ProjectMemoryRetriever().search("低速抖动怎么解决", buildDeterministicProjectMemory(input)).some((hit) => hit.kind === "problem")).toBe(true);
  });

  it("flags unsupported personal claims and AI-style answers", () => {
    const analysis = new QuestionAnalyzer().analyze("你项目里面遇到什么问题，怎么解决？");
    const result = new PersonalAnswerValidator().validate({ question: "你项目里面遇到什么问题，怎么解决？", answer: "首先，我在项目中使用了STM32H7，后来解决了问题。", analysis, evidence: ["项目使用 STM32F405 和 DMA"] });
    expect(result.issues).toEqual(expect.arrayContaining(["ai-style", "unsupported-technical-claim"]));
    expect(result.valid).toBe(false);
  });

  it("extracts code modules and functions", () => {
    const result = analyzeCodeFile({ filePath: "src/controller.c", language: "c", text: "void current_loop(void) { }\nvoid svpwm_update(int value) { }\n// DMA ADC PWM" });
    expect(result.modules[0]?.filePath).toBe("src/controller.c");
    expect(result.functions.map((item) => item.name)).toEqual(expect.arrayContaining(["current_loop", "svpwm_update"]));
    expect(result.keywords).toEqual(expect.arrayContaining(["DMA", "ADC", "PWM"]));
  });

  it("normalizes imported sources and builds graph relationships", () => {
    const source = normalizeImportedSource({ id: "repo-1", filename: "README.md", text: "项目：控制器" });
    expect(source.kind).toBe("readme");
    expect(inferSourceKind("controller.cpp", "void run() {}")) .toBe("repository");
    const graph = buildKnowledgeGraph(buildDeterministicProjectMemory(input));
    expect(graph.nodes.some((node) => node.type === "project")).toBe(true);
    expect(graph.edges.some((edge) => edge.relation === "solves")).toBe(true);
  });
});
