import { classifyNonQuestionSpeechAct, classifyQuestion, type QuestionCategory, type QuestionClassification } from "../question-classifier";
import type { LocalQuestionModel, LocalQuestionResult } from "./local-classifier";
import type { QuestionAnalysis, QuestionDetectionContext, QuestionDetectionType, QuestionLLMConfirmer, QuestionScore, QuestionSpeechAct } from "./types";
import { normalizeTechnicalTerms } from "../terminology";
import { classifyInterviewSpeechAct, shouldHardRejectSpeechAct } from "../interview/speech-act-classifier";
import { classifyQuestionSemanticFrame } from "./semantic-frame";

const RULE_KEYWORDS = /什么|为什么|为何|怎么|如何|介绍|原理|区别|优化|请问|能不能|是否|有没有|哪些|哪种|哪个|哪里|解释|说明|讲一下|说一下|说说|展开|常见误区|作用|困难|挑战|设计|架构|系统|如果.*(重新|改|换|设计)/;
const ROBUST_QUESTION_FORM = /为什么|为何|什么是|哪些|哪种|区别|原理|介绍|解释|说明|常见误区|作用|请问|怎么(?:排查|解决|定位|判断|验证|设计|优化)|如何(?:排查|解决|定位|判断|验证|设计|优化)|如果.*(?:重新|改|换|设计)|会怎么优化|设计.*(?:系统|架构|方案|模块)/;
const SHORT_FOLLOW_UP_FORM = /^(?:为什么|具体(?:呢)?|这个.+|那.+|怎么(?:做的?|办|排查|定位)|如何(?:做)?|还有(?:吗)?|然后呢|再具体一点)[？?。！!\s]*$/;
const CLARIFICATION_KEYWORDS = /具体一点|什么意思|没听清|再说一遍|能展开|详细一点|指的是|怎么理解/;
const FILLER_ONLY = /^(嗯+|呃+|啊+|哦+|好+|对+|那个|嗯嗯|知道了)[。！？?！\s]*$/i;
const SMALL_TALK = /^(你好|您好|谢谢|辛苦了|好的|明白了|嗯嗯|哈哈)[。！？?！\s]*$/i;
const META_PROMPT_ONLY = /^(?:你觉得(?:呢)?|怎么(?:回答|答|说)|答案(?:是什么|呢))[。！？?！\s]*$/i;

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

function normalize(text: string): string { return normalizeTechnicalTerms(text); }

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
  const shortFollowUp = /^(那|然后|还有|具体|为什么|怎么|如何|如果|再|这个|它|这里|其中)/.test(text)
    || /^(?:好|好的|嗯+|明白了?|对)[，,、\s]*(?:说说|讲讲|展开(?:说)?|具体(?:说)?|再说说|再讲讲|为什么呢|怎么做呢)/i.test(text);
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
  const nonQuestionAct = classifyNonQuestionSpeechAct(text);
  if (nonQuestionAct) return nonQuestionAct;
  if (SMALL_TALK.test(text)) return "SMALL_TALK";
  if (!isQuestion) return "STATEMENT";
  return followUp ? "FOLLOW_UP" : "QUESTION";
}

function fuseLocalClassification(base: QuestionClassification, local: LocalQuestionResult): QuestionClassification {
  const localIsQuestion = local.type === "QUESTION" || local.type === "FOLLOW_UP";
  const localConfidence = clamp(local.confidence);
  const strongRuleQuestion = base.isQuestion && base.confidence >= 0.72;
  const explicitQuestion = /[？?]/.test(base.questionText) || /(?:吗|呢)[。！？?！\s]*$/i.test(base.questionText);
  const confidentStatement = local.type === "STATEMENT" && localConfidence >= 0.82 && !explicitQuestion;
  const isQuestion = localIsQuestion
    ? localConfidence >= 0.55 || strongRuleQuestion
    : strongRuleQuestion && !confidentStatement;
  const category: QuestionCategory = local.type === "FOLLOW_UP" ? "followup" : base.category;
  return {
    ...base,
    isQuestion,
    confidence: Math.max(base.confidence, localConfidence),
    category,
    reason: `${base.reason}+local-${local.type.toLowerCase()}`,
  };
}

export interface QuestionDecisionInput {
  speechAct: QuestionSpeechAct;
  speechConfidence: number;
  ruleScore: number;
  semanticScore: number;
  localClassifierScore?: number;
  llmScore: number;
  llmIsQuestion?: boolean;
  llmConfidence?: number;
  finalScore: number;
  threshold: number;
  final: boolean;
  candidateQuestion: boolean;
  contextualFollowUp: boolean;
  robustRuleQuestion: boolean;
  followUpRescue: boolean;
}

export interface QuestionDecision {
  shouldAnswer: boolean;
  confidence: number;
  reason: string;
}

const ANSWERABLE_SPEECH_ACTS = new Set<QuestionSpeechAct>(["QUESTION", "ANSWER_REQUEST", "CODE_REQUEST", "FOLLOW_UP"]);
const HARD_REJECT_SPEECH_ACTS = new Set<QuestionSpeechAct>(["ACKNOWLEDGEMENT", "CONTROL", "META_CONVERSATION", "SMALL_TALK", "INSTRUCTION", "TOPIC_ANNOUNCEMENT", "INSTRUCTION_MODIFIER"]);

/**
 * Combines speech act, rule, semantic, local/LLM and context signals into one
 * explicit decision. A speech classifier is an important signal, but its old
 * boolean `shouldAnswer` result must not bypass conflict and candidate checks.
 */
export function decideQuestion(input: QuestionDecisionInput): QuestionDecision {
  const speechConfidence = clamp(input.speechConfidence);
  const finalScore = clamp(input.finalScore);
  const weightedScore = clamp(0.3 * input.ruleScore + 0.5 * input.semanticScore + 0.2 * input.llmScore);
  const strongSpeechAct = ANSWERABLE_SPEECH_ACTS.has(input.speechAct) && speechConfidence >= 0.86;
  const hardReject = HARD_REJECT_SPEECH_ACTS.has(input.speechAct);
  const llmStrongNegative = input.llmIsQuestion === false && (input.llmConfidence ?? 0) >= 0.95;
  const localOrRuleSupport = input.semanticScore >= 0.5 || input.ruleScore >= 0.35 || input.llmIsQuestion === true;
  const localRescue = (input.localClassifierScore ?? 0) >= 0.86;
  const scoreAccepted = finalScore >= input.threshold || input.robustRuleQuestion || input.followUpRescue || weightedScore >= input.threshold || localRescue;

  if (!input.final) return { shouldAnswer: false, confidence: finalScore, reason: "partial-utterance" };
  if (!input.candidateQuestion) return { shouldAnswer: false, confidence: 0, reason: "non-candidate-speech" };
  if (hardReject) return { shouldAnswer: false, confidence: 0, reason: `speech-act-${input.speechAct.toLowerCase()}` };
  if (llmStrongNegative && !strongSpeechAct && !input.robustRuleQuestion && !input.followUpRescue) {
    return { shouldAnswer: false, confidence: finalScore, reason: "llm-negative-confirmation" };
  }
  if (input.speechAct === "FOLLOW_UP" && !input.contextualFollowUp && !input.robustRuleQuestion && !scoreAccepted) {
    return { shouldAnswer: false, confidence: finalScore, reason: "follow-up-without-context" };
  }
  if (strongSpeechAct && (localOrRuleSupport || input.speechAct === "CODE_REQUEST" || input.speechAct === "ANSWER_REQUEST" || (input.speechAct === "FOLLOW_UP" && input.contextualFollowUp && input.followUpRescue))) {
    return { shouldAnswer: true, confidence: Math.max(finalScore, speechConfidence, 0.86), reason: `decision-${input.speechAct.toLowerCase()}` };
  }
  if (scoreAccepted && localOrRuleSupport) {
    return { shouldAnswer: true, confidence: Math.max(finalScore, weightedScore), reason: "decision-multi-signal" };
  }
  return { shouldAnswer: false, confidence: finalScore, reason: "insufficient-question-signals" };
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
        const localContext = context.recentTranscript?.length
          ? context.recentTranscript.slice(-10)
          : contextText
            ? [contextText]
            : [];
        const local = await this.localClassifier.predict(text, localContext);
        const localClassifier = { classify: () => fuseLocalClassification(preliminary.classification, local) };
        preliminary = buildAnalysisWithClassifier(text, { ...context, contextText }, final, localClassifier, undefined, this.threshold, local.confidence);
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
      const effectiveClassifier = { classify: () => preliminary.classification };
      return buildAnalysisWithClassifier(text, { ...context, contextText }, final, effectiveClassifier, confirmation, this.threshold, preliminary.score.localClassifierScore);
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
  threshold = 0.85,
  localClassifierScore?: number
): QuestionAnalysis {
  const normalized = normalize(text).replace(/^(?:面试官|interviewer)\s*[:：]\s*/i, "");
  const contextText = normalize(context.contextText || [context.memory?.currentTopic, ...(context.recentTranscript || [])].filter(Boolean).join(" "));
  const contextTopic = context.memory?.currentTopic
    ?? context.latestAnchor?.topic
    ?? contextText.match(/(?:STL|TCP|UDP|IIC|I2C|SPI|UART|CAN|FOC|DMA|PWM|ADC|FreeRTOS|RTOS|C\+\+|虚函数|堆和栈|EEPROM|Flash|链表|进程间通信|三次握手|四次挥手)/i)?.[0]
    ?? (contextText.length >= 4 ? contextText.replace(/^(?:面试官|候选人|我)\s*[:：]\s*/i, "").slice(0, 32) : undefined);
  const speech = classifyInterviewSpeechAct(normalized, {
    memory: context.memory,
    recentTranscript: context.recentTranscript,
    currentTopic: contextTopic,
    latestAnchor: context.latestAnchor ?? (contextTopic ? { text: contextTopic, topic: contextTopic, speechAct: "TOPIC_ANCHOR" } : undefined),
    pendingCodeContext: context.pendingCodeContext
  });
  const classification = { ...classifier.classify(normalized, contextText, final) };
  const nonQuestionAct = classifyNonQuestionSpeechAct(normalized);
  if (nonQuestionAct && speech.speechAct !== "ANSWER_REQUEST" && speech.speechAct !== "CODE_REQUEST" && speech.speechAct !== "QUESTION" && speech.speechAct !== "FOLLOW_UP") {
    const ruleScore = ruleScoreFor(normalized, final);
    const nonQuestionClassification = { ...classification, isQuestion: false, confidence: 0, reason: nonQuestionAct === "CONTROL" ? "control-speech" : "answer-instruction" };
    return {
      text: normalized,
      isQuestion: false,
      type: "not_question",
      speechAct: nonQuestionAct,
      confidence: 0,
      normalizedQuestion: normalized,
      reason: nonQuestionClassification.reason,
      score: { ruleScore, semanticScore: 0, ...(localClassifierScore !== undefined ? { localClassifierScore } : {}), llmScore: 0, finalScore: 0 },
      llmUsed: Boolean(llm),
      classification: nonQuestionClassification,
      legacyCategory: nonQuestionClassification.category,
      shouldAnswer: false,
      semanticFrame: classifyQuestionSemanticFrame(normalized, "not_question"),
      ...(speech.codeContext ? { codeContext: true } : {})
    };
  }
  if (shouldHardRejectSpeechAct(speech)) {
    const nonQuestionClassification = { ...classification, isQuestion: false, confidence: 0, reason: speech.reason };
    const isFiller = speech.speechAct === "ACKNOWLEDGEMENT" || speech.speechAct === "CONTROL" || speech.speechAct === "META_CONVERSATION" || speech.speechAct === "TOPIC_ANNOUNCEMENT" || speech.speechAct === "INSTRUCTION_MODIFIER";
    const ruleScore = isFiller ? 0 : ruleScoreFor(normalized, final);
    return {
      text: normalized,
      isQuestion: false,
      type: "not_question",
      speechAct: speech.speechAct,
      confidence: isFiller ? 0 : speech.confidence,
      normalizedQuestion: normalized,
      reason: speech.reason,
      score: { ruleScore, semanticScore: 0, ...(localClassifierScore !== undefined ? { localClassifierScore } : {}), llmScore: 0, finalScore: 0 },
      llmUsed: Boolean(llm),
      classification: nonQuestionClassification,
      legacyCategory: nonQuestionClassification.category,
      shouldAnswer: false,
      semanticFrame: classifyQuestionSemanticFrame(normalized, "not_question"),
      topicAnchor: speech.speechAct === "TOPIC_ANCHOR",
      ...(speech.codeContext ? { codeContext: true } : {})
    };
  }
  if (classification.isQuestion && RULE_KEYWORDS.test(normalized) && normalized.length >= 6) classification.confidence = Math.max(classification.confidence, 0.9);
  const contextualFollowUp = isFollowUp(normalized, contextText, context.memory);
  const shortFollowUpQuestion = contextualFollowUp && (SHORT_FOLLOW_UP_FORM.test(normalized) || (normalized.length <= 12 && /[？?]/.test(normalized)));
  const standaloneCompleteForm = /(?:在哪|哪里|是什么|哪些|哪种|哪个|多少|几个|几路|上限|容量)/.test(normalized);
  const effectiveSpeechAct: QuestionSpeechAct = speech.speechAct === "QUESTION" && contextualFollowUp && !standaloneCompleteForm ? "FOLLOW_UP" : speech.speechAct;
  const ruleScore = ruleScoreFor(normalized, final);
  const semanticScore = classification.isQuestion ? clamp(classification.confidence) : 0;
  // A negative/low-confidence LLM confirmation must not erase a clear local
  // question signal. LLM is a tie-breaker here, not the source of truth.
  const llmScore = llm?.isQuestion ? clamp(llm.confidence) : semanticScore;
  const rawFinalScore = clamp(0.3 * ruleScore + 0.5 * semanticScore + 0.2 * llmScore);
  // Explicit interview prompts such as “介绍一下你的项目” are complete
  // questions even when they do not contain a question particle. Their rule
  // signal is intentionally stronger than a generic topic statement, so let
  // the robust path accept the classifier's 0.60+ confidence here.
  const robustRuleQuestion = classification.isQuestion && classification.confidence >= 0.52 && ruleScore >= 0.35
    && (ROBUST_QUESTION_FORM.test(normalized) || /有什么|什么作用|常见误区|怎么做的/.test(normalized));
  // Interview harnesses and some ASR integrations use an explicit label such
  // as “问题：……” without a trailing particle. Preserve that question
  // signal instead of requiring a second interrogative form.
  const explicitQuestionLabel = /(?:问题|题目)\s*[:：]/.test(normalized);
  const labeledQuestionRescue = classification.isQuestion && explicitQuestionLabel && classification.confidence >= 0.72;
  const followUpRescue = shortFollowUpQuestion;
  const finalScore = robustRuleQuestion || followUpRescue ? Math.max(rawFinalScore, 0.86) : rawFinalScore;
  const candidateQuestion = !FILLER_ONLY.test(normalized) && !SMALL_TALK.test(normalized) && !META_PROMPT_ONLY.test(normalized);
  const llmRescue = Boolean(llm?.isQuestion && llm.confidence >= 0.82 && (ruleScore >= 0.35 || contextualFollowUp));
  const decision = decideQuestion({
    speechAct: effectiveSpeechAct,
    speechConfidence: speech.confidence,
    ruleScore,
    semanticScore,
    localClassifierScore,
    llmScore,
    llmIsQuestion: llm?.isQuestion,
    llmConfidence: llm?.confidence,
    finalScore,
    threshold,
    final,
    candidateQuestion,
    contextualFollowUp,
    robustRuleQuestion: robustRuleQuestion || labeledQuestionRescue,
    followUpRescue: followUpRescue || llmRescue
  });
  const isQuestion = decision.shouldAnswer;
  const type = effectiveSpeechAct === "FOLLOW_UP"
    ? "follow_up"
    : llm?.type && isQuestion
      ? llm.type
      : inferType(normalized, classification.category, contextualFollowUp);
  const inferredAnswerSpeechAct = contextualFollowUp ? "FOLLOW_UP" : "QUESTION";
  const speechAct = isQuestion && (effectiveSpeechAct === "STATEMENT" || effectiveSpeechAct === "TOPIC_ANCHOR")
    ? inferredAnswerSpeechAct
    : effectiveSpeechAct || (llm?.label && isQuestion ? llm.label : inferSpeechAct(normalized, isQuestion, contextualFollowUp));
  const effectiveFinalScore = isQuestion ? Math.max(finalScore, decision.confidence) : finalScore;
  return {
    text: normalized,
    isQuestion,
    type: isQuestion ? type : "not_question",
    speechAct: isQuestion ? speechAct : !final ? "STATEMENT" : SMALL_TALK.test(normalized) ? "SMALL_TALK" : speech.speechAct,
    confidence: effectiveFinalScore,
    normalizedQuestion: isQuestion ? normalized.replace(/[。！!]+$/, "") : normalized,
    reason: `${decision.reason}:${speech.reason || llm?.reason || classification.reason}`,
    score: { ruleScore, semanticScore, ...(localClassifierScore !== undefined ? { localClassifierScore } : {}), llmScore, finalScore: effectiveFinalScore },
    llmUsed: Boolean(llm),
    classification,
    legacyCategory: classification.category,
    shouldAnswer: decision.shouldAnswer,
    semanticFrame: classifyQuestionSemanticFrame(normalized, isQuestion ? type : "not_question"),
    ...(speech.codeContext ? { codeContext: true } : {})
  };
}

export function questionScore(text: string, final = true, contextText = ""): QuestionScore {
  return new QuestionDetector().analyzeSync(text, contextText, final).score;
}
