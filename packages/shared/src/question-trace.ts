export interface QuestionTraceInput {
  questionTraceId: string;
  asrFinalAt?: number;
  utteranceFinalizedAt?: number;
  questionDetectedAt?: number;
  questionConfirmedAt?: number;
  questionScore?: number;
  questionType?: string;
  followUp?: boolean;
  projectId?: string;
  jobTargetId?: string;
  retrievalRoute?: string;
}

export interface QuestionTraceMetrics {
  asrToQuestionMs?: number;
  questionToRetrievalMs?: number;
  retrievalMs?: number;
  llmFirstTokenMs?: number;
  answerTotalMs?: number;
  endToEndMs?: number;
}

export interface QuestionTraceSnapshot extends QuestionTraceInput {
  retrievalStartedAt?: number;
  retrievalEndedAt?: number;
  llmRequestStartedAt?: number;
  firstTokenAt?: number;
  answerEndedAt?: number;
  metrics: QuestionTraceMetrics;
}

const elapsed = (end?: number, start?: number): number | undefined => end === undefined || start === undefined ? undefined : Math.max(0, end - start);

/** Safe, bounded per-question timing state. It never stores transcript text. */
export class QuestionTrace {
  private value: QuestionTraceSnapshot;

  constructor(input: QuestionTraceInput) {
    this.value = { ...input, metrics: {} };
  }

  mark(stage: "asrFinal" | "utteranceFinalized" | "questionDetected" | "questionConfirmed" | "retrievalStarted" | "retrievalEnded" | "llmRequestStarted" | "firstToken" | "answerEnded", at: number): this {
    const key = {
      asrFinal: "asrFinalAt",
      utteranceFinalized: "utteranceFinalizedAt",
      questionDetected: "questionDetectedAt",
      questionConfirmed: "questionConfirmedAt",
      retrievalStarted: "retrievalStartedAt",
      retrievalEnded: "retrievalEndedAt",
      llmRequestStarted: "llmRequestStartedAt",
      firstToken: "firstTokenAt",
      answerEnded: "answerEndedAt"
    }[stage] as keyof QuestionTraceSnapshot;
    (this.value as unknown as Record<string, unknown>)[key] = at;
    this.value.metrics = {
      asrToQuestionMs: elapsed(this.value.questionConfirmedAt, this.value.asrFinalAt),
      questionToRetrievalMs: elapsed(this.value.retrievalStartedAt, this.value.questionConfirmedAt),
      retrievalMs: elapsed(this.value.retrievalEndedAt, this.value.retrievalStartedAt),
      llmFirstTokenMs: elapsed(this.value.firstTokenAt, this.value.llmRequestStartedAt),
      answerTotalMs: elapsed(this.value.answerEndedAt, this.value.llmRequestStartedAt),
      endToEndMs: elapsed(this.value.answerEndedAt, this.value.asrFinalAt)
    };
    return this;
  }

  snapshot(): QuestionTraceSnapshot {
    return { ...this.value, metrics: { ...this.value.metrics } };
  }
}
