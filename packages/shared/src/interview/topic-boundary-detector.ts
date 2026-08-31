import { normalizeTechnicalTerms } from "../terminology";

export type TopicBoundaryRelation = "SAME_TOPIC" | "RELATED_TOPIC" | "NEW_TOPIC" | "AMBIGUOUS";

export interface TopicBoundaryDecision {
  relation: TopicBoundaryRelation;
  confidence: number;
  previousEntities: string[];
  currentEntities: string[];
  reason: string;
}

/** Stable entities used only for topic-boundary decisions, not as a question classifier. */
export const TECHNICAL_TOPIC_ENTITIES = [
  "Linux 文件系统", "Linux", "ARM", "Cortex-M", "Cortex-A", "Cortex-R", "C++", "C语言", "volatile", "static", "const", "virtual",
  "TCP", "UDP", "HTTP", "MQTT", "IIC", "I2C", "SPI", "UART", "CAN FD", "CAN", "LIN", "FOC", "SVPWM", "Clarke", "Park",
  "ADC", "DMA", "PWM", "GPIO", "NVIC", "HardFault", "FreeRTOS", "RTOS", "Flash", "EEPROM", "文件系统", "堆", "栈", "链表",
  "中断", "实时采样", "电流环", "速度环", "仲裁", "架构"
] as const;

const EXPLICIT_TOPIC_SWITCH = /^(?:换个话题|换一个话题|另一个问题|下一个问题|接下来问|再问一个|说到另一个)/;
const FOLLOW_UP_PREFIX = /^(?:那|那么|然后|还有|这个|它|这里|其中|接下来|再|具体|如果|假如|对于这个|针对这个)/;
const GENERIC_FOLLOW_UP = /^(?:为什么|为何|怎么|如何|具体(?:呢)?|还有(?:呢|吗)?|然后呢|用过哪些|用在什么地方|哪几个|哪种|仲裁呢?|采样呢?|它呢?|你会关注哪些点|考虑哪些可能性|有哪些可能性|快速排查清单|给(?:个|一份)?(?:快速)?(?:排查|检查)(?:清单|步骤)|简单比较(?:一下)?|简单对比(?:一下)?|对比一下|具体细节)[？?。！!\s]*$/iu;
const CONTEXTUAL_WHY_FOLLOW_UP = /^(?:为什么|为何|怎么|如何|怎样)\s*(?:这样|这么|这种|这个|那个|它|此)/iu;
const ANSWER_REQUEST_WITH_SUBJECT = /^(?:请)?(?:口述|描述|介绍(?:一下)?|详细介绍|讲一下|讲讲|讲述|说一下|说说|说明(?:一下)?|解释(?:一下)?|展开讲一下|展开说|列举一下|总结一下|分析一下)\s*(?:你对)?(.{2,})[？?。！!]?$/iu;
const QUESTION_WITH_SUBJECT = /^(?:什么是|什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|区别|原理|作用|原因|流程|介绍|解释|说明)\s*(.{2,})[？?。！!]?$/iu;

function compact(text: string): string {
  return normalizeTechnicalTerms(text).replace(/[\s，。！？、,.!?；;：:"“”‘’（）()\[\]{}]/g, "").toLowerCase();
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractTopicEntities(text: string): string[] {
  const normalized = normalizeTechnicalTerms(text);
  return TECHNICAL_TOPIC_ENTITIES.filter((entity) => new RegExp(escaped(entity), "iu").test(normalized)).map(String);
}

export function hasStandaloneTopicSubject(text: string): boolean {
  const normalized = normalizeTechnicalTerms(text).trim();
  if (!normalized || FOLLOW_UP_PREFIX.test(normalized)) return false;
  if (GENERIC_FOLLOW_UP.test(normalized) || /^(?:为什么|为何|怎么|如何|怎样)\s*(?:这样|这么|这种|这个|那个|它|呢|吗)/i.test(normalized)) return false;
  const hasExplicitQuestionSubject = QUESTION_WITH_SUBJECT.test(normalized) || ANSWER_REQUEST_WITH_SUBJECT.test(normalized);
  if (hasExplicitQuestionSubject) {
    const subject = normalized.replace(/^(?:什么是|什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|区别|原理|作用|原因|流程|介绍|解释|说明|请)?\s*/iu, "");
    if (/^(?:场景|情况|时候|原因|区别|作用|问题|地方|方式|方法|结果|影响|风险|优缺点|好处|坏处|注意事项|验证|定位|排查|解决|设计|实现|优化|使用|选择|配置|判断|确认|处理|分析|说明|哪些点|哪些方面|可能性|清单|细节)/.test(subject)) return false;
  }
  return hasExplicitQuestionSubject || extractTopicEntities(normalized).length > 0 && normalized.replace(/[\s，。！？?！]/g, "").length >= 4;
}

function lexicalOverlap(left: string, right: string): number {
  const leftTokens = new Set(compact(left).match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []);
  const rightTokens = new Set(compact(right).match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? []);
  if (!leftTokens.size || !rightTokens.size) return 0;
  return [...leftTokens].filter((token) => rightTokens.has(token)).length / Math.max(1, Math.min(leftTokens.size, rightTokens.size));
}

/**
 * Decides whether a new turn can inherit the prior topic. Complete technical
 * subjects are boundaries even when the speech-act classifier calls them an
 * answer request.
 */
export function detectTopicBoundary(input: { previousText?: string; previousTopic?: string; currentText: string; currentTopic?: string }): TopicBoundaryDecision {
  const previousEntities = extractTopicEntities(`${input.previousTopic ?? ""} ${input.previousText ?? ""}`);
  // The current turn must be judged from what was actually said now. Mixing
  // the active topic into currentEntities makes every new question appear to
  // overlap with the previous topic and silently leaks context.
  const currentEntities = extractTopicEntities(input.currentText);
  const current = normalizeTechnicalTerms(input.currentText).trim();
  if (!input.previousText && !input.previousTopic) {
    return { relation: currentEntities.length || hasStandaloneTopicSubject(current) ? "NEW_TOPIC" : "AMBIGUOUS", confidence: currentEntities.length ? 0.96 : 0.52, previousEntities, currentEntities, reason: "no-previous-topic" };
  }
  if (EXPLICIT_TOPIC_SWITCH.test(current)) return { relation: "NEW_TOPIC", confidence: 0.99, previousEntities, currentEntities, reason: "explicit-topic-switch" };
  const overlap = currentEntities.filter((entity) => previousEntities.includes(entity));
  if (currentEntities.length > 0 && overlap.length === 0 && hasStandaloneTopicSubject(current)) {
    return { relation: "NEW_TOPIC", confidence: 0.98, previousEntities, currentEntities, reason: "standalone-entity-without-overlap" };
  }
  if (overlap.length > 0 && currentEntities.length === overlap.length) {
    return { relation: "SAME_TOPIC", confidence: 0.96, previousEntities, currentEntities, reason: "entity-overlap-only" };
  }
  if (overlap.length > 0) return { relation: "RELATED_TOPIC", confidence: 0.88, previousEntities, currentEntities, reason: "entity-overlap-with-new-detail" };
  if (GENERIC_FOLLOW_UP.test(current) || CONTEXTUAL_WHY_FOLLOW_UP.test(current) || FOLLOW_UP_PREFIX.test(current) || lexicalOverlap(input.previousText ?? "", current) >= 0.42) {
    return { relation: "SAME_TOPIC", confidence: 0.82, previousEntities, currentEntities, reason: "elliptical-or-lexical-follow-up" };
  }
  if (hasStandaloneTopicSubject(current)) return { relation: "NEW_TOPIC", confidence: 0.9, previousEntities, currentEntities, reason: "complete-standalone-subject" };
  return { relation: "AMBIGUOUS", confidence: 0.5, previousEntities, currentEntities, reason: "insufficient-topic-signal" };
}
