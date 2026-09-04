import { diagramSpecIsValid } from "./diagram-spec";
import { analyzeWrittenProblem } from "./written-problem-analyzer";
import { WRITTEN_QUESTION_TYPES, type WrittenAnswerDocument, type WrittenProblemFrame, type WrittenQuestionType, type WrittenTestResult } from "./written-test-types";

function invalid(field: string): never { throw new Error(`答案格式校验失败：${field}`); }
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, required = false): string {
  if (value == null && !required) return "";
  if (typeof value !== "string") return invalid(field);
  // Never normalize code identifiers or unescape strings a second time.
  if (/\uFFFD|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return invalid(`${field} 含损坏字符`);
  if (required && !value.trim()) return invalid(`${field} 为空`);
  return value;
}
function strings(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 300) return invalid(field);
  return value.map((item) => string(item, field, true));
}
function confidence(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return invalid(field);
  return value;
}
function questionType(value: unknown): WrittenQuestionType {
  if (!WRITTEN_QUESTION_TYPES.includes(value as WrittenQuestionType)) return invalid("questionType");
  return value as WrittenQuestionType;
}

/** Compatibility helper for importing old notes; never used to accept provider output. */
export function fallbackWrittenAnswer(problem: WrittenProblemFrame, text: string): WrittenAnswerDocument {
  return { questionType: problem.questionType, finalAnswer: text, steps: [], equations: [], explanation: "", warnings: ["未通过结构校验，请核对原始记录。"], confidence: 0 };
}

export function parseWrittenAnswer(value: unknown, problem: WrittenProblemFrame, _fallbackText = ""): WrittenAnswerDocument {
  const input = record(value, "answer");
  const type = questionType(input.questionType);
  if (type !== problem.questionType) return invalid("题型与题目不一致");
  const finalAnswer = string(input.finalAnswer, "finalAnswer");
  const steps = input.steps == null ? [] : input.steps;
  if (!Array.isArray(steps) || steps.length > 100) return invalid("steps");
  let code: WrittenAnswerDocument["code"];
  if (input.code != null) {
    const source = record(input.code, "code");
    code = { language: string(source.language, "code.language", true), content: string(source.content, "code.content", true) };
  }
  let table: WrittenAnswerDocument["table"];
  if (input.table != null) {
    const source = record(input.table, "table");
    const columns = strings(source.columns, "table.columns");
    if (!columns.length || !Array.isArray(source.rows) || source.rows.length > 300) return invalid("table");
    const rows = source.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== columns.length) return invalid("table.rows 列数");
      return row.map((cell) => string(cell, "table.cell"));
    });
    table = { columns, rows };
  }
  if (input.diagram != null && !diagramSpecIsValid(input.diagram)) return invalid("diagram");
  if (diagramSpecIsValid(input.diagram)) {
    string(input.diagram.title, "diagram.title");
    for (const node of input.diagram.nodes) { string(node.id, "diagram.node.id", true); string(node.label, "diagram.node.label", true); }
    for (const edge of input.diagram.edges) string(edge.label, "diagram.edge.label");
  }
  return {
    questionType: type, finalAnswer,
    steps: steps.map((value) => { const step = record(value, "step"); return { title: string(step.title, "step.title", true), content: string(step.content, "step.content", true) }; }),
    ...(code ? { code } : {}), ...(table ? { table } : {}),
    ...(input.diagram != null ? { diagram: input.diagram as NonNullable<WrittenAnswerDocument["diagram"]> } : {}),
    equations: strings(input.equations, "equations"), explanation: string(input.explanation, "explanation"),
    complexity: string(input.complexity, "complexity") || undefined,
    warnings: strings(input.warnings, "warnings"), confidence: confidence(input.confidence, "answer.confidence")
  };
}

export function parseWrittenTestResult(raw: string, _fallbackText = ""): WrittenTestResult {
  if (raw.length > 160_000) return invalid("内容过长");
  const trimmed = raw.trim().replace(/^\uFEFF/, "");
  // Only unwrap an entire JSON fence; never pick a code block from prose.
  const candidate = trimmed.match(/^```json\s*\n?([\s\S]*?)\n?```$/i)?.[1] ?? trimmed;
  let value: unknown;
  try { value = JSON.parse(candidate); } catch { return invalid("JSON 无效或输出被截断，请重试"); }
  const result = record(value, "result");
  const input = record(result.problem, "problem");
  const artifacts = record(input.requestedArtifacts, "requestedArtifacts");
  for (const key of ["code", "diagram", "table", "formula", "derivation"]) {
    if (artifacts[key] != null && typeof artifacts[key] !== "boolean") return invalid(`requestedArtifacts.${key}`);
  }
  const problem = analyzeWrittenProblem(string(input.rawText, "rawText", true), {
    canonicalQuestion: string(input.canonicalQuestion, "canonicalQuestion", true), questionType: questionType(input.questionType),
    language: string(input.language, "language") || undefined, codeContext: string(input.codeContext, "codeContext") || undefined,
    requirements: strings(input.requirements, "requirements"), inputs: strings(input.inputs, "inputs"), outputs: strings(input.outputs, "outputs"),
    constraints: strings(input.constraints, "constraints"), formulas: strings(input.formulas, "formulas"),
    requestedArtifacts: artifacts, confidence: confidence(input.confidence, "problem.confidence")
  });
  if (result.inputStatus !== "COMPLETE" && result.inputStatus !== "NEEDS_INPUT") return invalid("inputStatus");
  const missingInformation = strings(result.missingInformation, "missingInformation");
  if (result.inputStatus === "NEEDS_INPUT" && !missingInformation.length) return invalid("请说明缺失的题目条件");
  if (result.inputStatus === "COMPLETE" && missingInformation.length) return invalid("题目完整性状态矛盾");
  return { problem, answer: parseWrittenAnswer(result.answer, problem), inputStatus: result.inputStatus, missingInformation };
}

export function renderWrittenAnswer(document: WrittenAnswerDocument): string {
  const lines = [document.finalAnswer];
  if (document.code?.content) lines.push(`\n\`\`\`${document.code.language}\n${document.code.content}\n\`\`\``);
  if (document.equations.length) lines.push(`\n公式：\n${document.equations.join("\n")}`);
  if (document.table) {
    const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
    lines.push(`\n| ${document.table.columns.map(cell).join(" | ")} |\n| ${document.table.columns.map(() => "---").join(" | ")} |\n${document.table.rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n")}`);
  }
  if (document.steps.length) lines.push(`\n${document.steps.map((step, index) => `${index + 1}. ${step.title}：${step.content}`).join("\n")}`);
  if (document.explanation && document.explanation !== document.finalAnswer) lines.push(`\n${document.explanation}`);
  if (document.complexity) lines.push(`\n复杂度：${document.complexity}`);
  if (document.warnings.length) lines.push(`\n注意：${document.warnings.join("；")}`);
  return lines.join("\n").trim();
}

export function answerTypeLabel(type: WrittenQuestionType): string {
  return ({ SINGLE_CHOICE: "单选题", MULTIPLE_CHOICE: "多选题", CALCULATION: "计算题", PROGRAMMING: "编程题", CODE_READING: "代码阅读题", CODE_DEBUGGING: "代码调试题", DIGITAL_LOGIC: "数字逻辑题", SYSTEM_DESIGN: "系统设计题" } as Record<string, string>)[type] ?? "笔试题";
}
