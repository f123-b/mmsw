import type { InterviewMemorySnapshot } from "../interview-memory";
import type { QuestionAnalysis, QuestionDetectionType } from "../question";
import { routeAnswerTask } from "./router";
import type { AnswerTask, InterviewBrainDecision, QuestionEventInput } from "./types";

const ELLIPTICAL_FOLLOW_UP = /^(好|好的|嗯|嗯嗯|那好|明白了)?[，,。！!、\s]*(说说|讲讲|展开说|具体说|继续(?:说说|讲讲|展开说)?|然后呢|还有吗|再说说|再讲讲|怎么说|为什么呢|怎么做呢)[。！？?！\s]*$/i;
const CONTEXTUAL_FOLLOW_UP = /^(那|然后|还有|具体|如果|再|这个|它|这里|其中|为什么|怎么|如何)/;

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }

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

export class InterviewBrain {
  analyze(input: QuestionEventInput): InterviewBrainDecision {
    const text = normalize(input.text);
    const topic = input.memory.currentTopic;
    const tail = trailingFollowUp(text);
    const implicitFollowUp = Boolean(topic && (ELLIPTICAL_FOLLOW_UP.test(tail) || CONTEXTUAL_FOLLOW_UP.test(tail) && tail.length <= 18));
    const analysis = input.analysis;
    const isQuestion = implicitFollowUp || Boolean(analysis?.isQuestion);
    if (!isQuestion) return { isQuestion: false, type: "not_question", confidence: analysis?.confidence ?? 0, normalizedQuestion: text, reason: analysis?.reason ?? "not-question" };
    const type = implicitFollowUp ? "follow_up" : analysis?.type ?? "technical";
    const normalizedQuestion = implicitFollowUp && topic ? `围绕${topic}，${tail}` : analysis?.normalizedQuestion || text;
    const answerTask = routeAnswerTask({ question: normalizedQuestion, type: inferType(normalizedQuestion, type), topic, context: memoryContext(input.memory, input.recentTranscript) });
    return { isQuestion: true, type, confidence: Math.max(analysis?.confidence ?? 0, implicitFollowUp ? 0.86 : 0), normalizedQuestion, reason: implicitFollowUp ? "implicit-follow-up-with-topic" : analysis?.reason ?? "question-analysis", answerTask };
  }
}

export type { AnswerTask } from "./types";
