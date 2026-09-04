import { describe, expect, it } from "vitest";
import { analyzeWrittenProblem, checkWrittenAnswer, parseWrittenTestResult, renderDiagramSvg, type WrittenAnswerDocument } from "./index";

describe("written test V2 structured pipeline", () => {
  it("classifies and preserves the problem frame instead of flattening it", () => {
    const result = parseWrittenTestResult(JSON.stringify({ inputStatus: "COMPLETE", missingInformation: [], problem: { rawText: "计算电阻并画流程图", canonicalQuestion: "计算电阻并画流程图", questionType: "CALCULATION", requirements: ["写出公式", "给出单位"], requestedArtifacts: { formula: true, diagram: true }, confidence: 0.91 }, answer: { questionType: "CALCULATION", finalAnswer: "R = 10 Ω", steps: [{ title: "公式", content: "R=U/I" }], equations: ["R=U/I"], explanation: "代入得到结果", warnings: [], confidence: 0.86 } }), "");
    expect(result.problem.questionType).toBe("CALCULATION");
    expect(result.problem.requirements).toEqual(["写出公式", "给出单位"]);
    expect(result.answer.steps[0]?.title).toBe("公式");
  });

  it("marks missing code and never emits an ASCII diagram", () => {
    const problem = analyzeWrittenProblem("请实现排序算法并给出完整代码", { questionType: "PROGRAMMING", requestedArtifacts: { code: true } });
    const answer: WrittenAnswerDocument = { questionType: "PROGRAMMING", finalAnswer: "使用排序", steps: [], equations: [], explanation: "", warnings: [], confidence: 0.8 };
    expect(checkWrittenAnswer(problem, answer).missing).toContain("完整代码");
    const svg = renderDiagramSvg({ kind: "FLOWCHART", nodes: [{ id: "a", label: "开始", shape: "rounded" }, { id: "b", label: "结束", shape: "rounded" }], edges: [{ from: "a", to: "b" }] });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("ASCII");
  });
});
