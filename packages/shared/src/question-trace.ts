export interface QuestionTraceInput {
  questionTraceId: string;
  asrFinalReceivedAt?: number;
  /** @deprecated Use asrFinalReceivedAt. Kept for existing integrations. */
  asrFinalAt?: number;
  utteranceFinalizedAt?: number;
  questionDetectionStartedAt?: number;
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
  asrFinalToUtteranceMs?: number;
  utteranceToDetectionMs?: number;
  detectionToConfirmationMs?: number;
  confirmationToRetrievalMs?: number;
  asrToQuestionMs?: number;
  questionToRetrievalMs?: number;
  retrievalMs?: number;
  llmFirstTokenMs?: number;
  answerGenerationMs?: number;
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

  update(input: Partial<QuestionTraceInput>): this {
    this.value = { ...this.value, ...input, metrics: this.value.metrics };
    this.refreshMetrics();
    return this;
  }

  mark(stage: "asrFinalReceived" | "asrFinal" | "utteranceFinalized" | "questionDetectionStarted" | "questionDetected" | "questionConfirmed" | "retrievalStarted" | "retrievalEnded" | "llmRequestStarted" | "firstToken" | "answerEnded", at: number): this {
    const key = {
      asrFinalReceived: "asrFinalReceivedAt",
      asrFinal: "asrFinalAt",
      utteranceFinalized: "utteranceFinalizedAt",
      questionDetectionStarted: "questionDetectionStartedAt",
      questionDetected: "questionDetectedAt",
      questionConfirmed: "questionConfirmedAt",
      retrievalStarted: "retrievalStartedAt",
      retrievalEnded: "retrievalEndedAt",
      llmRequestStarted: "llmRequestStartedAt",
      firstToken: "firstTokenAt",
      answerEnded: "answerEndedAt"
    }[stage] as keyof QuestionTraceSnapshot;
    (this.value as unknown as Record<string, unknown>)[key] = at;
    this.refreshMetrics();
    return this;
  }

  private refreshMetrics(): void {
    const asrFinalReceivedAt = this.value.asrFinalReceivedAt ?? this.value.asrFinalAt;
    this.value.metrics = {
      asrFinalToUtteranceMs: elapsed(this.value.utteranceFinalizedAt, asrFinalReceivedAt),
      utteranceToDetectionMs: elapsed(this.value.questionDetectedAt, this.value.utteranceFinalizedAt),
      detectionToConfirmationMs: elapsed(this.value.questionConfirmedAt, this.value.questionDetectedAt),
      confirmationToRetrievalMs: elapsed(this.value.retrievalStartedAt, this.value.questionConfirmedAt),
      asrToQuestionMs: elapsed(this.value.questionConfirmedAt, asrFinalReceivedAt),
      questionToRetrievalMs: elapsed(this.value.retrievalStartedAt, this.value.questionConfirmedAt),
      retrievalMs: elapsed(this.value.retrievalEndedAt, this.value.retrievalStartedAt),
      llmFirstTokenMs: elapsed(this.value.firstTokenAt, this.value.llmRequestStartedAt),
      answerGenerationMs: elapsed(this.value.answerEndedAt, this.value.llmRequestStartedAt),
      answerTotalMs: elapsed(this.value.answerEndedAt, this.value.llmRequestStartedAt),
      endToEndMs: elapsed(this.value.answerEndedAt, asrFinalReceivedAt)
    };
  }

  snapshot(): QuestionTraceSnapshot {
    return { ...this.value, metrics: { ...this.value.metrics } };
  }
}
