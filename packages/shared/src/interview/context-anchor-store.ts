import type { InterviewMemorySnapshot } from "../interview-memory";
import type { InterviewSpeechAct } from "./speech-act-classifier";

export type ContextAnchorSpeechAct = "TOPIC_ANCHOR" | "QUESTION" | "CODE_CONTEXT";

export interface ContextAnchor {
  id: string;
  text: string;
  normalizedText: string;
  topic?: string;
  entities: string[];
  speechAct: ContextAnchorSpeechAct;
  createdAt: number;
  expiresAt: number;
  confidence: number;
}

export interface PendingTopicAnchor {
  topic: string;
  sourceText: string;
  confidence: number;
  createdAt: number;
  expiresAt: number;
}

export interface ContextAnchorSnapshot {
  latestAnchor?: ContextAnchor;
  lastConfirmedQuestion?: ContextAnchor;
  currentTopic?: string;
  currentTopicAnchor?: { topic: string; sourceAnchorId: string; createdAt: number; expiresAt: number };
  pendingTopicAnchor?: PendingTopicAnchor;
  pendingCodeContext?: ContextAnchor;
  anchors: ContextAnchor[];
}

function normalize(text: string): string { return text.replace(/\s+/g, " ").trim(); }

function inferTopic(text: string): string | undefined {
  const entities = ["反转链表", "内存泄漏", "内存溢出", "内存管理", "C语言", "STL", "TCP", "UDP", "IIC", "I2C", "SPI", "UART", "CAN", "FOC", "DMA", "PWM", "FreeRTOS", "Linux", "C++", "volatile", "HardFault", "虚函数", "堆和栈", "EEPROM", "链表", "字符串", "进程间通信", "三次握手", "四次挥手"];
  return entities.find((entity) => text.toLowerCase().includes(entity.toLowerCase())) ?? (normalize(text).replace(/[。！？?！]/g, "").slice(0, 40) || undefined);
}

export class ContextAnchorStore {
  private readonly values: ContextAnchor[] = [];
  private latest?: ContextAnchor;
  private lastConfirmedQuestion?: ContextAnchor;
  private pendingCodeContext?: ContextAnchor;
  private currentTopic?: string;
  private currentTopicExpiresAt = 0;
  private currentTopicAnchorId?: string;
  private counter = 0;

  private pendingTopicAnchor?: PendingTopicAnchor;

  constructor(private readonly now: () => number = () => Date.now(), private readonly topicTtlMs = 7_000, private readonly codeTtlMs = 12_000, private readonly pendingTopicTtlMs = 5_000) {}

  reset(): void {
    this.values.length = 0;
    this.latest = undefined;
    this.lastConfirmedQuestion = undefined;
    this.pendingCodeContext = undefined;
    this.currentTopic = undefined;
    this.currentTopicExpiresAt = 0;
    this.currentTopicAnchorId = undefined;
    this.pendingTopicAnchor = undefined;
  }

  addAnchor(input: { text: string; speechAct: ContextAnchorSpeechAct; confidence?: number; topic?: string; entities?: string[]; createdAt?: number; ttlMs?: number }): ContextAnchor {
    const createdAt = input.createdAt ?? this.now();
    const text = normalize(input.text);
    const anchor: ContextAnchor = {
      id: `anchor-${++this.counter}`,
      text,
      normalizedText: text.toLowerCase(),
      ...(input.topic || inferTopic(text) ? { topic: input.topic || inferTopic(text) } : {}),
      entities: input.entities ?? [],
      speechAct: input.speechAct,
      createdAt,
      expiresAt: createdAt + (input.ttlMs ?? (input.speechAct === "CODE_CONTEXT" ? this.codeTtlMs : this.topicTtlMs)),
      confidence: input.confidence ?? 0.9
    };
    this.values.push(anchor);
    while (this.values.length > 16) this.values.shift();
    this.latest = anchor;
    if (anchor.topic) {
      this.currentTopic = anchor.topic;
      this.currentTopicExpiresAt = anchor.expiresAt;
      this.currentTopicAnchorId = anchor.id;
      if (anchor.speechAct === "TOPIC_ANCHOR") {
        this.pendingTopicAnchor = {
          topic: anchor.topic,
          sourceText: anchor.text,
          confidence: anchor.confidence,
          createdAt: anchor.createdAt,
          expiresAt: anchor.createdAt + this.pendingTopicTtlMs
        };
      }
    }
    if (anchor.speechAct === "CODE_CONTEXT") this.pendingCodeContext = anchor;
    return anchor;
  }

  recordConfirmedQuestion(input: { id: string; text: string; confidence?: number; topic?: string; entities?: string[]; createdAt?: number }): ContextAnchor {
    // Keep the confirmed-question context longer than the late modifier
    // window. This covers a natural 2–8s follow-up without turning the topic
    // anchor into a session-wide implicit context.
    const anchor = this.addAnchor({ ...input, speechAct: "QUESTION", ttlMs: 11_000 });
    const confirmed = { ...anchor, id: input.id };
    this.lastConfirmedQuestion = confirmed;
    this.latest = confirmed;
    this.values[this.values.length - 1] = confirmed;
    this.pendingCodeContext = undefined;
    return confirmed;
  }

  clearCodeContext(): void { this.pendingCodeContext = undefined; }

  addPendingTopicAnchor(input: { topic: string; sourceText: string; confidence?: number; createdAt?: number; ttlMs?: number }): PendingTopicAnchor {
    const createdAt = input.createdAt ?? this.now();
    this.pendingTopicAnchor = {
      topic: normalize(input.topic),
      sourceText: normalize(input.sourceText),
      confidence: input.confidence ?? 0.9,
      createdAt,
      expiresAt: createdAt + (input.ttlMs ?? this.pendingTopicTtlMs)
    };
    return { ...this.pendingTopicAnchor };
  }

  consumePendingTopicAnchor(at = this.now()): PendingTopicAnchor | undefined {
    const value = this.pendingTopicAnchor && this.pendingTopicAnchor.expiresAt > at ? { ...this.pendingTopicAnchor } : undefined;
    this.pendingTopicAnchor = undefined;
    return value;
  }

  snapshot(at = this.now()): ContextAnchorSnapshot {
    const active = this.values.filter((anchor) => anchor.expiresAt > at);
    this.latest = this.latest && this.latest.expiresAt > at ? this.latest : active.at(-1);
    this.lastConfirmedQuestion = this.lastConfirmedQuestion && this.lastConfirmedQuestion.expiresAt > at ? this.lastConfirmedQuestion : undefined;
    this.pendingCodeContext = this.pendingCodeContext && this.pendingCodeContext.expiresAt > at ? this.pendingCodeContext : undefined;
    this.pendingTopicAnchor = this.pendingTopicAnchor && this.pendingTopicAnchor.expiresAt > at ? this.pendingTopicAnchor : undefined;
    const activeTopicAnchor = [...active].reverse().find((anchor) => anchor.topic);
    if (activeTopicAnchor && activeTopicAnchor.id !== this.currentTopicAnchorId) {
      this.currentTopic = activeTopicAnchor.topic;
      this.currentTopicExpiresAt = activeTopicAnchor.expiresAt;
      this.currentTopicAnchorId = activeTopicAnchor.id;
    }
    if (!this.currentTopic || this.currentTopicExpiresAt <= at) {
      this.currentTopic = undefined;
      this.currentTopicExpiresAt = 0;
      this.currentTopicAnchorId = undefined;
    }
    return {
      ...(this.latest ? { latestAnchor: { ...this.latest } } : {}),
      ...(this.lastConfirmedQuestion ? { lastConfirmedQuestion: { ...this.lastConfirmedQuestion } } : {}),
      ...(this.currentTopic ? { currentTopic: this.currentTopic } : {}),
      ...(activeTopicAnchor?.topic ? { currentTopicAnchor: { topic: activeTopicAnchor.topic, sourceAnchorId: activeTopicAnchor.id, createdAt: activeTopicAnchor.createdAt, expiresAt: activeTopicAnchor.expiresAt } } : {}),
      ...(this.pendingTopicAnchor ? { pendingTopicAnchor: { ...this.pendingTopicAnchor } } : {}),
      ...(this.pendingCodeContext ? { pendingCodeContext: { ...this.pendingCodeContext } } : {}),
      anchors: active.map((anchor) => ({ ...anchor }))
    };
  }

  speechContext(at = this.now()): { latestAnchor?: ContextAnchor; currentTopic?: string; pendingCodeContext?: boolean; memory?: InterviewMemorySnapshot } {
    const snapshot = this.snapshot(at);
    return { latestAnchor: snapshot.latestAnchor, currentTopic: snapshot.currentTopic, pendingCodeContext: Boolean(snapshot.pendingCodeContext) };
  }
}

export type { InterviewSpeechAct };
