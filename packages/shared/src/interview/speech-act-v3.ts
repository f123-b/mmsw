import type { QuestionFrameSpeechAct } from "./question-frame";
import { cleanQuestionDiscourse, spokenEntities } from "./question-subject";

export interface SpeechActV3Result {
  speechAct: QuestionFrameSpeechAct;
  confidence: number;
  shouldAnswer: boolean;
  reason: string;
}

const CONFIRMATION = /(?:懂我意思吗|对吧|明白吧|懂吧|知道我说什么吧|是不是这样|可以吧)[。！？?！\s]*$/iu;
const BACKCHANNEL = /^(?:嗯+|呃+|啊+|哦+|好+|好的|对|明白了?|知道了?|可以|行|嗯嗯)[。！？?！\s，,、]*$/iu;
const CONTROL = /^(?:(?:好|好的|行|可以|嗯+|那)[，,、\s]*)?(?:你继续|那你继续|继续|暂停|停止|开始|先这样)[。！？?！\s，,、]*$/iu;
const TOPIC_TRANSITION = /^(?:(?:好|好的|那|下面|接下来|我们先聊)[，,、\s]*)?(?:下一个问题|下个问题|下一题|换个话题|换个方向|再来一个问题|另一个问题|下面聊(?:一下)?(?:RTOS|Linux|CAN|DMA|FOC)?)[。！？?！\s，,、]*$/iu;
const ADVICE = /(?:自己去写吧|回去准备(?:一下)?|自己准备(?:一下)?|你可以回去|建议你|反正就是准备好|不用回答|就这样准备)/iu;
const FEEDBACK = /(?:我觉得|其实没什么特别|你说得对|这个回答不错|差不多就是|没问题)/iu;
const RHETORICAL = /^(?:你懂不懂|这还用说|这不是很明显)[？?。！!\s]*$/iu;
const UNRESOLVED = /(?:嗯+，?然后我最近也是|那什么事|我后来遇到的话|不知道在说什么)/iu;
const EXPLANATION = /(?:interrupt|exception|stack|nesting|hardware\s+stacking|中断|异常|嵌套|硬件压栈)/iu;
const FOLLOW_UP = /^(?:那|然后|还有|具体|如果|再|这个|它|这里|其中|刚才那个|前面那个|多久|为什么这么做|那这个呢)/iu;
const QUESTION = /(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|哪里|是否|有没有|能不能|可不可以|多少|几个|多久|吗|呢|区别|原理|作用|原因|介绍|解释|说明|讲一下|讲一讲|说一下|说说)/iu;

/** V3 speech act classification runs before question detection. */
export function classifySpeechActV3(text: string, hasContext = false): SpeechActV3Result {
  const value = cleanQuestionDiscourse(text.replace(/\s+/g, " "));
  if (!value) return { speechAct: "FILLER", confidence: 1, shouldAnswer: false, reason: "empty" };
  if (CONFIRMATION.test(value)) return { speechAct: "CONFIRMATION_CHECK", confidence: 0.99, shouldAnswer: false, reason: "confirmation-check" };
  if (BACKCHANNEL.test(value)) return { speechAct: "BACKCHANNEL", confidence: 0.99, shouldAnswer: false, reason: "backchannel" };
  if (CONTROL.test(value)) return { speechAct: "CONTROL", confidence: 0.99, shouldAnswer: false, reason: "conversation-control" };
  if (TOPIC_TRANSITION.test(value)) return { speechAct: "TOPIC_TRANSITION", confidence: 0.99, shouldAnswer: false, reason: "topic-transition" };
  if (ADVICE.test(value)) return { speechAct: "ADVICE", confidence: 0.98, shouldAnswer: false, reason: "advice" };
  if (FEEDBACK.test(value)) return { speechAct: "FEEDBACK", confidence: 0.9, shouldAnswer: false, reason: "feedback" };
  if (RHETORICAL.test(value)) return { speechAct: "RHETORICAL", confidence: 0.96, shouldAnswer: false, reason: "rhetorical" };
  if (UNRESOLVED.test(value)) return { speechAct: "ASR_UNRESOLVED", confidence: 0.98, shouldAnswer: false, reason: "unresolved-asr-pattern" };
  if (/(?:他|HR).{0,12}怎么通知你.{0,30}(?:就|会).{0,12}通知你/u.test(value)) return { speechAct: "EXPLANATION", confidence: 0.97, shouldAnswer: false, reason: "interviewer-process-explanation" };
  if (/(?:没什么(?:建议|问题|特别)|我们(?:主要是|是做|都有自己的))/.test(value)
    && !/(?:你|您).{0,12}(?:怎么|如何|什么|吗|呢)/u.test(value)) return { speechAct: "EXPLANATION", confidence: 0.96, shouldAnswer: false, reason: "interviewer-explanation" };
  if (QUESTION.test(value)) {
    const followUp = hasContext && !spokenEntities(value).length && !/自我介绍|你这边.*(?:问题|了解)|对我们.*了解/u.test(value) && FOLLOW_UP.test(value);
    return { speechAct: followUp ? "FOLLOW_UP" : "QUESTION", confidence: followUp ? 0.93 : 0.95, shouldAnswer: true, reason: followUp ? "contextual-follow-up" : "interrogative-content" };
  }
  if (EXPLANATION.test(value)) return { speechAct: "EXPLANATION", confidence: 0.88, shouldAnswer: false, reason: "technical-explanation-anchor" };
  return { speechAct: "EXPLANATION", confidence: 0.72, shouldAnswer: false, reason: "non-interrogative-explanation" };
}
