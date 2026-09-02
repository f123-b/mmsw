import type { WrittenProblemFrame, WrittenQuestionType } from "./written-test-types";

export interface WrittenAnswerPlan {
  questionType: WrittenQuestionType;
  sections: string[];
  requiresCompleteCode: boolean;
  requiresDiagram: boolean;
  requiresCalculation: boolean;
  defaultTab: "answer" | "code" | "diagram" | "steps";
}

export function createWrittenAnswerPlan(problem: WrittenProblemFrame): WrittenAnswerPlan {
  const code = ["PROGRAMMING", "CODE_DEBUGGING", "C_CPP", "DATABASE_SQL", "EMBEDDED"].includes(problem.questionType);
  const diagram = Boolean(problem.requestedArtifacts.diagram);
  const calculation = problem.questionType === "CALCULATION" || Boolean(problem.requestedArtifacts.formula);
  const sections = problem.questionType === "SINGLE_CHOICE" || problem.questionType === "MULTIPLE_CHOICE"
    ? ["答案", "理由"]
    : problem.questionType === "CALCULATION" ? ["已知", "公式", "代入", "结果"]
      : problem.questionType === "CODE_READING" ? ["输出", "执行过程", "原因"]
        : code ? ["题意理解", "核心思路", "完整代码", "复杂度", "边界情况"]
          : ["结论", "分析过程", "边界与注意事项"];
  return { questionType: problem.questionType, sections, requiresCompleteCode: code, requiresDiagram: diagram, requiresCalculation: calculation, defaultTab: code ? "code" : diagram ? "diagram" : calculation ? "steps" : "answer" };
}

