import type { ContextAnchor, ContextAnchorSnapshot } from "./context-anchor-store";
import type { InterviewSpeechAct } from "./speech-act-classifier";

export interface ResolvedQuestionContext {
  canonicalQuestion: string;
  parentQuestion?: string;
  rootQuestion?: string;
  parentQuestionId?: string;
  rootQuestionId?: string;
  topic?: string;
  anchorUsed?: ContextAnchor;
  confidence: number;
  reason: string;
}

function trimPunctuation(text: string): string { return text.trim().replace(/[。！？?！\s]+$/g, ""); }

function isElliptical(text: string): boolean {
  const compact = text.replace(/[？?。！!，,、\s]/g, "");
  return compact.length <= 14 || /^(?:讲一下|讲讲|说一下|说说|具体|为什么|怎么|如何|用过哪些|用在什么地方|还有呢?)[？?。！!]?$/i.test(text);
}

function isCompleteStandaloneQuestion(text: string): boolean {
  const compact = text.replace(/[？?。！!，,、\s]/g, "");
  return compact.length >= 8 && /第\s*\d+\s*题|(?:什么是|为什么|为何|怎么|如何|哪些|哪种|哪个|哪里|在哪|多少|几个|几路|上限|容量|吗|呢)/.test(text);
}

function withAnchor(text: string, anchor: ContextAnchor): string {
  const topic = anchor.topic || trimPunctuation(anchor.text);
  const clean = trimPunctuation(text);
  if (/^(?:用过哪些|哪些)[？?。！!]?$/i.test(clean)) return `你用过哪些${topic}？`;
  if (/^用在什么地方[？?。！!]?$/.test(clean)) return `${topic}用在什么地方？`;
  if (/^(?:讲一下|讲讲|说一下|说说|展开讲一下|详细讲述)[？?。！!]?$/.test(clean)) return `${clean}${topic}。`;
  return `围绕${topic}，${clean}${/[？?。！!]$/.test(text) ? "" : "？"}`;
}

export class ContextAnchorResolver {
  resolve(input: { text: string; speechAct: InterviewSpeechAct; anchors: ContextAnchorSnapshot }): ResolvedQuestionContext {
    const text = input.text.trim();
    const anchors = input.anchors;
    const anchor = anchors.latestAnchor ?? anchors.lastConfirmedQuestion;
    const standalone = input.speechAct === "QUESTION" && (!isElliptical(text) || isCompleteStandaloneQuestion(text) || /第\s*\d+\s*题/.test(text));
    if (standalone || input.speechAct === "CODE_REQUEST") {
      return {
        canonicalQuestion: text,
        ...(anchors.currentTopic ? { topic: anchors.currentTopic } : {}),
        confidence: 0.96,
        reason: "standalone-complete-question"
      };
    }
    if (!anchor || input.speechAct === "QUESTION" && !anchors.currentTopic) {
      return { canonicalQuestion: text, confidence: 0.74, reason: "no-anchor-available" };
    }
    const canonicalQuestion = withAnchor(text, anchor);
    const root = anchors.lastConfirmedQuestion ?? anchor;
    return {
      canonicalQuestion,
      parentQuestion: anchor.text,
      rootQuestion: root.text,
      parentQuestionId: anchor.id,
      rootQuestionId: root.id,
      ...(anchor.topic ? { topic: anchor.topic } : {}),
      anchorUsed: anchor,
      confidence: input.speechAct === "FOLLOW_UP" ? 0.95 : 0.88,
      reason: input.speechAct === "FOLLOW_UP" ? "latest-topic-anchor-follow-up" : "answer-request-resolved-to-anchor"
    };
  }
}
