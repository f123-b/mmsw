export const RUNTIME_SESSION_STATES = ["idle", "starting", "running", "stopping", "stopped", "failed"] as const;
export type RuntimeSessionState = typeof RUNTIME_SESSION_STATES[number];

export const RUNTIME_QUESTION_STATES = ["detected", "confirmed", "queued", "answering", "streaming", "answered", "finished", "cancelled", "failed"] as const;
export type RuntimeQuestionState = typeof RUNTIME_QUESTION_STATES[number];

export const RUNTIME_ANSWER_STATES = ["created", "context_loading", "provider_pending", "streaming", "completed", "committed", "cancelled", "failed"] as const;
export type RuntimeAnswerState = typeof RUNTIME_ANSWER_STATES[number];

export const RUNTIME_TRACE_EVENTS = [
  "INTERVIEW_SESSION_START_REQUESTED",
  "INTERVIEW_SESSION_STARTED",
  "TRANSCRIPT_RECEIVED",
  "QUESTION_DETECTED",
  "QUESTION_CONFIRMED",
  "QUESTION_QUEUED",
  "QUESTION_MERGED",
  "ANSWER_REQUEST_CREATED",
  "PROJECT_CONTEXT_STARTED",
  "PROJECT_CONTEXT_READY",
  "PROJECT_CONTEXT_FAILED",
  "PROVIDER_STREAM_REQUESTED",
  "PROVIDER_STREAM_STARTED",
  "PROVIDER_FIRST_TOKEN",
  "PROVIDER_STREAM_COMPLETED",
  "PROVIDER_STREAM_CANCELLED",
  "PROVIDER_STREAM_FAILED",
  "ANSWER_COMMITTED",
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
