import { normalizeQuestionBankText, questionBankSimilarity, type QuestionBankBankType, type QuestionBankMatch, type QuestionBankQuestionRecord } from "./question-bank";

export interface QuestionBankRouteOptions {
  threshold?: number;
  limit?: number;
  projectId?: string;
  skillIds?: string[];
  jobProfileId?: string;
  followUpQuestionId?: string;
  includeArchived?: boolean;
}

export interface QuestionBankRouteHit extends QuestionBankMatch {
  semanticScore: number;
  rankScore: number;
  priority: number;
  reasons: string[];
}

export interface QuestionBankRouteResult {
  hits: QuestionBankRouteHit[];
  top?: QuestionBankRouteHit;
}

function answerIsReady(question: QuestionBankQuestionRecord): boolean {
  return question.answerCards.some((card) => card.verified && !card.stale && card.content.trim().length > 0);
}

function bankWeight(bankType: QuestionBankBankType): number {
  return bankType === "project" ? 0.08 : bankType === "skill" ? 0.06 : bankType === "job" ? 0.05 : bankType === "behavioral" ? 0.04 : 0.02;
}

/**
 * Ranks existing question-bank records using semantic similarity plus the
 * current project, skill and follow-up context. It never generates content.
 */
export class QuestionBankRouter {
  route(questionText: string, candidates: QuestionBankQuestionRecord[], options: QuestionBankRouteOptions = {}): QuestionBankRouteResult {
    const threshold = options.threshold ?? 0.62;
    const limit = Math.max(1, Math.min(20, options.limit ?? 5));
    const skillIds = new Set(options.skillIds ?? []);
    const input = normalizeQuestionBankText(questionText);
    const scored = candidates
      .filter((question) => options.includeArchived || (question.status === "active" && !question.stale))
      .map((candidate): QuestionBankRouteHit => {
        const variantScore = candidate.variants.reduce((best, variant) => Math.max(best, questionBankSimilarity(questionText, variant)), 0);
        const semanticScore = Math.max(questionBankSimilarity(questionText, candidate.canonicalText), variantScore);
        const projectMatch = Boolean(options.projectId && candidate.projectId === options.projectId);
        const skillOverlap = skillIds.size === 0 ? 0 : candidate.skillIds.filter((skillId) => skillIds.has(skillId)).length / skillIds.size;
        const followUpMatch = Boolean(options.followUpQuestionId && candidate.relations.some((relation) => relation.sourceQuestionId === options.followUpQuestionId && relation.relationType === "FOLLOW_UP"));
        const readyAnswer = answerIsReady(candidate);
        const verified = candidate.verified;
        const reasons: string[] = [];
        if (projectMatch) reasons.push("current-project");
        if (skillOverlap > 0) reasons.push("matched-skill");
        if (followUpMatch) reasons.push("follow-up-relation");
        if (verified) reasons.push("verified-question");
        if (readyAnswer) reasons.push("verified-answer");
        reasons.push(`bank:${candidate.bankType}`);
        const contextBoost = (projectMatch ? 0.22 : 0) + skillOverlap * 0.12 + (options.jobProfileId && candidate.jobProfileId === options.jobProfileId ? 0.12 : 0) + (followUpMatch ? 0.14 : 0) + (verified ? 0.06 : 0) + (readyAnswer ? 0.05 : 0) + bankWeight(candidate.bankType);
        const rankScore = semanticScore * 0.78 + contextBoost;
        return {
          question: candidate,
          score: Math.min(1, semanticScore + contextBoost * 0.7),
          exact: input.length > 0 && input === candidate.normalizedText,
          semanticScore,
          rankScore,
          priority: Math.round(Math.min(1, contextBoost) * 100),
          reasons
        };
      })
      .filter((match) => match.semanticScore >= threshold)
      .sort((left, right) => right.rankScore - left.rankScore || right.score - left.score || right.question.updatedAt - left.question.updatedAt)
      .slice(0, limit);
    return { hits: scored, ...(scored[0] ? { top: scored[0] } : {}) };
  }
}
