import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AnswerAgent, InterviewHistoryStore, ModelRouter, SessionStateMachine, type AnswerProvider } from "@interview-copilot/shared";
import { InterviewCoordinator } from "./interview-coordinator";

class FakeAudio extends EventEmitter {
  started?: Record<string, unknown>;
  start(options: Record<string, unknown>): void { this.started = options; }
  stop(): void { this.emit("stopped"); }
}

class FakeRealtime extends EventEmitter {
  lastPacket?: Uint8Array;
  connect(): void { this.emit("state", "connected"); }
  disconnect(): void { this.emit("state", "disconnected"); }
  sendAudio(packet: Uint8Array): void { this.lastPacket = packet; }
  sendControl(message: unknown): void { this.emit("control", message); }
}

async function* answerChunks(): AsyncGenerator<string> {
  yield "核心回答";
  yield "。";
}

describe("InterviewCoordinator software E2E", () => {
  it("runs PCM transport, ASR final, aggregation, question, answer and history", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    const provider: AnswerProvider = { stream: () => answerChunks() };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => clock });
    const messages: unknown[] = [];
    const questions: unknown[] = [];
    coordinator.on("event", (event: { type: string; message?: unknown; event?: unknown }) => {
      if (event.type === "realtime_message") messages.push(event.message);
      if (event.type === "question") questions.push(event.event);
    });

    const interviewId = await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    expect(audio.started?.meterOnly).toBe(false);
    audio.emit("pcm-packet", new Uint8Array(2_560));
    expect(realtime.lastPacket?.byteLength).toBe(2_560);
    realtime.emit("transcript", { source: "remote", final: [] }, { id: "r1", source: "remote", text: "请介绍一下项目", startMs: 0, endMs: 900, final: true });
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(questions.some((event) => (event as { type: string }).type === "question_confirmed")).toBe(true);
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "answer_start" }),
      expect.objectContaining({ type: "answer_delta", delta: "核心回答" }),
      expect.objectContaining({ type: "answer_end", text: "核心回答。" })
    ]));
    await coordinator.stop();
    expect(coordinator.running).toBe(false);
    expect(interviewId).toMatch(/^interview-/);
    vi.useRealTimers();
  });

  it("uses a remote partial to prepare detection and confirms on the final transcript", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    const provider: AnswerProvider = { stream: async function* () { yield "核心回答"; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => clock });
    const events: unknown[] = [];
    coordinator.on("event", (event: { type: string; event?: unknown }) => { if (event.type === "question") events.push(event.event); });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "partial", source: "remote", text: "如果重新设计", startMs: 0, endMs: 500, final: false });
    expect(events.some((event) => (event as { type: string }).type === "question_candidate")).toBe(true);
    realtime.emit("transcript", {}, { id: "final", source: "remote", text: "如果重新设计，你会怎么优化？", startMs: 0, endMs: 900, final: true });
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(events.some((event) => (event as { type: string }).type === "question_confirmed")).toBe(true);
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("answers three consecutive questions in AUTO and persists answered status", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    const history = new InterviewHistoryStore();
    let clock = 1_000;
    const provider: AnswerProvider = { stream: async function* (request) { yield `回答 ${request.sections.find((section) => section.name === "question")?.content ?? ""}`; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, history, now: () => clock });
    const messages: Array<{ type: string }> = [];
    coordinator.on("event", (event: { type: string; message?: { type: string } }) => { if (event.type === "realtime_message" && event.message) messages.push(event.message); });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    for (const [index, text] of ["请介绍项目？", "为什么这样设计？", "如果换成 RTOS 呢？"].entries()) {
      clock = 1_000 + index * 2_000;
      realtime.emit("transcript", {}, { id: `r${index}`, source: "remote", text, startMs: index * 2_000, endMs: index * 2_000 + 900, final: true });
      clock += 600;
      vi.advanceTimersByTime(500);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    }
    expect(messages.filter((message) => message.type === "answer_start")).toHaveLength(3);
    expect(messages.filter((message) => message.type === "answer_end")).toHaveLength(3);
    const snapshot = history.snapshot(coordinator.interviewId!);
    expect(snapshot.questions).toHaveLength(3);
    expect(snapshot.questions.every((question) => question.status === "answered")).toBe(true);
    expect(snapshot.answers).toHaveLength(3);
    expect(snapshot.answers.every((answer) => answer.model === "test-model" && answer.latencyFirstToken !== undefined && answer.latencyTotal !== undefined)).toBe(true);
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("switches MANUAL and AUTO at runtime through the coordinator", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    const provider: AnswerProvider = { stream: async function* () { yield "回答"; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => clock });
    const starts: unknown[] = [];
    coordinator.on("event", (event: { type: string; message?: unknown }) => { if (event.type === "realtime_message" && (event.message as { type?: string })?.type === "answer_start") starts.push(event.message); });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "manual", source: "remote", text: "请手动回答？", startMs: 0, endMs: 900, final: true });
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    expect(starts).toHaveLength(0);
    coordinator.setAutomationMode("AUTO");
    clock = 3_600;
    realtime.emit("transcript", {}, { id: "auto", source: "remote", text: "那如果换成 RTOS 呢？", startMs: 2_000, endMs: 2_900, final: true });
    clock = 4_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(starts).toHaveLength(1);
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("cancels an in-flight answer when a new question supersedes it", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    const history = new InterviewHistoryStore();
    let clock = 1_000;
    let calls = 0;
    const provider: AnswerProvider = { stream: (_request, signal) => (async function* () { if (calls++ === 0) { yield "旧答案"; await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } else yield "新答案"; })() };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, history, now: () => clock });
    const messages: Array<{ type: string; reason?: string }> = [];
    coordinator.on("event", (event: { type: string; message?: { type: string; reason?: string } }) => { if (event.type === "realtime_message" && event.message) messages.push(event.message); });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "q1", source: "remote", text: "为什么要分层？", startMs: 0, endMs: 900, final: true });
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    realtime.emit("transcript", {}, { id: "q2", source: "remote", text: "那如果换成 RTOS？", startMs: 2_000, endMs: 2_900, final: true });
    clock = 3_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "answer_cancelled", reason: "superseded" }), expect.objectContaining({ type: "answer_end" })]));
    const snapshot = history.snapshot(coordinator.interviewId!);
    expect(snapshot.answers.find((answer) => answer.cancelReason === "superseded")?.text).toBe("旧答案");
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("AUTOMATION_DEFAULT_AUTO", () => {
    const coordinator = new InterviewCoordinator({ audio: new FakeAudio(), realtime: new FakeRealtime(), session: new SessionStateMachine(), answerAgent: new AnswerAgent({ "low-latency": { stream: answerChunks } }, new ModelRouter({ "low-latency": "test-model" })) });
    expect(coordinator.automationMode).toBe("AUTO");
  });

  it("AUTOMATION_IDLE_SET_UPDATES_DEFAULT", () => {
    const coordinator = new InterviewCoordinator({ audio: new FakeAudio(), realtime: new FakeRealtime(), session: new SessionStateMachine(), answerAgent: new AnswerAgent({ "low-latency": { stream: answerChunks } }, new ModelRouter({ "low-latency": "test-model" })), initialAutomationMode: "MANUAL" });
    expect(coordinator.automationMode).toBe("MANUAL");
    coordinator.setAutomationMode("AUTO");
    expect(coordinator.automationMode).toBe("AUTO");
  });

  it("AUTOMATION_ACTIVE_SET_UPDATES_CURRENT", async () => {
    const coordinator = new InterviewCoordinator({ audio: new FakeAudio(), realtime: new FakeRealtime(), session: new SessionStateMachine(), answerAgent: new AnswerAgent({ "low-latency": { stream: answerChunks } }, new ModelRouter({ "low-latency": "test-model" })) });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", answerMode: "NORMAL" });
    coordinator.setAutomationMode("MANUAL");
    expect(coordinator.automationMode).toBe("MANUAL");
    await coordinator.stop();
  });

  it("SCREENSHOT_WITHOUT_CURRENT_QUESTION", async () => {
    let requestedQuestion = "";
    const provider: AnswerProvider = { stream: async function* (request) { requestedQuestion = request.sections.find((section) => section.name === "question")?.content ?? ""; yield "截图回答"; } };
    const history = new InterviewHistoryStore();
    const coordinator = new InterviewCoordinator({ audio: new FakeAudio(), realtime: new FakeRealtime(), session: new SessionStateMachine(), answerAgent: new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "vision-model" })), history });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", answerMode: "NORMAL" });
    await coordinator.answerScreenshot("data:image/png;base64,mock");
    expect(requestedQuestion).toBe("请分析截图中的题目、代码或内容，并给出适合面试场景的回答。");
    expect(history.snapshot(coordinator.interviewId!).questions[0]?.text).toBe(requestedQuestion);
    await coordinator.stop();
  });

  it.each(["FAST", "NORMAL", "DEEP"] as const)("SCREENSHOT_ANSWER_%s", async (mode) => {
    let requestedMode = "";
    let hasAttachment = false;
    const provider: AnswerProvider = { stream: async function* (request) {
      requestedMode = request.sections.find((section) => section.name === "interview-style")?.content ?? "";
      hasAttachment = Boolean(request.attachments?.some((attachment) => attachment.dataUrl.startsWith("data:image/")));
      yield "截图回答";
    } };
    const coordinator = new InterviewCoordinator({ audio: new FakeAudio(), realtime: new FakeRealtime(), session: new SessionStateMachine(), answerAgent: new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "vision-model" })) });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", answerMode: mode });
    await coordinator.answerScreenshot("data:image/png;base64,mock");
    expect(requestedMode).toContain(`回答模式：${mode}`);
    expect(hasAttachment).toBe(true);
    await coordinator.stop();
  });

  it("SCREENSHOT_WITH_CURRENT_QUESTION", async () => {
    let requestedQuestion = "";
    let hasAttachment = false;
    const provider: AnswerProvider = { stream: async function* (request) { requestedQuestion = request.sections.find((section) => section.name === "question")?.content ?? ""; hasAttachment = Boolean(request.attachments?.length); yield "截图回答"; } };
    const realtime = new FakeRealtime();
    const coordinator = new InterviewCoordinator({ audio: new FakeAudio(), realtime, session: new SessionStateMachine(), answerAgent: new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "vision-model" })) });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "q-shot", source: "remote", text: "请解释这段代码？", startMs: 0, endMs: 900, final: true });
    await new Promise((resolve) => setTimeout(resolve, 550));
    await coordinator.answerScreenshot("data:image/png;base64,mock");
    expect(requestedQuestion).toContain("请解释这段代码");
    expect(hasAttachment).toBe(true);
    await coordinator.stop();
  });
});
