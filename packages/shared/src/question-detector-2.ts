/** Backward-compatible facade for the new modular Question Detection 2.0 API. */
import { classifyQuestion, type QuestionClassification } from "./question-classifier";

export type QuestionClassifierResult = QuestionClassification;

/** Retained for callers that used the pre-2.0 classifier directly. */
export class QuestionClassifier {
  classify(text: string, contextText = "", final = true): QuestionClassification {
    const result = classifyQuestion(text, contextText, final);
    if (result.isQuestion && /什么|为什么|为何|怎么|如何|介绍|原理|区别|优化|请问|能不能|是否|有没有|解释|讲一下|说一下/.test(text) && text.length >= 6) {
      return { ...result, confidence: Math.max(result.confidence, 0.9) };
    }
    return result;
  }
}

export { QuestionDetector as QuestionDetector2, decideQuestion, questionScore } from "./question/question-detector";
export type { QuestionDecision, QuestionDecisionInput } from "./question/question-detector";
export type { QuestionAnalysis, QuestionAnalysisSnapshot, QuestionDetectionContext, QuestionDetectionResult, QuestionDetectionType, QuestionLLMConfirmation, QuestionLLMConfirmer, QuestionScore, QuestionSpeechAct } from "./question/types";
