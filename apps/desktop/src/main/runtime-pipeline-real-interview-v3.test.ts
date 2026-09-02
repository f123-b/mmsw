import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../../../tests/fixtures/real-interview-20260902.json";
import { AnswerAgent, ModelRouter, SessionStateMachine, type AnswerContextInput, type QuestionCandidate } from "@interview-copilot/shared";
import { InterviewCoordinator } from "./interview-coordinator";

class ReplayAudio extends EventEmitter {
  isRunning = false;
  start(): void { this.isRunning = true; }
  stop(): void { this.isRunning = false; }
}

class ReplayRealtime extends EventEmitter {
  connect(): void { this.emit("state", "connected"); }
  disconnect(): void { this.emit("state", "disconnected"); }
  sendAudio(): void { /* replay transport */ }
  sendControl(): void { /* replay transport */ }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

async function replayCase(item: typeof fixture[number]): Promise<{ confirmed: QuestionCandidate[]; traceNames: string[] }> {
  const audio = new ReplayAudio();
  const realtime = new ReplayRealtime();
  const confirmed: QuestionCandidate[] = [];
  const coordinator = new InterviewCoordinator({
    audio,
    realtime,
    session: new SessionStateMachine(),
    answerAgent: new AnswerAgent({ "low-latency": { stream: async function* () { yield "unused"; } } }, new ModelRouter({ "low-latency": "v3-test-model" })),
    initialAutomationMode: "MANUAL"
  });
  coordinator.on("event", (event: { type: string; event?: { type?: string; question?: QuestionCandidate } }) => {
    if (event.type === "question" && event.event?.type === "question_confirmed" && event.event.question) confirmed.push(event.event.question);
  });
  await coordinator.start({
    profileId: "v3-replay",
    projectId: item.id === "case-2-f405-selection" || item.id === "case-8-dma-multi-slot" ? "foc-motor-control" : undefined,
    projectCandidates: [{ id: "foc-motor-control", name: "FOC / 电机控制", aliases: ["FOC", "电机控制"], entities: ["STM32F405", "DMA", "ADC", "PWM"] }],
    url: "wss://v3-replay.test",
    automationMode: "MANUAL",
    answerMode: "NORMAL",
    runtimeMode: "ACCURATE_INTERVIEW"
  });
  for (const [index, segment] of item.segments.entries()) {
    vi.advanceTimersByTime(index === 0 ? 0 : Math.max(0, segment.timestamp - item.segments[index - 1].timestamp));
    realtime.emit("transcript", {}, { id: `${item.id}-${index}`, source: "remote", text: segment.rawAsrText, rawText: segment.rawAsrText, startMs: segment.timestamp, endMs: segment.timestamp + 300, final: true, confidence: 0.98 });
    await settle();
  }
  vi.advanceTimersByTime(2_500);
  await settle();
  const traceNames = coordinator.getRuntimeTrace(500).map((event) => event.name);
  await coordinator.stop();
  return { confirmed, traceNames };
}

describe("accurate interview V3 runtime replay", () => {
  it("degrades a complete low-confidence question after the bounded stability window", async () => {
    vi.useFakeTimers();
    try {
      const audio = new ReplayAudio();
      const realtime = new ReplayRealtime();
      const confirmed: QuestionCandidate[] = [];
      const coordinator = new InterviewCoordinator({
        audio,
        realtime,
        session: new SessionStateMachine(),
        answerAgent: new AnswerAgent({ "low-latency": { stream: async function* () { yield "DMA 回答"; } } }, new ModelRouter({ "low-latency": "v3-stability-test" })),
        initialAutomationMode: "MANUAL",
        understandingStabilizationTimeoutMs: 500
      });
      coordinator.on("event", (event: { type: string; event?: { type?: string; question?: QuestionCandidate } }) => {
        if (event.type === "question" && event.event?.type === "question_confirmed" && event.event.question) confirmed.push(event.event.question);
      });
      await coordinator.start({ profileId: "v3-stability", url: "wss://v3-stability.test", automationMode: "MANUAL", answerMode: "NORMAL", runtimeMode: "ACCURATE_INTERVIEW" });
      realtime.emit("transcript", {}, { id: "low-confidence-complete", source: "remote", text: "DMA 的原理是什么？", rawText: "DMA 的原理是什么？", startMs: 0, endMs: 500, final: true, confidence: 0.7, endpoint: true, speechFinal: true, utteranceEnd: true });
      await settle();
      expect(confirmed).toHaveLength(0);

      vi.advanceTimersByTime(800);
      await settle();
      expect(confirmed).toHaveLength(1);
      expect(coordinator.getRuntimeTrace(500).some((event) => event.reasonCode === "stability-timeout-degraded-commit")).toBe(true);
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses V3 as the only commit authority across real ASR fragments", async () => {
    vi.useFakeTimers();
    const selected = fixture.filter((item) => [
      "case-1-incomplete-introduction",
      "case-2-f405-selection",
      "case-3-confirmation-check",
      "case-4-asr-unresolved",
      "case-6-stack-asr",
      "case-7-advice",
      "case-8-dma-multi-slot",
      "case-9-retrospective-reference"
    ].includes(item.id));
    const results = new Map<string, Awaited<ReturnType<typeof replayCase>>>();
    for (const item of selected) results.set(item.id, await replayCase(item));
    expect(results.get("case-1-incomplete-introduction")?.confirmed).toHaveLength(0);
    expect(results.get("case-3-confirmation-check")?.confirmed).toHaveLength(0);
    expect(results.get("case-4-asr-unresolved")?.confirmed).toHaveLength(0);
    expect(results.get("case-7-advice")?.confirmed).toHaveLength(0);
    expect(results.get("case-2-f405-selection")?.confirmed.some((question) => question.canonicalText?.includes("STM32F405"))).toBe(true);
    expect(results.get("case-6-stack-asr")?.confirmed.some((question) => question.canonicalText === "哪个栈？")).toBe(true);
    expect(results.get("case-8-dma-multi-slot")?.confirmed[0]?.questionDecomposition?.isMultiSlot).toBe(true);
    for (const result of results.values()) for (const question of result.confirmed) expect(question.commitAuthority).toBe("understanding-v3");
    expect([...results.values()].some((result) => result.traceNames.includes("QUESTION_COMMIT_DECISION"))).toBe(true);
    vi.useRealTimers();
  });

  it("holds a locked-project question instead of falling back after a strict QA miss", async () => {
    vi.useFakeTimers();
    const audio = new ReplayAudio();
    const realtime = new ReplayRealtime();
    let providerCalls = 0;
    const provider = { stream: async function* () { providerCalls += 1; yield "不应显示"; } };
    const coordinator = new InterviewCoordinator({
      audio,
      realtime,
      session: new SessionStateMachine(),
      answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "v3-strict-test" })),
      contextProvider: (): AnswerContextInput => ({
        answerSourcePlan: {
          mode: "project_qa_no_match",
          projectAnchorAvailable: true,
          projectQuestionRequested: true,
          projectId: "foc-motor-control",
          qaMatchLevel: "none",
          preserveStoredAnswerFacts: false,
          allowProjectKnowledge: false,
          allowGeneralKnowledge: false,
          allowSessionEvidence: false,
          answerRewriteUsed: false,
          strictProjectQa: true
        }
      })
    });
    await coordinator.start({
      profileId: "v3-strict-replay",
      projectId: "foc-motor-control",
      projectCandidates: [{ id: "foc-motor-control", name: "FOC / 电机控制", aliases: ["FOC"], entities: ["DMA"] }],
      url: "wss://v3-strict-replay.test",
      automationMode: "AUTO",
      answerMode: "NORMAL",
      runtimeMode: "ACCURATE_INTERVIEW"
    });
    realtime.emit("transcript", {}, { id: "strict-project-1", source: "remote", text: "你这个项目里面 DMA 是怎么用的？", rawText: "你这个项目里面 DMA 是怎么用的？", startMs: 0, endMs: 500, final: true, confidence: 0.98 });
    await settle();
    vi.advanceTimersByTime(2_500);
    await settle();
    const traceNames = coordinator.getRuntimeTrace(500).map((event) => event.name);
    expect(providerCalls).toBe(0);
    expect(traceNames).toContain("PROJECT_QA_HOLD");
    expect(traceNames).not.toContain("PROVIDER_REQUEST_SENT");
    await coordinator.stop();
    vi.useRealTimers();
  });
});
