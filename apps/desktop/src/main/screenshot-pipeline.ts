import type { ScreenshotImage } from "@interview-copilot/shared";

export const SCREENSHOT_PROMPT = "分析截图中的面试问题、代码或内容，并给出适合面试场景的回答。";

export const SCREENSHOT_TRACE_EVENTS = [
  "SCREENSHOT_ACTION_REQUESTED",
  "SCREENSHOT_RENDERER_HANDLER_ENTERED",
  "SCREENSHOT_IPC_SENT",
  "SCREENSHOT_IPC_RECEIVED",
  "SCREENSHOT_CAPTURE_STARTED",
  "SCREENSHOT_CAPTURE_COMPLETED",
  "SCREENSHOT_CAPTURE_FAILED",
  "SCREENSHOT_IMAGE_NORMALIZED",
  "VISION_REQUEST_BUILD_STARTED",
  "VISION_REQUEST_BUILT",
  "VISION_PROVIDER_REQUEST_STARTED",
  "VISION_PROVIDER_REQUEST_RECEIVED",
  "VISION_FIRST_TOKEN",
  "VISION_RESPONSE_COMPLETED",
  "VISION_RESPONSE_FAILED",
  "VISION_OVERLAY_UPDATE_REQUESTED",
  "VISION_OVERLAY_UPDATED",
  "SCREENSHOT_PIPELINE_COMPLETED",
  "SCREENSHOT_PIPELINE_FAILED"
] as const;

export type ScreenshotTraceEventName = typeof SCREENSHOT_TRACE_EVENTS[number];
export type ScreenshotState = "idle" | "capturing" | "building_request" | "provider_pending" | "streaming" | "completed" | "failed" | "cancelled";

export interface ScreenshotTraceEvent {
  name: ScreenshotTraceEventName;
  timestamp: number;
  elapsedMs: number;
  sessionId?: string;
  questionId?: string;
  answerId?: string;
  screenshotRequestId: string;
  providerRequestId?: string;
  imageMimeType?: ScreenshotImage["mimeType"];
  imageBytes?: number;
  imageWidth?: number;
  imageHeight?: number;
  messageShape?: "text" | "multimodal";
  providerModel?: string;
  status?: ScreenshotState;
  reasonCode?: string;
  fields?: Record<string, unknown>;
}

export interface ScreenshotDiagnostics {
  activeScreenshotOperations: number;
  lastScreenshotState?: ScreenshotState;
  lastScreenshotError?: string;
  lastScreenshotRequestId?: string;
  lastCaptureBytes?: number;
  lastPipelineDurationMs?: number;
  activeAbortControllers: number;
  lastLifecycleEvent?: ScreenshotTraceEventName;
  lastLifecycleEventAt?: number;
}

interface ScreenshotOperation {
  requestId: string;
  sessionId?: string;
  state: ScreenshotState;
  controller: AbortController;
  startedAt: number;
  providerRequestId?: string;
}

export class ScreenshotTraceBuffer {
  private readonly events: ScreenshotTraceEvent[] = [];

  constructor(private readonly maxSize = 200) {}

  push(event: ScreenshotTraceEvent): void {
    this.events.push(event);
    while (this.events.length > this.maxSize) this.events.shift();
  }

  snapshot(limit = this.maxSize): ScreenshotTraceEvent[] {
    return this.events.slice(-Math.max(1, Math.min(this.events.length || 1, limit)));
  }

  clear(): void { this.events.length = 0; }
}

export class ScreenshotOperationRegistry {
  private readonly operations = new Map<string, ScreenshotOperation>();
  private lastState: ScreenshotState = "idle";
  private lastError: string | undefined;
  private lastRequestId: string | undefined;
  private lastFinishedRequestId: string | undefined;
  private lastCaptureBytes: number | undefined;
  private lastDurationMs: number | undefined;
  private lastEvent: ScreenshotTraceEventName | undefined;
  private lastEventAt: number | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  begin(requestId: string, sessionId?: string): ScreenshotOperation {
    if (this.operations.size > 0) throw new Error("SCREENSHOT_BUSY");
    const operation: ScreenshotOperation = {
      requestId,
      sessionId,
      state: "capturing",
      controller: new AbortController(),
      startedAt: this.now()
    };
    this.operations.set(requestId, operation);
    this.remember(requestId, "capturing");
    return operation;
  }

  get(requestId: string): ScreenshotOperation | undefined { return this.operations.get(requestId); }

  transition(requestId: string, state: ScreenshotState, providerRequestId?: string): ScreenshotOperation | undefined {
    const operation = this.operations.get(requestId);
    if (!operation) return undefined;
    operation.state = state;
    if (providerRequestId) operation.providerRequestId = providerRequestId;
    this.remember(requestId, state);
    return operation;
  }

  setCaptureBytes(requestId: string, bytes: number): void {
    if (this.operations.has(requestId)) this.lastCaptureBytes = bytes;
  }

  finish(requestId: string, state: Extract<ScreenshotState, "completed" | "failed" | "cancelled">, error?: string): void {
    const operation = this.operations.get(requestId);
    if (!operation) return;
    operation.state = state;
    this.lastError = error;
    this.lastDurationMs = Math.max(0, this.now() - operation.startedAt);
    this.lastFinishedRequestId = requestId;
    this.remember(requestId, state);
    this.operations.delete(requestId);
  }

  abortAll(): void {
    for (const operation of this.operations.values()) operation.controller.abort();
  }

  clear(): void { this.operations.clear(); }

  elapsedMs(requestId: string): number {
    const operation = this.operations.get(requestId);
    if (operation) return Math.max(0, this.now() - operation.startedAt);
    return this.lastFinishedRequestId === requestId ? this.lastDurationMs ?? 0 : 0;
  }

  recordEvent(name: ScreenshotTraceEventName, at = this.now()): void {
    this.lastEvent = name;
    this.lastEventAt = at;
  }

  diagnostics(): ScreenshotDiagnostics {
    return {
      activeScreenshotOperations: this.operations.size,
      lastScreenshotState: this.lastState,
      lastScreenshotError: this.lastError,
      lastScreenshotRequestId: this.lastRequestId,
      lastCaptureBytes: this.lastCaptureBytes,
      lastPipelineDurationMs: this.lastDurationMs,
      activeAbortControllers: [...this.operations.values()].filter((operation) => !operation.controller.signal.aborted).length,
      lastLifecycleEvent: this.lastEvent,
      lastLifecycleEventAt: this.lastEventAt
    };
  }

  private remember(requestId: string, state: ScreenshotState): void {
    this.lastState = state;
    this.lastRequestId = requestId;
    this.lastEventAt = this.now();
  }
}

export function createScreenshotRequestId(now: () => number = () => Date.now()): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `screenshot-${now()}-${uuid ?? Math.random().toString(36).slice(2, 10)}`;
}

export async function withScreenshotTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      const error = new Error("Screenshot pipeline timed out");
      error.name = "TimeoutError";
      reject(error);
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void task.catch(() => undefined);
  }
}
