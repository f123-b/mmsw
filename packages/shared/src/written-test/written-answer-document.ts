import { diagramSpecIsValid } from "./diagram-spec";
import { analyzeWrittenProblem } from "./written-problem-analyzer";
import type { WrittenAnswerDocument, WrittenProblemFrame, WrittenQuestionType, WrittenTestResult } from "./written-test-types";

function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String).filter(Boolean) : []; }

export function fallbackWrittenAnswer(problem: WrittenProblemFrame, text: string): WrittenAnswerDocument {
  const finalAnswer = text.trim() || "未能从截图中提取出完整答案，请重试或补充清晰截图。";
  return { questionType: problem.questionType, finalAnswer, steps: [{ title: "分析", content: finalAnswer }], equations: [], explanation: finalAnswer, warnings: ["答案由非结构化模型输出整理而成，请核对题目细节。"], confidence: 0.45 };
}

export function parseWrittenAnswer(value: unknown, problem: WrittenProblemFrame, fallbackText = ""): WrittenAnswerDocument {
  if (!value || typeof value !== "object") return fallbackWrittenAnswer(problem, fallbackText);
  const input = value as Partial<WrittenAnswerDocument>;
  const code = input.code && typeof input.code === "object" && typeof input.code.content === "string" ? { language: String(input.code.language || problem.language || "text"), content: input.code.content } : undefined;
  const table = input.table && typeof input.table === "object" && Array.isArray(input.table.columns) && Array.isArray(input.table.rows) ? { columns: input.table.columns.map(String), rows: input.table.rows.map((row) => Array.isArray(row) ? row.map(String) : []) } : undefined;
  const diagram = diagramSpecIsValid(input.diagram) ? input.diagram : undefined;
  const finalAnswer = String(input.finalAnswer ?? fallbackText).trim() || "答案为空，请重试。";
  const normalizedFinalAnswer = ["SINGLE_CHOICE", "MULTIPLE_CHOICE"].includes(problem.questionType) && !/^答案[：:]/.test(finalAnswer) ? `答案：${finalAnswer}` : finalAnswer;
  return {
    questionType: input.questionType ?? problem.questionType,
    finalAnswer: normalizedFinalAnswer,
    steps: Array.isArray(input.steps) ? input.steps.map((step) => typeof step === "object" && step ? { title: String((step as { title?: unknown }).title ?? "步骤"), content: String((step as { content?: unknown }).content ?? "") } : { title: "步骤", content: String(step) }).filter((step) => step.content) : [],
    ...(code ? { code } : {}), equations: stringArray(input.equations), ...(table ? { table } : {}), ...(diagram ? { diagram } : {}), explanation: String(input.explanation ?? ""), complexity: input.complexity ? String(input.complexity) : undefined, warnings: stringArray(input.warnings), confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0.7)))
  };
}

function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{") >= 0 ? raw.indexOf("{") : 0);
  try { return JSON.parse(candidate); } catch { return undefined; }
}

export function parseWrittenTestResult(raw: string, fallbackText = ""): WrittenTestResult {
  const parsed = extractJson(raw) as Partial<WrittenTestResult> | undefined;
  const problemInput = parsed?.problem && typeof parsed.problem === "object" ? parsed.problem as Partial<WrittenProblemFrame> : undefined;
  const problem = problemInput ? analyzeWrittenProblem(String(problemInput.rawText ?? fallbackText), problemInput) : analyzeWrittenProblem(fallbackText);
  const answer = parsed?.answer && typeof parsed.answer === "object" ? parseWrittenAnswer(parsed.answer, problem, fallbackText) : fallbackWrittenAnswer(problem, raw);
  return { problem, answer };
}

export function renderWrittenAnswer(document: WrittenAnswerDocument): string {
  const lines = [document.finalAnswer];
  if (document.code?.content) lines.push(`\n\
\`\`\`${document.code.language}\n${document.code.content}\n\`\`\``);
  if (document.steps.length) lines.push(`\n${document.steps.map((step, index) => `${index + 1}. ${step.title}：${step.content}`).join("\n")}`);
  if (document.complexity) lines.push(`\n复杂度：${document.complexity}`);
  if (document.warnings.length) lines.push(`\n注意：${document.warnings.join("；")}`);
  return lines.join("\n").trim();
}

export function answerTypeLabel(type: WrittenQuestionType): string {
  return ({ SINGLE_CHOICE: "单选题", MULTIPLE_CHOICE: "多选题", CALCULATION: "计算题", PROGRAMMING: "编程题", CODE_READING: "代码阅读题", CODE_DEBUGGING: "代码调试题", DIGITAL_LOGIC: "数字逻辑题", SYSTEM_DESIGN: "系统设计题" } as Record<string, string>)[type] ?? "笔试题";
}
