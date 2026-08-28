import type { AnswerMode } from "../answer";
import { normalizeTechnicalTerms } from "../terminology";
import { AnswerLengthController } from "./answer-length-controller";
import type { AnswerPlan } from "./answer-planner";
import type { AnswerQuestionKind } from "./answer-strategy";

function cleanMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*#{1,6}\s+[^\n]*$/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s+/gm, "")
    .replace(/```(?:[a-z0-9+#_-]+)?\s*/gi, "")
    .replace(/```/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function removeModelThroat(text: string): string {
  return text
    .replace(/^(?:这个问题(?:可以从以下几个方面回答|可以这样回答)|下面从以下几个方面回答|从以下几个方面来看)[：:，,、\s]*/i, "")
    .replace(/(?:^|[。；;\n])\s*(?:综上所述|综上|总的来说)[，,：:、\s]*/g, "$1")
    .replace(/(?:^|[。；;\n])\s*首先[，,：:、\s]*/g, "$1我一般先")
    .replace(/(?:^|[。；;\n])\s*其次[，,：:、\s]*/g, "$1然后")
    .replace(/(?:^|[。；;\n])\s*最后[，,：:、\s]*/g, "$1最后")
    .replace(/因此/g, "所以")
    .replace(/需要注意的是[，,：:]?/g, "要注意")
    .replace(/该项目|本项目/g, "这个项目")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

function sentenceParts(text: string): string[] {
  const compact = text.replace(/\n+/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!compact) return [];
  return (compact.match(/[^。！？!?；;]+(?:[。！？!?；;]|$)/g) ?? [compact])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function splitLongSentence(sentence: string, maxCharacters: number): string[] {
  if (sentence.length <= maxCharacters) return [sentence];
  const pieces: string[] = [];
  let remaining = sentence;
  while (remaining.length > maxCharacters) {
    const window = remaining.slice(0, maxCharacters);
    const splitAt = Math.max(window.lastIndexOf("，"), window.lastIndexOf(","), window.lastIndexOf("、"));
    if (splitAt < Math.floor(maxCharacters * 0.55)) break;
    pieces.push(`${remaining.slice(0, splitAt + 1).trim()}`);
    remaining = remaining.slice(splitAt + 1).trim();
  }
  return [...pieces, remaining].filter(Boolean);
}

function groupSpokenBlocks(text: string, mode: AnswerMode, maxSentenceCharacters: number): string {
  const sentences = sentenceParts(text).flatMap((sentence) => splitLongSentence(sentence, maxSentenceCharacters));
  if (sentences.length <= 1) return text.trim();
  const targetBlocks = mode === "FAST" ? 2 : mode === "DEEP" ? 6 : 4;
  const blockCount = Math.min(targetBlocks, sentences.length);
  const perBlock = Math.ceil(sentences.length / blockCount);
  const blocks: string[] = [];
  for (let index = 0; index < sentences.length; index += perBlock) blocks.push(sentences.slice(index, index + perBlock).join(""));
  return blocks.join("\n\n").trim();
}

/** Converts provider output into compact language that can be spoken directly. */
export class SpokenAnswerFormatter {
  private readonly lengthController = new AnswerLengthController();

  policy(mode: AnswerMode, kind: AnswerQuestionKind = "technical") {
    return this.lengthController.policy(mode, kind);
  }

  instructions(mode: AnswerMode, kind: AnswerQuestionKind = "technical", plan?: AnswerPlan): string {
    const policy = plan?.length ?? this.policy(mode, kind);
    const firstPerson = kind === "project" || kind === "behavioral" ? "使用第一人称并严格依据真实经历。" : "不必强行使用第一人称项目叙述。";
    if (kind === "code") return `你是一名正在参加技术面试的工程师。代码题必须给出完整、可运行的代码，并用简短口语解释思路、复杂度和边界情况；不要虚构项目经历。${mode === "FAST" ? "优先代码和一句话说明。" : `控制在约 ${policy.minCharacters}~${policy.maxCharacters} 字，不能在代码中途截断。`}`;
    return `你是一名正在参加技术面试的工程师。请用候选人能直接说出口的短句回答：第一句先给结论，再补充关键依据，必要时结合项目或验证方式。${firstPerson}不要百科式展开，不要虚构经历，不要评价“面试官会喜欢什么”，不要讲回答策略。涉及嵌入式问题时先区分 Cortex-M、ARM32、ARM64、Linux 等语境，不能把不同架构的机制混在一起。${this.lengthController.instruction(policy)}`;
  }

  format(text: string, mode: AnswerMode, kind: AnswerQuestionKind = "technical", plan?: AnswerPlan): string {
    if (kind === "code") return text.replace(/\r\n/g, "\n").trim();
    const clean = removeModelThroat(normalizeTechnicalTerms(cleanMarkdown(text)));
    if (!clean) return "";
    const maxSentenceCharacters = plan?.length.maxSentenceCharacters ?? this.policy(mode, kind).maxSentenceCharacters;
    return groupSpokenBlocks(clean, mode, maxSentenceCharacters);
  }
}
