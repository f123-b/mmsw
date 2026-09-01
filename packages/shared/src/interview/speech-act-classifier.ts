import type { InterviewMemorySnapshot } from "../interview-memory";
import { detectTopicBoundary, hasStandaloneTopicSubject } from "./topic-boundary-detector";
import { isStyleOnly } from "./semantic-answerability";

export type InterviewSpeechAct =
  | "QUESTION"
  | "ANSWER_REQUEST"
  | "CODE_REQUEST"
  | "FOLLOW_UP"
  | "TOPIC_ANCHOR"
  | "TOPIC_ANNOUNCEMENT"
  | "TOPIC_TRANSITION"
  | "INSTRUCTION_MODIFIER"
  | "ACKNOWLEDGEMENT"
  | "CONTROL"
  | "META_CONVERSATION"
  | "STATEMENT";

export interface SpeechActAnchorContext {
  text?: string;
  topic?: string;
  speechAct?: "TOPIC_ANCHOR" | "QUESTION" | "CODE_CONTEXT";
  expiresAt?: number;
}

export interface SpeechActContext {
  memory?: InterviewMemorySnapshot;
  recentTranscript?: string[];
  currentTopic?: string;
  latestAnchor?: SpeechActAnchorContext;
  pendingCodeContext?: boolean;
  now?: number;
}

export interface SpeechActClassification {
  speechAct: InterviewSpeechAct;
  shouldAnswer: boolean;
  confidence: number;
  normalizedText: string;
  reason: string;
  topic?: string;
  entities: string[];
  codeContext?: boolean;
  candidateSpeech?: boolean;
}

const ACKNOWLEDGEMENT = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|那|明白了?|知道了?|可以|行)[。！？?！\s，,、]*$/i;
const TOPIC_TRANSITION = /^(?:(?:好|好的|行|可以|嗯+|那)[，,、\s]*)?(?:下一个问题|下个问题|下一题|换一个问题|换个问题|换个话题|再来一个(?:问题)?|再问一个(?:问题)?|另一个问题|接下来(?:问)?)[。！？?！\s，,、]*$/i;
const CONTROL = /^(?:(?:好|好的|行|可以|嗯+|那)[，,、\s]*)?(?:继续|暂停|停止|开始)(?:[。！？?！\s，,、]*)$/i;
const META_CONVERSATION = /(?:你能看到吗|看得到吗|你能听到吗|听得到吗|你在动鼠标吗|动我鼠标|鼠标|屏幕能看到吗|能看到屏幕|声音听得到吗|卡了吗|软件怎么了|网络卡吗|你怎么知道我这里|你操作我电脑了吗|你操作了吗|能看到我这边|能听到我这边)/i;
const META_REPAIR = /^(?:你觉得(?:呢)?|怎么(?:回答|答|说)|答案(?:是什么|呢))[。！？?！\s]*$/i;
const CODE_CONTEXT = /(?:现在|接下来|下面|来)?(?:考你|问你)?(?:一个)?代码题|算法题|编程题/i;
const CODE_REQUEST = /(?:写.{0,18}(?:代码|函数|程序)|手写|代码实现|实现一下|写一个|写个|给一段代码|(?:^请?|\s请?)用\s*C(?:\+\+|语言)?\s*(?:写|实现)|用\s*C\+\+\s*写|伪代码|补全(?:这段)?代码|(?:^请?|\s请?)输出(?:一个)?[^。！？?]{0,20}(?:代码|示例)|字符串.{0,12}(?:代码|实现)|链表.{0,12}(?:代码|函数|实现)|排序.{0,12}(?:代码|实现))/i;
const ALGORITHM_TASK = /(?:反转|遍历|查找|排序|合并|去重|判断|检测|求|计算|打印|实现).{0,18}(?:链表|二叉树|数组|字符串|队列|栈|哈希|回文|斐波那契|最大子序列|环|单例|生产者消费者)/i;
const ANSWER_REQUEST = /^(?:请)?(?:口述|描述|介绍(?:一下)?|详细介绍|讲一下|讲讲|讲一个|详细讲述|讲述|说一下|说说|说明(?:一下)?|解释(?:一下)?|展开讲一下|展开说|列举一下|总结一下|分析一下|完整讲一下|完整讲述|具体说|再说一遍)(?:[：:]|\s|$|(?=[\p{L}\p{N}]))/iu;
const TRAILING_ANSWER_REQUEST = /(?:^|[，,、\s])(?:好|好的|嗯+|明白了?)?[，,、\s]*(?:说说|讲讲|展开说|展开说说|展开讲讲|具体说|具体讲|再说说|再讲讲)[。！？?！\s]*$/i;
const QUESTION_FORM = /(?:什么是|什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|哪里|哪|谁|是否|有没有|能不能|可不可以|区别|原理|作用|原因|流程|优缺点|怎么解决|怎么验证|怎么设计|怎么实现|什么地方|用过哪些|最多|最少|最大|最小|上限|容量|数量|多少|几个|几路|几种|多大|多长|多快|频率|设计.*(?:系统|架构|方案|模块))/i;
const QUESTION_PARTICLE = /(?:吗|呢)[。！？?！\s]*$/i;
const FOLLOW_UP_PREFIX = /^(?:那|然后|还有|具体|如果|再|这个|它|这里|其中|继续|接着|接下来)/;
const ELLIPTICAL_FOLLOW_UP = /^(?:为什么|为何|怎么|如何|具体(?:呢)?|还有(?:呢|吗)?|然后呢|用过哪些|用在什么地方|哪几个|哪种|哪一个|这两个|前者|后者|其中|那低速呢|再具体一点|能不能具体一点|你会关注哪些点|考虑哪些可能性|有哪些可能性|快速排查清单|给(?:个|一份)?(?:快速)?(?:排查|检查)(?:清单|步骤)|简单比较(?:一下)?|简单对比(?:一下)?|对比一下|具体细节|你会更倾向于?用?哪(?:一个|个))[？?。！!\s]*$/iu;
const CONTEXTUAL_OUTPUT_FOLLOW_UP = /^(?:请)?(?:简单|重点|分别)?(?:比较|对比|讲|说|列出|给)(?:一下|一下子)?[^。！？?！]{0,18}[。！？?！\s]*$/iu;
const ELLIPTICAL_ANSWER_REQUEST = /^(?:讲一下|讲讲|说一下|说说|展开讲一下|详细讲述|具体说)[？?。！!\s]*$/i;
const STRONG_TOPIC = /(?:STL|TCP|UDP|HTTP|MQTT|CoAP|LwIP|IIC|I2C|SPI|UART|CAN(?: FD)?|LIN|FlexRay|Modbus|FOC|DMA|PWM|ADC|DAC|GPIO|NVIC|SysTick|MPU|MMU|FreeRTOS|RT-Thread|Zephyr|Linux|RTOS|C\+\+|C语言|RISC-V|Cortex-[MAR]|虚函数|堆和栈|进程间通信|进程线程|链表|字符串|排序|同步机制|三次握手|四次挥手|容器|上拉电阻|EEPROM|Flash|内存管理|低速抖动|系统架构|完整过程|实现过程)/i;
const ASSERTIVE_STATEMENT = /^(?:我|我们|系统|项目|这个项目|当前项目|当前|这个方案|这次优化|它|该模块).*(?:是|为|通过|使用|采用|完成|下降|提升|增加|减少|切换|实现了|负责了)[^？?]*[。！!]$/;
const SMALL_TALK = /^(?:你好|您好|谢谢|辛苦了|哈哈|嗨)[。！？?！\s]*$/i;
const CANDIDATE_SPEECH = /^(?:我|我们|本人|候选人).*(?:负责|做过|参与|实现|采用|使用|认为|觉得|已经|目前|先|会|可以).*[。！!]$/;
const TOPIC_ANNOUNCEMENT = /^(?:(?:(?:下面聊(?:一下)?|接下来问一个|继续问一个|我们先聊(?:一下)?|先聊(?:一下)?|再聊(?:一下)?|我换个(?:更底层的)?|换个(?:话题|方向)?)(?:\s*(?:RTOS|FreeRTOS|C\+\+基础|底层驱动|通信协议|系统设计|项目经验|异常恢复|CAN|UART|DMA|FOC)(?:这个|相关)?(?:话题|部分|问题)?|(?:更?底层|技术|方向)?(?:的)?(?:话题|问题)?))|(?:RTOS|FreeRTOS|C\+\+基础|底层驱动|通信协议|系统设计|项目经验|异常恢复|CAN|UART|DMA|FOC)(?:这个|相关)?(?:话题|部分|问题)?)[。！？?！\s，,、]*$/iu;
const INSTRUCTION_MODIFIER = /^(?!.*(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|哪一个|是否|有没有|吗|呢|[？?]))(?:请你|请)?(?:(?:重点|着重)(?:讲|说|说明|展开)(?:一下|一点)?(?:\s*[^\n。！？?！]{0,30})?|展开一点|具体一点|(?:简单|大概)(?:说|讲)(?:说|一下|讲一下)?(?:思路)?(?:就行|即可)?|说重点|不用展开|简短(?:一点|说一下)?|控制在\s*\d+\s*(?:秒|分钟)|结合项目(?:说|讲)|只讲|[^\n。！？?！]{1,32}角度(?:也)?(?:说|讲|考虑)(?:一下|一点)?)(?:[。！？?！\s，,、]*)$/iu;
const SELF_INTRODUCTION = /^(?:请你|请|能否|可以)?(?:先)?(?:做|进行|来)(?:一下)?(?:一分钟|一段|个)?自我介绍[。！？?！\s，,、]*$/iu;

const KNOWN_ENTITIES = [
  "STL", "TCP", "UDP", "HTTP", "MQTT", "CoAP", "LwIP", "IIC", "I2C", "SPI", "UART", "CAN FD", "CAN", "LIN", "FlexRay", "Modbus", "FOC", "DMA", "PWM", "ADC", "DAC", "GPIO", "NVIC", "SysTick", "MPU", "MMU", "FreeRTOS", "RT-Thread", "Zephyr", "Linux", "RTOS", "RISC-V", "Cortex-M", "Cortex-A", "C++", "虚函数", "堆", "栈", "EEPROM", "Flash", "链表", "字符串", "进程间通信", "三次握手", "四次挥手"
];

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function topicFor(text: string): string | undefined {
  const topic = KNOWN_ENTITIES.find((entity) => text.toLowerCase().includes(entity.toLowerCase()));
  if (topic) return topic;
  return undefined;
}

function entitiesFor(text: string): string[] {
  return KNOWN_ENTITIES.filter((entity) => text.toLowerCase().includes(entity.toLowerCase()));
}

function hasCompleteQuestion(text: string): boolean {
  const compact = text.replace(/[？?。！!，,、\s]/g, "");
  if (!compact) return false;
  if (QUESTION_PARTICLE.test(text) || /[？?]$/.test(text)) {
    const withoutPrefix = compact.replace(/^(?:那|然后|还有|具体|如果)/, "");
    return withoutPrefix.length >= 6;
  }
  return compact.length >= 10 && QUESTION_FORM.test(text);
}

function isFollowUp(text: string, context: SpeechActContext): boolean {
  const compact = text.replace(/[？?。！!\s]/g, "");
  const hasAnchor = Boolean(context.latestAnchor?.text || context.currentTopic || context.memory?.currentTopic);
  const hasEmbeddedAnchor = /(?:围绕|关于|针对|基于).*(?:项目|系统|模块|FOC|RTOS|CAN|UART|DMA)/i.test(text);
  if (!hasAnchor && !hasEmbeddedAnchor) return false;
  if (hasStandaloneTopicSubject(text) && !hasEmbeddedAnchor) return false;
  if (context.latestAnchor?.text && detectTopicBoundary({ previousText: context.latestAnchor.text, previousTopic: context.currentTopic, currentText: text }).relation === "NEW_TOPIC") return false;
  if (ELLIPTICAL_FOLLOW_UP.test(text) || CONTEXTUAL_OUTPUT_FOLLOW_UP.test(text) || ELLIPTICAL_ANSWER_REQUEST.test(text) || TRAILING_ANSWER_REQUEST.test(text)) return true;
  const completeStandaloneForm = /(?:在哪|哪里|是什么|哪些|哪种|哪个|多少|几个|几路|上限|容量)/.test(text);
  const completeWhyHowFollowUp = /^(?:那|然后).*(?:为什么|为何|怎么|如何)/.test(text) && !completeStandaloneForm;
  const contextualCompleteFollowUp = /^(?:那|然后|如果|接下来|再|这个|它|这里|其中).*(?:如果|换成|换为|结果|低速|验证|设计|优化|实现|怎么|如何|呢|吗)/.test(text) && !completeStandaloneForm;
  const shortInterrogativeFollowUp = /^(?:为什么|为何|怎么|如何|怎样)/.test(text) && compact.length <= 16 && !completeStandaloneForm;
  return (ELLIPTICAL_FOLLOW_UP.test(text) || CONTEXTUAL_OUTPUT_FOLLOW_UP.test(text) || FOLLOW_UP_PREFIX.test(text) || shortInterrogativeFollowUp) && compact.length <= 24 && (!hasCompleteQuestion(text) || completeWhyHowFollowUp || contextualCompleteFollowUp || shortInterrogativeFollowUp || ELLIPTICAL_FOLLOW_UP.test(text) || CONTEXTUAL_OUTPUT_FOLLOW_UP.test(text));
}

/**
 * Only clear acknowledgements, controls, meta conversation and explicit
 * candidate statements may be rejected before the question detector runs.
 * Topic anchors and ordinary statements remain recoverable signals because
 * ASR frequently drops the interrogative tail.
 */
export function shouldHardRejectSpeechAct(classification: SpeechActClassification): boolean {
  if (["ACKNOWLEDGEMENT", "CONTROL", "TOPIC_TRANSITION", "META_CONVERSATION", "TOPIC_ANNOUNCEMENT", "INSTRUCTION_MODIFIER"].includes(classification.speechAct)) return true;
  if (SMALL_TALK.test(classification.normalizedText)) return true;
  return classification.speechAct === "STATEMENT" && classification.candidateSpeech === true;
}

/** Deterministic interview speech-act classification before QuestionDetector. */
export class SpeechActClassifier {
  classify(text: string, context: SpeechActContext = {}): SpeechActClassification {
    const normalizedText = normalizeText(text);
    const topic = topicFor(normalizedText);
    const entities = entitiesFor(normalizedText);
    if (!normalizedText) return { speechAct: "STATEMENT", shouldAnswer: false, confidence: 0, normalizedText, reason: "empty", entities };
    if (META_REPAIR.test(normalizedText)) return { speechAct: "META_CONVERSATION", shouldAnswer: false, confidence: 0.98, normalizedText, reason: "meta-repair-prompt", topic, entities };
    if (META_CONVERSATION.test(normalizedText)) return { speechAct: "META_CONVERSATION", shouldAnswer: false, confidence: 0.99, normalizedText, reason: "environment-conversation", topic, entities };
    if (TOPIC_TRANSITION.test(normalizedText)) return { speechAct: "TOPIC_TRANSITION", shouldAnswer: false, confidence: 0.99, normalizedText, reason: "topic-transition-marker", topic, entities };
    if (CONTROL.test(normalizedText)) return { speechAct: "CONTROL", shouldAnswer: false, confidence: 0.99, normalizedText, reason: "interview-control", topic, entities };
    if (ACKNOWLEDGEMENT.test(normalizedText) || /^(?:那个)[。！？?！\s]*$/i.test(normalizedText)) return { speechAct: "ACKNOWLEDGEMENT", shouldAnswer: false, confidence: 0.99, normalizedText, reason: "acknowledgement", topic, entities };
    if (isStyleOnly(normalizedText) || INSTRUCTION_MODIFIER.test(normalizedText)) return { speechAct: "INSTRUCTION_MODIFIER", shouldAnswer: false, confidence: 0.97, normalizedText, reason: "instruction-modifier", topic, entities };
    if (TOPIC_ANNOUNCEMENT.test(normalizedText) && !QUESTION_FORM.test(normalizedText)) return { speechAct: "TOPIC_ANNOUNCEMENT", shouldAnswer: false, confidence: 0.96, normalizedText, reason: "topic-announcement", topic, entities };
    if (SELF_INTRODUCTION.test(normalizedText)) return { speechAct: "ANSWER_REQUEST", shouldAnswer: true, confidence: 0.98, normalizedText, reason: "self-introduction", topic, entities };
    if (CODE_CONTEXT.test(normalizedText) && !CODE_REQUEST.test(normalizedText)) return { speechAct: "TOPIC_ANCHOR", shouldAnswer: false, confidence: 0.98, normalizedText, reason: "code-context", topic: "代码题", entities, codeContext: true };
    if (CODE_REQUEST.test(normalizedText) || (context.pendingCodeContext && ALGORITHM_TASK.test(normalizedText))) return { speechAct: "CODE_REQUEST", shouldAnswer: true, confidence: 0.98, normalizedText, reason: CODE_REQUEST.test(normalizedText) ? "code-request" : "code-context-algorithm-request", topic, entities };
    if (ANSWER_REQUEST.test(normalizedText) || TRAILING_ANSWER_REQUEST.test(normalizedText)) return { speechAct: isFollowUp(normalizedText, context) ? "FOLLOW_UP" : "ANSWER_REQUEST", shouldAnswer: true, confidence: 0.96, normalizedText, reason: "answer-request", topic, entities };
    if (isFollowUp(normalizedText, context)) return { speechAct: "FOLLOW_UP", shouldAnswer: true, confidence: 0.94, normalizedText, reason: "elliptical-follow-up", topic, entities };
    if (/^(?:我|我们).*(?:说明|介绍|解释|讲一下|说一下).*[。！!]$/.test(normalizedText)) return { speechAct: "STATEMENT", shouldAnswer: false, confidence: 0.94, normalizedText, reason: "declarative-explanation", topic, entities, candidateSpeech: true };
    if (!ASSERTIVE_STATEMENT.test(normalizedText) && (hasCompleteQuestion(normalizedText) || QUESTION_FORM.test(normalizedText))) return { speechAct: "QUESTION", shouldAnswer: true, confidence: 0.94, normalizedText, reason: "interrogative-form", topic, entities };
    if (STRONG_TOPIC.test(normalizedText)) return { speechAct: "TOPIC_ANCHOR", shouldAnswer: false, confidence: 0.9, normalizedText, reason: "technical-topic-anchor", topic, entities };
    return { speechAct: "STATEMENT", shouldAnswer: false, confidence: clamp(normalizedText.length >= 8 ? 0.65 : 0.45), normalizedText, reason: "statement", topic, entities, ...(CANDIDATE_SPEECH.test(normalizedText) ? { candidateSpeech: true } : {}) };
  }
}

export function classifyInterviewSpeechAct(text: string, context: SpeechActContext = {}): SpeechActClassification {
  return new SpeechActClassifier().classify(text, context);
}
