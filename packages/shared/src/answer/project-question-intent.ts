import type { FollowUpContext } from "../follow-up-context";
import type { AnswerIntent } from "./answer-intent";

export interface ProjectQuestionIntentInput {
  question: string;
  targetProjectId?: string;
  answerIntent: Pick<AnswerIntent, "requiresPersonalIdentity" | "asksProjectImplementation" | "requiresPersonalOwnership" | "requiresPersonalMetric" | "requiresPersonalResult" | "technicalNucleusWithProjectAnchor">;
  questionAnalysisType?: "project" | "technical" | "behavioral" | "follow-up";
  followUpContext?: FollowUpContext;
}

export interface ProjectQuestionIntentDecision {
  projectAnchorAvailable: boolean;
  projectQuestionRequested: boolean;
  explicitProjectMention: boolean;
  projectAnchoredFollowUp: boolean;
  projectQuestionMode: "actual_project_fact" | "actual_project_implementation" | "hypothetical_project_design" | "general_technical_with_project_anchor";
}

const PROJECT_MENTION = /项目|你这个|你们的|这个系统|这个模块|这套(?:系统|方案|实现)|实际实现|工程上|你在.*(?:项目|系统|模块).*中/;
const FOLLOW_UP_SHAPE = /^(?:那|然后|所以|为什么|为何|怎么|如何|怎样|具体|如果|还有|这个|这种|它|这里|其中|一定)/;
const GENERIC_STANDALONE_TECHNICAL = /^(?:那)?(?:volatile|c\+\+|c语言|c\/c\+\+|rtos|freertos|can|adc|dma|pwm|tcp|udp|mqtt|虚函数|优先级反转|三次握手|系统设计|数据结构|操作系统|网络协议)/i;

function normalized(text: string): string {
  return text.toLowerCase().replace(/[\s\u3000，。！？、；：,.!?;:()（）{}<>《》「」"'`]/g, "");
}

function technicalAnchors(text: string): Set<string> {
  return new Set(normalized(text).match(/adc|dma|pwm|can|uart|iic|spi|foc|svpwm|rtos|freertos|tcp|udp|volatile|c\+\+|虚函数|优先级反转|中点|采样|实时性|仲裁|校准|频率|时序/g) ?? []);
}

function hasThreadTopicOverlap(question: string, context: FollowUpContext): boolean {
  const current = technicalAnchors(question);
  const thread = technicalAnchors([context.rootQuestion, context.parentQuestion, context.parentAnswer ?? "", context.currentTopic ?? "", context.relatedTechnicalTopic ?? ""].join(" "));
  return [...current].some((token) => thread.has(token));
}

/**
 * Separates a selected project (an available anchor) from a question that
 * actually asks for project facts. A short follow-up can inherit the project
 * only when its parent thread is project-oriented and the topic remains
 * connected; standalone generic technical concepts are a hard boundary.
 */
export function analyzeProjectQuestionIntent(input: ProjectQuestionIntentInput): ProjectQuestionIntentDecision {
  const projectAnchorAvailable = Boolean(input.targetProjectId);
  const explicitProjectMention = PROJECT_MENTION.test(input.question);
  const genericStandalone = GENERIC_STANDALONE_TECHNICAL.test(normalized(input.question.trim()));
  const followUp = input.followUpContext;
  const parentThreadIsProject = Boolean(followUp && (PROJECT_MENTION.test(followUp.rootQuestion) || PROJECT_MENTION.test(followUp.parentQuestion) || PROJECT_MENTION.test(followUp.parentAnswer ?? "") || followUp.relatedProject));
  const followUpShape = Boolean(followUp && (FOLLOW_UP_SHAPE.test(input.question.trim()) || input.question.trim().length <= 18));
  const projectAnchoredFollowUp = Boolean(
    followUp
    && parentThreadIsProject
    && !input.answerIntent.requiresPersonalIdentity
    && !genericStandalone
    && (followUpShape || hasThreadTopicOverlap(input.question, followUp))
  );
  const projectQuestionRequested = Boolean(
    projectAnchorAvailable
    && (
      !input.answerIntent.requiresPersonalIdentity
      && !input.answerIntent.technicalNucleusWithProjectAnchor
      && !genericStandalone
      && (
        input.answerIntent.asksProjectImplementation
        || input.answerIntent.requiresPersonalOwnership
        || input.answerIntent.requiresPersonalMetric
        || input.answerIntent.requiresPersonalResult
        || input.questionAnalysisType === "project"
        || explicitProjectMention
        || projectAnchoredFollowUp
      )
    )
  );
  const hypothetical = /(?:如果|假设|重新设计|设计一个|会怎么|如何设计)/.test(input.question);
  const projectQuestionMode = projectQuestionRequested
    ? hypothetical ? "hypothetical_project_design" : input.answerIntent.asksProjectImplementation ? "actual_project_implementation" : "actual_project_fact"
    : projectAnchorAvailable ? "general_technical_with_project_anchor" : "actual_project_fact";
  return { projectAnchorAvailable, projectQuestionRequested, explicitProjectMention, projectAnchoredFollowUp, projectQuestionMode };
}
