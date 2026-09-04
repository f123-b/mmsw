import type { WrittenAnswerDocument, WrittenProblemFrame } from "./written-test-types";

export interface WrittenAnswerQuality {
  score: number;
  missing: string[];
  repaired: boolean;
}

export function checkWrittenAnswer(problem: WrittenProblemFrame, answer: WrittenAnswerDocument): WrittenAnswerQuality {
  const missing: string[] = [];
  if (!answer.finalAnswer.trim()) missing.push("最终答案");
  if (problem.requestedArtifacts.code && !answer.code?.content.trim()) missing.push("完整代码");
  if (problem.requestedArtifacts.diagram && !answer.diagram) missing.push("图示");
  if (problem.requestedArtifacts.formula && answer.equations.length === 0) missing.push("公式或计算过程");
  if (problem.requestedArtifacts.table && !answer.table?.rows.length) missing.push("表格");
  if (problem.requestedArtifacts.derivation && !answer.steps.length) missing.push("推导步骤");
  const score = Math.max(0, Math.min(1, 1 - missing.length / 4));
  return { score, missing, repaired: false };
}

export function repairWrittenAnswer(problem: WrittenProblemFrame, answer: WrittenAnswerDocument): { answer: WrittenAnswerDocument; quality: WrittenAnswerQuality } {
  const quality = checkWrittenAnswer(problem, answer);
  if (quality.missing.length === 0) return { answer, quality };
  const warnings = [...answer.warnings, `待补充：${quality.missing.join("、")}`];
  return { answer: { ...answer, warnings, confidence: Math.min(answer.confidence, 0.6) }, quality };
}
