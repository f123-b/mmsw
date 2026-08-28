import { normalizeQuestionBankText, questionBankSimilarity, type QuestionBankBankType, type QuestionBankMatch, type QuestionBankQuestionRecord } from "./question-bank";

export type ProjectQaMatchLevel = "exact" | "strong" | "partial" | "none";

export interface ProjectQaRoutingPolicy {
  /** Exact normalized canonical/variant matches are always exact. */
  strongThreshold: number;
  partialThreshold: number;
}

export const DEFAULT_PROJECT_QA_ROUTING_POLICY: ProjectQaRoutingPolicy = {
  strongThreshold: 0.7,
  partialThreshold: 0.6
};

export interface QuestionBankRouteOptions {
  threshold?: number;
  limit?: number;
  projectId?: string;
  skillIds?: string[];
  jobProfileId?: string;
  followUpQuestionId?: string;
  includeArchived?: boolean;
  policy?: Partial<ProjectQaRoutingPolicy>;
}

export interface QuestionBankRouteHit extends QuestionBankMatch {
  semanticScore: number;
  rankScore: number;
  priority: number;
  reasons: string[];
  matchLevel?: ProjectQaMatchLevel;
}

export interface QuestionBankRouteResult {
  hits: QuestionBankRouteHit[];
  top?: QuestionBankRouteHit;
  /** Present when the route was evaluated with the project-first policy. */
  stage?: "project" | "fallback";
  matchLevel?: ProjectQaMatchLevel;
  projectQa?: ProjectQaRouteResult;
  fallback?: QuestionBankRouteResult;
}

export interface ProjectQaRouteResult {
  hits: QuestionBankRouteHit[];
  top?: QuestionBankRouteHit;
  level: ProjectQaMatchLevel;
  projectId: string;
}

export function questionBankAnswerIsReady(question: QuestionBankQuestionRecord): boolean {
  return question.answerCards.some((card) => card.verified && !card.stale && card.content.trim().length > 0);
}

function bankWeight(bankType: QuestionBankBankType): number {
  return bankType === "project" ? 0.08 : bankType === "skill" ? 0.06 : bankType === "job" ? 0.05 : bankType === "behavioral" ? 0.04 : 0.02;
}

function technicalTokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(normalizeQuestionBankText(left).match(/[a-z][a-z0-9+#-]{1,}|\d+(?:\.\d+)?/gi) ?? []);
  const rightTokens = new Set(normalizeQuestionBankText(right).match(/[a-z][a-z0-9+#-]{1,}|\d+(?:\.\d+)?/gi) ?? []);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  return [...leftTokens].some((token) => rightTokens.has(token)) ? 0.61 : 0;
}

function projectQaEvidenceScore(questionText: string, candidate: QuestionBankQuestionRecord): number {
  return Math.max(
    technicalTokenOverlap(questionText, candidate.canonicalText),
    ...candidate.variants.map((variant) => technicalTokenOverlap(questionText, variant)),
    ...candidate.answerCards.map((card) => technicalTokenOverlap(questionText, `${card.content} ${card.codeContent ?? ""}`))
  );
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
        const readyAnswer = questionBankAnswerIsReady(candidate);
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
          exact: input.length > 0 && (input === candidate.normalizedText || candidate.variants.some((variant) => input === normalizeQuestionBankText(variant))),
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

  /**
   * Stage 1 of project-question routing. Only active, non-stale records that
   * belong to the selected project are considered; global records can never
   * outrank this result because they are not in this candidate set.
   */
  routeProjectFirst(questionText: string, candidates: QuestionBankQuestionRecord[], projectId: string, options: QuestionBankRouteOptions = {}): ProjectQaRouteResult {
    const policy: ProjectQaRoutingPolicy = {
      ...DEFAULT_PROJECT_QA_ROUTING_POLICY,
      ...options.policy
    };
    const projectCandidates = candidates.filter((candidate) => candidate.scope === "project" && candidate.projectId === projectId);
    const routed = this.route(questionText, projectCandidates, {
      ...options,
      // Keep the candidate window broad enough for a follow-up that shares a
      // technical anchor with the stored answer but not with the question
      // wording itself. The final level still applies the policy threshold.
      threshold: 0,
      limit: Math.max(options.limit ?? 5, 20),
      projectId,
      includeArchived: false
    });
    const hits = routed.hits.map((hit) => {
      const readyAnswer = questionBankAnswerIsReady(hit.question);
      const exact = hit.exact;
      const effectiveSemanticScore = Math.max(hit.semanticScore, projectQaEvidenceScore(questionText, hit.question));
      const matchLevel: ProjectQaMatchLevel = exact
        ? "exact"
        : effectiveSemanticScore >= policy.strongThreshold && readyAnswer
          ? "strong"
          : effectiveSemanticScore >= policy.partialThreshold
            ? "partial"
            : "none";
      return { ...hit, matchLevel };
    }).filter((hit) => hit.matchLevel !== "none")
      .sort((left, right) => {
        const levelWeight = (level?: ProjectQaMatchLevel): number => level === "exact" ? 4 : level === "strong" ? 3 : level === "partial" ? 2 : 0;
        return levelWeight(right.matchLevel) - levelWeight(left.matchLevel)
          || Math.max(right.semanticScore, projectQaEvidenceScore(questionText, right.question)) - Math.max(left.semanticScore, projectQaEvidenceScore(questionText, left.question))
          || right.rankScore - left.rankScore;
      })
      .slice(0, Math.max(1, Math.min(20, options.limit ?? 5)));
    const top = hits[0];
    return {
      projectId,
      hits,
      ...(top ? { top } : {}),
      level: top?.matchLevel ?? "none"
    };
  }

  /**
   * Two-stage route used by the realtime answer path. A strong project QA
   * result is authoritative; partial results remain available for an
   * augmented answer, while fallback records are only searched afterwards.
   */
  routeProjectQaFirst(questionText: string, candidates: QuestionBankQuestionRecord[], options: QuestionBankRouteOptions & { projectId: string }): QuestionBankRouteResult {
    const project = this.routeProjectFirst(questionText, candidates, options.projectId, options);
    if (project.level !== "none") {
      const result: QuestionBankRouteResult = {
        hits: project.hits,
        ...(project.top ? { top: project.top } : {}),
        stage: "project",
        matchLevel: project.level,
        projectQa: project
      };
      if (project.level === "partial") {
        const fallbackCandidates = candidates.filter((candidate) => candidate.scope !== "project");
        result.fallback = this.route(questionText, fallbackCandidates, { ...options, projectId: undefined });
      }
      return result;
    }
    const fallbackCandidates = candidates.filter((candidate) => candidate.scope !== "project");
    const fallback = this.route(questionText, fallbackCandidates, { ...options, projectId: undefined });
    return {
      ...fallback,
      stage: "fallback",
      matchLevel: "none",
      projectQa: project,
      fallback
    };
  }
}
