export const RUNTIME_SESSION_STATES = ["idle", "starting", "running", "stopping", "stopped", "failed"] as const;
export type RuntimeSessionState = typeof RUNTIME_SESSION_STATES[number];

export const RUNTIME_QUESTION_STATES = ["detected", "confirmed", "queued", "answering", "streaming", "answered", "finished", "cancelled", "failed"] as const;
export type RuntimeQuestionState = typeof RUNTIME_QUESTION_STATES[number];

export const RUNTIME_ANSWER_STATES = ["created", "context_loading", "request_ready", "request_sent", "provider_pending", "streaming", "completed", "committed", "cancelled", "failed"] as const;
export type RuntimeAnswerState = typeof RUNTIME_ANSWER_STATES[number];

export const RUNTIME_TRACE_EVENTS = [
  "INTERVIEW_SESSION_START_REQUESTED",
  "INTERVIEW_SESSION_STARTED",
  "TRANSCRIPT_RECEIVED",
  "ASR_PARTIAL_RECEIVED",
  "ASR_FINAL_RECEIVED",
  "QUESTION_DRAFT_UPDATED",
  "LATE_CONSTRAINT_RECEIVED",
  "LATE_CONSTRAINT_MERGED",
  "LATE_CONSTRAINT_SUPPLEMENTED",
  "LATE_CONSTRAINT_DROPPED",
  "LATE_AUGMENTATION_QUEUED",
  "TURN_COMPLETION_STARTED",
  "TURN_COMPLETION_COMPLETED",
  "QUESTION_LOCAL_ANALYSIS_STARTED",
  "QUESTION_LOCAL_ANALYSIS_COMPLETED",
  "QUESTION_CLASSIFIER_WARMUP_STARTED",
  "QUESTION_CLASSIFIER_WARMUP_COMPLETED",
  "QUESTION_CLASSIFIER_WARMUP_FAILED",
  "QUESTION_DETECTED",
  "QUESTION_CONFIRMED",
  "QUESTION_QUEUED",
  "QUESTION_MERGED",
  "ANSWER_REQUEST_CREATED",
  "CONTEXT_BUILDING",
  "REQUEST_READY",
  "PROVIDER_REQUEST_STARTED",
  "PROVIDER_REQUEST_SENT",
  "PROJECT_CONTEXT_STARTED",
  "PROJECT_CONTEXT_READY",
  "PROJECT_CONTEXT_FAILED",
  "PROVIDER_STREAM_REQUESTED",
  "PROVIDER_STREAM_STARTED",
  "PROVIDER_FIRST_TOKEN",
  "FIRST_VISIBLE_TOKEN",
  "PROVIDER_STREAM_COMPLETED",
  "PROVIDER_STREAM_CANCELLED",
  "PROVIDER_STREAM_FAILED",
  "ANSWER_COMMITTED",
  "ANSWER_COMPLETED",
  "FAST_CONTEXT_STARTED",
  "FAST_CONTEXT_COMPLETED",
  "RICH_CONTEXT_STARTED",
  "RICH_CONTEXT_COMPLETED",
  "CLAIM_GATE_FIRST_PASS",
  "OVERLAY_UPDATE_REQUESTED",
  "OVERLAY_UPDATED",
  "QUESTION_FINISHED",
  "QUESTION_CANCELLED",
  "QUESTION_FAILED",
  "ANSWER_OPERATION_CLEANUP_COMPLETED",
  "INTERVIEW_SESSION_STOP_REQUESTED",
  "INTERVIEW_SESSION_STOPPING",
  "RUNTIME_CLEANUP_STARTED",
  "RUNTIME_CLEANUP_COMPLETED",
  "INTERVIEW_SESSION_STOPPED",
  "RUNTIME_IDLE",
  "STALE_RUNTIME_EVENT_DROPPED",
  "RUNTIME_STALL_DETECTED"
  ,"SELF_INTRO_DETECTED"
  ,"SELF_INTRO_DIRECT"
  ,"SELF_INTRO_REWRITE"
  ,"PROJECT_RESOLVED"
  ,"PROJECT_QA_ROUTE"
  ,"PROJECT_QA_DIRECT"
  ,"PROJECT_OVERVIEW_RETRIEVAL"
  ,"PROJECT_FAST_CONTEXT_READY"
  ,"TRANSCRIPT_ASSEMBLED"
  ,"PROJECT_ENTITY_CONFLICT"
] as const;
export type RuntimeTraceEventName = typeof RUNTIME_TRACE_EVENTS[number];

export interface InterviewRuntimeDiagnostics {
  sessionId?: string;
  sessionState: RuntimeSessionState;
  pendingQuestions: number;
  activeAnswers: number;
  activeStreams: number;
  transcriptQueueDepth: number;
  answerQueueDepth: number;
  activeAbortControllers: number;
  activeTimers: number;
  activeProviderRequests: number;
  activeAudioSessions?: number;
  activeListeners?: number;
  lastLifecycleEvent?: RuntimeTraceEventName;
  lastLifecycleEventAt?: number;
}

export interface RuntimeTraceEvent {
  name: RuntimeTraceEventName;
  timestamp: number;
  elapsedMs?: number;
  sessionId?: string;
  questionId?: string;
  answerId?: string;
  providerRequestId?: string;
  sessionState: RuntimeSessionState;
  questionState?: RuntimeQuestionState;
  answerState?: RuntimeAnswerState;
  pendingQuestions: number;
  activeAnswers: number;
  activeStreams: number;
  transcriptQueueDepth: number;
  answerQueueDepth: number;
  activeAbortControllers: number;
  activeTimers: number;
  activeProviderRequests: number;
  activeAudioSessions?: number;
  activeListeners?: number;
  reasonCode?: string;
  fields?: Record<string, string | number | boolean | undefined>;
}

export class RuntimeTimerRegistry {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  get size(): number { return this.timers.size; }

  set(name: string, callback: () => void, delayMs: number): void {
    this.clear(name);
    const timer = setTimeout(() => {
      this.timers.delete(name);
      callback();
    }, Math.max(0, delayMs));
    this.timers.set(name, timer);
  }

  clear(name: string): void {
    const timer = this.timers.get(name);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(name);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export class RuntimeAbortRegistry {
  private readonly controllers = new Map<string, AbortController>();

  get size(): number { return this.controllers.size; }

  create(id: string): AbortController {
    this.delete(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    return controller;
  }

  delete(id: string): void { this.controllers.delete(id); }

  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  clear(): void { this.controllers.clear(); }
}

export class RuntimeTraceBuffer {
  private readonly events: RuntimeTraceEvent[] = [];

  constructor(private readonly limit = 300) {}

  push(event: RuntimeTraceEvent): RuntimeTraceEvent {
    this.events.push({ ...event, ...(event.fields ? { fields: { ...event.fields } } : {}) });
    while (this.events.length > this.limit) this.events.shift();
    return event;
  }

  snapshot(limit = this.limit): RuntimeTraceEvent[] {
    return this.events.slice(-Math.max(1, limit)).map((event) => ({ ...event, ...(event.fields ? { fields: { ...event.fields } } : {}) }));
  }

  clear(): void { this.events.length = 0; }
}

export interface RuntimeLatencySample {
  id: string;
  asrFinalReceivedAt?: number;
  questionConfirmedAt?: number;
  providerRequestStartedAt?: number;
  providerRequestSentAt?: number;
  providerFirstTokenAt?: number;
  firstVisibleTokenAt?: number;
  answerDeltaAt?: number;
  overlayVisibleAt?: number;
  fastContextStartedAt?: number;
  fastContextCompletedAt?: number;
  /** Local sentence-level ClaimGate cost reported by AnswerAgent. */
  claimGateMs?: number;
  claimGateAt?: number;
}

export interface RuntimeLatencyStageMetrics {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface RuntimeLatencyMetrics {
  sampleCount: number;
  stages: {
    asrFinalToQuestionConfirmedMs: RuntimeLatencyStageMetrics;
    questionConfirmedToProviderRequestMs: RuntimeLatencyStageMetrics;
    providerRequestToFirstTokenMs: RuntimeLatencyStageMetrics;
    asrFinalToFirstVisibleTokenMs: RuntimeLatencyStageMetrics;
    fastContextMs: RuntimeLatencyStageMetrics;
    claimGateMs: RuntimeLatencyStageMetrics;
    answerDeltaToOverlayVisibleMs: RuntimeLatencyStageMetrics;
    /** Aliases retained for dashboards that use the shorter stage names. */
    providerFirstTokenMs: RuntimeLatencyStageMetrics;
    asrFinalToFirstTokenMs: RuntimeLatencyStageMetrics;
  };
}

function stageMetrics(values: number[]): RuntimeLatencyStageMetrics {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number): number => sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!.toFixed(3)) : 0;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.length ? Number(sorted[sorted.length - 1]!.toFixed(3)) : 0 };
}

/** Formal low-latency runtime telemetry. Samples are bounded to one session. */
export class RuntimeLatencyTelemetry {
  private readonly values = new Map<string, RuntimeLatencySample>();

  start(id: string, at: number): RuntimeLatencySample {
    const sample = this.values.get(id) ?? { id };
    sample.asrFinalReceivedAt ??= at;
    this.values.set(id, sample);
    return sample;
  }

  mark(id: string, stage: Exclude<keyof RuntimeLatencySample, "id">, at: number): void {
    const sample = this.values.get(id) ?? { id };
    sample[stage] = at;
    this.values.set(id, sample);
  }

  markOnce(id: string, stage: Exclude<keyof RuntimeLatencySample, "id">, at: number): void {
    const sample = this.values.get(id) ?? { id };
    if (sample[stage] !== undefined) return;
    sample[stage] = at;
    this.values.set(id, sample);
  }

  setDuration(id: string, stage: "claimGateMs", durationMs: number | undefined): void {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return;
    const sample = this.values.get(id) ?? { id };
    sample[stage] = durationMs;
    this.values.set(id, sample);
  }

  snapshot(): RuntimeLatencySample[] { return [...this.values.values()].map((sample) => ({ ...sample })); }

  metrics(): RuntimeLatencyMetrics {
    const samples = this.snapshot();
    const durations = (get: (sample: RuntimeLatencySample) => number | undefined): number[] => samples.map(get).filter((value): value is number => value !== undefined && Number.isFinite(value) && value >= 0);
    return {
      sampleCount: samples.length,
      stages: {
        asrFinalToQuestionConfirmedMs: stageMetrics(durations((sample) => sample.asrFinalReceivedAt !== undefined && sample.questionConfirmedAt !== undefined ? sample.questionConfirmedAt - sample.asrFinalReceivedAt : undefined)),
        questionConfirmedToProviderRequestMs: stageMetrics(durations((sample) => sample.questionConfirmedAt !== undefined && sample.providerRequestStartedAt !== undefined ? sample.providerRequestStartedAt - sample.questionConfirmedAt : undefined)),
        providerRequestToFirstTokenMs: stageMetrics(durations((sample) => sample.providerRequestStartedAt !== undefined && sample.providerFirstTokenAt !== undefined ? sample.providerFirstTokenAt - sample.providerRequestStartedAt : undefined)),
        asrFinalToFirstVisibleTokenMs: stageMetrics(durations((sample) => sample.asrFinalReceivedAt !== undefined && sample.firstVisibleTokenAt !== undefined ? sample.firstVisibleTokenAt - sample.asrFinalReceivedAt : undefined)),
        fastContextMs: stageMetrics(durations((sample) => sample.fastContextStartedAt !== undefined && sample.fastContextCompletedAt !== undefined ? sample.fastContextCompletedAt - sample.fastContextStartedAt : undefined)),
        claimGateMs: stageMetrics(durations((sample) => sample.claimGateMs ?? (sample.providerFirstTokenAt !== undefined && sample.claimGateAt !== undefined ? sample.claimGateAt - sample.providerFirstTokenAt : undefined))),
        answerDeltaToOverlayVisibleMs: stageMetrics(durations((sample) => sample.answerDeltaAt !== undefined && sample.overlayVisibleAt !== undefined ? sample.overlayVisibleAt - sample.answerDeltaAt : undefined)),
        providerFirstTokenMs: stageMetrics(durations((sample) => sample.providerRequestStartedAt !== undefined && sample.providerFirstTokenAt !== undefined ? sample.providerFirstTokenAt - sample.providerRequestStartedAt : undefined)),
        asrFinalToFirstTokenMs: stageMetrics(durations((sample) => sample.asrFinalReceivedAt !== undefined && sample.providerFirstTokenAt !== undefined ? sample.providerFirstTokenAt - sample.asrFinalReceivedAt : undefined))
      }
    };
  }

  clear(): void { this.values.clear(); }
}

export async function withRuntimeTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.();
          resolve(undefined);
        }, Math.max(1, timeoutMs));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
