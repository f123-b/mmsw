import type { InterviewMemorySnapshot } from "../interview-memory";
import { decideSemanticAnswerability, type AnswerabilityDecision } from "./semantic-answerability";
import { SpeechActClassifier, type SpeechActClassification, type SpeechActContext } from "./speech-act-classifier";
import { decideTurnCompletion } from "./turn-completion-gate";

export type FragmentDependency = "INDEPENDENT" | "DEPENDS_ON_PREVIOUS" | "EXPECTS_NEXT" | "CONTINUATION";
export type SemanticTurnSpeechAct = "QUESTION" | "ANSWER_REQUEST" | "FOLLOW_UP_REQUEST" | "STATEMENT" | "BACKCHANNEL" | "INCOMPLETE" | "ASR_NOISE";
export type SemanticTurnCompleteness = "COMPLETE" | "INCOMPLETE" | "DEPENDENT";

export interface SemanticTurnContext extends SpeechActContext {
  memory?: InterviewMemorySnapshot;
  previousInterviewerTurn?: string;
  asrEndpoint?: boolean;
  localClassifierConfidence?: number;
}

export interface SemanticTurnDecision {
  speechAct: SemanticTurnSpeechAct;
  completeness: SemanticTurnCompleteness;
  dependency: FragmentDependency;
  shouldAnswer: boolean;
  confidence: number;
  reason: string;
  /** Rich legacy signals are retained for the detector bridge and telemetry. */
  sourceSpeechAct: string;
  answerabilityState: AnswerabilityDecision["state"];
  answerability: AnswerabilityDecision;
  classification: SpeechActClassification;
  recommendedWaitMs: number;
}

const BACKCHANNEL = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|行|可以|还有|然后|那个|就是)[。！？?！\s，,、]*$/iu;
const NOISE = /^(?:乱码|听不清|无法识别|日制日制|色一块|嗯啊嗯啊|spm|sps)[^？?]*$/iu;
const CONTINUATION = /^(?:来做的?|里面|这一块|这个方面|这种情况下|尤其是在|这里面|上面|下去|然后呢)[。！？?！\s，,、]*$/iu;
const EXPECTS_NEXT = /^(?:什么是|什么|有哪些|有什么区别|有什么|关于这个|针对这种情况|假设现在|如果让你|如果在|如果|假设|若|那对于|你刚才提到|你刚才说)[？?。！？!；;，,、\s]*$/iu;
const DEPENDENT_TAIL = /^(?:是什么|为什么|为何|怎么|如何|怎样|具体怎么|是具体怎么|会怎么样|会有什么问题|有哪些|有哪几种|有什么区别|哪里用了|然后呢|还有呢|还有|结果呢|为什么这样)[？?。！？!；;，,、\s]*$/iu;
const QUESTION_SIGNAL = /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|是否|有没有|能不能|可不可以|多少|几个|吗|呢|请问|介绍|解释|说明|说说|讲讲|排查|定位|设计|优化|验证|解决|区别|原理|作用)/iu;
const EXPLICIT_ANSWER_REQUEST = /^(?:请|你|能否|可以)?(?:说说|讲讲|介绍一下|解释一下|说明一下|回答一下|谈谈|聊聊|给我讲|告诉我)/iu;
const INSTRUCTION_MODIFIER = /^请(?:你)?重点(?:说明|讲|展开|介绍)|^请重点说明/iu;
const SUBSTANTIVE_TOPIC = /(?:IIC|I2C|SPI|UART|CAN|RTOS|FOC|DMA|ADC|中断|总线|系统|项目|模块|架构|内存|HardFault|看门狗|电机|协议|锁|任务|采样)/iu;

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

function normalized(text: string): string { return text.replace(/\s+/g, " ").trim(); }

function mapSpeechAct(classification: SpeechActClassification, text: string): SemanticTurnSpeechAct {
  if (NOISE.test(text)) return "ASR_NOISE";
  if (BACKCHANNEL.test(text) || classification.speechAct === "ACKNOWLEDGEMENT") return "BACKCHANNEL";
  if (EXPLICIT_ANSWER_REQUEST.test(text)) return "ANSWER_REQUEST";
  if (["ANSWER_REQUEST", "CODE_REQUEST"].includes(classification.speechAct)) return "ANSWER_REQUEST";
  if (classification.speechAct === "FOLLOW_UP") return "FOLLOW_UP_REQUEST";
  if (classification.speechAct === "QUESTION") return "QUESTION";
  return "STATEMENT";
}

function promoteEmbeddedQuestion(classification: SpeechActClassification, text: string): SpeechActClassification {
  if (!(["META_CONVERSATION", "ACKNOWLEDGEMENT", "INSTRUCTION_MODIFIER"] as string[]).includes(classification.speechAct)) return classification;
  // A later “怎么回答/你觉得呢/嗯” must not erase a substantive question
  // that was already assembled earlier in the same remote turn.
  if (!SUBSTANTIVE_TOPIC.test(text) || !QUESTION_SIGNAL.test(text)) return classification;
  return { ...classification, speechAct: "QUESTION", shouldAnswer: true, confidence: Math.max(classification.confidence, 0.88), reason: `${classification.reason}+embedded-substantive-question` };
}

function dependencyFor(text: string, speechAct: SemanticTurnSpeechAct, answerability: AnswerabilityDecision, context: SemanticTurnContext): FragmentDependency {
  const value = normalized(text);
  if (speechAct === "BACKCHANNEL" || speechAct === "ASR_NOISE") return "INDEPENDENT";
  if (CONTINUATION.test(value)) return "CONTINUATION";
  if (DEPENDENT_TAIL.test(value) || answerability.state === "CONTEXT_DEPENDENT" || speechAct === "FOLLOW_UP_REQUEST") return "DEPENDS_ON_PREVIOUS";
  if (EXPECTS_NEXT.test(value) || answerability.state === "OPEN_PREDICATE" || answerability.state === "SETUP_ONLY" || answerability.state === "INCOMPLETE") {
    // A complete, object-bearing question must not be held as an open setup.
    if (answerability.shouldAnswer && QUESTION_SIGNAL.test(value) && value.replace(/[？?。！!，,、\s]/g, "").length >= 8) return "INDEPENDENT";
    return "EXPECTS_NEXT";
  }
  if (context.previousInterviewerTurn && (/^(?:那|然后|这个|它|这里|其中|具体|再)/u.test(value) || answerability.shouldAttachToPrevious)) return "DEPENDS_ON_PREVIOUS";
  return "INDEPENDENT";
}

function waitFor(completeness: SemanticTurnCompleteness, dependency: FragmentDependency, speechAct: SemanticTurnSpeechAct, text: string): number {
  if (speechAct === "BACKCHANNEL" || speechAct === "ASR_NOISE") return 150;
  if (dependency === "EXPECTS_NEXT") return completeness === "INCOMPLETE" ? 2_000 : 1_700;
  // A punctuated, answerable follow-up (including a short “好，说说”) is a
  // complete conversational turn. Keep the longer dependent horizon for
  // dangling tails so a trailing fragment can still join it.
  if (dependency === "DEPENDS_ON_PREVIOUS") {
    const completeFollowUp = speechAct === "FOLLOW_UP_REQUEST" && (/[？?]$/u.test(text) || text.length <= 8);
    const completeDependentQuestion = speechAct === "QUESTION" && text.length >= 10;
    return completeFollowUp || completeDependentQuestion ? 420 : 1_100;
  }
  if (dependency === "CONTINUATION") return 900;
  if (completeness === "INCOMPLETE") return 1_200;
  return 420;
}

/**
 * The one semantic gate used by the live runtime. It consumes an assembled
 * interviewer turn, never a raw ASR partial, and owns the answer/no-answer
 * decision together with dependency and adaptive wait classification.
 */
export class SemanticTurnGate {
  constructor(private readonly classifier = new SpeechActClassifier()) {}

  decide(text: string, context: SemanticTurnContext = {}): SemanticTurnDecision {
    const value = normalized(text);
    let classification = promoteEmbeddedQuestion(this.classifier.classify(value, context), value);
    const answerability = decideSemanticAnswerability(value, {
      speechAct: classification.speechAct,
      currentTopic: context.currentTopic,
      latestQuestionText: context.latestAnchor?.text,
      hasRecentQuestion: Boolean(context.latestAnchor || context.memory?.pendingQuestion || context.memory?.turns?.length || context.recentTranscript?.length),
      localClassifierConfidence: context.localClassifierConfidence
    });
    let speechAct = mapSpeechAct(classification, value);
    // A continuation can begin with a setup/statement fragment and only
    // reveal its interrogative nucleus after the next ASR final arrives. Once
    // the assembled text is structurally answerable, keep that semantic fact
    // instead of allowing the first statement label to suppress the turn.
  if (speechAct === "STATEMENT" && answerability.shouldAnswer && QUESTION_SIGNAL.test(value)) {
    if (!INSTRUCTION_MODIFIER.test(value)) {
      // “请重点说明 X，比如……” is an answer constraint/setup, not a
      // question. Do not let the broad lexical question signal promote it.
    classification = { ...classification, speechAct: "QUESTION", shouldAnswer: true, confidence: Math.max(classification.confidence, answerability.confidence), reason: `${classification.reason}+assembled-question-nucleus` };
    speechAct = "QUESTION";
    }
  }
    const completion = decideTurnCompletion(value, { previousText: context.previousInterviewerTurn, currentTopic: context.currentTopic, asrEndpoint: context.asrEndpoint });
    const dependency = dependencyFor(value, speechAct, answerability, context);
    const dependent = dependency === "DEPENDS_ON_PREVIOUS" || dependency === "CONTINUATION";
    const completeness: SemanticTurnCompleteness = answerability.state === "INCOMPLETE" || answerability.state === "SETUP_ONLY" || answerability.state === "OPEN_PREDICATE" || completion.state === "incomplete"
      ? "INCOMPLETE"
      : dependent ? "DEPENDENT" : "COMPLETE";
    const shouldAnswer = speechAct === "QUESTION" || speechAct === "ANSWER_REQUEST" || speechAct === "FOLLOW_UP_REQUEST"
      ? answerability.shouldAnswer && completeness !== "INCOMPLETE"
      : false;
    const confidence = clamp(Math.min(classification.confidence, answerability.confidence, completion.confidence));
    return {
      speechAct: speechAct === "STATEMENT" && completeness === "INCOMPLETE" ? "INCOMPLETE" : speechAct,
      completeness,
      dependency,
      shouldAnswer,
      confidence,
      reason: `${classification.reason}+${answerability.reason}+${completion.reason}`,
      sourceSpeechAct: classification.speechAct,
      answerabilityState: answerability.state,
      answerability,
      classification,
      recommendedWaitMs: waitFor(completeness, dependency, speechAct, value)
    };
  }
}

export function decideSemanticTurn(text: string, context: SemanticTurnContext = {}): SemanticTurnDecision {
  return new SemanticTurnGate().decide(text, context);
}
