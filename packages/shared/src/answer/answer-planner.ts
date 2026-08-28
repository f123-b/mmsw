import type { FollowUpContext } from "../follow-up-context";
import type { AnswerMode } from "../answer";
import { AnswerLengthController, type AnswerLengthPolicy } from "./answer-length-controller";
import { answerStrategyFor, classifyAnswerQuestion, type AnswerEvidenceRequirement, type AnswerPlanQuestionType, type AnswerQuestionKind, type AnswerStrategy } from "./answer-strategy";
import type { QuestionBankRouteHit } from "../question-bank-router";

export interface AnswerPlannerInput {
  question: string;
  questionType?: AnswerQuestionKind;
  currentProject?: string;
  currentTopic?: string;
  currentModule?: string;
  followUpContext?: FollowUpContext;
  recentTranscript?: string[];
  projectEvidence?: string[];
  retrievedKnowledge?: string[];
  preparedAnswer?: { content: string; score: number; verified: boolean; source?: string };
  questionBankContext?: QuestionBankRouteHit[];
  interviewMode?: AnswerMode;
}
export interface AnswerPlan {
  question: string;
  questionType: AnswerPlanQuestionType;
  kind: AnswerQuestionKind;
  answerMode: AnswerMode;
  targetDurationSec: number;
  durationRangeSec: { min: number; max: number };
  structure: string[];
  requiredEvidence: AnswerEvidenceRequirement[];
  mustUseFirstPerson: boolean;
  useCurrentProject: boolean;
  complexity: "low" | "medium" | "high";
  strategy: AnswerStrategy;
  length: AnswerLengthPolicy;
  questionBankContext: QuestionBankRouteHit[];
  reason: string;
}

function complexityFor(question: string, kind: AnswerQuestionKind, followUp?: FollowUpContext): "low" | "medium" | "high" {
  if (kind === "follow-up" || kind === "clarification") return "low";
  if (kind === "code" || kind === "system-design" || kind === "project" || kind === "behavioral") return "high";
  if (followUp?.parentAnswer && followUp.parentAnswer.length > 220) return "high";
  if ((question.match(/[？?]/g)?.length ?? 0) > 1 || question.length > 58) return "high";
  return "medium";
}

function requiredEvidence(strategy: AnswerStrategy, input: AnswerPlannerInput): AnswerEvidenceRequirement[] {
  const evidence = [...strategy.requiredEvidence];
  if (input.preparedAnswer?.verified && input.preparedAnswer.score >= 0.88 && !evidence.includes("prepared_answer")) evidence.push("prepared_answer");
  return evidence;
}

/** Plans answer shape and evidence needs without generating answer text. */
export class AnswerPlanner {
  constructor(private readonly lengthController = new AnswerLengthController()) {}

  plan(input: AnswerPlannerInput): AnswerPlan {
    const question = input.question.trim();
    const kind = input.questionType ?? classifyAnswerQuestion(question);
    const hasProjectEvidence = (input.projectEvidence?.length ?? 0) > 0;
    const strategy = answerStrategyFor(kind, question, hasProjectEvidence);
    const complexity = complexityFor(question, kind, input.followUpContext);
    const answerMode = input.interviewMode ?? "NORMAL";
    const length = this.lengthController.policy(answerMode, kind, complexity);
    const useCurrentProject = strategy.useCurrentProject && Boolean(input.currentProject || input.followUpContext?.relatedProject || hasProjectEvidence);
    const firstPerson = strategy.mustUseFirstPerson || (useCurrentProject && hasProjectEvidence);
    const reason = [
      `kind=${kind}`,
      `strategy=${strategy.id}`,
      `complexity=${complexity}`,
      useCurrentProject ? "project-context=enabled" : "project-context=disabled",
      hasProjectEvidence ? "evidence=available" : "evidence=missing",
      input.questionBankContext?.length ? `question-bank=${input.questionBankContext.length}` : "question-bank=none"
    ].join(";");
    return {
      question,
      questionType: strategy.id,
      kind,
      answerMode,
      targetDurationSec: length.target,
      durationRangeSec: { min: length.min, max: length.max },
      structure: [...strategy.structure],
      requiredEvidence: requiredEvidence(strategy, input),
      mustUseFirstPerson: firstPerson,
      useCurrentProject,
      complexity,
      strategy,
      length,
      questionBankContext: (input.questionBankContext ?? []).slice(0, 5),
      reason
    };
  }
}
