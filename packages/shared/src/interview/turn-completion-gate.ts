import { isDanglingQuestionTail, isOpenPredicate, isStyleOnly } from "./semantic-answerability";

export type TurnCompletionState = "complete" | "incomplete" | "topic_announcement" | "instruction_modifier" | "filler" | "ambiguous";

export interface TurnCompletionDecision {
  state: TurnCompletionState;
  confidence: number;
  reason: string;
  recommendedWaitMs: number;
}

export interface TurnCompletionContext {
  previousText?: string;
  currentTopic?: string;
  /** Provider/VAD explicitly marked the speech item as ended. */
  asrEndpoint?: boolean;
}

const FILLER = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|可以|行|那个|然后)[。！？?！\s，,、]*$/iu;
const TOPIC_ANNOUNCEMENT = /^(?:(?:(?:下面聊(?:一下)?|接下来问一个|继续问一个|我们先聊(?:一下)?|先聊(?:一下)?|再聊(?:一下)?|我换个(?:更底层的)?|换个(?:话题|方向)?)(?:\s*(?:RTOS|FreeRTOS|C\+\+基础|底层驱动|通信协议|系统设计|项目经验|异常恢复|CAN|UART|DMA|FOC)(?:这个|相关)?(?:话题|部分|问题)?|(?:更?底层|技术|方向)?(?:的)?(?:话题|问题)?))|(?:RTOS|FreeRTOS|C\+\+基础|底层驱动|通信协议|系统设计|项目经验|异常恢复|CAN|UART|DMA|FOC)(?:这个|相关)?(?:话题|部分|问题)?)[。！？?！\s，,、]*$/iu;
const INSTRUCTION_MODIFIER = /^(?!.*(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|哪一个|是否|有没有|吗|呢|[？?]))(?:请你|请)?(?:(?:重点|着重)(?:讲|说|说明|展开)(?:一下|一点)?(?:\s*[^\n。！？?！]{0,30})?|展开一点|具体一点|(?:简单|大概)(?:说|讲)(?:说|一下|讲一下)?(?:思路)?(?:就行|即可)?|说重点|不用展开|简短(?:一点|说一下)?|控制在\s*\d+\s*(?:秒|分钟)|结合项目(?:说|讲)|只讲)(?:[。！？?！\s，,、]*)$/iu;
const INCOMPLETE_TAIL = /(?:如果|若|假设|当|在|对于|针对|关于|比如|例如|包括|以及|并且|而且|尤其|问题是|最后|然后|或者|或|和|与|跟|的|导致|影响|决定|复现|条件|情况下|时)[。！？?！；;，,、\s]*$/iu;
const INCOMPLETE_SENTENCE = /(?:持有(?:互斥锁|锁)|网络断开或设备重启|出现偶发死机|没有复现条件|存在竞争条件|发生异常|遇到故障)[。！？?！；;，,、\s]*$/iu;
const QUESTION_FORM = /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|是否|有没有|能不能|可不可以|多少|几个|吗|呢|请解释|请说明|请介绍)/iu;
const CONDITIONAL_OPEN = /^(?:如果|假设|若|要是|当)\s*[^。！？?！]*$/iu;

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

/**
 * Decides whether a final ASR segment is safe to hand to question detection.
 * Punctuation is only one signal: conditional/setup clauses remain open even
 * when ASR inserts a full stop at the segment boundary.
 */
export function decideTurnCompletion(text: string, context: TurnCompletionContext = {}): TurnCompletionDecision {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || FILLER.test(normalized)) return { state: "filler", confidence: 0.99, reason: "filler-only", recommendedWaitMs: 140 };
  if (isStyleOnly(normalized) || INSTRUCTION_MODIFIER.test(normalized)) return { state: "instruction_modifier", confidence: 0.97, reason: "instruction-modifier", recommendedWaitMs: 260 };
  if (TOPIC_ANNOUNCEMENT.test(normalized) && !QUESTION_FORM.test(normalized)) return { state: "topic_announcement", confidence: 0.96, reason: "topic-announcement", recommendedWaitMs: 180 };
  if (CONDITIONAL_OPEN.test(normalized) && !/(?:怎么|如何|怎样|怎么办|会不会|是否|能不能|可不可以|吗|呢|[？?])/iu.test(normalized)) return { state: "incomplete", confidence: 0.94, reason: "conditional-clause-open", recommendedWaitMs: 760 };
  if (isOpenPredicate(normalized) || isDanglingQuestionTail(normalized)) return { state: "incomplete", confidence: 0.96, reason: "dangling-question-tail", recommendedWaitMs: 1_200 };
  // A terminal question mark closes the semantic turn even when the final
  // Chinese character also matches a generic open-tail heuristic (for
  // example, “是干什么的？”).
  if (QUESTION_FORM.test(normalized) || /[？?]$/.test(normalized)) return { state: "complete", confidence: 0.96, reason: context.asrEndpoint ? "explicit-question-endpoint" : "explicit-question", recommendedWaitMs: context.asrEndpoint ? 0 : 140 };
  if (INCOMPLETE_TAIL.test(normalized) || INCOMPLETE_SENTENCE.test(normalized)) return { state: "incomplete", confidence: 0.94, reason: "semantic-clause-open", recommendedWaitMs: 620 };
  if (context.previousText && /(?:如果|若|假设|在|关于|针对|比如|包括|以及|并且|而且|尤其)[。！？?！；;，,、\s]*$/u.test(context.previousText)) {
    return { state: "incomplete", confidence: 0.88, reason: "previous-clause-open", recommendedWaitMs: 620 };
  }
  if (/[。！？!；;]$/.test(normalized)) return { state: "complete", confidence: 0.82, reason: context.asrEndpoint ? "terminal-punctuation-endpoint" : "terminal-punctuation", recommendedWaitMs: context.asrEndpoint ? 0 : 180 };
  return { state: "ambiguous", confidence: clamp(normalized.length >= 8 ? 0.66 : 0.48), reason: context.asrEndpoint ? "ambiguous-endpoint" : "no-semantic-boundary", recommendedWaitMs: context.asrEndpoint ? 80 : 260 };
}

export class TurnCompletionGate {
  decide(text: string, context: TurnCompletionContext = {}): TurnCompletionDecision {
    return decideTurnCompletion(text, context);
  }
}
