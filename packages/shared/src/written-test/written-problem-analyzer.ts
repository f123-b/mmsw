import { normalizeTechnicalTerms } from "../terminology";
import { WRITTEN_QUESTION_TYPES, type WrittenProblemFrame, type WrittenQuestionType, type WrittenRequestedArtifacts } from "./written-test-types";

const typeWords: Array<[WrittenQuestionType, RegExp]> = [
  ["SINGLE_CHOICE", /单选|选择题|以下.*正确|以下.*错误/],
  ["MULTIPLE_CHOICE", /多选|不定项/],
  ["CALCULATION", /计算|求值|算出|推导|电阻|概率|时间复杂度/],
  ["CODE_DEBUGGING", /调试|错误|bug|为什么.*错|修复/i],
  ["CODE_READING", /阅读.*代码|代码.*输出|运行结果|执行结果/],
  ["PROGRAMMING", /编程|实现.*函数|写.*代码|完整代码|算法题/],
  ["DIGITAL_LOGIC", /逻辑门|真值表|触发器|数字逻辑|与门|或门|非门/],
  ["FLOWCHART", /流程图|流程/],
  ["STATE_MACHINE", /状态机|状态转移/],
  ["SEQUENCE_DIAGRAM", /时序图|序列图/],
  ["SYSTEM_DESIGN", /系统设计|架构设计|设计.*系统/],
  ["DATABASE_SQL", /sql|数据库|查询|索引|事务/i],
  ["NETWORK", /tcp|udp|http|网络|协议/i],
  ["OPERATING_SYSTEM", /操作系统|进程|线程|死锁|内存管理/],
  ["C_CPP", /c\+\+|c语言|指针|stl|模板/i],
  ["EMBEDDED", /嵌入式|单片机|寄存器|中断|驱动/],
  ["ALGORITHM", /算法|排序|二叉树|链表|动态规划|贪心/]
];

export function inferWrittenQuestionType(text: string): WrittenQuestionType {
  const normalized = normalizeTechnicalTerms(text).trim();
  return typeWords.find(([, pattern]) => pattern.test(normalized))?.[0] ?? "SHORT_ANSWER";
}

function linesAfter(text: string, labels: string[]): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && labels.some((label) => line.startsWith(label))).slice(0, 12);
}

export function analyzeWrittenProblem(rawText: string, hint?: Partial<WrittenProblemFrame>): WrittenProblemFrame {
  const clean = normalizeTechnicalTerms(rawText).trim();
  const questionType = hint?.questionType ?? inferWrittenQuestionType(clean);
  const requestedArtifacts: WrittenRequestedArtifacts = {
    code: hint?.requestedArtifacts?.code ?? ["PROGRAMMING", "CODE_DEBUGGING", "C_CPP", "DATABASE_SQL"].includes(questionType),
    diagram: hint?.requestedArtifacts?.diagram ?? ["FLOWCHART", "STATE_MACHINE", "SEQUENCE_DIAGRAM", "SYSTEM_DESIGN", "DIGITAL_LOGIC"].includes(questionType),
    table: hint?.requestedArtifacts?.table ?? /表格|真值表|对比|比较/.test(clean),
    formula: hint?.requestedArtifacts?.formula ?? ["CALCULATION", "DIGITAL_LOGIC"].includes(questionType),
    derivation: hint?.requestedArtifacts?.derivation ?? /推导|证明|过程/.test(clean)
  };
  const canonicalQuestion = hint?.canonicalQuestion?.trim() || clean || "截图中的笔试题目";
  return {
    rawText: rawText.trim(), canonicalQuestion, questionType,
    language: hint?.language,
    requirements: hint?.requirements?.filter(Boolean) ?? linesAfter(clean, ["要求", "请", "需要"]),
    inputs: hint?.inputs?.filter(Boolean) ?? linesAfter(clean, ["输入", "给定"]),
    outputs: hint?.outputs?.filter(Boolean) ?? linesAfter(clean, ["输出", "返回"]),
    constraints: hint?.constraints?.filter(Boolean) ?? linesAfter(clean, ["约束", "限制", "范围"]),
    codeContext: hint?.codeContext,
    formulas: hint?.formulas?.filter(Boolean) ?? [],
    requestedArtifacts,
    confidence: Math.max(0, Math.min(1, hint?.confidence ?? (clean ? 0.62 : 0.1)))
  };
}

export function parseWrittenProblem(value: unknown, fallbackText: string): WrittenProblemFrame {
  if (!value || typeof value !== "object") return analyzeWrittenProblem(fallbackText);
  const input = value as Partial<WrittenProblemFrame>;
  const questionType = WRITTEN_QUESTION_TYPES.includes(input.questionType as WrittenQuestionType) ? input.questionType as WrittenQuestionType : undefined;
  return analyzeWrittenProblem(fallbackText, {
    ...input,
    ...(questionType ? { questionType } : {}),
    requirements: Array.isArray(input.requirements) ? input.requirements.map(String) : undefined,
    inputs: Array.isArray(input.inputs) ? input.inputs.map(String) : undefined,
    outputs: Array.isArray(input.outputs) ? input.outputs.map(String) : undefined,
    constraints: Array.isArray(input.constraints) ? input.constraints.map(String) : undefined,
    formulas: Array.isArray(input.formulas) ? input.formulas.map(String) : undefined
  });
}

