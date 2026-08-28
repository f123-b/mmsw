import type { InterviewMemorySnapshot } from "../interview-memory";
import type { QuestionAnalysis, QuestionDetectionType } from "../question";
import { routeAnswerTask } from "./router";
import type { AnswerTask, InterviewBrainDecision, QuestionEventInput } from "./types";
import { normalizeTechnicalTerms } from "../terminology";
import { hasStandaloneTopicSubject } from "../interview/topic-boundary-detector";

const ELLIPTICAL_FOLLOW_UP = /^(好|好的|嗯|嗯嗯|那好|明白了)?[，,。！!、\s]*(说说|讲讲|展开说|具体说|继续(?:说说|讲讲|展开说)?|然后呢|还有吗|再说说|再讲讲|怎么说|为什么呢|怎么做呢)[。！？?！\s]*$/i;
const CONTEXTUAL_FOLLOW_UP = /^(那|然后|还有|具体|如果|再|这个|它|这里|其中|为什么|怎么|如何)/;
const META_REPAIR_ONLY = /^(?:你觉得(?:呢)?|怎么(?:回答|答|说)|答案(?:是什么|呢))[。！？?！\s]*$/i;
const ACK_ONLY = /^(?:好|好的|那|嗯+|呃+|啊+|哦+|对|明白了?|知道了?|行|可以)[。！？?！\s，,、]*$/i;

function normalize(text: string): string { return normalizeTechnicalTerms(text); }

function trailingFollowUp(text: string): string {
  const match = text.match(/(?:^|[。！？?！；;]\s*|\s+)(好|好的|嗯|嗯嗯|那好)?[，,。！!、\s]*(说说|讲讲|展开说|具体说|继续(?:说说|讲讲|展开说)?|然后呢|还有吗|再说说|再讲讲|怎么说|为什么呢|怎么做呢)[。！？?！\s]*$/i);
  return match ? normalize(match[0]) : text;
}

function inferType(text: string, fallback: QuestionDetectionType): AnswerTask["type"] {
  if (fallback === "behavior") return "behavior";
  if (fallback === "project") return "project";
  if (fallback === "follow_up") return "follow_up";
  if (/项目|负责|主导|经历|落地|做过/.test(text)) return "project";
  if (/团队|冲突|压力|困难|失败|沟通|决策/.test(text)) return "behavior";
  return "technical";
}

function memoryContext(memory: InterviewMemorySnapshot, recentTranscript: string[] = []): string[] {
  const lastTurns = memory.turns.slice(-4).flatMap((turn) => [`问题：${turn.question}`, ...(turn.answer ? [`回答：${turn.answer}`] : [])]);
  return [...lastTurns, ...recentTranscript.slice(-4)].filter(Boolean);
}

function parentQuestion(memory: InterviewMemorySnapshot): string | undefined {
  // pendingQuestion is preferred while the previous answer is still being
  // completed. Once the answer is recorded, the latest turn remains the best
  // parent for short follow-ups such as “怎么验证？” or “为什么呢？”。
  return memory.pendingQuestion?.trim() || memory.turns.at(-1)?.question?.trim();
}

export class InterviewBrain {
  analyze(input: QuestionEventInput): InterviewBrainDecision {
    const text = normalize(input.text);
    const topic = input.memory.currentTopic;
    const tail = trailingFollowUp(text);
    if (META_REPAIR_ONLY.test(text)) {
      return { isQuestion: false, type: "not_question", confidence: input.analysis?.confidence ?? 0, normalizedQuestion: text, reason: "meta-repair-prompt" };
    }
    if (ACK_ONLY.test(text)) return { isQuestion: false, type: "not_question", confidence: input.analysis?.confidence ?? 0, normalizedQuestion: text, reason: "standalone-acknowledgement" };
    const implicitFollowUp = Boolean(topic && !hasStandaloneTopicSubject(text) && (ELLIPTICAL_FOLLOW_UP.test(tail) || CONTEXTUAL_FOLLOW_UP.test(tail) && tail.length <= 18));
    const analysis = input.analysis;
    const isQuestion = implicitFollowUp || Boolean(analysis?.isQuestion);
    if (!isQuestion) return { isQuestion: false, type: "not_question", confidence: analysis?.confidence ?? 0, normalizedQuestion: text, reason: analysis?.reason ?? "not-question" };
    const type = implicitFollowUp ? "follow_up" : analysis?.type ?? "technical";
    const parent = implicitFollowUp ? parentQuestion(input.memory) : undefined;
    const normalizedQuestion = analysis?.normalizedQuestion || text;
    const answerTask = routeAnswerTask({ question: normalizedQuestion, type: inferType(normalizedQuestion, type), topic, context: memoryContext(input.memory, input.recentTranscript) });
    return { isQuestion: true, type, confidence: Math.max(analysis?.confidence ?? 0, implicitFollowUp ? 0.86 : 0), normalizedQuestion, reason: implicitFollowUp ? parent ? "implicit-follow-up-with-parent" : "implicit-follow-up-with-topic" : analysis?.reason ?? "question-analysis", contextRelation: analysis?.contextRelation ?? (implicitFollowUp ? "follow_up" : "standalone"), inheritedTopic: analysis?.inheritedTopic ?? (implicitFollowUp ? topic : undefined), answerTask };
  }
}

export type { AnswerTask } from "./types";
