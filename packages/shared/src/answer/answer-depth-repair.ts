import type { AnswerPlan } from "./answer-planner";

export interface AnswerDepthRepairInput {
  question: string;
  existingAnswer: string;
  missingFacets: string[];
  targetCharacters: number;
  plan?: AnswerPlan;
  evidenceText?: string;
}

export interface AnswerDepthRepairOptions {
  generate?: (instruction: string) => Promise<string>;
}

/** Builds a bounded supplement request; it never asks the model to rewrite the answer. */
export class AnswerDepthRepair {
  constructor(private readonly options: AnswerDepthRepairOptions = {}) {}

  instruction(input: AnswerDepthRepairInput): string {
    return [
      "这是同一个面试答案的深度补充，不是新问题。只输出可以直接接在原答案后面的新增技术内容。",
      `问题：${input.question}`,
      `已有答案：${input.existingAnswer}`,
      `只补这些缺失方面：${input.missingFacets.join("、") || "必要的技术依据"}`,
      `目标总长度约 ${input.targetCharacters} 字。不要重复已有答案，不要写空泛套话，不要输出标题、编号或修正过程。`,
      input.evidenceText?.trim() ? `可引用的证据（只能使用其中事实）：\n${input.evidenceText}` : "没有个人证据时只补通用技术解释，不得添加个人经历、职责、数字或项目结果。"
    ].join("\n");
  }

  async repair(input: AnswerDepthRepairInput): Promise<string> {
    if (!this.options.generate || !input.missingFacets.length) return "";
    return (await this.options.generate(this.instruction(input))).trim();
  }
}
