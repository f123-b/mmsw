import type { AnswerMode } from "../answer";

export const ANSWER_LENGTH_POLICY: Record<AnswerMode, { min: number; max: number }> = {
  FAST: { min: 30, max: 80 },
  NORMAL: { min: 80, max: 150 },
  DEEP: { min: 150, max: 250 }
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

function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const candidate = text.slice(0, max);
  const punctuation = [...candidate].reduce((last, char, index) => /[。！？!?；;，,]/.test(char) ? index + 1 : last, 0);
  return (punctuation >= Math.floor(max * 0.55) ? candidate.slice(0, punctuation) : candidate).trim();
}

/** Converts provider output into compact, spoken interview language at the final boundary. */
export class InterviewAnswerFormatter {
  policy(mode: AnswerMode): { min: number; max: number } { return ANSWER_LENGTH_POLICY[mode]; }

  instructions(mode: AnswerMode): string {
    const { min, max } = this.policy(mode);
    return `你是一名正在参加技术面试的工程师。请用第一人称、自然口语回答，先直接回答，再结合真实项目经历，最后补充优化或总结。不要百科式展开，不要大量编号，不要虚构经历。控制在 ${min}~${max} 字。`;
  }

  format(text: string, mode: AnswerMode): string {
    const clean = naturalize(cleanMarkdown(text));
    if (!clean) return "";
    return trimToSentence(clean, this.policy(mode).max);
  }
}
