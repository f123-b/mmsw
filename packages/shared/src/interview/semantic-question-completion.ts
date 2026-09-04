import { hasContextReference, isDanglingQuestionTail, isOpenPredicate } from "./semantic-answerability";
import type { QuestionFrameCompletion, QuestionFrameSpeechAct, ReferenceCandidate } from "./question-frame";

export interface SemanticQuestionCompletionInput {
  text: string;
  speechAct: QuestionFrameSpeechAct;
  references: ReferenceCandidate[];
  unresolvedAsr: boolean;
  hasSubject: boolean;
  hasObject: boolean;
  slotCount: number;
  currentTopic?: string;
}

export interface SemanticQuestionCompletionResult {
  state: QuestionFrameCompletion;
  confidence: number;
  unresolvedSlots: string[];
  reason: string;
}

const OPEN_SETUP = /(?:你能给我介绍一下|如果发生|如果让你|假设现在|首先比如说|比如说)[？?。！？!\s]*$/iu;
const MISSING_OBJECT = /^(?:怎么衡量|如何衡量|为什么选|为什么选择|怎么做|如何做|怎么验证|如何验证)[？?。！？!\s]*$/iu;
const MISSING_SUBJECT = /^(?:为什么|为何|怎么|如何|怎样|什么时候|多久|哪个|哪一个)[？?。！？!\s]*$/iu;

/** Semantic completeness, separate from ASR punctuation or endpoint markers. */
export class SemanticQuestionCompletion {
  evaluate(input: SemanticQuestionCompletionInput): SemanticQuestionCompletionResult {
    const text = input.text.replace(/\s+/g, " ").trim();
    if (input.unresolvedAsr) return { state: "ASR_UNCERTAIN", confidence: 0.98, unresolvedSlots: ["asr"], reason: "asr-unresolved" };
    if (["CONFIRMATION_CHECK", "BACKCHANNEL", "ADVICE", "EXPLANATION", "FEEDBACK", "TOPIC_TRANSITION", "CONTROL", "FILLER"].includes(input.speechAct)) return { state: "COMPLETE", confidence: 0.99, unresolvedSlots: [], reason: "non-answer-speech-act" };
    if (!text) return { state: "OPEN", confidence: 0, unresolvedSlots: ["question"], reason: "empty-question" };
    if (/(?:里边|里面|的话|比方说在你的这个|用的是)[。！？?！\s]*$/u.test(text)) return { state: "OPEN", confidence: 0.97, unresolvedSlots: ["predicate"], reason: "unfinished-question-predicate" };
    const selectionWithoutObject = /(?:为什么|为何)(?:要)?(?:选|选择)\s*[？?。！!\s，,、]*$/iu.test(text)
      && !/(?:STM\d+|F\d{3,4}|芯片|MCU|方案|组件|Cortex|DMA|ADC|PWM|CAN|SPI)/iu.test(text);
    if (selectionWithoutObject) return { state: "WAITING_OBJECT", confidence: 0.96, unresolvedSlots: ["selected-object"], reason: "selection-object-missing" };
    if (OPEN_SETUP.test(text) || isOpenPredicate(text) || isDanglingQuestionTail(text)) {
      return selectionWithoutObject
        ? { state: "WAITING_OBJECT", confidence: 0.96, unresolvedSlots: ["selected-object"], reason: "selection-object-missing" }
        : { state: "OPEN", confidence: 0.96, unresolvedSlots: ["predicate-or-constraint"], reason: "open-predicate-or-continuation" };
    }
    if (input.references.some((reference) => !reference.resolved || reference.confidence < 0.8)) return { state: "WAITING_REFERENCE", confidence: 0.95, unresolvedSlots: ["reference"], reason: "reference-unresolved" };
    if (MISSING_OBJECT.test(text) || !input.hasObject && !input.currentTopic && /(?:怎么|如何|多久|为什么|为何|哪个|哪一个)/iu.test(text)) return { state: "WAITING_OBJECT", confidence: 0.9, unresolvedSlots: ["object"], reason: "object-missing" };
    if (MISSING_SUBJECT.test(text) || !input.hasSubject && !input.currentTopic) return { state: "WAITING_SUBJECT", confidence: 0.9, unresolvedSlots: ["subject"], reason: "subject-missing" };
    if (hasContextReference(text) && input.references.length === 0 && !input.currentTopic && !input.hasSubject) return { state: "WAITING_REFERENCE", confidence: 0.9, unresolvedSlots: ["reference"], reason: "context-reference-without-anchor" };
    if (input.slotCount === 0) return { state: "OPEN", confidence: 0.82, unresolvedSlots: ["question-slot"], reason: "no-question-slot" };
    return { state: "COMPLETE", confidence: 0.94, unresolvedSlots: [], reason: "semantic-question-complete" };
  }
}

export function evaluateSemanticQuestionCompletion(input: SemanticQuestionCompletionInput): SemanticQuestionCompletionResult {
  return new SemanticQuestionCompletion().evaluate(input);
}
