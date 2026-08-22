import { normalizeTechnicalTerms } from "./terminology";

export type QuestionCategory = "technical" | "project" | "behavioral" | "followup";

export interface QuestionClassification {
  isQuestion: boolean;
  confidence: number;
  category: QuestionCategory;
  questionText: string;
  reason: string;
}

// Keep topic words (原理、流程、优化、设计) separate from actual speech
// acts. A statement such as “我先说明一下原理” must not become a question
// only because it contains a technical topic.
const QUESTION_FORMS = [
  /为什么|为何|怎么|如何|怎样|怎么看|怎么判断|怎么做/,
  /什么是|什么|哪些|哪种|哪一类|哪个|哪里|谁|有什么|有没有|是否|能否|能不能|可不可以/,
  /(?:^|[，,、\s])(?:请问|请(?:介绍|解释|说明|讲|说)|介绍一下|介绍下|说一下|说说|讲一下|讲讲|解释一下|说明一下|展开说|具体说)|你(?:能|可以)?(?:介绍|讲|说|解释|说明)/,
  /遇到什么问题|如何解决|怎么解决|怎么验证|先看什么|为什么这么做/,
  /如果.*(重新|换成|改成|设计)|会怎么优化|怎么优化/
];

const TECHNICAL_TERMS = /原理|实现|架构|设计|算法|代码|接口|并发|线程|性能|内存|网络|数据库|协议|模块|低速|抖动|优化|技术栈|部署|测试|故障/;
const PROJECT_TERMS = /项目|方案|产品|业务|需求|功能|负责|做过|选择|落地|交付|结果/;
const BEHAVIORAL_TERMS = /团队|沟通|冲突|压力|挑战|困难|问题|失败|优势|缺点|成长|协作|领导|决策/;
const FOLLOWUP_TERMS = /那|那么|如果|继续|再|还有|具体|为什么|怎么|如何|然后/;
const CONTEXTUAL_FOLLOWUP = /^(?:好|好的|嗯+|明白了?|对)[，,、\s]*(?:说说|讲讲|展开(?:说)?|具体(?:说)?|再说说|再讲讲|为什么呢|怎么做呢|然后呢|还有吗)/i;
const BARE_CONTINUATION = /^(?:(?:好|好的|嗯+|明白了?|对)[，,、\s]*)?(?:继续|然后|再见|下一个|换个问题|换一个问题)[。！？?！\s]*$/i;
const CONTROL_SPEECH = /^(?:(?:好|好的|行|可以|嗯+|那)[，,、\s]*)?(?:下一个问题|下一题|换一个问题|换个问题|再来一个(?:问题)?|接下来(?:问)?)(?:[，,、].*)?[。！？?！\s，,、]*$/i;
const INSTRUCTION_SPEECH = /^(?:(?:好|好的|行|可以|嗯+)[，,、\s]*)?(?:尽量|最好|请尽量|控制在|用.{0,8}(?:秒|分钟)|给个.{0,14}(?:例子|路径|思路|排查路径)|简单(?:说|讲)|简短(?:一点)?|讲清楚|说清楚|结合(?:你|自己的)?项目|用你项目里的例子)/i;

function normalize(text: string): string {
  return normalizeTechnicalTerms(text);
}

export function questionFingerprint(text: string): string {
  return normalize(text).toLowerCase().replace(/[\s，。！？、,.!?；;：:"“”‘’（）()【】\[\]{}<>]/g, "").slice(0, 240);
}

export function classifyNonQuestionSpeechAct(text: string): "INSTRUCTION" | "CONTROL" | undefined {
  const normalized = normalize(text);
  if (CONTROL_SPEECH.test(normalized)) return "CONTROL";
  // A sentence that explicitly asks “怎么/为什么/什么” remains a question;
  // otherwise these are interview constraints, not answerable questions.
  if (INSTRUCTION_SPEECH.test(normalized) && !/[？?]$/.test(normalized) && !/为什么|为何|什么|怎么|如何|是否/.test(normalized)) return "INSTRUCTION";
  return undefined;
}

function categoryFor(text: string): QuestionCategory {
  if (BEHAVIORAL_TERMS.test(text) && /你|团队|遇到|挑战|冲突|压力|优势|缺点/.test(text)) return "behavioral";
  if (TECHNICAL_TERMS.test(text)) return "technical";
  if (FOLLOWUP_TERMS.test(text) && (/那|如果|继续|再|还有|具体/.test(text) || text.length < 18)) return "followup";
  if (PROJECT_TERMS.test(text)) return "project";
  return "project";
}

/**
 * Low-latency semantic question classification. This intentionally stays
 * local and deterministic: it combines speech-act patterns, context signals
 * and interview vocabulary instead of calling an LLM from the ASR hot path.
 */
export function classifyQuestion(text: string, contextText = "", final = false): QuestionClassification {
  const normalized = normalize(text);
  const context = normalize(contextText);
  if (!normalized) return { isQuestion: false, confidence: 0, category: "project", questionText: "", reason: "empty" };
  const nonQuestionAct = classifyNonQuestionSpeechAct(normalized);
  if (nonQuestionAct) return { isQuestion: false, confidence: 0, category: "followup", questionText: normalized, reason: nonQuestionAct === "CONTROL" ? "control-speech" : "answer-instruction" };

  const hasQuestionMark = /[？?]$/.test(normalized);
  const questionForm = QUESTION_FORMS.some((pattern) => pattern.test(normalized));
  const hasSecondPersonOrTarget = /你|您的|项目|方案|系统|这个/.test(normalized);
  const hasQuestionLabel = /(?:问题|题目)\s*[:：]/.test(normalized);
  const hasTrailingQuestionParticle = /(吗|呢)[。！？?！\s]*$/i.test(normalized);
  const hasContextQuestion = /[？?]|为什么|为何|怎么|如何|怎样|什么|哪些|哪种|是否|有没有|请问|请(?:介绍|解释|说明)/.test(context);
  const isContextualFollowup = !BARE_CONTINUATION.test(normalized)
    && context.length > normalized.length
    && hasContextQuestion
    && (CONTEXTUAL_FOLLOWUP.test(normalized) || (FOLLOWUP_TERMS.test(normalized) && normalized.length <= 12));
  const isBareContinuation = BARE_CONTINUATION.test(normalized);
  const reasons: string[] = [];
  let confidence = 0;
  if (hasQuestionMark) { confidence += 0.25; reasons.push("question-mark"); }
  if (hasTrailingQuestionParticle) { confidence += 0.25; reasons.push("question-particle"); }
  if (questionForm) { confidence += 0.42; reasons.push("interrogative-form"); }
  if (hasSecondPersonOrTarget) { confidence += 0.08; reasons.push("interview-target"); }
  if (hasQuestionLabel) { confidence += 0.72; reasons.push("explicit-question-label"); }
  if (isContextualFollowup) { confidence += 0.18; reasons.push("context-followup"); }
  if (final) { confidence += 0.08; reasons.push("final-transcript"); }
  if (normalized.length >= 8) confidence += 0.04;
  if (isBareContinuation) reasons.push("bare-continuation");
  confidence = Math.min(0.99, confidence);

  const isQuestion =
    !isBareContinuation && (
      hasQuestionLabel ||
      hasTrailingQuestionParticle ||
      (questionForm && (hasSecondPersonOrTarget || normalized.length >= 6)) ||
      (hasQuestionMark && (questionForm || hasSecondPersonOrTarget || normalized.length >= 6)) ||
      isContextualFollowup
    );
  return {
    isQuestion,
    confidence,
    category: categoryFor(normalized),
    questionText: normalized,
    reason: reasons.length ? reasons.join("+") : "no-question-signal"
  };
}
