import type { AnswerMode } from "../answer";
import type { AnswerQuestionKind } from "./answer-strategy";

export interface AnswerDurationRange {
  min: number;
  max: number;
  target: number;
}

export interface AnswerLengthPolicy extends AnswerDurationRange {
  minCharacters: number;
  maxCharacters: number;
  targetCharacters: number;
  maxSentenceCharacters: number;
  maxSentences: number;
}

// Chinese interview speech is usually around 4~5 readable characters/second.
// Keep the estimate deterministic and intentionally conservative: the provider
// may produce mixed Chinese/English text, but the user needs a usable time band,
// not an exact TTS duration.
const CHARACTERS_PER_SECOND = 4.2;
const MIN_CHARACTERS_PER_SECOND = 4;
const MAX_CHARACTERS_PER_SECOND = 4.8;

export const ANSWER_DURATION_POLICY: Record<AnswerMode, AnswerDurationRange> = {
  FAST: { min: 15, max: 25, target: 20 },
  NORMAL: { min: 30, max: 60, target: 45 },
  DEEP: { min: 60, max: 120, target: 90 }
};

export const FOLLOW_UP_DURATION_POLICY: AnswerDurationRange = { min: 10, max: 30, target: 20 };

// Kept as a compatibility export for integrations that still consume the old
// character-based formatter contract. New answer planning uses the policy
// returned by AnswerLengthController below.
export const ANSWER_LENGTH_POLICY: Record<AnswerMode, { min: number; max: number }> = {
  FAST: { min: 20, max: 60 },
  NORMAL: { min: 60, max: 130 },
  DEEP: { min: 120, max: 250 }
};

export const CODE_LENGTH_POLICY: Record<AnswerMode, { min: number; max: number }> = {
  FAST: { min: 80, max: 900 },
  NORMAL: { min: 160, max: 1_800 },
  DEEP: { min: 260, max: 3_200 }
};

function complexityAdjustment(complexity: "low" | "medium" | "high", range: AnswerDurationRange): AnswerDurationRange {
  if (complexity === "low") return { ...range, target: Math.max(range.min, range.target - 5) };
  if (complexity === "high") return { ...range, target: Math.min(range.max, range.target + 10) };
  return range;
}

export class AnswerLengthController {
  durationRange(mode: AnswerMode, kind: AnswerQuestionKind, complexity: "low" | "medium" | "high" = "medium"): AnswerDurationRange {
    const base = kind === "follow-up" ? FOLLOW_UP_DURATION_POLICY : ANSWER_DURATION_POLICY[mode];
    return complexityAdjustment(complexity, base);
  }

  policy(mode: AnswerMode, kind: AnswerQuestionKind, complexity: "low" | "medium" | "high" = "medium"): AnswerLengthPolicy {
    const range = this.durationRange(mode, kind, complexity);
    const code = kind === "code" ? CODE_LENGTH_POLICY[mode] : undefined;
    const minCharacters = code?.min ?? Math.ceil(range.min * MIN_CHARACTERS_PER_SECOND);
    const maxCharacters = code?.max ?? Math.floor(range.max * MAX_CHARACTERS_PER_SECOND);
    const targetCharacters = code ? Math.round((code.min + code.max) / 2) : Math.round(range.target * CHARACTERS_PER_SECOND);
    return {
      ...range,
      minCharacters,
      maxCharacters,
      targetCharacters,
      maxSentenceCharacters: kind === "code" ? 120 : 72,
      maxSentences: kind === "code" ? 12 : mode === "FAST" || kind === "follow-up" ? 4 : mode === "DEEP" ? 9 : 6
    };
  }

  estimateDurationSec(text: string): number {
    const normalized = text.replace(/```[\s\S]*?```/g, "代码").replace(/[\s\p{P}\p{S}]+/gu, "");
    const latinWords = text.match(/[A-Za-z0-9+#._-]+/g) ?? [];
    const chineseAndOther = Math.max(0, normalized.length - latinWords.join("").length);
    return Number(((chineseAndOther + latinWords.length * 2) / CHARACTERS_PER_SECOND).toFixed(1));
  }

  instruction(policy: AnswerLengthPolicy): string {
    return `目标口述时长约 ${policy.target} 秒，控制在 ${policy.min}~${policy.max} 秒，约 ${policy.minCharacters}~${policy.maxCharacters} 字；单句尽量不超过 ${policy.maxSentenceCharacters} 字。`;
  }
}
