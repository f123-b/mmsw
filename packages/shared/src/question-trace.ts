export interface QuestionTraceInput {
  questionTraceId: string;
  source?: string;
  textLength?: number;
  textHash?: string;
  speechAct?: string;
  ruleScore?: number;
  semanticScore?: number;
  localClassifierScore?: number;
  llmScore?: number;
  contextTopic?: string;
  contextRelation?: string;
  topicRelation?: string;
  semanticFrame?: string;
  terminologyCorrectionCount?: number;
  terminologyConfidence?: number;
  projectAnchorAvailable?: boolean;
  projectQuestionRequested?: boolean;
  parentQuestionId?: string;
  isFollowUp?: boolean;
  finalScore?: number;
  decision?: "answer" | "reject";
  decisionReason?: string;
  asrFinalReceivedAt?: number;
  /** @deprecated Use asrFinalReceivedAt. Kept for existing integrations. */
  asrFinalAt?: number;
  speechEndAt?: number;
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
  answerSource?: "llm" | "question-bank" | "project-qa" | "project-memory" | "other";
  answerSourceMode?: string;
  qaMatchLevel?: string;
  claimGateDecision?: "allow" | "rewrite" | "partial" | "abstain";
  blockedClaimCount?: number;
  llmRequestAt?: number;
  answerFinishedAt?: number;
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
  answerLookupMs?: number;
  endToEndMs?: number;
}

export interface QuestionTraceSnapshot extends QuestionTraceInput {
  retrievalStartedAt?: number;
  retrievalEndedAt?: number;
  retrievalFinishedAt?: number;
  answerLookupStartedAt?: number;
  answerVisibleAt?: number;
  llmRequestStartedAt?: number;
  firstTokenAt?: number;
  answerEndedAt?: number;
  metrics: QuestionTraceMetrics;
}

const elapsed = (end?: number, start?: number): number | undefined => end === undefined || start === undefined ? undefined : Math.max(0, end - start);
/** Non-reversible, bounded metadata for production traces. Raw transcript is never stored. */
export function questionTraceTextMetadata(text: string): Pick<QuestionTraceInput, "textLength" | "textHash"> {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return { textLength: text.length, textHash: (hash >>> 0).toString(16).padStart(8, "0") };
}

/** Safe, bounded per-question timing state. Production snapshots contain no transcript text. */
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

  mark(stage: "asrFinalReceived" | "asrFinal" | "speechEnd" | "utteranceFinalized" | "questionDetectionStarted" | "questionDetected" | "questionConfirmed" | "retrievalStarted" | "retrievalEnded" | "retrievalFinished" | "answerLookupStarted" | "answerVisible" | "llmRequest" | "llmRequestStarted" | "firstToken" | "answerFinished" | "answerEnded", at: number): this {
    const key = {
      asrFinalReceived: "asrFinalReceivedAt",
      asrFinal: "asrFinalAt",
      speechEnd: "speechEndAt",
      utteranceFinalized: "utteranceFinalizedAt",
      questionDetectionStarted: "questionDetectionStartedAt",
      questionDetected: "questionDetectedAt",
      questionConfirmed: "questionConfirmedAt",
      retrievalStarted: "retrievalStartedAt",
      retrievalEnded: "retrievalEndedAt",
      retrievalFinished: "retrievalFinishedAt",
      answerLookupStarted: "answerLookupStartedAt",
      answerVisible: "answerVisibleAt",
      llmRequest: "llmRequestAt",
      llmRequestStarted: "llmRequestStartedAt",
      firstToken: "firstTokenAt",
      answerFinished: "answerFinishedAt",
      answerEnded: "answerEndedAt"
    }[stage] as keyof QuestionTraceSnapshot;
    (this.value as unknown as Record<string, unknown>)[key] = at;
    const aliases: Partial<Record<typeof stage, keyof QuestionTraceSnapshot>> = {
      utteranceFinalized: "speechEndAt",
      retrievalEnded: "retrievalFinishedAt",
      llmRequestStarted: "llmRequestAt",
      answerEnded: "answerFinishedAt"
    };
    const alias = aliases[stage];
    if (alias) (this.value as unknown as Record<string, unknown>)[alias] = at;
    this.refreshMetrics();
    return this;
  }

  private refreshMetrics(): void {
    const asrFinalReceivedAt = this.value.asrFinalReceivedAt ?? this.value.asrFinalAt;
    const speechEndAt = this.value.speechEndAt ?? this.value.utteranceFinalizedAt;
    const retrievalFinishedAt = this.value.retrievalFinishedAt ?? this.value.retrievalEndedAt;
    const llmRequestAt = this.value.llmRequestAt ?? this.value.llmRequestStartedAt;
    const answerFinishedAt = this.value.answerFinishedAt ?? this.value.answerEndedAt;
    this.value.metrics = {
      asrFinalToUtteranceMs: elapsed(speechEndAt, asrFinalReceivedAt),
      utteranceToDetectionMs: elapsed(this.value.questionDetectedAt, this.value.utteranceFinalizedAt),
      detectionToConfirmationMs: elapsed(this.value.questionConfirmedAt, this.value.questionDetectedAt),
      confirmationToRetrievalMs: elapsed(this.value.retrievalStartedAt, this.value.questionConfirmedAt),
      asrToQuestionMs: elapsed(this.value.questionConfirmedAt, asrFinalReceivedAt),
      questionToRetrievalMs: elapsed(this.value.retrievalStartedAt, this.value.questionConfirmedAt),
      retrievalMs: elapsed(retrievalFinishedAt, this.value.retrievalStartedAt),
      answerLookupMs: elapsed(this.value.answerVisibleAt, this.value.answerLookupStartedAt),
      llmFirstTokenMs: elapsed(this.value.firstTokenAt, llmRequestAt),
      answerGenerationMs: elapsed(answerFinishedAt, llmRequestAt),
      answerTotalMs: elapsed(answerFinishedAt, llmRequestAt),
      endToEndMs: elapsed(answerFinishedAt, asrFinalReceivedAt)
    };
  }

  snapshot(): QuestionTraceSnapshot {
    return { ...this.value, metrics: { ...this.value.metrics } };
  }
}
