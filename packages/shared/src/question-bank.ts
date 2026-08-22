import { normalizeTechnicalTerms } from "./terminology";

export const QUESTION_BANK_TYPES = [
  "technical",
  "concept",
  "comparison",
  "system-design",
  "troubleshooting",
  "code",
  "project",
  "behavioral",
  "general"
] as const;

export type QuestionBankType = typeof QUESTION_BANK_TYPES[number];
export type QuestionBankAnswerMode = "short" | "standard" | "deep" | "code";
export type QuestionBankSourceType = "manual" | "imported" | "verified" | "generated";

export interface ParsedQuestionBankEntry {
  question: string;
  answer?: string;
  sourceLine: number;
  type: QuestionBankType;
}

export const QUESTION_BANK_TYPE_LABELS: Record<QuestionBankType, string> = {
  technical: "技术原理",
  concept: "概念解释",
  comparison: "对比选型",
  "system-design": "系统设计",
  troubleshooting: "故障排查",
  code: "代码题",
  project: "项目经历",
  behavioral: "行为面试",
  general: "通用问题"
};

export interface QuestionBankQuestionRecord {
  id: string;
  canonicalText: string;
  normalizedText: string;
  type: QuestionBankType;
  difficulty: string;
  jobRole?: string;
  source: QuestionBankSourceType;
  status: "active" | "archived";
  variants: string[];
  answerCards: QuestionBankAnswerCardRecord[];
  skillIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface QuestionBankAnswerCardRecord {
  id: string;
  questionId: string;
  mode: QuestionBankAnswerMode;
  content: string;
  codeContent?: string;
  keyPoints: string[];
  complexity?: string;
  limitations?: string;
  sourceType: QuestionBankSourceType;
  verified: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface QuestionBankSkillRecord {
  id: string;
  name: string;
  normalizedName: string;
  category: string;
  aliases: string[];
  description: string;
  points: QuestionBankSkillPointRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface QuestionBankSkillPointRecord {
  id: string;
  skillId: string;
  title: string;
  content: string;
  sourceType: QuestionBankSourceType;
  verified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface QuestionBankJobProfileRecord {
  id: string;
  name: string;
  description: string;
  skillIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface QuestionBankMatch {
  question: QuestionBankQuestionRecord;
  score: number;
  exact: boolean;
}

const QUESTION_LINE_PREFIX = /^\s*(?:(?:q\s*\d*|question|问题|题目)\s*[:：]|(?:\d+\s*[\.、）)]|[（(]\s*\d+\s*[）)]|[一二三四五六七八九十百]+\s*[、.）)]|[-•]\s+))\s*/i;
const ANSWER_LINE_PREFIX = /^\s*(?:a\s*\d*|answer|答案|参考答案)\s*[:：]\s*/i;
const QUESTION_HINTS = /[?？]|什么|如何|怎么|怎样|为什么|为何|是否|能否|哪个|哪些|区别|优缺点|介绍|说说|讲讲|解释|说明|原理|流程|作用|用途|机制|场景|实现|配置|排查|定位|解决|用过|了解|吗|呢|多少|包含|手撕|写一个|判断|反转|复杂度/i;

function isLikelyQuestion(text: string): boolean {
  const value = text.trim();
  if (value.length < 4) return false;
  if (/^(?:free-?rtos|linux|c\s*语言|c\+\+|c\/c\+\+|嵌入式|网络|操作系统|项目经历|实习|一面|二面|三面|主管面|单板硬件面试|实习笔试|笔试题|技术问题)$/i.test(value)) return false;
  return QUESTION_HINTS.test(value) || value.length >= 12;
}

function isSectionHeading(text: string): boolean {
  const value = text.trim();
  return /^(?:[一二三四五六七八九十百]+|\d+)\s*[、.]\s*(?:free-?rtos|linux|c\s*语言|c\+\+|项目|实习|面试|笔试|技术问题|单板硬件面试)/i.test(value)
    || /^\d+\s+(?:实习笔试|面试|技术问题|单板硬件面试|项目经历)/i.test(value)
    || /^(?:一面|二面|三面|主管面|单板硬件面试|实习笔试|笔试题|技术问题|项目经历)\s*$/i.test(value);
}

function stripQuestionPrefix(line: string): string {
  return line.replace(QUESTION_LINE_PREFIX, "").replace(/^#{1,6}\s+/, "").trim();
}

/**
 * Parses common interview-bank text formats line by line. A blank line is
 * treated as a visual separator only; it is never used as the question
 * boundary, which prevents a large numbered list from collapsing into one
 * question.
 */
export function parseQuestionBankText(text: string): ParsedQuestionBankEntry[] {
  const entries: ParsedQuestionBankEntry[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let current: { question: string; answerLines: string[]; sourceLine: number } | undefined;
  let collectingAnswer = false;

  const flush = () => {
    if (!current) return;
    const question = current.question.replace(/\s+/g, " ").trim();
    const answer = current.answerLines.join("\n").trim();
    if (isLikelyQuestion(question) && !isSectionHeading(question)) {
      entries.push({ question, ...(answer ? { answer } : {}), sourceLine: current.sourceLine, type: inferQuestionBankType(question) });
    }
    current = undefined;
    collectingAnswer = false;
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      if (collectingAnswer && current?.answerLines.length) current.answerLines.push("");
      return;
    }
    const answerMatch = line.match(ANSWER_LINE_PREFIX);
    if (answerMatch && current) {
      collectingAnswer = true;
      const answer = line.slice(answerMatch[0].length).trim();
      if (answer) current.answerLines.push(answer);
      return;
    }

    const isMarkdownHeading = /^#{1,6}\s+/.test(line);
    const hasQuestionPrefix = QUESTION_LINE_PREFIX.test(line) || isMarkdownHeading;
    if (hasQuestionPrefix) {
      const question = stripQuestionPrefix(line);
      if (isSectionHeading(question) && !isLikelyQuestion(question)) {
        flush();
        return;
      }
      if (isLikelyQuestion(question)) {
        flush();
        current = { question, answerLines: [], sourceLine: index + 1 };
        collectingAnswer = false;
        return;
      }
    }

    if (collectingAnswer && current) {
      current.answerLines.push(line);
    } else if (current && !isSectionHeading(line) && !QUESTION_LINE_PREFIX.test(line)) {
      current.question = `${current.question} ${line}`;
    } else if (!current && isLikelyQuestion(line)) {
      current = { question: line, answerLines: [], sourceLine: index + 1 };
    }
  });
  flush();
  return entries;
}

export function normalizeQuestionBankText(text: string): string {
  return normalizeTechnicalTerms(text)
    .normalize("NFKC")
    .replace(/通讯/g, "通信")
    .replace(/i2c/g, "iic")
    .replace(/[“”‘’]/g, "")
    .replace(/[\s\u3000，。！？、；：,.!?;:()（）[\]{}<>《》「」"'`]/g, "")
    .toLowerCase()
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalizeQuestionBankText(text).match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []);
}

function meaningfulText(text: string): string {
  return normalizeQuestionBankText(text).replace(/请问|如何|怎么|怎样|为什么|是否|能否|吗|呢|时/g, "");
}

function longestCommonSubstringLength(left: string, right: string): number {
  const previous = new Array<number>(right.length + 1).fill(0);
  let best = 0;
  for (let index = 1; index <= left.length; index += 1) {
    const current = new Array<number>(right.length + 1).fill(0);
    for (let other = 1; other <= right.length; other += 1) {
      if (left[index - 1] === right[other - 1]) {
        current[other] = previous[other - 1] + 1;
        best = Math.max(best, current[other]);
      }
    }
    for (let other = 0; other <= right.length; other += 1) previous[other] = current[other];
  }
  return best;
}

export function questionBankSimilarity(left: string, right: string): number {
  const a = normalizeQuestionBankText(left);
  const b = normalizeQuestionBankText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(0.97, Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.22);
  const leftTokens = tokens(a);
  const rightTokens = tokens(b);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const unionScore = overlap / Math.max(1, new Set([...leftTokens, ...rightTokens]).size);
  const coverageScore = (overlap / Math.max(1, Math.min(leftTokens.size, rightTokens.size))) * 0.82;
  const commonLength = longestCommonSubstringLength(meaningfulText(a), meaningfulText(b));
  const commonScore = commonLength >= 6 ? 0.45 + (commonLength / Math.max(1, Math.max(meaningfulText(a).length, meaningfulText(b).length))) * 0.55 : 0;
  return Math.min(0.96, Math.max(unionScore, coverageScore, commonScore));
}

export function inferQuestionBankType(text: string): QuestionBankType {
  const value = normalizeTechnicalTerms(text).toLowerCase();
  if (/代码|手写|实现|编程|算法|时间复杂度|空间复杂度|code|leetcode/.test(value)) return "code";
  if (/项目|简历|经历|负责|做过|落地|成果|挑战/.test(value)) return "project";
  if (/排查|定位|故障|异常|崩溃|死锁|超时|不通|丢包|问题怎么解决/.test(value)) return "troubleshooting";
  if (/架构|设计|高并发|扩展性|容灾|可用性|模块怎么划分/.test(value)) return "system-design";
  if (/区别|对比|比较|优缺点|选型|为什么不用/.test(value)) return "comparison";
  if (/自我介绍|为什么选择|优点|缺点|团队|冲突|沟通|离职|职业规划/.test(value)) return "behavioral";
  if (/是什么|原理|概念|解释|含义/.test(value)) return "concept";
  return "technical";
}
