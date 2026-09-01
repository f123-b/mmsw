import type { QuestionBankRouteHit, ProjectQaMatchLevel, ProjectQaRouteResult } from "../question-bank-router";
import type { CoreTechnicalQaCard } from "./core-technical-qa";

export type AnswerSourceMode =
  | "project_qa_direct"
  | "project_qa_augmented"
  | "project_knowledge_generated"
  | "self_intro_direct"
  | "self_intro_rewrite"
  | "general_technical"
  | "general_core_qa"
  | "personal_experience"
  | "project_context_unresolved";

export interface AnswerSourcePlan {
  mode: AnswerSourceMode;
  projectAnchorAvailable: boolean;
  projectQuestionRequested: boolean;
  projectId?: string;
  qaMatch?: {
    questionId: string;
    answerCardId: string;
    score: number;
    exact: boolean;
    verified: boolean;
  };
  qaMatchLevel: ProjectQaMatchLevel;
  preserveStoredAnswerFacts: boolean;
  allowProjectKnowledge: boolean;
  allowGeneralKnowledge: boolean;
  allowSessionEvidence: boolean;
  answerRewriteUsed: boolean;
}

export interface AnswerSourcePlannerInput {
  projectId?: string;
  projectAnchorAvailable?: boolean;
  projectQuestion?: boolean;
  personalQuestion?: boolean;
  projectQa?: ProjectQaRouteResult;
  preparedAnswer?: {
    answerCardId?: string;
    content: string;
    score: number;
    verified: boolean;
    stale?: boolean;
    questionId?: string;
  };
  coreTechnicalQa?: CoreTechnicalQaCard;
}

function selectedAnswerCard(hit?: QuestionBankRouteHit): { id: string; verified: boolean; content: string } | undefined {
  if (!hit) return undefined;
  const card = hit.question.answerCards
    .filter((candidate) => !candidate.stale && candidate.content.trim())
    .sort((left, right) => Number(right.verified) - Number(left.verified) || right.updatedAt - left.updatedAt)[0];
  return card ? { id: card.id, verified: card.verified, content: card.content } : undefined;
}

function qaMatchFor(hit: QuestionBankRouteHit, card: { id: string; verified: boolean }): AnswerSourcePlan["qaMatch"] {
  return {
    questionId: hit.question.id,
    answerCardId: card.id,
    score: hit.score,
    exact: hit.exact,
    verified: card.verified && hit.question.verified && !hit.question.stale
  };
}

export function planAnswerSource(input: AnswerSourcePlannerInput): AnswerSourcePlan {
  const projectAnchorAvailable = input.projectAnchorAvailable ?? Boolean(input.projectId);
  const projectQuestionRequested = Boolean(input.projectQuestion);
  const personalQuestionRequested = Boolean(input.personalQuestion);
  const qa = input.projectQa?.top;
  const level = input.projectQa?.level ?? "none";
  const card = selectedAnswerCard(qa);
  const verifiedQa = Boolean(qa && card?.verified && qa.question.verified && !qa.question.stale);
  const qaMatch = qa && card ? qaMatchFor(qa, card) : undefined;

  // Project intent and project resolution are independent. Never silently
  // turn an unresolved project question into a free-form personal answer.
  if (projectQuestionRequested && !input.projectId) {
    return {
      mode: "project_context_unresolved",
      projectAnchorAvailable,
      projectQuestionRequested,
      qaMatchLevel: level,
      preserveStoredAnswerFacts: false,
      allowProjectKnowledge: false,
      allowGeneralKnowledge: true,
      allowSessionEvidence: true,
      answerRewriteUsed: false
    };
  }

  if (input.projectId && projectQuestionRequested && verifiedQa && (level === "exact" || level === "strong")) {
    return {
      mode: "project_qa_direct",
      projectAnchorAvailable,
      projectQuestionRequested,
      projectId: input.projectId,
      ...(qaMatch ? { qaMatch } : {}),
      qaMatchLevel: level,
      preserveStoredAnswerFacts: true,
      allowProjectKnowledge: false,
      allowGeneralKnowledge: false,
      allowSessionEvidence: true,
      answerRewriteUsed: true
    };
  }

  if (input.projectId && projectQuestionRequested && level === "partial" && qa && card && verifiedQa) {
    return {
      mode: "project_qa_augmented",
      projectAnchorAvailable,
      projectQuestionRequested,
      projectId: input.projectId,
      ...(qaMatch ? { qaMatch } : {}),
      qaMatchLevel: level,
      preserveStoredAnswerFacts: true,
      allowProjectKnowledge: true,
      allowGeneralKnowledge: true,
      allowSessionEvidence: true,
      answerRewriteUsed: true
    };
  }

  if (input.projectId && projectQuestionRequested) {
    return {
      mode: "project_knowledge_generated",
      projectAnchorAvailable,
      projectQuestionRequested,
      projectId: input.projectId,
      qaMatchLevel: level,
      preserveStoredAnswerFacts: false,
      allowProjectKnowledge: true,
      allowGeneralKnowledge: true,
      allowSessionEvidence: true,
      answerRewriteUsed: false
    };
  }

  if (input.coreTechnicalQa?.verified && !projectQuestionRequested && !personalQuestionRequested) {
    return {
      mode: "general_core_qa",
      projectAnchorAvailable,
      projectQuestionRequested,
      qaMatchLevel: "none",
      preserveStoredAnswerFacts: true,
      allowProjectKnowledge: false,
      allowGeneralKnowledge: false,
      allowSessionEvidence: false,
      answerRewriteUsed: true
    };
  }

  if (input.preparedAnswer?.verified && !input.preparedAnswer.stale && input.preparedAnswer.content.trim()) {
    return {
      mode: "general_technical",
      projectAnchorAvailable,
      projectQuestionRequested,
      qaMatchLevel: "none",
      preserveStoredAnswerFacts: true,
      allowProjectKnowledge: false,
      allowGeneralKnowledge: true,
      allowSessionEvidence: true,
      answerRewriteUsed: true
    };
  }

  return {
    mode: personalQuestionRequested || projectQuestionRequested ? "personal_experience" : "general_technical",
    projectAnchorAvailable,
    projectQuestionRequested,
    ...(projectQuestionRequested && input.projectId ? { projectId: input.projectId } : {}),
    qaMatchLevel: level,
    preserveStoredAnswerFacts: false,
    allowProjectKnowledge: false,
    allowGeneralKnowledge: true,
    allowSessionEvidence: true,
    answerRewriteUsed: false
  };
}

export const createAnswerSourcePlan = planAnswerSource;
