import { normalizeTechnicalTerms } from "../terminology";

export type AnswerabilityState =
  | "ANSWERABLE"
  | "INCOMPLETE"
  | "SETUP_ONLY"
  | "STYLE_ONLY"
  | "CONTEXT_DEPENDENT"
  | "FILLER"
  | "OPEN_PREDICATE"
  | "META_CONVERSATION"
  | "TOPIC_ANNOUNCEMENT"
  | "ANSWER_CONSTRAINT"
  | "TOPIC_FRAGMENT";

export interface SemanticAnswerabilityContext {
  speechAct?: string;
  currentTopic?: string;
  latestQuestionText?: string;
  hasRecentQuestion?: boolean;
  /** A strong local classifier may rescue an ambiguous, structurally complete question. */
  localClassifierConfidence?: number;
}

export interface AnswerabilityDecision {
  state: AnswerabilityState;
  confidence: number;
  reason: string;
  shouldAnswer: boolean;
  shouldBuffer: boolean;
  shouldAttachToPrevious: boolean;
  hasIndependentSubject: boolean;
  hasMeaningfulObject: boolean;
  isDangling: boolean;
}

const FILLER_ONLY = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|可以|行|那个|继续|继续说|然后)[。！？?！\s，,、]*$/iu;
const STYLE_ONLY = /^(?:请你?|请)?(?:(?:简单(?:地)?(?:说说|说一下|讲讲|讲一下)|简单说说(?:思路)?|大概(?:说说|说一下|讲讲|讲一下)|说重点|重点说(?:一下)?|不用展开|不要展开|简短(?:一点|说一下)?|控制在\s*\d+\s*(?:秒|分钟)|结合项目(?:说|讲)(?:一下)?|只讲(?:思路|重点)?|只说(?:你会)?[^？?。！？!]{0,20}\d+\s*(?:件|点|条|个)|越具体(?:一点|越好)?|说说(?:思路)?就行|简单讲一下就行|简单说说就行)(?:[，,、\s]+(?:控制在\s*\d+\s*(?:秒|分钟)|结合项目(?:说|讲)(?:一下)?|说重点|不用展开|简短(?:一点|说一下)?))*|(?:简单|大概|重点|简短|只讲|只说|越具体|结合项目|控制在)[^？?。！？!]{0,48}(?:就行|即可|不用展开|不要展开|越好))[。！？?！\s，,、]*$/iu;
const BARE_ANSWER_REQUEST = /^(?:(?:来个|给个|给我个|请给个)[^，,。！？?！]{0,12}[，,、\s]*)?(?:你\s*)?(?:说说|讲讲|说一下|讲一下|介绍一下|解释一下|展开说|展开讲)(?:吧|看)?$/iu;
const CONDITIONAL_PREFIX = /^(?:如果|假设|若|要是|当|在[^，,。！？?！]{0,20}(?:情况下|时|的时候)?)[^。！？?！]*[。！？?！]?$/iu;
const QUESTION_NUCLEUS = /(?:为什么|为何|怎么|如何|怎样|怎么办|哪些|哪种|哪个|哪一个|哪几种|哪里|什么是|什么意思|什么|是否|有没有|能不能|可不可以|多少|几个|几路|吗|呢|区别|原理|作用|原因|介绍|解释|说明|说说|讲讲|排查|定位|设计|实现|验证|解决|优化|比较|对比|会不会|会怎么)/iu;
const DANGLING_TAIL = /(?:以及|还有|包括|并且|而且|分别|哪些方面|哪些情况下|什么场景|什么时候|什么情况|哪种情况|哪一个|哪个|怎么|如何)[。！？?！\s，,、]*$/iu;
const CONTEXT_REFERENCE = /(?:这个|那个|这种|那种|这样|这么|它|这里|其中|然后|还有|具体|再|那|什么时候|哪些(?:场景|情况|方面)|什么(?:情况下|时候)|必须用|会出什么问题|用过哪些|用在什么地方|哪一个|哪个|这两个|前者|后者|为什么这样|怎么这样|你会(?:更)?倾向于?用?哪(?:一个|个)|更倾向(?:于)?哪(?:一个|个))/iu;
const EXPLICIT_TOPIC = /(?:STL|TCP|UDP|HTTP|MQTT|CoAP|LwIP|IIC|I2C|SPI|UART|CAN(?:\s*FD)?|LIN|FOC|DMA|PWM|ADC|DAC|GPIO|NVIC|SysTick|FreeRTOS|RT-Thread|Zephyr|Linux|RTOS|RISC-V|Cortex-[MAR]|C\+\+|C语言|虚函数|堆和栈|看门狗|链表|字符串|进程间通信|线程|任务|内存|中断|驱动|协议|架构|系统|项目|日志|硬件|电机|网络|队列|栈|Flash|EEPROM|HardFault|ACID|数据库|Redis)/iu;
const MEANINGFUL_OBJECT = /(?:项目|系统|模块|方案|协议|接口|链路|问题|场景|情况|原因|区别|原理|作用|设计|实现|定位|排查|验证|风险|计划|步骤|清单|方法|数值|示例|代码|任务|线程|内存|硬件|日志|网络|电机|看门狗|UART|SPI|I2C|CAN|RTOS|HardFault|故障|性能|索引|词|意思|结果|负责|经历|ACID|数据库|微服务|缓存|寄存器|复杂度|带宽)/iu;
const GENERIC_OBJECT_ONLY = /(?:问题|场景|情况|原因|区别|原理|作用|定位|排查|验证|风险|步骤|方法|结果|影响|哪些点|哪些方面|什么时候|什么情况)/iu;
const OPEN_PREDICATE = /(?:能不能|可不可以|要不要|是否可以)\s*(?:用|开|启用|配|配置|设置|选择|调用|处理|接|放|加|改)(?:[。！？?！\s，,、]*$)/iu;
const OPEN_CONFIG_PREDICATE = /(?:这里|那个|这个|这种情况|这种场景|中断里|中断中)\s*(?:怎么|如何|怎样)\s*(?:用|开|启用|配|配置|设置|选择|调用|处理)(?:[。！？?！\s，,、]*$)/iu;
const SHORT_OBJECT_COMPOSITION = /(?:怎么|如何|怎样)\s*(?:避免|防止|解决|降低|判断|保证|处理|定位|排查|修复)\s*[\u4e00-\u9fff](?:[？?。！？!])$/iu;
const CONTEXTUAL_REPLACEMENT_QUESTION = /^(?:那|然后|如果|假设|若|再)?[^。！？?！]*?(?:换成|换为|改成|改为|迁到|切到)[^。！？?！]*[？?]$/iu;
const CONSTRAINT_FRAGMENT = /^(?:包括|涵盖|还要(?:说明|考虑)?|需要(?:覆盖|说明|考虑)|同时(?:说明|考虑)|不得|不能|仅限|只(?:说|讲|比较))[^？?。！？!]*[。！？!；;]?$|(?:map\s*文件|栈回溯|寄存器解析|降级策略)[^？?。！？!]*$/iu;
const EXPLICIT_QUESTION_LABEL = /(?:问题|题目)\s*[:：]/u;
const SELF_INTRODUCTION = /(?:自我介绍|介绍一下自己)/iu;
const CONTEXTUAL_ELLIPTICAL_REQUEST = /^(?:(?:嗯+|呃+|好+|好的|哦+|那)[，,、\s]*)?(?:说说|讲讲|展开说(?:说)?|具体说|再说说|再讲讲)[。！？?！\s，,、]*$/iu;

function clean(text: string): string {
  return normalizeTechnicalTerms(text).replace(/\s+/g, " ").trim();
}

function compact(text: string): string {
  return clean(text).replace(/[。！？?！；;，,、:：\s]+/g, "");
}

export function isStyleOnly(text: string): boolean {
  return STYLE_ONLY.test(clean(text));
}

export function hasContextReference(text: string): boolean {
  return CONTEXT_REFERENCE.test(clean(text));
}

export function isOpenPredicate(text: string): boolean {
  const normalized = clean(text);
  return OPEN_PREDICATE.test(normalized) || OPEN_CONFIG_PREDICATE.test(normalized);
}

function isShortObjectComposition(text: string): boolean {
  return SHORT_OBJECT_COMPOSITION.test(clean(text));
}

function negative(
  state: AnswerabilityState,
  reason: string,
  confidence: number,
  options: Partial<Pick<AnswerabilityDecision, "shouldBuffer" | "shouldAttachToPrevious" | "hasIndependentSubject" | "hasMeaningfulObject" | "isDangling">> = {}
): AnswerabilityDecision {
  return {
    state,
    confidence,
    reason,
    shouldAnswer: false,
    shouldBuffer: options.shouldBuffer ?? false,
    shouldAttachToPrevious: options.shouldAttachToPrevious ?? false,
    hasIndependentSubject: options.hasIndependentSubject ?? false,
    hasMeaningfulObject: options.hasMeaningfulObject ?? false,
    isDangling: options.isDangling ?? false
  };
}

export function hasIndependentQuestionNucleus(text: string): boolean {
  const normalized = clean(text);
  if (!normalized || BARE_ANSWER_REQUEST.test(compact(normalized))) return false;
  if (CONDITIONAL_PREFIX.test(normalized) && !/(?:怎么|如何|怎样|怎么办|会不会|是否|能不能|可不可以|什么|哪里|哪儿|谁|多少|几个|吗|呢)/iu.test(normalized)) return false;
  return Boolean(EXPLICIT_TOPIC.test(normalized) || MEANINGFUL_OBJECT.test(normalized)) && QUESTION_NUCLEUS.test(normalized);
}

export function isDanglingQuestionTail(text: string): boolean {
  const normalized = clean(text);
  if (!normalized || /[？?]$/.test(normalized)) return false;
  if (!DANGLING_TAIL.test(normalized)) return false;
  // A tail after a complete answer request is only incomplete when the last
  // clause is itself open. This keeps ordinary “以及哪些风险？” questions fast.
  return /(?:以及|还有|包括|并且|而且|分别|哪些方面|哪些情况下|什么场景|什么时候|什么情况|哪种情况)[^。！？?！]*$/iu.test(normalized)
    || /(?:以及|还有|包括|并且|而且|分别)\s*(?:哪一个|哪个|怎么|如何|什么时候|哪些)/iu.test(normalized);
}

function answerable(reason: string, confidence: number, state: "ANSWERABLE" | "CONTEXT_DEPENDENT", independent: boolean): AnswerabilityDecision {
  return { state, confidence, reason, shouldAnswer: true, shouldBuffer: false, shouldAttachToPrevious: state === "CONTEXT_DEPENDENT", hasIndependentSubject: independent, hasMeaningfulObject: independent, isDangling: false };
}

/**
 * Cheap semantic guard for the live path. It deliberately does not classify
 * topics or call a model; it only prevents lexical question signals from
 * starting an answer before a real question nucleus exists.
 */
export function decideSemanticAnswerability(text: string, context: SemanticAnswerabilityContext = {}): AnswerabilityDecision {
  const normalized = clean(text);
  const compactText = compact(normalized);
  const recentQuestion = Boolean(context.hasRecentQuestion || context.latestQuestionText);
  const concreteSubject = EXPLICIT_TOPIC.test(normalized) || MEANINGFUL_OBJECT.test(normalized) && !GENERIC_OBJECT_ONLY.test(normalized);
  const structuralNucleus = QUESTION_NUCLEUS.test(normalized) || /[？?]$/.test(normalized);
  const answerRequestWithContent = (context.speechAct === "ANSWER_REQUEST" || context.speechAct === "CODE_REQUEST") && compactText.length >= 6;
  const contextualReference = recentQuestion && hasContextReference(normalized);
  const independent = (structuralNucleus && compactText.length >= 6 && !contextualReference)
    || (answerRequestWithContent && !BARE_ANSWER_REQUEST.test(compactText));
  const meaningfulObject = concreteSubject || independent;

  if (!normalized || FILLER_ONLY.test(normalized)) {
    return negative("FILLER", "filler-only", 0.99);
  }
  if (recentQuestion && context.speechAct === "FOLLOW_UP" && CONTEXTUAL_ELLIPTICAL_REQUEST.test(normalized)) {
    return answerable("contextual-elliptical-answer-request", 0.92, "CONTEXT_DEPENDENT", false);
  }
  if (isStyleOnly(normalized)) {
    return negative("STYLE_ONLY", "style-only-modifier", 0.98, { shouldAttachToPrevious: recentQuestion });
  }
  if (context.speechAct === "META_CONVERSATION") {
    return negative("META_CONVERSATION", "meta-conversation", 0.99);
  }
  if (context.speechAct === "TOPIC_ANNOUNCEMENT") {
    return negative("TOPIC_ANNOUNCEMENT", "topic-announcement", 0.96, { shouldBuffer: true });
  }
  if (context.speechAct === "INSTRUCTION_MODIFIER") {
    return negative("ANSWER_CONSTRAINT", "answer-constraint", 0.97, { shouldAttachToPrevious: recentQuestion });
  }
  if (recentQuestion && CONTEXTUAL_REPLACEMENT_QUESTION.test(normalized)) {
    return answerable("contextual-replacement-question", 0.92, "CONTEXT_DEPENDENT", false);
  }
  if (CONSTRAINT_FRAGMENT.test(normalized) && !QUESTION_NUCLEUS.test(normalized)) {
    return negative("ANSWER_CONSTRAINT", "constraint-fragment", 0.9, { shouldAttachToPrevious: recentQuestion });
  }
  if (context.speechAct === "TOPIC_ANCHOR") {
    return negative("TOPIC_FRAGMENT", "topic-fragment", 0.9, { shouldBuffer: true, hasIndependentSubject: concreteSubject, hasMeaningfulObject: meaningfulObject });
  }
  if (BARE_ANSWER_REQUEST.test(compactText)) {
    if (recentQuestion && context.speechAct === "FOLLOW_UP") return answerable("contextual-bare-answer-request", 0.92, "CONTEXT_DEPENDENT", false);
    return negative("SETUP_ONLY", "bare-answer-request-without-subject", 0.97, { shouldBuffer: true });
  }
  if (EXPLICIT_QUESTION_LABEL.test(normalized) && compactText.length >= 6) {
    return answerable("explicit-question-label", 0.94, "ANSWERABLE", true);
  }
  if (SELF_INTRODUCTION.test(normalized) || context.speechAct === "CODE_REQUEST" && meaningfulObject) {
    return answerable("explicit-answer-request", 0.94, "ANSWERABLE", true);
  }
  if (isOpenPredicate(normalized)) {
    return negative("OPEN_PREDICATE", "predicate-missing-object", 0.97, { shouldBuffer: true, hasIndependentSubject: concreteSubject, isDangling: true });
  }
  if (isShortObjectComposition(normalized)) {
    return negative("INCOMPLETE", "short-object-composition-open", 0.93, { shouldBuffer: true, hasIndependentSubject: concreteSubject, isDangling: true });
  }
  const strongLocalRescue = (context.localClassifierConfidence ?? 0) >= 0.86;
  if (CONDITIONAL_PREFIX.test(normalized) && !/(?:怎么|如何|怎样|怎么办|会不会|是否|能不能|可不可以|什么|哪里|哪儿|谁|多少|几个|吗|呢)/iu.test(normalized)) {
    return negative("SETUP_ONLY", "conditional-setup-without-nucleus", 0.94, { shouldBuffer: true, hasIndependentSubject: meaningfulObject, hasMeaningfulObject: meaningfulObject });
  }
  const dangling = isDanglingQuestionTail(normalized);
  if (dangling) {
    return negative("INCOMPLETE", "dangling-question-tail", 0.91, { shouldBuffer: true, hasIndependentSubject: independent, hasMeaningfulObject: meaningfulObject, isDangling: true });
  }

  if (recentQuestion && hasContextReference(normalized) && !independent && QUESTION_NUCLEUS.test(normalized)) {
    return answerable("context-dependent-follow-up", 0.95, "CONTEXT_DEPENDENT", false);
  }
  if (recentQuestion && context.speechAct === "FOLLOW_UP" && compactText.length <= 18 && /(?:说说|讲讲|具体|为什么|为何|怎么|如何|哪一个|哪个)/iu.test(normalized)) {
    return answerable("contextual-speech-act-follow-up", 0.92, "CONTEXT_DEPENDENT", false);
  }
  if (recentQuestion && compactText.length <= 18 && /^(?:为什么|怎么(?:做的?)?|如何(?:做)?|具体(?:呢)?|然后呢|还有吗?|哪一个|哪个|那.+呢)[？?。！!\s]*$/iu.test(normalized)) {
    return answerable("contextual-short-question-follow-up", 0.92, "CONTEXT_DEPENDENT", false);
  }
  // The local model may only rescue an otherwise structurally complete,
  // ambiguous utterance. It cannot override a deterministic semantic
  // negative such as setup, an open predicate, or an incomplete tail.
  const ambiguousStructurallyComplete = compactText.length >= 8
    && meaningfulObject
    && (/[？?]$/.test(normalized) || QUESTION_NUCLEUS.test(normalized));
  if (strongLocalRescue && ambiguousStructurallyComplete) {
    return answerable("strong-local-question-rescue", 0.9, "ANSWERABLE", true);
  }
  if (independent || QUESTION_NUCLEUS.test(normalized) && meaningfulObject) {
    return answerable("independent-question-nucleus", 0.9, "ANSWERABLE", true);
  }
  if (QUESTION_NUCLEUS.test(normalized) || /[？?]$/.test(normalized)) {
    return negative("INCOMPLETE", "question-signal-without-nucleus", 0.78, { shouldBuffer: true, hasMeaningfulObject: meaningfulObject });
  }
  return negative("INCOMPLETE", "no-question-nucleus", 0.72, { shouldBuffer: true, hasMeaningfulObject: meaningfulObject });
}

export class SemanticAnswerabilityGate {
  decide(text: string, context: SemanticAnswerabilityContext = {}): AnswerabilityDecision {
    return decideSemanticAnswerability(text, context);
  }
}
