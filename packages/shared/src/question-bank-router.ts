import { normalizeQuestionBankText, questionBankSimilarity, type QuestionBankBankType, type QuestionBankMatch, type QuestionBankQuestionRecord } from "./question-bank";

export type ProjectQaMatchLevel = "exact" | "strong" | "partial" | "none";

export interface ProjectQaRoutingPolicy {
  /** Exact normalized canonical/variant matches are always exact. */
  strongThreshold: number;
  partialThreshold: number;
}

export const DEFAULT_PROJECT_QA_ROUTING_POLICY: ProjectQaRoutingPolicy = {
  strongThreshold: 0.7,
  // Partial is a safe augmented route, not an authority signal. Keep it
  // below strong while still requiring base similarity or an eligible
  // anchor boost; a lone ADC/DMA/CAN token remains below this score.
  partialThreshold: 0.46
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
  /** Similarity before any deterministic technical-anchor boost. */
  baseScore?: number;
  /** A bounded boost that is only applied after base similarity and intent checks. */
  anchorBoost?: number;
  answerSupportScore?: number;
  technicalAnchorMatched?: boolean;
  intentMatched?: boolean;
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

const TECHNICAL_ANCHOR_PATTERN = /adc|dma|pwm|can|uart|iic|i2c|spi|foc|svpwm|rtos|freertos|tcp|udp|volatile|c\+\+|虚函数|优先级反转|采样|中点|实时性|仲裁|校准|频率|时序/gi;
const INTENT_PATTERNS: Array<[string, RegExp]> = [
  ["implementation", /实现|怎么做|如何做|采样|同步|搬运|配置|封装|设计|采用|使用|选型/],
  ["principle", /原理|是什么|作用|机制|为什么|为何|怎么工作|如何工作/],
  ["performance", /实时性|性能|延迟|耗时|吞吐|开销|负载|频率|周期/],
  ["validation", /验证|测试|确认|时序|波形|指标|测量/],
  ["troubleshooting", /排查|定位|故障|异常|报错|不及时|覆盖|丢帧|处理不过来|来不及|怎么办|怎么解决|如何解决/],
  ["calibration", /校准|误差|偏差|精度/],
];
const MIN_PARTIAL_BASE_SCORE = 0.30;
const MAX_TECHNICAL_ANCHOR_BOOST = 0.16;

function technicalAnchors(text: string): Set<string> {
  return new Set(normalizeQuestionBankText(text).match(TECHNICAL_ANCHOR_PATTERN) ?? []);
}

function intentGroups(text: string): Set<string> {
  const normalized = normalizeQuestionBankText(text);
  return new Set(INTENT_PATTERNS.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name));
}

function intentsCompatible(left: Set<string>, right: Set<string>): boolean {
  if ([...left].some((item) => right.has(item))) return true;
  const compatiblePairs = new Set([
    "implementation:validation",
    "implementation:troubleshooting",
    "performance:troubleshooting",
    "performance:validation",
    "validation:troubleshooting"
  ]);
  return [...left].some((leftIntent) => [...right].some((rightIntent) => compatiblePairs.has(`${leftIntent}:${rightIntent}`) || compatiblePairs.has(`${rightIntent}:${leftIntent}`)));
}

export interface ProjectQaEvidenceScore {
  baseScore: number;
  answerSupportScore: number;
  score: number;
  anchorBoost: number;
  technicalAnchorMatched: boolean;
  intentMatched: boolean;
}

/**
 * Technical terms are topic anchors only. They can add a small boost after
 * lexical/semantic evidence and intent compatibility have already passed;
 * one shared token can never create a partial match by itself.
 */
export function projectQaEvidenceScore(questionText: string, candidate: QuestionBankQuestionRecord): ProjectQaEvidenceScore {
  const candidateTexts = [candidate.canonicalText, ...candidate.variants];
  const baseScore = Math.max(0, ...candidateTexts.map((text) => questionBankSimilarity(questionText, text)));
  const answerSupportScore = Math.max(0, ...candidate.answerCards.filter((card) => !card.stale && card.content.trim()).map((card) => questionBankSimilarity(questionText, card.content)));
  const partialBaseScore = Math.max(baseScore, Math.min(0.44, answerSupportScore));
  const leftAnchors = technicalAnchors(questionText);
  const rightAnchors = new Set([...candidateTexts, ...candidate.answerCards.filter((card) => !card.stale && card.content.trim()).map((card) => card.content)].flatMap((text) => [...technicalAnchors(text)]));
  const technicalAnchorMatched = [...leftAnchors].some((token) => rightAnchors.has(token));
  const intentMatched = intentsCompatible(intentGroups(questionText), new Set(candidateTexts.flatMap((text) => [...intentGroups(text)])));
  const anchorBoost = technicalAnchorMatched && intentMatched && partialBaseScore >= MIN_PARTIAL_BASE_SCORE ? MAX_TECHNICAL_ANCHOR_BOOST : 0;
  return { baseScore, answerSupportScore, score: Math.min(0.96, partialBaseScore + anchorBoost), anchorBoost, technicalAnchorMatched, intentMatched };
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
          baseScore: semanticScore,
          anchorBoost: 0,
          technicalAnchorMatched: false,
          intentMatched: false,
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
      const evidenceScore = projectQaEvidenceScore(questionText, hit.question);
      const effectiveSemanticScore = Math.max(hit.semanticScore, evidenceScore.score);
      const matchLevel: ProjectQaMatchLevel = exact
        ? "exact"
        : Math.max(hit.semanticScore, evidenceScore.baseScore) >= policy.strongThreshold && readyAnswer
          ? "strong"
          : effectiveSemanticScore >= policy.partialThreshold && (evidenceScore.baseScore >= MIN_PARTIAL_BASE_SCORE || evidenceScore.anchorBoost > 0)
            ? "partial"
            : "none";
      return { ...hit, baseScore: evidenceScore.baseScore, answerSupportScore: evidenceScore.answerSupportScore, anchorBoost: evidenceScore.anchorBoost, technicalAnchorMatched: evidenceScore.technicalAnchorMatched, intentMatched: evidenceScore.intentMatched, matchLevel };
    }).filter((hit) => hit.matchLevel !== "none")
      .sort((left, right) => {
        const levelWeight = (level?: ProjectQaMatchLevel): number => level === "exact" ? 4 : level === "strong" ? 3 : level === "partial" ? 2 : 0;
        return levelWeight(right.matchLevel) - levelWeight(left.matchLevel)
          || Math.max(right.semanticScore, projectQaEvidenceScore(questionText, right.question).score) - Math.max(left.semanticScore, projectQaEvidenceScore(questionText, left.question).score)
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
