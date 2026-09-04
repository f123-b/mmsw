import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerAgent, InterviewHistoryStore, ModelRouter, SessionStateMachine, type AnswerContextInput, type AnswerProvider, type QuestionCandidate } from "@interview-copilot/shared";
import { InterviewCoordinator, type InterviewCoordinatorEvent } from "./interview-coordinator";

class Audio extends EventEmitter { isRunning = false; start() { this.isRunning = true; } stop() { this.isRunning = false; } }
class Realtime extends EventEmitter { connect() { this.emit("state", "connected"); } disconnect() { this.emit("state", "disconnected"); } sendAudio() {} sendControl() {} }

async function createSession(contextProvider?: (question: QuestionCandidate) => AnswerContextInput, provider?: AnswerProvider) {
  vi.useFakeTimers();
  const realtime = new Realtime();
  const history = new InterviewHistoryStore();
  const questions: QuestionCandidate[] = [];
  const events: InterviewCoordinatorEvent[] = [];
  const requests: string[] = [];
  const coordinator = new InterviewCoordinator({
    audio: new Audio(), realtime, history, session: new SessionStateMachine(), contextProvider,
    providerFirstTokenTimeoutMs: 600,
    answerAgent: new AnswerAgent({ "low-latency": provider ?? { stream: async function* (request) { requests.push(request.sections.find((section) => section.name === "question")?.content ?? ""); yield "这是针对当前问题的回答。"; } } }, new ModelRouter({ "low-latency": "replay" }))
  });
  coordinator.on("event", (event: InterviewCoordinatorEvent) => {
    events.push(event);
    if (event.type === "question" && event.event.type === "question_confirmed") questions.push(event.event.question);
  });
  await coordinator.start({ profileId: "replay", projectId: "foc", projectCandidates: [{ id: "foc", name: "FOC 电机控制", aliases: ["FOC"], entities: ["FOC", "DMA", "ADC", "PWM"] }], url: "wss://replay.test", runtimeMode: "ACCURATE_INTERVIEW", automationMode: "AUTO", answerMode: "NORMAL" });
  const interviewId = coordinator.interviewId!;
  let sequence = 0;
  let time = 0;
  return { coordinator, history, interviewId, questions, events, requests,
    async push(text: string, gap = 1_000) {
      await vi.advanceTimersByTimeAsync(gap);
      time += gap;
      realtime.emit("transcript", {}, { id: `fragment-${++sequence}`, source: "remote", text, rawText: text, final: true, startMs: time, endMs: time + 250, confidence: 0.98 });
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

afterEach(() => vi.useRealTimers());

describe("September 3 desktop production chain regression", () => {
  it("excludes manual waiting from generation latency", async () => {
    const s = await createSession();
    try {
      s.coordinator.setAutomationMode("MANUAL");
      await s.push("什么是SPI？");
      await vi.advanceTimersByTimeAsync(60_000);
      await s.coordinator.answerLatest();
      const answer = s.history.snapshot(s.interviewId).answers[0];
      expect(answer?.latencyFirstToken).toBeLessThan(1_000);
      expect(answer?.latencyTotal).toBeLessThan(1_000);
      expect(answer?.telemetry?.providerFirstTokenMs).toBeLessThan(1_000);
    } finally { await s.coordinator.stop(); }
  });
  it("preserves the real DMA fragments after unrelated questions and fillers", async () => {
    const s = await createSession();
    try {
      await s.push("线程和进程有什么区别？");
      await s.push("嗯。", 10_000);
      await s.push("那DMA。", 6_000);
      await s.push("的原理是什么？", 2_000);
      await vi.advanceTimersByTimeAsync(3_000);
      const dma = s.questions.find((question) => /DMA/iu.test(question.text));
      expect(dma?.text).toMatch(/DMA.*原理/u);
      expect(dma?.text).not.toMatch(/线程|进程|vector/iu);
      expect(s.questions).toHaveLength(2);
      expect(new Set(s.questions.map((question) => question.groupId)).size).toBe(2);
    } finally { await s.coordinator.stop(); }
  });

  it("answers a project question after a QA miss and still answers the next independent question", async () => {
    const s = await createSession((question) => /项目/u.test(question.text) ? {
      answerSourcePlan: { mode: "project_qa_no_match", projectAnchorAvailable: true, projectQuestionRequested: true, projectId: "foc", qaMatchLevel: "none", preserveStoredAnswerFacts: false, allowProjectKnowledge: false, allowGeneralKnowledge: false, allowSessionEvidence: false, answerRewriteUsed: false, strictProjectQa: true }
    } : {});
    try {
      await s.push("这个FOC项目你主要负责什么？");
      await s.push("什么是SPI？", 12_000);
      await vi.advanceTimersByTimeAsync(3_000);
      const snapshot = s.history.snapshot(s.interviewId);
      expect(snapshot.questions.map((question) => question.status)).toEqual(["answered", "answered"]);
      expect(s.requests.length).toBeGreaterThanOrEqual(2);
      expect(s.events.some((event) => event.type === "realtime_message" && event.message.type === "runtime_error" && event.message.code === "PROJECT_EVIDENCE_REQUIRED")).toBe(false);
    } finally { await s.coordinator.stop(); }
  });

  it("measures provider tokens separately and streams an ordinary technical answer", async () => {
    const s = await createSession(undefined, { stream: async function* () {
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield "SPI 是同步串行接口，主机提供时钟。";
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      yield "常见信号为 SCLK、MOSI、MISO 和片选。";
    } });
    try {
      await s.push("什么是SPI？");
      await vi.advanceTimersByTimeAsync(700);
      expect(s.events.some((event) => event.type === "realtime_message" && event.message.type === "answer_delta")).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      const answer = s.history.snapshot(s.interviewId).answers[0];
      expect(answer?.cancelReason).toBeUndefined();
      expect(answer?.telemetry?.providerFirstTokenMs).toBeLessThan(600);
      expect(answer?.latencyTotal).toBeGreaterThan(answer?.latencyFirstToken ?? 0);
    } finally { await s.coordinator.stop(); }
  });
});
