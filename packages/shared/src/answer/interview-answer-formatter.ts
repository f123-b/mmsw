import type { AnswerMode, AnswerQuestionKind } from "../answer";
import { normalizeTechnicalTerms } from "../terminology";

export const ANSWER_LENGTH_POLICY: Record<AnswerMode, { min: number; max: number }> = {
  FAST: { min: 20, max: 60 },
  NORMAL: { min: 60, max: 130 },
  DEEP: { min: 120, max: 250 }
};

const CODE_LENGTH_POLICY: Record<AnswerMode, { min: number; max: number }> = {
  FAST: { min: 80, max: 900 },
  NORMAL: { min: 160, max: 1_800 },
  DEEP: { min: 260, max: 3_200 }
};

function cleanMarkdown(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+[^\n]*$/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function naturalize(text: string): string {
  return text
    .replace(/^(综上所述|综上|总的来说)[，,：:]?\s*/i, "")
    .replace(/首先[，,：:]?/g, "我一般先")
    .replace(/其次[，,：:]?/g, "然后")
    .replace(/因此/g, "所以")
    .replace(/需要注意的是[，,：:]?/g, "我会特别注意")
    .replace(/该项目/g, "这个项目")
    .replace(/本项目/g, "我的项目")
    .replace(/进行(了)?/g, "做了")
    .replace(/\s+/g, " ")
    .trim();
}

/** Converts provider output into compact, spoken interview language at the final boundary. */
export class InterviewAnswerFormatter {
  policy(mode: AnswerMode, kind: AnswerQuestionKind = "technical"): { min: number; max: number } { return kind === "code" ? CODE_LENGTH_POLICY[mode] : ANSWER_LENGTH_POLICY[mode]; }

  instructions(mode: AnswerMode, kind: AnswerQuestionKind = "technical"): string {
    const { min, max } = this.policy(mode, kind);
    if (kind === "code") return `你是一名正在参加技术面试的工程师。代码题必须给出完整、可运行的代码，并用简短口语解释思路、复杂度和边界情况；不要虚构项目经历。${mode === "FAST" ? "优先代码和一句话说明。" : `控制在约 ${min}~${max} 字，不能在代码中途截断。`}`;
    const firstPerson = kind === "project" || kind === "behavioral" ? "使用第一人称并严格依据真实经历。" : "不必强行使用第一人称项目叙述。";
    return `你是一名正在参加技术面试的工程师。请用候选人能直接说出口的短句回答：第一句先给结论，再补充 2~3 个关键点，最后在确有必要时给出项目或验证方式。${firstPerson}不要百科式展开，不要虚构经历，不要评价“面试官会喜欢什么”，不要讲回答策略。涉及嵌入式问题时优先使用标准术语，并先区分 Cortex-M、ARM32、ARM64、Linux 等语境，不能把不同架构的寄存器或机制混在一起。控制在约 ${min}~${max} 字。`;
  }

  format(text: string, mode: AnswerMode, kind: AnswerQuestionKind = "technical"): string {
    if (kind === "code") return text.replace(/\r\n/g, "\n").trim();
    // The model can still spell an embedded term inconsistently even when
    // ASR was corrected. Normalize the completed answer at the local output
    // boundary so the candidate sees one canonical vocabulary.
    const clean = naturalize(normalizeTechnicalTerms(cleanMarkdown(text)));
    if (!clean) return "";
    // The provider receives an explicit output-token budget. Do not slice the
    // final answer here: slicing is what previously removed the tail of a
    // valid explanation and could leave the user with an incomplete answer.
    return clean;
  }
}
