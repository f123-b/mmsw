import { describe, expect, it } from "vitest";
import { analyzeWrittenProblem, diagramSpecIsValid, inferWrittenQuestionType, parseWrittenTestResult, renderWrittenAnswer, resolveWrittenProblemRelation, checkWrittenAnswer } from "./index";

const valid = () => ({ inputStatus: "COMPLETE", missingInformation: [], problem: { rawText: "计算1+1", canonicalQuestion: "计算1+1", questionType: "CALCULATION", requestedArtifacts: { formula: true }, confidence: 0.9 }, answer: { questionType: "CALCULATION", finalAnswer: "2 Ω", equations: ["1+1=2"], steps: [], confidence: 0.9 } });
describe("written response validation", () => {
  it.each(["", "{broken", "普通回答", "```cpp\nint main() {}\n```", "{}", "[]", "null"])("rejects invalid raw output %j", (raw) => { expect(() => parseWrittenTestResult(raw)).toThrow(); });
  it.each([
    (x: any) => { x.problem.requirements = "not an array"; },
    (x: any) => { x.problem.confidence = "NaN"; },
    (x: any) => { x.answer.finalAnswer = {}; },
    (x: any) => { x.answer.questionType = "HACK"; },
    (x: any) => { x.answer.table = { columns: ["A"], rows: [["1", "2"]] }; },
    (x: any) => { x.answer.finalAnswer = "\uFFFD"; },
    (x: any) => { x.answer.code = { language: "cpp", content: "\uD800" }; },
    (x: any) => { x.inputStatus = "NEEDS_INPUT"; },
    (x: any) => { x.answer.confidence = -1; },
    (x: any) => { x.answer.diagram = { nodes: [null], edges: [null] }; }
  ])("rejects invalid nested fields without coercing them to text", (mutate) => {
    const value = valid(); mutate(value); expect(() => parseWrittenTestResult(JSON.stringify(value))).toThrow();
  });
  it("unwraps JSON only and preserves Unicode, formulas and escaped code", () => {
    const source = valid(); const code = 'print("中文 😀", "\\n")\n# Ω';
    Object.assign(source.answer, { code: { language: "python", content: code }, table: { columns: ["x"], rows: [["2"]] }, complexity: "O(1)" });
    const parsed = parseWrittenTestResult(`\`\`\`json\n${JSON.stringify(source)}\n\`\`\``);
    expect(parsed.answer.code?.content).toBe(code); const rendered = renderWrittenAnswer(parsed.answer);
    expect(rendered).toContain(code); expect(rendered).toContain("1+1=2"); expect(rendered).toContain("| 2 |"); expect(rendered).toContain("O(1)");
  });
  it("prioritizes multiple choice and exact duplicate detection", () => {
    expect(inferWrittenQuestionType("多选题：以下正确的是？")).toBe("MULTIPLE_CHOICE");
    const problem = analyzeWrittenProblem("这是一段足够长的题目，继续完成以下步骤并写出答案");
    expect(resolveWrittenProblemRelation(problem, problem, 1)).toBe("REPLACE_SCREENSHOT");
  });
  it("does not require code for a C++ concept question", () => {
    const problem = analyzeWrittenProblem("什么是 C++ 虚函数？", { questionType: "C_CPP" });
    const answer = { ...parseWrittenTestResult(JSON.stringify(valid())).answer, questionType: problem.questionType };
    expect(checkWrittenAnswer(problem, answer).missing).not.toContain("完整代码");
  });
  it("rejects malformed diagrams and duplicate node ids", () => {
    expect(diagramSpecIsValid({ kind: "FLOWCHART", nodes: [null], edges: [null] })).toBe(false);
    const node = { id: "a", label: "开始", shape: "rounded" };
    expect(diagramSpecIsValid({ kind: "FLOWCHART", nodes: [node, node], edges: [] })).toBe(false);
  });
});
