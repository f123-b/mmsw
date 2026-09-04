import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerAgent, InterviewHistoryStore, ModelRouter, SessionStateMachine, type QuestionCandidate } from "@interview-copilot/shared";
import { InterviewCoordinator, type InterviewCoordinatorEvent } from "./interview-coordinator";

class Audio extends EventEmitter { isRunning = false; start() { this.isRunning = true; } stop() { this.isRunning = false; } }
class Realtime extends EventEmitter { connect() { this.emit("state", "connected"); } disconnect() {} sendAudio() {} sendControl() {} }
async function session() {
  vi.useFakeTimers();
  const realtime = new Realtime();
  const questions: QuestionCandidate[] = [];
  const requests: string[] = [];
  const history = new InterviewHistoryStore();
  const coordinator = new InterviewCoordinator({ audio: new Audio(), realtime, history, session: new SessionStateMachine(), answerAgent: new AnswerAgent({ "low-latency": { stream: async function* (request) { requests.push(request.sections.find((section) => section.name === "question")?.content ?? ""); yield "这是测试回答，不包含项目事实。"; } } }, new ModelRouter({ "low-latency": "replay" })) });
  coordinator.on("event", (event: InterviewCoordinatorEvent) => { if (event.type === "question" && event.event.type === "question_confirmed") questions.push(event.event.question); });
  await coordinator.start({ profileId: "replay", projectId: "foc", projectCandidates: [{ id: "foc", name: "FOC 电机控制", aliases: ["FOC"], entities: ["STM32F405", "ADC", "PWM", "DMA", "ABZ"] }], url: "wss://replay.test", runtimeMode: "ACCURATE_INTERVIEW", automationMode: "AUTO", answerMode: "NORMAL" });
  let id = 0;
  let time = 0;
  return { coordinator, questions, requests, history, async push(text: string, gap = 1_000, final = true, confidence = 0.98) { await vi.advanceTimersByTimeAsync(gap); time += gap; realtime.emit("transcript", {}, { id: `item-${++id}`, source: "remote", text, rawText: text, final, startMs: time - 200, endMs: time, confidence, endpoint: final }); await vi.advanceTimersByTimeAsync(0); } };
}
afterEach(() => vi.useRealTimers());
describe("19:34 interviewer-only recording regression", () => {
  it("resolves a pronoun to the latest question rather than the project technology list", async () => {
    const s = await session();
    try {
      await s.push("DMA的原理是什么？");
      await s.push("它有什么优势？", 6000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.questions.at(-1)?.text).toContain("DMA");
      expect(s.questions.at(-1)?.text).toContain("优势");
      expect(s.questions.at(-1)?.text).not.toContain("STM32F405");
      expect(s.requests.at(-1)).toContain("DMA");
    } finally { await s.coordinator.stop(); }
  });
  it("keeps an explicit new topic independent of a contextual follow-up", async () => {
    const s = await session();
    try {
      await s.push("DMA的原理是什么？"); await s.push("它有什么优势？",6000);
      await s.push("TCP和UDP有什么区别？",6000); await vi.advanceTimersByTimeAsync(5000);
      expect(s.questions.at(-1)?.text).toContain("TCP"); expect(s.questions.at(-1)?.text).not.toContain("DMA");
    } finally { await s.coordinator.stop(); }
  });
  it.each([
    ["你这个 FOC 的项目为什么？", "选这个 F 四零五作为主控。", 3_000, /STM32F405/u],
    ["那个定时器是如何？", "触发 ADC 采样。", 1_000, /定时器.*ADC/u],
    ["呃，DMA是用的什么？", "什么模式？", 2_000, /DMA.*模式/u],
    ["你这个SPI。", "是怎么设置的？", 2_000, /SPI.*设置/u],
    ["为什么要设计摩擦状态器？", "和抗齿槽补偿。", 2_000, /摩擦.*抗齿槽补偿/u]
  ])("keeps %s with its spoken completion", async (head, tail, gap, expected) => {
    const s = await session();
    try { await s.push(head); await s.push(tail, gap); await vi.advanceTimersByTimeAsync(5_000); expect(s.questions.map(q => q.text)).toHaveLength(1); expect(s.questions[0]?.text).toMatch(expected); }
    finally { await s.coordinator.stop(); }
  });
  it("does not commit a final fragment while newer interim speech is continuing", async () => {
    const s = await session();
    try { await s.push("为什么要设计摩擦状态机？"); await s.push("和抗齿", 100, false); await s.push("和抗齿槽", 900, false); expect(s.questions).toHaveLength(0); await s.push("和抗齿槽补偿。", 600); await vi.advanceTimersByTimeAsync(5_000); expect(s.questions).toHaveLength(1); expect(s.questions[0]?.text).toContain("抗齿槽补偿"); }
    finally { await s.coordinator.stop(); }
  });
  it("does not inject ADC into the explicitly spoken Id/Iq question", async () => {
    const s = await session();
    try { await s.push("ADC的原理是什么？"); await s.push("这个I D和I Q分别代表什么？", 10_000); await vi.advanceTimersByTimeAsync(4_000); expect(s.questions.at(-1)?.text).toMatch(/Id.*Iq/u); expect(s.questions.at(-1)?.text).not.toContain("ADC"); }
    finally { await s.coordinator.stop(); }
  });

  it("retains a complete lower-confidence question when a new topic arrives before timeout", async () => {
    const s = await session();
    try {
      await s.push("DMA的原理是什么？", 1000, true, 0.7);
      await s.push("什么是I2C？", 700);
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.questions.map(question => question.text)).toHaveLength(2);
      expect(s.questions[0]?.text).toContain("DMA");
      expect(s.questions[1]?.text).toMatch(/I2C|IIC/u);
      expect(s.requests).toHaveLength(2);
    } finally { await s.coordinator.stop(); }
  });
});
