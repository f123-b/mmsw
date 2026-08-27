import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AnswerAgent, ModelRouter, SessionStateMachine, type AnswerProvider, type QuestionCandidate } from "@interview-copilot/shared";
import { InterviewCoordinator } from "./interview-coordinator";
import type { RuntimeTraceEvent } from "./runtime-diagnostics";

class RuntimeTestAudio extends EventEmitter {
  isRunning = false;

  start(): void { this.isRunning = true; }
  stop(): void { this.isRunning = false; }
}

class RuntimeTestRealtime extends EventEmitter {
  connect(): void { this.emit("state", "connected"); }
  disconnect(): void { this.emit("state", "disconnected"); }
  sendAudio(): void { /* transport is intentionally inert */ }
  sendControl(): void { /* transport is intentionally inert */ }
}

function agent(provider: AnswerProvider): AnswerAgent {
  return new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "runtime-test-model" }));
}

function createRuntime(provider: AnswerProvider, options: Record<string, unknown> = {}) {
  const audio = new RuntimeTestAudio();
  const realtime = new RuntimeTestRealtime();
  const coordinator = new InterviewCoordinator({
    audio,
    realtime,
    session: new SessionStateMachine(),
    answerAgent: agent(provider),
    ...options
  });
  return { coordinator, audio, realtime };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`runtime test timeout: ${JSON.stringify(condition)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function trace(coordinator: InterviewCoordinator): RuntimeTraceEvent[] {
  return coordinator.getRuntimeTrace(300);
}

function names(coordinator: InterviewCoordinator): string[] {
  return trace(coordinator).map((item) => item.name);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

const question = (id: string, text = "为什么使用 DMA？"): QuestionCandidate => ({
  id,
  text,
  confidence: "high",
  score: 1,
  source: "extractor",
  detectedAt: Date.now(),
  status: "confirmed"
});

describe("realtime interview runtime lifecycle", () => {
  it("runs the short smoke chain through question finish and runtime idle", async () => {
    const provider: AnswerProvider = { stream: async function* () { yield "首个 token"; yield "，完整回答。"; } };
    const { coordinator, realtime } = createRuntime(provider, { questionSilenceMs: 180 });
    const benchmarkStartedAt = Date.now();
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", automationMode: "AUTO", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "smoke-question", source: "remote", text: "请解释 DMA 的作用？", startMs: 0, endMs: 500, final: true });
    await waitFor(() => names(coordinator).includes("QUESTION_FINISHED"));
    const lifecycle = names(coordinator);
    const required = [
      "INTERVIEW_SESSION_STARTED",
      "QUESTION_CONFIRMED",
      "ANSWER_REQUEST_CREATED",
      "PROJECT_CONTEXT_READY",
      "PROVIDER_STREAM_STARTED",
      "PROVIDER_FIRST_TOKEN",
      "PROVIDER_STREAM_COMPLETED",
      "ANSWER_COMMITTED",
      "QUESTION_FINISHED"
    ];
    for (const item of required) expect(lifecycle).toContain(item);
    for (let index = 1; index < required.length; index += 1) {
      expect(lifecycle.indexOf(required[index])).toBeGreaterThan(lifecycle.indexOf(required[index - 1]));
    }
    expect(lifecycle).toContain("OVERLAY_UPDATED");
    const beforeStopTrace = trace(coordinator);
    const stopStartedAt = Date.now();
    await coordinator.stop();
    const afterStopTrace = trace(coordinator);
    const finished = (name: RuntimeTraceEvent["name"]) => afterStopTrace.find((item) => item.name === name);
    const max = (field: "pendingQuestions" | "activeStreams") => Math.max(0, ...afterStopTrace.map((item) => item[field]));
    console.log("REALTIME_RUNTIME_BENCHMARK", JSON.stringify({
      startLatencyMs: Math.max(0, (beforeStopTrace.find((item) => item.name === "INTERVIEW_SESSION_STARTED")?.timestamp ?? benchmarkStartedAt) - benchmarkStartedAt),
      questionToAnswerStartMs: Math.max(0, (beforeStopTrace.find((item) => item.name === "PROVIDER_STREAM_STARTED")?.timestamp ?? benchmarkStartedAt) - (beforeStopTrace.find((item) => item.name === "QUESTION_CONFIRMED")?.timestamp ?? benchmarkStartedAt)),
      firstTokenLatencyMs: Math.max(0, (beforeStopTrace.find((item) => item.name === "PROVIDER_FIRST_TOKEN")?.timestamp ?? benchmarkStartedAt) - (beforeStopTrace.find((item) => item.name === "PROVIDER_STREAM_STARTED")?.timestamp ?? benchmarkStartedAt)),
      answerCompletionMs: Math.max(0, (beforeStopTrace.find((item) => item.name === "QUESTION_FINISHED")?.timestamp ?? benchmarkStartedAt) - (beforeStopTrace.find((item) => item.name === "PROVIDER_STREAM_STARTED")?.timestamp ?? benchmarkStartedAt)),
      stopLatencyMs: Math.max(0, (finished("RUNTIME_CLEANUP_COMPLETED")?.timestamp ?? stopStartedAt) - stopStartedAt),
      maxPendingQuestions: max("pendingQuestions"),
      maxActiveStreams: max("activeStreams"),
      leakedTimers: coordinator.getRuntimeDiagnostics().activeTimers,
      leakedListeners: coordinator.getRuntimeDiagnostics().activeListeners ?? 0,
      finalRuntimeIdle: coordinator.isRuntimeIdle()
    }));
    expect(names(coordinator)).toEqual(expect.arrayContaining(["INTERVIEW_SESSION_STOPPED", "RUNTIME_IDLE"]));
    expect(coordinator.isRuntimeIdle()).toBe(true);
    expect(coordinator.getRuntimeDiagnostics()).toMatchObject({ pendingQuestions: 0, activeAnswers: 0, activeStreams: 0, activeProviderRequests: 0, activeAbortControllers: 0, activeTimers: 0, answerQueueDepth: 0 });
  });

  it("stops without a question and tolerates repeated stop calls", async () => {
    const { coordinator } = createRuntime({ stream: async function* () { yield "unused"; } });
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    await Promise.all([coordinator.stop(), coordinator.stop(), coordinator.stop()]);
    await coordinator.stop();
    expect(coordinator.isRuntimeIdle()).toBe(true);
    expect(coordinator.runtimeState).toBe("stopped");
  });

  it("drains an unrequested confirmed question when MANUAL mode stops", async () => {
    const { coordinator, realtime } = createRuntime({ stream: async function* () { yield "unused"; } }, { questionSilenceMs: 180 });
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", automationMode: "MANUAL", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "manual-pending", source: "remote", text: "请说明 DMA 的作用？", startMs: 0, endMs: 500, final: true });
    await waitFor(() => names(coordinator).includes("QUESTION_CONFIRMED"));
    await coordinator.stop();
    expect(names(coordinator)).toContain("QUESTION_CANCELLED");
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });

  it("aborts a provider hang and force-closes local runtime state within the stop boundary", async () => {
    const provider: AnswerProvider = { stream: async function* () {
      await new Promise<void>(() => undefined);
      yield "never";
    } };
    const { coordinator } = createRuntime(provider, { stopTimeoutMs: 250, answerTimeoutMs: 5_000 });
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    void coordinator.answerQuestionText("为什么使用 DMA？");
    await waitFor(() => names(coordinator).includes("PROVIDER_STREAM_REQUESTED"));
    const startedAt = Date.now();
    await coordinator.stop();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(names(coordinator)).toEqual(expect.arrayContaining(["PROVIDER_STREAM_CANCELLED", "QUESTION_CANCELLED", "RUNTIME_CLEANUP_COMPLETED", "RUNTIME_IDLE"]));
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });

  it("closes a provider error after the first delta and remains controllable", async () => {
    const provider: AnswerProvider = { stream: async function* () {
      yield "已收到";
      throw new Error("provider offline");
    } };
    const { coordinator } = createRuntime(provider);
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    await coordinator.answerQuestionText("为什么使用 DMA？");
    expect(names(coordinator)).toEqual(expect.arrayContaining(["PROVIDER_STREAM_FAILED", "QUESTION_FAILED"]));
    expect(coordinator.runtimeState).toBe("running");
    await coordinator.stop();
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });

  it("fails a no-first-token provider without leaving a live timer", async () => {
    const provider: AnswerProvider = { stream: async function* () {
      await new Promise<void>(() => undefined);
      yield "late";
    } };
    const { coordinator } = createRuntime(provider, { providerFirstTokenTimeoutMs: 50, stopTimeoutMs: 250 });
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    void coordinator.answerQuestionText("为什么使用 DMA？");
    await waitFor(() => names(coordinator).includes("PROVIDER_STREAM_FAILED"));
    expect(names(coordinator)).toContain("QUESTION_FAILED");
    expect(coordinator.getRuntimeDiagnostics().activeTimers).toBe(0);
    await coordinator.stop();
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });

  it("drops late provider tokens and late transcripts after stop", async () => {
    let releaseProvider!: () => void;
    const provider: AnswerProvider = { stream: async function* () {
      await new Promise<void>((resolve) => { releaseProvider = resolve; });
      yield "late token";
    } };
    const { coordinator, realtime } = createRuntime(provider, { stopTimeoutMs: 250 });
    const messages: unknown[] = [];
    coordinator.on("event", (event: { type: string; message?: unknown }) => { if (event.type === "realtime_message") messages.push(event.message); });
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    void coordinator.answerQuestionText("为什么使用 DMA？");
    await waitFor(() => names(coordinator).includes("PROVIDER_STREAM_REQUESTED"));
    await waitFor(() => typeof releaseProvider === "function");
    await coordinator.stop();
    const messageCount = messages.length;
    realtime.emit("transcript", {}, { id: "late-transcript", source: "remote", text: "晚到的问题？", startMs: 0, endMs: 100, final: true });
    releaseProvider();
    await flush();
    expect(messages.length).toBe(messageCount);
    expect(names(coordinator)).toEqual(expect.arrayContaining(["STALE_RUNTIME_EVENT_DROPPED", "RUNTIME_IDLE"]));
    expect(coordinator.getRuntimeDiagnostics().pendingQuestions).toBe(0);
  });

  it("restarts without stale answer state, queue residue, or listener growth", async () => {
    let calls = 0;
    const provider: AnswerProvider = { stream: async function* () { calls += 1; yield `answer-${calls}`; } };
    const { coordinator, realtime } = createRuntime(provider);
    const listenerCount = realtime.listenerCount("transcript");
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    await coordinator.answerQuestionText("第一轮问题？");
    await coordinator.stop();
    expect(coordinator.isRuntimeIdle()).toBe(true);
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    await coordinator.answerQuestionText("第二轮问题？");
    await coordinator.stop();
    expect(calls).toBe(2);
    expect(realtime.listenerCount("transcript")).toBe(listenerCount);
    expect(coordinator.getRuntimeDiagnostics()).toMatchObject({ answerQueueDepth: 0, activeTimers: 0, activeAbortControllers: 0 });
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });

  it("deduplicates a repeated question request under the serial policy", async () => {
    let calls = 0;
    let release!: () => void;
    const provider: AnswerProvider = { stream: async function* () {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      yield "answer";
    } };
    const { coordinator } = createRuntime(provider, { stopTimeoutMs: 250 });
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    const sameQuestion = question("duplicate-question");
    void coordinator.answer(sameQuestion);
    await waitFor(() => names(coordinator).includes("PROVIDER_STREAM_REQUESTED"));
    void coordinator.answer(sameQuestion);
    await flush();
    expect(calls).toBe(1);
    release();
    await waitFor(() => names(coordinator).includes("QUESTION_FINISHED"));
    await coordinator.stop();
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });

  it("uses serial AUTO policy for three questions and finishes all of them", async () => {
    const provider: AnswerProvider = { stream: async function* (request) { yield `answer-${request.sections.find((item) => item.name === "question")?.content}`; } };
    const { coordinator } = createRuntime(provider);
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", automationMode: "AUTO", answerMode: "NORMAL" });
    for (const [index, text] of ["第一题是什么？", "第二题是什么？", "第三题是什么？"].entries()) {
      await coordinator.answerQuestionText(`${text}-${index}`);
    }
    await flush();
    const lifecycle = trace(coordinator);
    expect(lifecycle.filter((item) => item.name === "QUESTION_FINISHED")).toHaveLength(3);
    expect(coordinator.getRuntimeDiagnostics().pendingQuestions).toBe(0);
    await coordinator.stop();
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });

  it("times out a retrieval hang and still reaches runtime idle", async () => {
    const provider: AnswerProvider = { stream: async function* () { yield "unused"; } };
    const { coordinator } = createRuntime(provider, { contextTimeoutMs: 50, stopTimeoutMs: 250, contextProvider: () => new Promise(() => undefined) });
    await coordinator.start({ profileId: "runtime-profile", url: "wss://runtime.test", answerMode: "NORMAL" });
    void coordinator.answerQuestionText("为什么使用 DMA？");
    await waitFor(() => names(coordinator).includes("PROJECT_CONTEXT_STARTED"));
    await waitFor(() => names(coordinator).includes("PROJECT_CONTEXT_FAILED"));
    await coordinator.stop();
    expect(names(coordinator)).toEqual(expect.arrayContaining(["PROJECT_CONTEXT_FAILED", "QUESTION_FAILED", "RUNTIME_IDLE"]));
    expect(coordinator.isRuntimeIdle()).toBe(true);
  });
});
