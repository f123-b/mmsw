import type { InterviewMemorySnapshot } from "../interview-memory";
import type { QuestionCategory, QuestionClassification } from "../question-classifier";

export type QuestionDetectionType = "technical" | "project" | "behavior" | "follow_up" | "clarification" | "not_question";
export type QuestionSpeechAct = "QUESTION" | "FOLLOW_UP" | "STATEMENT" | "SMALL_TALK" | "INSTRUCTION" | "CONTROL";

export interface QuestionScore {
  ruleScore: number;
  semanticScore: number;
  llmScore: number;
  finalScore: number;
}

export interface QuestionLLMConfirmation {
  isQuestion: boolean;
  confidence: number;
  label?: QuestionSpeechAct;
  type?: QuestionDetectionType;
  reason?: string;
}

export type QuestionLLMConfirmer = (text: string, contextText?: string) => Promise<QuestionLLMConfirmation>;

export interface QuestionDetectionContext {
  memory?: InterviewMemorySnapshot;
  recentTranscript?: string[];
  contextText?: string;
}

export interface QuestionAnalysisSnapshot {
  type: QuestionDetectionType;
  speechAct: QuestionSpeechAct;
  confidence: number;
  reason: string;
  score: QuestionScore;
}

export interface QuestionDetectionResult {
  isQuestion: boolean;
  type: QuestionDetectionType;
  speechAct: QuestionSpeechAct;
  confidence: number;
  normalizedQuestion: string;
  reason: string;
  score: QuestionScore;
  llmUsed: boolean;
}

export interface QuestionAnalysis extends QuestionDetectionResult {
  text: string;
  classification: QuestionClassification;
  legacyCategory: QuestionCategory;
}
