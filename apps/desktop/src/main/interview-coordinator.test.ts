import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AnswerAgent, buildSessionTerminologyContext, InterviewHistoryStore, ModelRouter, QuestionDetector2, resolveInterviewDomainContext, SessionStateMachine, type AnswerProvider, type InterviewDirectionSelection, type QuestionCandidate } from "@interview-copilot/shared";
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

class OrderedAudio extends FakeAudio {
  constructor(private readonly order: string[]) { super(); }
  override start(options: Record<string, unknown>): void { this.order.push("audio-start"); super.start(options); this.emit("pcm-packet", new Uint8Array([1, 2, 3])); }
}

class OrderedRealtime extends FakeRealtime {
  constructor(private readonly order: string[]) { super(); }
  override connect(): void { this.order.push("asr-connect"); super.connect(); }
  override sendAudio(packet: Uint8Array): void { this.order.push(`pcm-${packet.byteLength}`); super.sendAudio(packet); }
}

async function* answerChunks(): AsyncGenerator<string> {
  yield "核心回答";
  yield "。";
}

describe("InterviewCoordinator software E2E", () => {
  it("passes an optional direction selection to the one-time terminology context build", async () => {
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    const agent = new AnswerAgent({ "low-latency": { stream: answerChunks } }, new ModelRouter({ "low-latency": "test-model" }));
    const selection: InterviewDirectionSelection = { mode: "hybrid", primaryDirectionId: "ai_application", secondaryDirectionIds: ["robotics_ros2"] };
    const provider = vi.fn(() => buildSessionTerminologyContext({ domainContext: resolveInterviewDomainContext({ selection, jd: "AI 应用和 ROS2" }) }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, terminologyContextProvider: provider });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL", directionSelection: selection });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith("p1", undefined, undefined, selection);
    await coordinator.stop();
  });

  it("connects ASR before capture so the first PCM packet is not dropped", async () => {
    const order: string[] = [];
    const audio = new OrderedAudio(order);
    const realtime = new OrderedRealtime(order);
    const agent = new AnswerAgent({ "low-latency": { stream: answerChunks } }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent });

    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });

    expect(order.slice(-3)).toEqual(["asr-connect", "audio-start", "pcm-3"]);
    await coordinator.stop();
  });

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
      expect.objectContaining({ type: "answer_end", text: expect.stringContaining("核心回答") })
    ]));
    expect(messages.some((message) => (message as { type?: string }).type === "answer_delta")).toBe(true);
    await coordinator.stop();
    expect(coordinator.running).toBe(false);
    expect(interviewId).toMatch(/^interview-/);
    vi.useRealTimers();
  });

  it("keeps QUESTION_TRACE telemetry out of renderer diagnostics", async () => {
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    const provider: AnswerProvider = { stream: async function* () { yield "直接回答。"; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => 1_000 });
    const events: Array<{ type: string; name?: string; message?: string }> = [];
    coordinator.on("event", (event: { type: string; name?: string; message?: string }) => events.push(event));
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    await coordinator.answerQuestionText("同步机制的作用是什么？");
    expect(events.some((event) => event.type === "telemetry" && event.name === "QUESTION_TRACE")).toBe(true);
    expect(events.some((event) => event.type === "diagnostic" && event.message?.startsWith("QUESTION_TRACE"))).toBe(false);
    await coordinator.stop();
  });

  it("uses a verified high-confidence question-bank answer without calling the model", async () => {
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let modelCalled = false;
    const provider: AnswerProvider = { stream: async function* () { modelCalled = true; yield "不应调用模型"; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({
      audio,
      realtime,
      session: new SessionStateMachine(),
      answerAgent: agent,
      contextProvider: async () => ({ preparedAnswer: { content: "volatile 用于告诉编译器变量可能被外部异步修改，不能依赖缓存值。", score: 0.96, verified: true } }),
      now: () => 1_000
    });
    const messages: unknown[] = [];
    const traces: Array<Record<string, unknown>> = [];
    coordinator.on("event", (event: { type: string; message?: unknown; name?: string; fields?: Record<string, unknown> }) => {
      if (event.type === "realtime_message") messages.push(event.message);
      if (event.type === "telemetry" && event.name === "QUESTION_TRACE" && event.fields) traces.push(event.fields);
    });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    await coordinator.answerQuestionText("volatile 的作用是什么？");
    expect(modelCalled).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "answer_end", text: expect.stringContaining("volatile") })]));
    expect(traces.at(-1)).toEqual(expect.objectContaining({ answerSource: "question-bank" }));
    expect(traces.at(-1)?.llmRequestAt).toBeUndefined();
    expect(traces.at(-1)?.firstTokenAt).toBeUndefined();
    await coordinator.stop();
  });

  it("uses verified project QA and approved self introduction directly without a provider request", async () => {
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let modelCalls = 0;
    const provider: AnswerProvider = { stream: async function* () { modelCalls += 1; yield "不应调用模型"; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, contextProvider: (question) => ({ preparedAnswer: { content: question.text.includes("项目") ? "项目题库已确认答案。" : "我是一名嵌入式工程师。", score: 1, verified: true }, answerSourcePlan: question.text.includes("项目") ? { mode: "project_qa_direct", projectAnchorAvailable: true, projectQuestionRequested: true, projectId: "p1", qaMatchLevel: "exact", preserveStoredAnswerFacts: true, allowProjectKnowledge: false, allowGeneralKnowledge: false, allowSessionEvidence: true, answerRewriteUsed: false } : { mode: "self_intro_direct", projectAnchorAvailable: false, projectQuestionRequested: false, qaMatchLevel: "none", preserveStoredAnswerFacts: true, allowProjectKnowledge: false, allowGeneralKnowledge: false, allowSessionEvidence: false, answerRewriteUsed: false }, questionTelemetry: { selfIntroductionDetected: !question.text.includes("项目"), projectQuestionRequested: question.text.includes("项目") } }) });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    await coordinator.answerQuestionText("介绍一下你的项目");
    await coordinator.answerQuestionText("请做个自我介绍");
    expect(modelCalls).toBe(0);
    await coordinator.stop();
  });

  it("carries candidate statements into the next personal follow-up", async () => {
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let prompt = "";
    const provider: AnswerProvider = { stream: async function* (request) {
      prompt = request.sections.map((section) => section.content).join("\n");
      yield "可以沿着采样数据、标注口径和验证集继续说明。";
    } };
    const coordinator = new InterviewCoordinator({
      audio,
      realtime,
      session: new SessionStateMachine(),
      answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" })),
      contextProvider: () => ({}),
      now: () => 1_000
    });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "candidate-1", source: "mic", text: "我的语音识别准确率大约98%。", startMs: 0, endMs: 800, final: true, confidence: 0.95 });
    await coordinator.answerQuestionText("这个98%是怎么做到的？");
    expect(prompt).toContain("我的语音识别准确率大约98%");
    expect(prompt).toContain("candidate_asserted");
    await coordinator.stop();
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

  it("promotes an implicit follow-up using the remembered topic", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    const provider: AnswerProvider = { stream: async function* () { yield "我会结合项目回答。"; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => clock });
    const confirmed: string[] = [];
    coordinator.on("event", (event: { type: string; event?: { type?: string; question?: { text?: string } } }) => {
      if (event.type === "question" && event.event?.type === "question_confirmed") confirmed.push(event.event.question?.text ?? "");
    });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "topic", source: "remote", text: "介绍一下你的FOC项目", startMs: 0, endMs: 900, final: true });
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    realtime.emit("transcript", {}, { id: "implicit", source: "remote", text: "好，说说", startMs: 2_000, endMs: 2_600, final: true });
    clock = 3_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
    expect(confirmed.some((text) => text === "好，说说")).toBe(true);
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("keeps short prompts and punctuation-split prompts from the recorded interview", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    const provider: AnswerProvider = { stream: async function* () { yield "不会自动回答"; } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => clock });
    const confirmed: string[] = [];
    coordinator.on("event", (event: { type: string; event?: { type?: string; question?: { text?: string } } }) => {
      if (event.type === "question" && event.event?.type === "question_confirmed") confirmed.push(event.event.question?.text ?? "");
    });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "v1", source: "remote", text: "请解释 volatile。", startMs: 0, endMs: 900, final: true });
    realtime.emit("transcript", {}, { id: "v2", source: "remote", text: "关键字的作用。", startMs: 900, endMs: 1_600, final: true });
    realtime.emit("transcript", {}, { id: "v3", source: "remote", text: "以及常见误区，十五秒。", startMs: 1_600, endMs: 2_300, final: true });
    clock = 3_000;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(confirmed.some((text) => text.includes("volatile") && text.includes("关键字") && text.includes("常见误区"))).toBe(true);
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("waits for trailing ASR fragments before answering a long interviewer question", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    let requestedQuestion = "";
    const provider: AnswerProvider = { stream: async function* (request) {
      requestedQuestion = request.sections.find((section) => section.name === "question")?.content ?? "";
      yield "完整回答";
    } };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, now: () => clock });
    const starts: unknown[] = [];
    coordinator.on("event", (event: { type: string; message?: unknown }) => {
      if (event.type === "realtime_message" && (event.message as { type?: string })?.type === "answer_start") starts.push(event.message);
    });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    const emit = (id: string, text: string, startMs: number, endMs: number) => realtime.emit("transcript", {}, { id, source: "remote", text, startMs, endMs, final: true });
    emit("q1", "行，下一个，说说你遇到过最难定位的一个问题，比如。", 0, 1_000);
    emit("q2", "急速抖动。", 1_020, 1_300);
    emit("q3", "当时你怎么一步步排查的？关键转折点是什么？", 1_320, 2_000);
    emit("q4", "最后。", 2_020, 2_160);
    emit("q5", "怎么验证？", 2_180, 2_400);
    expect(starts).toHaveLength(0);
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 24; turn += 1) await Promise.resolve();
    expect(starts).toHaveLength(1);
    expect(requestedQuestion).toContain("急速抖动");
    expect(requestedQuestion).toContain("一步步排查");
    expect(requestedQuestion).toContain("怎么验证");
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("answers the substantive IIC question before trailing remote repair fragments", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    let clock = 1_000;
    const requestedQuestions: string[] = [];
    const provider: AnswerProvider = { stream: async function* (request) {
      requestedQuestions.push(request.sections.find((section) => section.name === "question")?.content ?? "");
      yield "IIC 排查回答";
    } };
    const detector = new QuestionDetector2({
      localClassifier: {
        predict: async (text) => text.includes("怎么回答") ? { type: "FOLLOW_UP", confidence: 0.96 } : { type: "QUESTION", confidence: 0.96 }
      }
    });
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, questionDetector2: detector, now: () => clock });
    const starts: unknown[] = [];
    coordinator.on("event", (event: { type: string; message?: unknown }) => { if (event.type === "realtime_message" && (event.message as { type?: string })?.type === "answer_start") starts.push(event.message); });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    const emit = (id: string, text: string, startMs: number, endMs: number) => realtime.emit("transcript", {}, { id, source: "remote", text, startMs, endMs, final: true });
    emit("iic-question", "好，那我问 IIC 吧。如果 IIC 通讯啊，偶发读不到数据或者总线被拉低卡死，你会怎么排查？", 0, 3_200);
    emit("iic-detail", "比如说从硬件连接、上拉电阻、时序、地址、ACK、软件超时恢复这些角度。", 3_300, 5_200);
    emit("ack", "那。", 5_600, 5_800);
    emit("opinion", "你觉得呢？", 6_000, 6_300);
    emit("meta", "怎么回答？", 6_500, 6_800);
    emit("filler", "嗯。", 7_000, 7_100);
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    expect(requestedQuestions[0]).toContain("IIC");
    expect(starts).toHaveLength(1);
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
    expect(snapshot.answers.every((answer) => answer.model === "test-model" && answer.latencyFirstToken !== undefined && answer.latencyTotal !== undefined && answer.telemetry?.canonicalText && answer.telemetry.technicalGuardDecision)).toBe(true);
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

  it("queues rapid follow-up questions without cancelling the in-flight answer", async () => {
    vi.useFakeTimers();
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    const history = new InterviewHistoryStore();
    let clock = 1_000;
    let calls = 0;
    let releaseFirst!: () => void;
    const firstAnswerGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const provider: AnswerProvider = { stream: () => (async function* () { if (calls++ === 0) { yield "第一题答案"; await firstAnswerGate; yield "完成"; } else yield "第二题答案"; })() };
    const agent = new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" }));
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: agent, history, now: () => clock });
    const messages: Array<{ type: string; reason?: string }> = [];
    const questionEvents: Array<{ type: string; question?: { id: string; groupId?: string; relationType?: string } }> = [];
    coordinator.on("event", (event: { type: string; message?: { type: string; reason?: string }; event?: { type: string; question?: { id: string; groupId?: string; relationType?: string } } }) => {
      if (event.type === "realtime_message" && event.message) messages.push(event.message);
      if (event.type === "question" && event.event) questionEvents.push(event.event);
    });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "AUTO", answerMode: "NORMAL" });
    realtime.emit("transcript", {}, { id: "q1", source: "remote", text: "为什么要分层？", startMs: 0, endMs: 900, final: true });
    clock = 1_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    realtime.emit("transcript", {}, { id: "q2", source: "remote", text: "那如果换成 RTOS？", startMs: 2_000, endMs: 2_900, final: true });
    clock = 3_600;
    vi.advanceTimersByTime(500);
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    expect(messages.some((message) => message.type === "answer_cancelled")).toBe(false);
    releaseFirst();
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    expect(messages.filter((message) => message.type === "answer_end")).toHaveLength(2);
    const confirmed = questionEvents.filter((event) => event.type === "question_confirmed");
    expect(confirmed).toHaveLength(2);
    expect(confirmed[1]?.question?.groupId).toBe(confirmed[0]?.question?.groupId);
    expect(confirmed[1]?.question?.relationType).toBe("FOLLOW_UP");
    const snapshot = history.snapshot(coordinator.interviewId!);
    expect(snapshot.answers.map((answer) => answer.text)).toEqual(["第一题答案完成", "第二题答案"]);
    expect(snapshot.questions.every((question) => question.status === "answered")).toBe(true);
    await coordinator.stop();
    vi.useRealTimers();
  });

  it("merges a same-group constraint before the provider request without starting a duplicate answer", async () => {
    let releaseContext!: () => void;
    const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
    let providerCalls = 0;
    let requestedQuestion = "";
    const provider: AnswerProvider = { stream: async function* (request) {
      providerCalls += 1;
      requestedQuestion = request.sections.find((section) => section.name === "question")?.content ?? "";
      yield "合并后的回答";
    } };
    const coordinator = new InterviewCoordinator({
      audio: new FakeAudio(),
      realtime: new FakeRealtime(),
      session: new SessionStateMachine(),
      answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" })),
      contextProvider: async () => { await contextGate; return {}; }
    });
    let baseQuestion: QuestionCandidate | undefined;
    coordinator.on("event", (event: { type: string; event?: { type?: string; question?: QuestionCandidate } }) => {
      if (event.type === "question" && event.event?.type === "question_confirmed") baseQuestion = event.event.question;
    });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    const baseTask = coordinator.answerQuestionText("C语言里，指针和数组有什么区别？");
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    expect(baseQuestion?.groupId).toBeDefined();
    await coordinator.answer({ id: "constraint-before-token", text: "请从空间大小和常见风险这几个角度也说一下", confidence: "high", score: 1, source: "extractor", detectedAt: 1_100, status: "confirmed", groupId: baseQuestion?.groupId, relationType: "ANSWER_CONSTRAINT", answerable: false });
    releaseContext();
    await baseTask;

    expect(providerCalls).toBe(1);
    expect(requestedQuestion).toContain("C语言里，指针和数组有什么区别？");
    expect(requestedQuestion).toContain("空间大小和常见风险这几个角度也说一下");
    await coordinator.stop();
  });

  it("closes the answer state when the model fails after answer_start", async () => {
    const audio = new FakeAudio();
    const realtime = new FakeRealtime();
    const provider: AnswerProvider = { stream: async function* () { yield "已经收到"; throw new Error("provider offline"); } };
    const coordinator = new InterviewCoordinator({ audio, realtime, session: new SessionStateMachine(), answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "test-model" })) });
    const messages: Array<{ type: string; reason?: string }> = [];
    coordinator.on("event", (event: { type: string; message?: { type: string; reason?: string } }) => { if (event.type === "realtime_message" && event.message) messages.push(event.message); });
    await coordinator.start({ profileId: "p1", url: "wss://asr.test/realtime", automationMode: "MANUAL", answerMode: "NORMAL" });
    await coordinator.answerQuestionText("为什么使用 DMA？");
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "answer_start" }), expect.objectContaining({ type: "answer_cancelled", reason: "timeout" }), expect.objectContaining({ type: "runtime_error", code: "LLM_FAILED" })]));
    await coordinator.stop();
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
