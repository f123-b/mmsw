export type QuestionCategory = "technical" | "project" | "behavioral" | "followup";

export interface QuestionClassification {
  isQuestion: boolean;
  confidence: number;
  category: QuestionCategory;
  questionText: string;
  reason: string;
}

const STRONG_PROMPTS = [
  /为什么|为何/,
  /怎么|如何|怎样/,
  /能不能|可不可以|是否|有没有/,
  /请问|请解释|请说明|请讲|介绍一下|介绍下|说一下|说说|讲一下|讲讲|解释一下|说明一下|展开|展开说/,
  /什么.*区别|区别.*什么|原理|流程/,
  /遇到什么问题|如何解决|怎么解决/,
  /有什么优势|有什么缺点|优点.*缺点|为什么这么做/,
  /如果.*(重新|换成|改成|设计)|会怎么优化|怎么优化/
];

const TECHNICAL_TERMS = /原理|实现|架构|设计|算法|代码|接口|并发|线程|性能|内存|网络|数据库|协议|模块|低速|抖动|优化|技术栈|部署|测试|故障/;
const PROJECT_TERMS = /项目|方案|产品|业务|需求|功能|负责|做过|选择|落地|交付|结果/;
const BEHAVIORAL_TERMS = /团队|沟通|冲突|压力|挑战|困难|问题|失败|优势|缺点|成长|协作|领导|决策/;
const FOLLOWUP_TERMS = /那|那么|如果|继续|再|还有|具体|为什么|怎么|如何|然后/;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function questionFingerprint(text: string): string {
  return normalize(text).toLowerCase().replace(/[\s，。！？、,.!?；;：:"“”‘’（）()【】\[\]{}<>]/g, "").slice(0, 240);
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

  const hasQuestionMark = /[？?]$/.test(normalized);
  const strongPrompt = STRONG_PROMPTS.some((pattern) => pattern.test(normalized));
  const hasSecondPersonOrTarget = /你|您的|项目|方案|系统|这个/.test(normalized);
  const hasQuestionLabel = /(?:问题|题目)\s*[:：]/.test(normalized);
  const isContextualFollowup = FOLLOWUP_TERMS.test(normalized) && context.length > normalized.length && (hasSecondPersonOrTarget || normalized.length <= 8);
  const reasons: string[] = [];
  let confidence = 0;
  if (hasQuestionMark) { confidence += 0.42; reasons.push("question-mark"); }
  if (strongPrompt) { confidence += 0.42; reasons.push("semantic-prompt"); }
  if (hasSecondPersonOrTarget) { confidence += 0.08; reasons.push("interview-target"); }
  if (hasQuestionLabel) { confidence += 0.72; reasons.push("explicit-question-label"); }
  if (isContextualFollowup) { confidence += 0.12; reasons.push("context-followup"); }
  if (final) { confidence += 0.08; reasons.push("final-transcript"); }
  if (normalized.length >= 8) confidence += 0.04;
  confidence = Math.min(0.99, confidence);

  const isQuestion =
    (hasQuestionMark && (strongPrompt || hasSecondPersonOrTarget || normalized.length >= 6)) ||
    (strongPrompt && (hasSecondPersonOrTarget || normalized.length >= 6)) ||
    hasQuestionLabel ||
    isContextualFollowup;
  return {
    isQuestion,
    confidence,
    category: categoryFor(normalized),
    questionText: normalized,
    reason: reasons.length ? reasons.join("+") : "no-question-signal"
  };
}
