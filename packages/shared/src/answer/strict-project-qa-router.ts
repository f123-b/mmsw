import { QuestionBankRouter, type ProjectQaRouteResult } from "../question-bank-router";
import { normalizeQuestionBankText, type QuestionBankQuestionRecord } from "../question-bank";

export type StrictProjectQaMatchLevel = "EXACT" | "RERANK_CONFIRMED" | "NO_MATCH";

export interface StrictProjectQaResult {
  projectId: string;
  level: StrictProjectQaMatchLevel;
  route: ProjectQaRouteResult;
  topScore: number;
  secondScore: number;
  margin: number;
  reason: string;
}

export interface StrictProjectQaOptions {
  minRerankScore?: number;
  minMargin?: number;
}

/**
 * Accurate interview routing is deliberately narrower than the legacy
 * augmented route. It only considers verified, current records owned by the
 * locked project and never falls through to global knowledge.
 */
export class StrictProjectQaRouter {
  constructor(private readonly router = new QuestionBankRouter()) {}

  match(questionText: string, candidates: QuestionBankQuestionRecord[], projectId: string, options: StrictProjectQaOptions = {}): StrictProjectQaResult {
    const minRerankScore = options.minRerankScore ?? 0.7;
    const minMargin = options.minMargin ?? 0.1;
    const projectCandidates = candidates.filter((candidate) => candidate.scope === "project" && candidate.projectId === projectId);
    const route = this.router.routeProjectFirst(questionText, projectCandidates, projectId, { limit: 5 });
    return this.evaluateRoute(route, questionText, projectId, minRerankScore, minMargin);
  }

  /** Final strict decision for a route already produced by a project-first repository. */
  matchRoute(route: ProjectQaRouteResult | undefined, projectId: string, options: StrictProjectQaOptions = {}): StrictProjectQaResult {
    return this.evaluateRoute(route ?? { projectId, hits: [], level: "none" }, "", projectId, options.minRerankScore ?? 0.7, options.minMargin ?? 0.1);
  }

  private evaluateRoute(route: ProjectQaRouteResult, questionText: string, projectId: string, minRerankScore: number, minMargin: number): StrictProjectQaResult {
    const top = route.top;
    const second = route.hits[1];
    const topScore = top?.score ?? 0;
    const secondScore = second?.score ?? 0;
    const margin = Math.max(0, topScore - secondScore);
    const ready = Boolean(top?.question.verified && top.question.answerCards.some((card) => card.verified && !card.stale && card.content.trim()));
    const exact = Boolean(top && (top.exact || normalizeQuestionBankText(questionText) === normalizeQuestionBankText(top.question.canonicalText)));
    if (top && exact && ready) {
      return { projectId, level: "EXACT", route, topScore, secondScore, margin, reason: "exact-verified-project-qa" };
    }
    if (top && ready && topScore >= minRerankScore && margin >= minMargin && (top.matchLevel === "strong" || top.matchLevel === "exact")) {
      return { projectId, level: "RERANK_CONFIRMED", route, topScore, secondScore, margin, reason: "rerank-score-and-margin-confirmed" };
    }
    return { projectId, level: "NO_MATCH", route, topScore, secondScore, margin, reason: top ? "project-qa-score-or-margin-insufficient" : "no-project-qa-candidate" };
  }
}
