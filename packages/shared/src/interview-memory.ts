export interface InterviewMemoryTurn {
  question: string;
  answer?: string;
  topic?: string;
  createdAt?: number;
}

export interface InterviewMemorySnapshot {
  recentQuestions: string[];
  recentAnswers: string[];
  topics: string[];
  currentTopic?: string;
  pendingQuestion?: string;
  turns: InterviewMemoryTurn[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function inferTopic(text: string): string | undefined {
  const candidates: Array<[RegExp, string]> = [
    [/FOC|电流环|电压环|SVPWM|Clarke|Park/i, "电机控制/FOC"],
    [/DMA|中断|采样|PWM/i, "实时采样与中断"],
    [/CAN|SPI|I2C|UART|串口|总线|通信/i, "嵌入式通信"],
    [/RTOS|任务|线程|调度|并发/i, "实时系统与并发"],
    [/SQLite|数据库|RAG|知识库|向量|Embedding/i, "数据与知识库"],
    [/架构|模块|系统设计|部署|服务/i, "系统架构"]
  ];
  return candidates.find(([pattern]) => pattern.test(text))?.[1];
}

/** Runtime interview context. It is intentionally independent from SQLite schema. */
export class InterviewMemory {
  private readonly turns: InterviewMemoryTurn[] = [];
  private pendingQuestion: string | undefined;
  private currentTopic: string | undefined;

  constructor(private readonly maxTurns = 10) {}

  reset(): void {
    this.turns.length = 0;
    this.pendingQuestion = undefined;
    this.currentTopic = undefined;
  }

  recordQuestion(question: string, metadata: { topic?: string; createdAt?: number } = {}): void {
    const normalized = normalize(question);
    if (!normalized) return;
    const topic = metadata.topic || inferTopic(normalized) || this.currentTopic;
    this.turns.push({ question: normalized, topic, createdAt: metadata.createdAt });
    while (this.turns.length > this.maxTurns) this.turns.shift();
    this.pendingQuestion = normalized;
    if (topic) this.currentTopic = topic;
  }

  recordAnswer(answer: string, metadata: { question?: string; topic?: string; createdAt?: number } = {}): void {
    const normalized = normalize(answer);
    const question = normalize(metadata.question || this.pendingQuestion || "");
    if (!normalized) return;
    const turn = question ? [...this.turns].reverse().find((item) => item.question === question) : this.turns[this.turns.length - 1];
    if (turn) {
      turn.answer = normalized;
      if (metadata.topic) turn.topic = metadata.topic;
      if (turn.topic) this.currentTopic = turn.topic;
    } else if (question) {
      this.recordQuestion(question, { topic: metadata.topic, createdAt: metadata.createdAt });
      this.turns[this.turns.length - 1].answer = normalized;
    }
    this.pendingQuestion = undefined;
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
      currentTopic: this.currentTopic,
      pendingQuestion: this.pendingQuestion,
      turns
    };
  }

  contextText(recentTranscript: string[] = []): string {
    const snapshot = this.snapshot();
    const lines = snapshot.turns.slice(-this.maxTurns).map((turn) => `问题：${turn.question}${turn.answer ? `\n回答：${turn.answer}` : ""}`);
    if (snapshot.currentTopic) lines.unshift(`当前技术主题：${snapshot.currentTopic}`);
    return [...lines, ...recentTranscript.slice(-6)].join("\n").slice(-8_000);
  }
}
