import { describe, expect, it, vi } from "vitest";
import { RuntimeAbortRegistry, RuntimeLatencyTelemetry, RuntimeTimerRegistry, RuntimeTraceBuffer, withRuntimeTimeout, type RuntimeTraceEvent } from "./runtime-diagnostics";

const event = (name: RuntimeTraceEvent["name"], timestamp: number): RuntimeTraceEvent => ({
  name,
  timestamp,
  sessionState: "running",
  pendingQuestions: 0,
  activeAnswers: 0,
  activeStreams: 0,
  transcriptQueueDepth: 0,
  answerQueueDepth: 0,
  activeAbortControllers: 0,
  activeTimers: 0,
  activeProviderRequests: 0
});

describe("runtime diagnostics primitives", () => {
  it("clears named timers and bounds the trace buffer", () => {
    vi.useFakeTimers();
    const timers = new RuntimeTimerRegistry();
    let fired = 0;
    timers.set("question", () => { fired += 1; }, 50);
    timers.set("question", () => { fired += 10; }, 50);
    expect(timers.size).toBe(1);
    timers.clear("question");
    vi.advanceTimersByTime(100);
    expect(fired).toBe(0);
    timers.set("answer", () => { fired += 1; }, 50);
    vi.advanceTimersByTime(50);
    expect(fired).toBe(1);
    expect(timers.size).toBe(0);

    const traces = new RuntimeTraceBuffer(2);
    traces.push(event("INTERVIEW_SESSION_STARTED", 1));
    traces.push(event("TRANSCRIPT_RECEIVED", 2));
    traces.push(event("QUESTION_DETECTED", 3));
    expect(traces.snapshot().map((item) => item.name)).toEqual(["TRANSCRIPT_RECEIVED", "QUESTION_DETECTED"]);
    vi.useRealTimers();
  });

  it("owns and aborts every registered controller", () => {
    const registry = new RuntimeAbortRegistry();
    const first = registry.create("first");
    const second = registry.create("second");
    expect(registry.size).toBe(2);
    registry.abortAll();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    registry.delete("first");
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it("returns a bounded timeout result without leaving the timer registered", async () => {
    vi.useFakeTimers();
    const result = withRuntimeTimeout(new Promise<string>(() => undefined), 25);
    vi.advanceTimersByTime(25);
    await expect(result).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("reports bounded p50, p95, and max latency for each runtime stage", () => {
    const telemetry = new RuntimeLatencyTelemetry();
    [10, 20, 30, 40].forEach((duration, index) => {
      const id = `q-${index}`;
      telemetry.start(id, 0);
      telemetry.mark(id, "questionConfirmedAt", duration);
      telemetry.mark(id, "providerRequestStartedAt", duration + 2);
      telemetry.mark(id, "providerFirstTokenAt", duration + 5);
      telemetry.mark(id, "firstVisibleTokenAt", duration + 6);
      telemetry.mark(id, "fastContextStartedAt", 1);
      telemetry.mark(id, "fastContextCompletedAt", 1 + duration);
      telemetry.setDuration(id, "claimGateMs", duration / 10);
    });

    const metrics = telemetry.metrics();
    expect(metrics.sampleCount).toBe(4);
    expect(metrics.stages.asrFinalToQuestionConfirmedMs).toMatchObject({ count: 4, p50: 20, p95: 40, max: 40 });
    expect(metrics.stages.providerRequestToFirstTokenMs).toMatchObject({ count: 4, p50: 3, p95: 3, max: 3 });
    expect(metrics.stages.claimGateMs).toMatchObject({ count: 4, p50: 2, p95: 4, max: 4 });
  });
});
