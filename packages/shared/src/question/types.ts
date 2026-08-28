import type { InterviewMemorySnapshot } from "../interview-memory";
import type { QuestionCategory, QuestionClassification } from "../question-classifier";
import type { InterviewSpeechAct, SpeechActAnchorContext } from "../interview/speech-act-classifier";
import type { TerminologyCorrection } from "../terminology";
import type { QuestionSemanticFrame } from "./semantic-frame";

export type QuestionDetectionType = "technical" | "project" | "behavior" | "follow_up" | "clarification" | "not_question";
export type QuestionSpeechAct = InterviewSpeechAct | "SMALL_TALK" | "INSTRUCTION";

export interface QuestionScore {
  ruleScore: number;
  semanticScore: number;
  /** Undefined when the optional local classifier did not run. */
  localClassifierScore?: number;
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
  latestAnchor?: SpeechActAnchorContext;
  pendingCodeContext?: boolean;
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
  rawText?: string;
  normalizedText?: string;
  canonicalText?: string;
  classification: QuestionClassification;
  legacyCategory: QuestionCategory;
  shouldAnswer?: boolean;
  codeContext?: boolean;
  topicAnchor?: boolean;
  anchorUsedId?: string;
  contextRelation?: "standalone" | "follow_up" | "continuation" | "repair";
  inheritedTopic?: string;
  topic?: string;
  semanticFrame?: QuestionSemanticFrame;
  terminologyCorrections?: TerminologyCorrection[];
}
