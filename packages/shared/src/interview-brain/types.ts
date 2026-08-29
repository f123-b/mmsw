import type { InterviewMemorySnapshot } from "../interview-memory";
import type { QuestionAnalysis, QuestionDetectionType } from "../question";

export interface QuestionEventInput {
  text: string;
  analysis?: QuestionAnalysis;
  memory: InterviewMemorySnapshot;
  recentTranscript?: string[];
}

export interface AnswerTask {
  question: string;
  type: "technical" | "project" | "behavior" | "follow_up";
  context: string[];
  mode: "FAST" | "NORMAL" | "DEEP";
}

export interface InterviewBrainDecision {
  isQuestion: boolean;
  type: QuestionDetectionType;
  confidence: number;
  normalizedQuestion: string;
  reason: string;
  contextRelation?: "standalone" | "follow_up" | "continuation" | "repair" | "topic_announcement" | "instruction_modifier";
  inheritedTopic?: string;
  answerTask?: AnswerTask;
}
