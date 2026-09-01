import type { AnswerMode, AnswerQuestionKind } from "../answer";
import type { AnswerTelemetry } from "../answer";
import { AnswerLengthController } from "./answer-length-controller";

export interface AnswerQualityResult {
  score: number;
  issues: string[];
  suggestions: string[];
  needsRepair: boolean;
  claimGateDecision?: "allow" | "rewrite" | "partial" | "abstain";
  blockedClaimCount?: number;
  answerSourceMode?: string;
  qaMatchLevel?: string;
  projectTruthDecision?: "ALLOW" | "REWRITE" | "BLOCK";
  telemetry?: AnswerTelemetry;
}

export interface AnswerQualityInput {
  question: string;
  answer: string;
  mode: AnswerMode;
  kind?: AnswerQuestionKind;
  groundingText?: string;
}

/** Lightweight deterministic guardrail; it does not call an LLM or alter SQLite data. */
export class AnswerQualityChecker {
  private readonly lengthController = new AnswerLengthController();

  check(input: AnswerQualityInput): AnswerQualityResult {
    const issues: string[] = [];
    const suggestions: string[] = [];
    const kind = input.kind ?? "technical";
    const policy = this.lengthController.policy(input.mode, kind);
    const answer = input.answer.trim();
    const grounding = `${input.groundingText || ""} ${input.question}`.toLowerCase();
    let score = 1;
    if (answer.length < policy.minCharacters && input.mode !== "FAST") {
      issues.push("answer-too-short");
      suggestions.push(`补充到约 ${policy.minCharacters}~${policy.maxCharacters} 字，补足题型要求的关键内容`);
      score -= 0.18;
    }
    if (answer.length > policy.maxCharacters) {
      issues.push("answer-too-long");
      suggestions.push(`压缩到约 ${policy.minCharacters}~${policy.maxCharacters} 字`);
      score -= 0.2;
    }
    if ((kind === "project" || kind === "behavioral") && !/(我|我们|我会|我一般|在项目中|我的)/.test(answer)) {
      issues.push("not-first-person");
      suggestions.push("改成候选人口吻，使用第一人称直接回答");
      score -= 0.16;
    }
    if (/^(首先|其次|最后|综上|本文|总的来说)/.test(answer) || /\d+[.)、]/.test(answer)) {
      issues.push("too-formal");
      suggestions.push("减少书面化连接词和编号，改成自然口语");
      score -= 0.12;
    }
    const questionTerms = input.question.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]{2,}/gi) ?? [];
    if (questionTerms.length > 0 && !questionTerms.some((term) => answer.toLowerCase().includes(term))) {
      issues.push("question-mismatch");
      suggestions.push("第一句先明确回答面试官的问题");
      score -= 0.18;
    }
    if (/我负责|我实现|我设计|我带领|我主导/.test(answer) && input.groundingText && !/(我负责|我实现|我设计|我带领|我主导)/.test(grounding)) {
      issues.push("possibly-invented-experience");
      suggestions.push("只使用简历或知识库中能被证实的项目经历");
      score -= 0.25;
    }
    const normalizedScore = Math.max(0, Math.min(1, Number(score.toFixed(2))));
    return { score: normalizedScore, issues, suggestions, needsRepair: normalizedScore < 0.65 || issues.includes("possibly-invented-experience") };
  }
}
