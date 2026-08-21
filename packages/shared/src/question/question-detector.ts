import { classifyQuestion, type QuestionCategory, type QuestionClassification } from "../question-classifier";
import type { LocalQuestionModel, LocalQuestionResult } from "./local-classifier";
import type { QuestionAnalysis, QuestionDetectionContext, QuestionDetectionType, QuestionLLMConfirmer, QuestionScore, QuestionSpeechAct } from "./types";

const RULE_KEYWORDS = /什么|为什么|为何|怎么|如何|介绍|原理|区别|优化|请问|能不能|是否|有没有|哪个|哪里|解释|讲一下|说一下|说说|展开|困难|挑战|设计|如果.*(重新|改|换|设计)/;
const CLARIFICATION_KEYWORDS = /具体一点|什么意思|没听清|再说一遍|能展开|详细一点|指的是|怎么理解/;
const FILLER_ONLY = /^(嗯+|呃+|啊+|哦+|好+|对+|那个|嗯嗯|知道了)[。！？?！\s]*$/i;
const SMALL_TALK = /^(你好|您好|谢谢|辛苦了|好的|明白了|嗯嗯|哈哈)[。！？?！\s]*$/i;

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }

function ruleScoreFor(text: string, final: boolean): number {
  if (!text || FILLER_ONLY.test(text)) return 0;
  let score = 0;
  if (RULE_KEYWORDS.test(text)) score += 0.62;
  if (RULE_KEYWORDS.test(text) && text.length < 8) score += 0.08;
  if (/[？?]$/.test(text)) score += 0.25;
  if (/(吗|呢)[。！？?！\s]*$/.test(text)) score += 0.15;
  if (text.length >= 8) score += 0.08;
  if (final) score += 0.05;
  return clamp(score);
}

function isFollowUp(text: string, contextText: string, memory?: QuestionDetectionContext["memory"]): boolean {
  const shortFollowUp = /^(那|然后|还有|具体|为什么|怎么|如何|如果|再|继续|这个|它|这里|其中)/.test(text) || text.length <= 10;
  return Boolean((memory?.currentTopic || contextText.length > text.length) && shortFollowUp);
}

function mapCategory(category: QuestionCategory): QuestionDetectionType {
  return category === "behavioral" ? "behavior" : category === "followup" ? "technical" : category;
}

function inferType(text: string, category: QuestionCategory, contextualFollowUp: boolean): QuestionDetectionType {
  if (CLARIFICATION_KEYWORDS.test(text)) return "clarification";
  if (/如果.*(重新|改|换|设计)|重新设计/.test(text)) return "follow_up";
  if (contextualFollowUp || (category === "followup" && /^(那|然后|还有|具体|再|继续|这个|它|这里)/.test(text))) return "follow_up";
  return mapCategory(category);
}

function inferSpeechAct(text: string, isQuestion: boolean, followUp: boolean): QuestionSpeechAct {
  if (SMALL_TALK.test(text)) return "SMALL_TALK";
  if (!isQuestion) return "STATEMENT";
  return followUp ? "FOLLOW_UP" : "QUESTION";
}

function fuseLocalClassification(base: QuestionClassification, local: LocalQuestionResult): QuestionClassification {
  const localIsQuestion = local.type === "QUESTION" || local.type === "FOLLOW_UP";
  const localConfidence = clamp(local.confidence);
  const strongRuleQuestion = base.isQuestion && base.confidence >= 0.72;
  const isQuestion = localIsQuestion
    ? localConfidence >= 0.55 || strongRuleQuestion
    : strongRuleQuestion;
  const category: QuestionCategory = local.type === "FOLLOW_UP" ? "followup" : base.category;
  return {
    ...base,
    isQuestion,
    confidence: Math.max(base.confidence, localConfidence),
    category,
    reason: `${base.reason}+local-${local.type.toLowerCase()}`,
  };
}

/** Rules + local semantic classifier + selective LLM confirmation. */
export class QuestionDetector {
  private readonly classifier: { classify(text: string, contextText?: string, final?: boolean): QuestionClassification };
  private readonly llmConfirmer?: QuestionLLMConfirmer;
  private readonly localClassifier?: LocalQuestionModel;
  private readonly threshold: number;
  private readonly llmMinScore: number;
  private readonly llmMaxScore: number;

  constructor(options: { classifier?: { classify(text: string, contextText?: string, final?: boolean): QuestionClassification }; localClassifier?: LocalQuestionModel; llmConfirmer?: QuestionLLMConfirmer; threshold?: number; llmMinScore?: number; llmMaxScore?: number } = {}) {
    this.classifier = options.classifier ?? { classify: classifyQuestion };
    this.localClassifier = options.localClassifier;
    this.llmConfirmer = options.llmConfirmer;
    this.threshold = options.threshold ?? 0.85;
    this.llmMinScore = options.llmMinScore ?? 0.5;
    this.llmMaxScore = options.llmMaxScore ?? 0.8;
  }

  get hasLocalClassifier(): boolean { return Boolean(this.localClassifier); }

  analyzeSync(text: string, contextText = "", final = true, context: QuestionDetectionContext = {}): QuestionAnalysis {
    return buildAnalysisWithClassifier(text, { ...context, contextText }, final, this.classifier, undefined, this.threshold);
  }

  async analyze(text: string, contextText = "", final = true, context: QuestionDetectionContext = {}): Promise<QuestionAnalysis> {
    let preliminary = this.analyzeSync(text, contextText, final, context);
    if (this.localClassifier) {
      try {
        const local = await this.localClassifier.predict(text, context.recentTranscript?.slice(-10) ?? (contextText ? [contextText] : []));
        const localClassifier = { classify: () => fuseLocalClassification(preliminary.classification, local) };
        preliminary = buildAnalysisWithClassifier(text, { ...context, contextText }, final, localClassifier, undefined, this.threshold);
      } catch {
        // The local model is an accelerator. Rules and the optional LLM remain
        // the compatibility path if the model is missing or cannot load.
      }
    }
    const weightedWithoutLlm = 0.3 * preliminary.score.ruleScore + 0.5 * preliminary.score.semanticScore;
    if (!this.llmConfirmer || weightedWithoutLlm < this.llmMinScore || weightedWithoutLlm > this.llmMaxScore) {
      return preliminary;
    }
    try {
      const confirmation = await this.llmConfirmer(preliminary.normalizedQuestion, contextText);
      return buildAnalysisWithClassifier(text, { ...context, contextText }, final, this.classifier, confirmation, this.threshold);
    } catch {
      return preliminary;
    }
  }
}

function buildAnalysisWithClassifier(
  text: string,
  context: QuestionDetectionContext,
  final: boolean,
  classifier: { classify(text: string, contextText?: string, final?: boolean): QuestionClassification },
  llm?: { confidence: number; isQuestion: boolean; label?: QuestionSpeechAct; type?: QuestionDetectionType; reason?: string },
  threshold = 0.85
): QuestionAnalysis {
  const normalized = normalize(text);
  const contextText = normalize(context.contextText || [context.memory?.currentTopic, ...(context.recentTranscript || [])].filter(Boolean).join(" "));
  const classification = { ...classifier.classify(normalized, contextText, final) };
  if (classification.isQuestion && RULE_KEYWORDS.test(normalized) && normalized.length >= 6) classification.confidence = Math.max(classification.confidence, 0.9);
  const contextualFollowUp = isFollowUp(normalized, contextText, context.memory);
  const ruleScore = ruleScoreFor(normalized, final);
  const semanticScore = classification.isQuestion ? clamp(classification.confidence) : 0;
  const llmScore = llm ? clamp(llm.confidence) : semanticScore;
  const finalScore = clamp(0.3 * ruleScore + 0.5 * semanticScore + 0.2 * llmScore);
  const candidateQuestion = !FILLER_ONLY.test(normalized) && !SMALL_TALK.test(normalized);
  const isQuestion = candidateQuestion && (llm?.isQuestion ?? classification.isQuestion) && finalScore >= threshold;
  const type = llm?.type && isQuestion ? llm.type : inferType(normalized, classification.category, contextualFollowUp);
  const speechAct = llm?.label && isQuestion ? llm.label : inferSpeechAct(normalized, isQuestion, contextualFollowUp);
  return {
    text: normalized,
    isQuestion,
    type: isQuestion ? type : "not_question",
    speechAct: isQuestion ? speechAct : SMALL_TALK.test(normalized) ? "SMALL_TALK" : "STATEMENT",
    confidence: finalScore,
    normalizedQuestion: isQuestion ? normalized.replace(/[。！!]+$/, "") : normalized,
    reason: llm?.reason || classification.reason,
    score: { ruleScore, semanticScore, llmScore, finalScore },
    llmUsed: Boolean(llm),
    classification,
    legacyCategory: classification.category
  };
}

export function questionScore(text: string, final = true, contextText = ""): QuestionScore {
  return new QuestionDetector().analyzeSync(text, contextText, final).score;
}
