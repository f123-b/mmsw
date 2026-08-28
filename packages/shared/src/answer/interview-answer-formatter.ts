import type { AnswerMode, AnswerQuestionKind } from "../answer";
import { SpokenAnswerFormatter } from "./spoken-answer-formatter";

// Compatibility boundary for callers that still use the old formatter name.
import { ANSWER_LENGTH_POLICY, CODE_LENGTH_POLICY } from "./answer-length-controller";

export { ANSWER_LENGTH_POLICY, CODE_LENGTH_POLICY } from "./answer-length-controller";

/**
 * Compatibility facade for integrations that still use the pre-Phase-1 name.
 * The live answer path uses SpokenAnswerFormatter directly.
 */
export class InterviewAnswerFormatter {
  private readonly spokenFormatter = new SpokenAnswerFormatter();

  policy(mode: AnswerMode, kind: AnswerQuestionKind = "technical"): { min: number; max: number } {
    return kind === "code" ? CODE_LENGTH_POLICY[mode] : ANSWER_LENGTH_POLICY[mode];
  }

  instructions(mode: AnswerMode, kind: AnswerQuestionKind = "technical"): string {
    const { min, max } = this.policy(mode, kind);
    if (kind === "code") return `你是一名正在参加技术面试的工程师。代码题必须给出完整、可运行的代码，并用简短口语解释思路、复杂度和边界情况；不要虚构项目经历。${mode === "FAST" ? "优先代码和一句话说明。" : `控制在约 ${min}~${max} 字，不能在代码中途截断。`}`;
    const firstPerson = kind === "project" || kind === "behavioral" ? "使用第一人称并严格依据真实经历。" : "不必强行使用第一人称项目叙述。";
    return `你是一名正在参加技术面试的工程师。请用候选人能直接说出口的短句回答：第一句先给结论，再补充 2~3 个关键点，最后在确有必要时给出项目或验证方式。${firstPerson}不要百科式展开，不要虚构经历，不要评价“面试官会喜欢什么”，不要讲回答策略。涉及嵌入式问题时优先使用标准术语，并先区分 Cortex-M、ARM32、ARM64、Linux 等语境，不能把不同架构的寄存器或机制混在一起。控制在约 ${min}~${max} 字。`;
  }

  format(text: string, mode: AnswerMode, kind: AnswerQuestionKind = "technical"): string {
    return this.spokenFormatter.format(text, mode, kind);
  }
}
