import type { AnswerSourcePlan } from "../answer/project-answer-source-planner";

export function createSelfIntroductionAnswerPlan(mode: "direct" | "rewrite"): AnswerSourcePlan {
  const rewrite = mode === "rewrite";
  return {
    mode: rewrite ? "self_intro_rewrite" : "self_intro_direct",
    projectAnchorAvailable: false,
    projectQuestionRequested: false,
    qaMatchLevel: "none",
    preserveStoredAnswerFacts: true,
    allowProjectKnowledge: false,
    allowGeneralKnowledge: false,
    allowSessionEvidence: false,
    answerRewriteUsed: rewrite
  };
}
