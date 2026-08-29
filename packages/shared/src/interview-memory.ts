import { normalizeTechnicalTerms } from "./terminology";
import type { QuestionRelationType } from "./interview/turn-builder";

export type InterviewMemoryEntryKind = "question" | "answer" | "observation";

export interface InterviewMemoryEntry {
  id: string;
  kind: InterviewMemoryEntryKind;
  text: string;
  questionId?: string;
  groupId?: string;
  relationType?: QuestionRelationType;
  topic?: string;
  salience: number;
  createdAt: number;
}

export interface InterviewMemoryTurn {
  questionId?: string;
  parentQuestionId?: string;
  rootQuestionId?: string;
  question: string;
  answer?: string;
  topic?: string;
  createdAt?: number;
}

export interface InterviewMemorySnapshot {
  recentQuestions: string[];
  recentAnswers: string[];
  topics: string[];
  entities: string[];
  currentTopic?: string;
  pendingQuestion?: string;
  turns: InterviewMemoryTurn[];
  /** Phase 4 memory surface; optional to keep old serialized snapshots valid. */
  schemaVersion?: 2;
  entries?: InterviewMemoryEntry[];
  activeGroupId?: string;
}

function normalize(text: string): string {
  return normalizeTechnicalTerms(text);
}

function inferTopic(text: string): string | undefined {
  const candidates: Array<[RegExp, string]> = [
    [/FOC|电流环|电压环|SVPWM|Clarke|Park/i, "电机控制/FOC"],
    [/DMA|中断|采样|PWM/i, "实时采样与中断"],
    [/CAN|IIC|I2C|SPI|UART|串口|总线|通信/i, "嵌入式通信"],
    [/RTOS|任务|线程|调度|并发/i, "实时系统与并发"],
    [/SQLite|数据库|RAG|知识库|向量|Embedding/i, "数据与知识库"],
    [/架构|模块|系统设计|部署|服务/i, "系统架构"]
  ];
  return candidates.find(([pattern]) => pattern.test(text))?.[1];
}

/** Runtime interview context. It is intentionally independent from SQLite schema. */
export class InterviewMemory {
  private readonly turns: InterviewMemoryTurn[] = [];
  private readonly entries: InterviewMemoryEntry[] = [];
  private readonly entities = new Set<string>();
  private pendingQuestion: string | undefined;
  private currentTopic: string | undefined;
  private activeGroupId: string | undefined;
  private readonly maxEntries: number;

  constructor(private readonly maxTurns = 10, maxEntries?: number) {
    this.maxEntries = Math.max(1, maxEntries ?? maxTurns * 3);
  }

  reset(): void {
    this.turns.length = 0;
    this.entries.length = 0;
    this.entities.clear();
    this.pendingQuestion = undefined;
    this.currentTopic = undefined;
    this.activeGroupId = undefined;
  }

  recordQuestion(question: string, metadata: { questionId?: string; parentQuestionId?: string; rootQuestionId?: string; groupId?: string; relationType?: QuestionRelationType; topic?: string; createdAt?: number; salience?: number } = {}): void {
    const normalized = normalize(question);
    if (!normalized) return;
    const topic = metadata.topic || inferTopic(normalized) || this.currentTopic;
    const createdAt = metadata.createdAt ?? Date.now();
    extractEntities(normalized).forEach((entity) => this.entities.add(entity));
    this.turns.push({ questionId: metadata.questionId, parentQuestionId: metadata.parentQuestionId, rootQuestionId: metadata.rootQuestionId, question: normalized, topic, createdAt });
    while (this.turns.length > this.maxTurns) this.turns.shift();
    this.entries.push({
      id: `memory-question-${metadata.questionId ?? createdAt}-${this.entries.length}`,
      kind: "question",
      text: normalized,
      ...(metadata.questionId ? { questionId: metadata.questionId } : {}),
      ...(metadata.groupId ? { groupId: metadata.groupId } : {}),
      ...(metadata.relationType ? { relationType: metadata.relationType } : {}),
      ...(topic ? { topic } : {}),
      salience: metadata.salience ?? (metadata.relationType === "FOLLOW_UP" ? 0.9 : 0.75),
      createdAt
    });
    this.trimEntries();
    this.pendingQuestion = normalized;
    this.activeGroupId = metadata.groupId ?? this.activeGroupId;
    if (topic) this.currentTopic = topic;
  }

  recordAnswer(answer: string, metadata: { question?: string; questionId?: string; groupId?: string; topic?: string; createdAt?: number; salience?: number } = {}): void {
    const normalized = normalize(answer);
    const question = normalize(metadata.question || this.pendingQuestion || "");
    if (!normalized) return;
    const turn = metadata.questionId
      ? [...this.turns].reverse().find((item) => item.questionId === metadata.questionId)
      : question ? [...this.turns].reverse().find((item) => item.question === question) : this.turns[this.turns.length - 1];
    if (turn) {
      turn.answer = normalized;
      if (metadata.topic) turn.topic = metadata.topic;
      if (turn.topic) this.currentTopic = turn.topic;
    } else if (question) {
      this.recordQuestion(question, { topic: metadata.topic, createdAt: metadata.createdAt, questionId: metadata.questionId, groupId: metadata.groupId });
      this.turns[this.turns.length - 1].answer = normalized;
    }
    const createdAt = metadata.createdAt ?? Date.now();
    this.entries.push({
      id: `memory-answer-${metadata.questionId ?? createdAt}-${this.entries.length}`,
      kind: "answer",
      text: normalized,
      ...(metadata.questionId ? { questionId: metadata.questionId } : {}),
      ...(metadata.groupId ? { groupId: metadata.groupId } : {}),
      ...(metadata.topic ? { topic: metadata.topic } : {}),
      salience: metadata.salience ?? 0.7,
      createdAt
    });
    this.trimEntries();
    this.pendingQuestion = undefined;
  }

  recordObservation(text: string, metadata: { questionId?: string; groupId?: string; topic?: string; salience?: number; createdAt?: number } = {}): void {
    const normalized = normalize(text);
    if (!normalized) return;
    const createdAt = metadata.createdAt ?? Date.now();
    this.entries.push({ id: `memory-observation-${createdAt}-${this.entries.length}`, kind: "observation", text: normalized, ...(metadata.questionId ? { questionId: metadata.questionId } : {}), ...(metadata.groupId ? { groupId: metadata.groupId } : {}), ...(metadata.topic ? { topic: metadata.topic } : {}), salience: metadata.salience ?? 0.5, createdAt });
    this.trimEntries();
  }

  setPendingQuestion(question?: string): void {
    this.pendingQuestion = question ? normalize(question) : undefined;
  }

  snapshot(): InterviewMemorySnapshot {
    const turns = this.turns.map((turn) => ({ ...turn }));
    return {
      recentQuestions: turns.map((turn) => turn.question),
      recentAnswers: turns.map((turn) => turn.answer || "").filter(Boolean),
      topics: [...new Set(turns.map((turn) => turn.topic).filter((topic): topic is string => Boolean(topic)))],
      entities: [...this.entities].slice(-30),
      currentTopic: this.currentTopic,
      pendingQuestion: this.pendingQuestion,
      turns,
      schemaVersion: 2,
      entries: this.entries.map((entry) => ({ ...entry })),
      ...(this.activeGroupId ? { activeGroupId: this.activeGroupId } : {})
    };
  }

  contextText(recentTranscript: string[] = []): string {
    const snapshot = this.snapshot();
    const lines = snapshot.turns.slice(-this.maxTurns).map((turn) => `问题：${turn.question}${turn.answer ? `\n回答：${turn.answer}` : ""}`);
    if (snapshot.currentTopic) lines.unshift(`当前技术主题：${snapshot.currentTopic}`);
    return [...lines, ...recentTranscript.slice(-6)].join("\n").slice(-8_000);
  }

  private trimEntries(): void {
    while (this.entries.length > this.maxEntries) {
      const lowest = this.entries.reduce((index, entry, candidateIndex, all) => {
        const current = all[index];
        return entry.salience < current.salience ? candidateIndex : index;
      }, 0);
      this.entries.splice(lowest, 1);
    }
  }
}

/** Explicit Phase 4 name for callers that want the richer bounded memory API. */
export class InterviewMemory2 extends InterviewMemory {}

function extractEntities(text: string): string[] {
  const known = ["FOC", "DMA", "PWM", "CAN", "UART", "SPI", "IIC", "I2C", "RTOS", "SQLite", "RAG", "ASR", "VAD", "SVPWM", "Clarke", "Park", "编码器", "电流环", "速度环"];
  return known.filter((entity) => text.toLowerCase().includes(entity.toLowerCase()));
}
