import { normalizeTechnicalTerms } from "../terminology";
import type { ContextAnchorSnapshot } from "./context-anchor-store";
import { ContextAnchorResolver, type ResolvedQuestionContext } from "./context-anchor-resolver";
import { AntecedentResolver, type AntecedentResolution } from "./antecedent-resolver";
import type { ActiveProjectState } from "./project-context-state";
import type { SemanticTurnDecision } from "./semantic-turn-gate";

export interface QuestionUnderstandingInput {
  text: string;
  fragments?: string[];
  semantic: SemanticTurnDecision;
  anchors?: ContextAnchorSnapshot;
  activeProject?: ActiveProjectState;
  currentModule?: string;
  previousQuestion?: string;
  previousAnswer?: string;
  spokenProblem?: string;
}

export interface QuestionUnderstandingResult extends ResolvedQuestionContext {
  antecedent: {
    antecedentType: "PROJECT" | "TOPIC" | "MODULE" | "TECHNOLOGY" | "PREVIOUS_QUESTION" | "PREVIOUS_ANSWER";
    antecedentId?: string;
    confidence: number;
  };
  fragments: string[];
}

const QUESTION_TAIL = /^(?:是)?(?:什么|为什么|为何|怎么|如何|怎样|会怎么样|会有什么问题|有哪些|有哪几种|有什么区别|哪里用了|然后呢|还有呢|还有)[？?。！!\s，,、]*$/iu;
const PREFIX_QUESTION = /^(?:什么是|什么|有哪些|有什么区别|有什么|哪几种)[？?。！!\s，,、]*$/iu;
const MID_HOW = /^(?:是)?(?:具体)?怎么[？?。！!\s，,、]*$/iu;
const SUBJECT_TAIL = /^(.*?)[。．.]+\s*(是什么|为什么|为何|怎么|如何|怎样|会怎么样|会有什么问题|有哪些|有什么区别)[？?。！!\s，,、]*$/iu;
const TOPIC = /(?:STL|TCP|UDP|HTTP|MQTT|CoAP|LwIP|IIC|I2C|SPI|UART|CAN(?:\s*FD)?|LIN|FOC|DMA|PWM|ADC|DAC|GPIO|NVIC|SysTick|FreeRTOS|RT-Thread|Zephyr|Linux|RTOS|RISC-V|Cortex-[MAR]|C\+\+|C语言|volatile|Flash|EEPROM|HardFault|malloc|内存泄漏|内存溢出|架构|分层|项目)/iu;

function stripTerminal(value: string): string { return value.trim().replace(/[。．.！？?！；;，,、\s]+$/gu, ""); }

function compactSpaces(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fffA-Za-z0-9])/gu, "$1")
    .replace(/([A-Za-z0-9+#])\s+(?=[\u4e00-\u9fff])/gu, "$1")
    .replace(/\s+([，。！？?！；;：:])/gu, "$1")
    .trim();
}

function glue(values: string[]): string {
  return compactSpaces(values.map(stripTerminal).filter(Boolean).join(" "));
}

function withQuestionMark(value: string): string {
  const normalized = compactSpaces(value).replace(/[。！？!；;]+$/gu, "");
  return normalized && /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|是否|有没有|能不能|可不可以|多少|几个|吗|呢|区别|原理|作用|会怎么样|有什么问题)/iu.test(normalized)
    ? `${normalized.replace(/[？?]+$/u, "")}？`
    : normalized;
}

/** Canonicalizes common spoken fragment orders without using a case-specific map. */
export function canonicalizeQuestion(text: string, fragments = [text]): string {
  const values = fragments.map((item) => normalizeTechnicalTerms(item).trim()).filter(Boolean);
  if (!values.length) return "";
  const cleaned = values.map(stripTerminal);
  if (cleaned.length === 1) {
    const single = compactSpaces(cleaned[0]);
    const subjectTail = single.match(SUBJECT_TAIL);
    if (subjectTail) return withQuestionMark(`${subjectTail[2] === "是什么" ? `什么是${subjectTail[1]}` : `${subjectTail[1]}${subjectTail[2]}`}`);
    return withQuestionMark(single);
  }
  const first = cleaned[0];
  const rest = cleaned.slice(1);
  if (PREFIX_QUESTION.test(first)) return withQuestionMark(`${first}${glue(rest)}`);
  // Spoken Chinese often puts the question nucleus in the middle of a
  // context/setup turn: “软件分层。是具体怎么？来做的。” Handle this
  // before the generic tail rule so the result stays natural.
  if (cleaned.length >= 3 && MID_HOW.test(cleaned[1])) {
    return withQuestionMark(`${cleaned[0]}，具体是怎么${glue(cleaned.slice(2))}`);
  }
  if (QUESTION_TAIL.test(rest[0])) {
    const tail = rest[0].replace(/^是(?=具体|怎么|如何|怎样)/u, "");
    if (rest.length === 1 && /^(?:是什么)$/u.test(rest[0])) return withQuestionMark(`什么是${first}`);
    return withQuestionMark(`${first}${tail}${glue(rest.slice(1))}`);
  }
  const questionIndex = cleaned.findIndex((item) => /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|是否|有没有|能不能|可不可以|吗|呢|会怎么样|有什么问题)/iu.test(item));
  if (questionIndex > 0) {
    const prefix = glue(cleaned.slice(0, questionIndex));
    const suffix = glue(cleaned.slice(questionIndex));
    return withQuestionMark(`${prefix}，${suffix}`);
  }
  return withQuestionMark(glue(cleaned));
}

function mapAntecedent(input: QuestionUnderstandingInput, resolution: AntecedentResolution): QuestionUnderstandingResult["antecedent"] {
  const type = resolution.type === "PROJECT" ? "PROJECT" : resolution.type === "MODULE" ? "MODULE" : resolution.type === "PREVIOUS_ANSWER" ? "PREVIOUS_ANSWER" : resolution.type === "PREVIOUS_QUESTION" ? "PREVIOUS_QUESTION" : TOPIC.test(input.text) ? "TOPIC" : "TECHNOLOGY";
  const antecedentId = type === "PROJECT" ? input.activeProject?.projectId : type === "PREVIOUS_QUESTION" ? input.anchors?.lastConfirmedQuestion?.id : type === "PREVIOUS_ANSWER" ? `answer:${input.anchors?.lastConfirmedQuestion?.id ?? "latest"}` : undefined;
  return { antecedentType: type, ...(antecedentId ? { antecedentId } : {}), confidence: resolution.confidence };
}

/** Understands a complete turn; it never performs ASR fragment assembly. */
export class QuestionUnderstanding {
  constructor(private readonly anchorResolver = new ContextAnchorResolver(), private readonly antecedentResolver = new AntecedentResolver()) {}

  understand(input: QuestionUnderstandingInput): QuestionUnderstandingResult {
    const fragments = input.fragments?.length ? input.fragments : [input.text];
    let canonicalQuestion = canonicalizeQuestion(input.text, fragments);
    const topicAnchor = input.anchors?.latestAnchor;
    const dependentTail = QUESTION_TAIL.test(fragments[0]?.trim() ?? "") || PREFIX_QUESTION.test(fragments[0]?.trim() ?? "");
    // When the ASR stream delivered a topic statement and the question tail
    // arrived as a separate turn, retain the spoken subject in the canonical
    // question. This is the bridge between “C语言里，指针和数组。” and
    // “有什么区别？”; metadata alone is insufficient for retrieval/history.
    if (dependentTail && topicAnchor?.speechAct === "TOPIC_ANCHOR" && !input.anchors?.lastConfirmedQuestion && topicAnchor.text !== canonicalQuestion) {
      canonicalQuestion = canonicalizeQuestion(canonicalQuestion, [topicAnchor.text, ...fragments]);
    }
    const anchorResolution = input.anchors
      ? this.anchorResolver.resolve({ text: canonicalQuestion, speechAct: input.semantic.sourceSpeechAct as Parameters<ContextAnchorResolver["resolve"]>[0]["speechAct"], anchors: input.anchors })
      : { canonicalQuestion, contextRelation: input.semantic.dependency === "CONTINUATION" ? "continuation" as const : input.semantic.dependency === "DEPENDS_ON_PREVIOUS" ? "follow_up" as const : "standalone" as const, confidence: input.semantic.confidence, reason: "semantic-turn-context" };
    const antecedent = this.antecedentResolver.resolve({ text: canonicalQuestion, activeProject: input.activeProject, currentModule: input.currentModule, currentTopic: input.anchors?.currentTopic, previousQuestion: input.previousQuestion ?? input.anchors?.lastConfirmedQuestion?.text, previousAnswer: input.previousAnswer, spokenProblem: input.spokenProblem });
    const relation = input.semantic.dependency === "CONTINUATION" ? "continuation" : input.semantic.dependency === "DEPENDS_ON_PREVIOUS" || antecedent.relation !== "STANDALONE" ? "follow_up" : anchorResolution.contextRelation;
    const topic = TOPIC.test(canonicalQuestion) ? canonicalQuestion.match(TOPIC)?.[0] : anchorResolution.topic ?? input.anchors?.currentTopic;
    const parent = input.anchors?.lastConfirmedQuestion;
    return {
      ...anchorResolution,
      canonicalQuestion,
      contextRelation: relation,
      ...(topic ? { topic } : {}),
      ...(relation !== "standalone" && (anchorResolution.parentQuestion || parent) ? { parentQuestion: anchorResolution.parentQuestion ?? parent?.text, parentQuestionId: anchorResolution.parentQuestionId ?? parent?.id, rootQuestion: anchorResolution.rootQuestion ?? parent?.text, rootQuestionId: anchorResolution.rootQuestionId ?? parent?.id, inheritedTopic: anchorResolution.inheritedTopic ?? input.anchors?.currentTopic } : {}),
      antecedent: mapAntecedent(input, antecedent),
      fragments: [...fragments]
    };
  }
}
