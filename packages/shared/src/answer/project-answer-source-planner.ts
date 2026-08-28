import type { QuestionBankRouteHit, ProjectQaMatchLevel, ProjectQaRouteResult } from "../question-bank-router";

export type AnswerSourceMode =
  | "project_qa_direct"
  | "project_qa_augmented"
  | "project_knowledge_generated"
  | "general_technical"
  | "personal_experience";

export interface AnswerSourcePlan {
  mode: AnswerSourceMode;
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
  projectQuestion?: boolean;
  projectQa?: ProjectQaRouteResult;
  preparedAnswer?: {
    answerCardId?: string;
    content: string;
    score: number;
    verified: boolean;
    stale?: boolean;
    questionId?: string;
  };
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
  const qa = input.projectQa?.top;
  const level = input.projectQa?.level ?? "none";
  const card = selectedAnswerCard(qa);
  const verifiedQa = Boolean(qa && card?.verified && qa.question.verified && !qa.question.stale);
  const qaMatch = qa && card ? qaMatchFor(qa, card) : undefined;

  if (input.projectId && verifiedQa && (level === "exact" || level === "strong")) {
    return {
      mode: "project_qa_direct",
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

  if (input.projectId && level === "partial" && qa && card && verifiedQa) {
    return {
      mode: "project_qa_augmented",
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

  if (input.projectId && input.projectQuestion) {
    return {
      mode: "project_knowledge_generated",
      projectId: input.projectId,
      qaMatchLevel: level,
      preserveStoredAnswerFacts: false,
      allowProjectKnowledge: true,
      allowGeneralKnowledge: true,
      allowSessionEvidence: true,
      answerRewriteUsed: false
    };
  }

  if (input.preparedAnswer?.verified && !input.preparedAnswer.stale && input.preparedAnswer.content.trim()) {
    return {
      mode: "general_technical",
      ...(input.projectId ? { projectId: input.projectId } : {}),
      qaMatchLevel: "none",
      preserveStoredAnswerFacts: true,
      allowProjectKnowledge: false,
      allowGeneralKnowledge: true,
      allowSessionEvidence: true,
      answerRewriteUsed: true
    };
  }

  return {
    mode: input.projectQuestion ? "personal_experience" : "general_technical",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    qaMatchLevel: level,
    preserveStoredAnswerFacts: false,
    allowProjectKnowledge: false,
    allowGeneralKnowledge: true,
    allowSessionEvidence: true,
    answerRewriteUsed: false
  };
}

export const createAnswerSourcePlan = planAnswerSource;
