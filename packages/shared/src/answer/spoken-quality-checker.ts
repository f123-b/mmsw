import type { AnswerMode } from "../answer";
import type { AnswerPlan } from "./answer-planner";
import type { AnswerQuestionKind } from "./answer-strategy";
import { AnswerLengthController } from "./answer-length-controller";

export interface SpokenQualityInput {
  question: string;
  answer: string;
  mode: AnswerMode;
  kind: AnswerQuestionKind;
  plan?: AnswerPlan;
  projectEvidence?: string[];
  groundingText?: string;
}

export interface SpokenQualityMetrics {
  estimatedDurationSec: number;
  sentenceCount: number;
  maxSentenceCharacters: number;
  markdownMarkers: number;
  repeatedSentences: number;
  technicalTermCount: number;
}

export interface SpokenQualityResult {
  score: number;
  issues: string[];
  suggestions: string[];
  needsRepair: boolean;
  metrics: SpokenQualityMetrics;
}

const AI_STYLE = /(?:首先|其次|综上所述|综上|总的来说|从以下几个方面|这个问题可以这样回答|下面从以下)/;
const TECHNICAL_TERM = /\b(?:STM\d+[A-Z0-9]*|RK\d+|FreeRTOS|RTOS|FOC|SVPWM|DMA|ADC|PWM|CAN|UART|MQTT|Linux|Python|C\+\+|TypeScript|SQLite|WebSocket|IIC|I2C|SPI|TCP|UDP|API|RAG|ASR|VAD)\b/gi;
const QUANTITATIVE_CLAIM = /(?<![A-Za-z])\d+(?:\.\d+)?\s*(?:ms|us|秒|分钟|小时|天|周|个月|年|%|Hz|MHz|kHz|MB|KB|路|个)/gi;

function sentences(text: string): string[] {
  return (text.replace(/\n+/g, " ").match(/[^。！？!?；;]+(?:[。！？!?；;]|$)/g) ?? [text])
    .map((item) => item.trim())
    .filter(Boolean);
}

function compact(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function questionTerms(question: string): string[] {
  return [...new Set(question.match(/[A-Za-z][A-Za-z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [])]
    .filter((term) => !/^(什么|为什么|如何|怎么|怎样|哪些|哪个|介绍|一下|作用|原理|区别|场景|请问|能不能|是否|有没有)$/.test(term));
}

function mergeUnique(values: string[]): string[] { return [...new Set(values)]; }

/** Checks whether a completed answer sounds usable in a live interview. */
export class SpokenQualityChecker {
  constructor(private readonly lengthController = new AnswerLengthController()) {}

  check(input: SpokenQualityInput): SpokenQualityResult {
    const answer = input.answer.trim();
    const plan = input.plan;
    const length = plan?.length ?? this.lengthController.policy(input.mode, input.kind);
    const parts = sentences(answer);
    const normalizedParts = parts.map(compact);
    const repeatedSentences = normalizedParts.length - new Set(normalizedParts).size;
    const technicalTermCount = answer.match(TECHNICAL_TERM)?.length ?? 0;
    const markdownMarkers = (answer.match(/```|^\s*#{1,6}\s|^\s*[-*•]\s|^\s*\d+[.)、]\s/gm) ?? []).length;
    const metrics: SpokenQualityMetrics = {
      estimatedDurationSec: this.lengthController.estimateDurationSec(answer),
      sentenceCount: parts.length,
      maxSentenceCharacters: Math.max(0, ...parts.map((part) => part.length)),
      markdownMarkers,
      repeatedSentences,
      technicalTermCount
    };
    const issues: string[] = [];
    const suggestions: string[] = [];
    const firstSentence = parts[0] ?? "";
    const terms = questionTerms(input.question);
    const direct = terms.length === 0 || terms.some((term) => compact(firstSentence).includes(compact(term)));
    if (input.kind !== "code" && !direct) {
      issues.push("question-mismatch");
      suggestions.push("第一句先直接回应问题，再补充原因或例子");
    }
    if (input.kind !== "code" && AI_STYLE.test(answer)) {
      issues.push("too-formal");
      suggestions.push("删除模板化连接词，改成面试现场能直接说出口的短句");
    }
    if (input.kind !== "code" && markdownMarkers > 0) {
      issues.push("markdown-heavy");
      suggestions.push("去掉标题、编号和项目符号，只保留自然段口述内容");
    }
    if (input.kind !== "code" && metrics.maxSentenceCharacters > length.maxSentenceCharacters) {
      issues.push("long-sentence");
      suggestions.push(`拆分长句，单句尽量控制在 ${length.maxSentenceCharacters} 字以内`);
    }
    if (input.kind !== "code" && repeatedSentences > 0) {
      issues.push("repetitive");
      suggestions.push("合并重复句，只保留一次结论和一次依据");
    }
    if (input.kind !== "code" && technicalTermCount >= Math.max(6, Math.ceil(answer.length / 18))) {
      issues.push("term-dense");
      suggestions.push("减少连续缩写，首次出现的术语补一句短解释");
    }
    if (input.kind !== "code" && answer && metrics.estimatedDurationSec < length.min) {
      issues.push("spoken-too-short");
      suggestions.push(`补足到约 ${length.min}~${length.max} 秒，至少覆盖核心结论和一个依据`);
    }
    if (input.kind !== "code" && metrics.estimatedDurationSec > length.max) {
      issues.push("spoken-too-long");
      suggestions.push(`压缩到约 ${length.min}~${length.max} 秒，只保留与问题直接相关的内容`);
    }
    if (plan?.mustUseFirstPerson && !/(我|我的|我们|在项目中)/.test(answer)) {
      issues.push("not-first-person");
      suggestions.push("项目或行为题改用候选人第一人称，明确我做了什么");
    }
    if (plan?.requiredEvidence.includes("personal_project_fact") && !(input.projectEvidence?.length || input.groundingText?.trim())) {
      issues.push("missing-personal-evidence");
      suggestions.push("没有确认过的个人事实时，不要生成具体职责、指标或项目经历");
    }
    const numbers = input.kind === "code" ? [] : answer.match(QUANTITATIVE_CLAIM) ?? [];
    const evidence = `${input.projectEvidence?.join("\n") ?? ""}\n${input.groundingText ?? ""}`;
    if (numbers.length > 0 && !numbers.every((number) => evidence.includes(number))) {
      issues.push("unverified-quantitative-claim");
      suggestions.push("量化数据必须能在项目证据中逐项找到，找不到就改成定性描述");
    }
    const penalty = new Map<string, number>([
      ["question-mismatch", 0.18], ["too-formal", 0.12], ["markdown-heavy", 0.08], ["long-sentence", 0.08],
      ["repetitive", 0.08], ["term-dense", 0.08], ["spoken-too-short", 0.18], ["spoken-too-long", 0.16],
      ["not-first-person", 0.16], ["missing-personal-evidence", 0.3], ["unverified-quantitative-claim", 0.25]
    ]);
    const rawScore = 1 - issues.reduce((sum, issue) => sum + (penalty.get(issue) ?? 0.05), 0);
    const score = Math.max(0, Math.min(1, Number(rawScore.toFixed(2))));
    const needsRepair = score < 0.65 || issues.some((issue) => ["missing-personal-evidence", "unverified-quantitative-claim", "question-mismatch", "not-first-person"].includes(issue));
    return { score, issues: mergeUnique(issues), suggestions: mergeUnique(suggestions), needsRepair, metrics };
  }
}
