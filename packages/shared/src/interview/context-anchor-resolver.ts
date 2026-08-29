import type { ContextAnchor, ContextAnchorSnapshot } from "./context-anchor-store";
import type { InterviewSpeechAct } from "./speech-act-classifier";
import { detectTopicBoundary, hasStandaloneTopicSubject } from "./topic-boundary-detector";

export interface ResolvedQuestionContext {
  canonicalQuestion: string;
  parentQuestion?: string;
  rootQuestion?: string;
  parentQuestionId?: string;
  rootQuestionId?: string;
  topic?: string;
  inheritedTopic?: string;
  contextRelation: "standalone" | "follow_up" | "continuation" | "repair";
  anchorUsed?: ContextAnchor;
  confidence: number;
  reason: string;
}

function trimPunctuation(text: string): string { return text.trim().replace(/[。！？?！\s]+$/g, ""); }

const GENERIC_FOLLOW_UP_SUBJECT = /^(?:场景|情况|时候|原因|区别|作用|问题|地方|方式|方法|结果|影响|风险|优缺点|好处|坏处|注意事项)/;

function hasExplicitStandaloneSubject(text: string): boolean {
  const compact = text.replace(/[？?。！!，,、\s]/g, "");
  const whatMatch = compact.match(/^什么(?:是)?(.+)$/);
  if (whatMatch) {
    const subject = whatMatch[1];
    return subject.length >= 2 && !GENERIC_FOLLOW_UP_SUBJECT.test(subject);
  }
  return /^(?:请)?(?:简述|说明|解释|介绍)(?!一下$).{2,}/.test(compact);
}

function isElliptical(text: string): boolean {
  const compact = text.replace(/[？?。！!，,、\s]/g, "");
  if (hasExplicitStandaloneSubject(text)) return false;
  return /^(?:讲一下|讲讲|说一下|说说|具体|为什么|怎么|如何|用过哪些|用在什么地方|还有呢?|什么(?:场景|情况|时候|原因|区别|作用|问题|地方|方式|方法|结果|影响|风险|优缺点).*)[？?。！!]?$/i.test(text)
    || /^(?:那|然后|还有|这个|它|这里|其中|接下来|再).{0,12}$/.test(compact);
}

function isCompleteStandaloneQuestion(text: string): boolean {
  const compact = text.replace(/[？?。！!，,、\s]/g, "");
  return hasExplicitStandaloneSubject(text)
    || compact.length >= 8 && /第\s*\d+\s*题|(?:什么是|为什么|为何|怎么|如何|哪些|哪种|哪个|哪里|在哪|多少|几个|几路|上限|容量|吗|呢)/.test(text);
}

function topicFromText(text: string): string | undefined {
  return text.match(/(?:Linux|ARM|Cortex-M|C\+\+|volatile|static|const|TCP|UDP|IIC|I2C|SPI|UART|CAN(?: FD)?|FOC|SVPWM|ADC|DMA|PWM|FreeRTOS|RTOS|Flash|文件系统|堆|栈|中断|仲裁)/i)?.[0];
}

export class ContextAnchorResolver {
  resolve(input: { text: string; speechAct: InterviewSpeechAct; anchors: ContextAnchorSnapshot }): ResolvedQuestionContext {
    const text = input.text.trim();
    const anchors = input.anchors;
    const anchor = anchors.latestAnchor ?? anchors.lastConfirmedQuestion;
    const boundary = anchor ? detectTopicBoundary({ previousText: anchor.text, previousTopic: anchors.currentTopic, currentText: text }) : detectTopicBoundary({ currentText: text });
    const standalone = input.speechAct === "CODE_REQUEST"
      || hasStandaloneTopicSubject(text)
      || (input.speechAct === "QUESTION" && (!isElliptical(text) || isCompleteStandaloneQuestion(text) || /第\s*\d+\s*题/.test(text)))
      || boundary.relation === "NEW_TOPIC";
    if (standalone) {
      return {
        canonicalQuestion: text,
        contextRelation: "standalone",
        ...(topicFromText(text) ? { topic: topicFromText(text) } : {}),
        confidence: 0.96,
        reason: "standalone-complete-question"
      };
    }
    if (!anchor || input.speechAct === "QUESTION" && !anchors.currentTopic) {
      return { canonicalQuestion: text, contextRelation: "standalone", ...(topicFromText(text) ? { topic: topicFromText(text) } : {}), confidence: 0.74, reason: "no-anchor-available" };
    }
    const root = anchors.lastConfirmedQuestion ?? anchor;
    return {
      // Context is metadata. The canonical question remains the question the
      // interviewer actually said so retrieval and history cannot be polluted.
      canonicalQuestion: text,
      parentQuestion: anchor.text,
      rootQuestion: root.text,
      parentQuestionId: anchor.id,
      rootQuestionId: root.id,
      ...(anchor.topic ? { topic: anchor.topic } : {}),
      ...(anchor.topic ? { inheritedTopic: anchor.topic } : {}),
      anchorUsed: anchor,
      contextRelation: boundary.relation === "RELATED_TOPIC" ? "continuation" : "follow_up",
      confidence: input.speechAct === "FOLLOW_UP" ? 0.95 : 0.88,
      reason: input.speechAct === "FOLLOW_UP" ? `topic-${boundary.relation.toLowerCase()}-follow-up` : "answer-request-context-metadata"
    };
  }
}
