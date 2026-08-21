import { classifyQuestion, type QuestionClassification } from "../question-classifier";

export type LocalQuestionLabel = "QUESTION" | "FOLLOW_UP" | "STATEMENT" | "OTHER";

export interface LocalQuestionResult {
  type: LocalQuestionLabel;
  confidence: number;
}

export interface LocalQuestionModel {
  predict(text: string, context?: string[]): Promise<LocalQuestionResult>;
}

/**
 * Model-agnostic local classifier boundary. The default path is deterministic
 * and has no native dependency; an ONNX/MiniLM adapter can be injected later
 * without changing QuestionDetector or InterviewBrain.
 */
export class LocalQuestionClassifier implements LocalQuestionModel {
  constructor(private readonly model?: LocalQuestionModel) {}

  async predict(text: string, context: string[] = []): Promise<LocalQuestionResult> {
    if (this.model) return this.model.predict(text, context);
    const result: QuestionClassification = classifyQuestion(text, context.join("\n"), true);
    const followUp = result.category === "followup" || /^(那|然后|还有|具体|继续|再|这个|它)/.test(text.trim());
    return { type: result.isQuestion ? followUp ? "FOLLOW_UP" : "QUESTION" : "STATEMENT", confidence: result.confidence };
  }
}

