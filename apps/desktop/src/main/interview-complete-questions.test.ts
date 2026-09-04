import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerAgent, InterviewHistoryStore, ModelRouter, SessionStateMachine, type AnswerContextInput, type QuestionCandidate } from "@interview-copilot/shared";
import { InterviewCoordinator, type InterviewCoordinatorEvent } from "./interview-coordinator";
class Audio extends EventEmitter { isRunning = false; start() { this.isRunning = true; } stop() { this.isRunning = false; } }
class Realtime extends EventEmitter { connect() { this.emit("state", "connected"); } disconnect() {} sendAudio() {} sendControl() {} }
afterEach(() => vi.useRealTimers());
async function setup(contextProvider?: () => AnswerContextInput) {
  vi.useFakeTimers();
  const realtime = new Realtime();
  const questions: QuestionCandidate[] = [];
  const requests: string[] = [];
  const errors: string[] = [];
  const coordinator = new InterviewCoordinator({ audio: new Audio(), realtime, history: new InterviewHistoryStore(), session: new SessionStateMachine(), answerAgent: new AnswerAgent({ "low-latency": { stream: async function* (request) { requests.push(request.sections.find(s => s.name === "question")?.content ?? ""); yield "可以从目标、职责、实现和结果展开说明。"; } } }, new ModelRouter({ "low-latency": "replay" })), contextProvider });
  coordinator.on("event", (event: InterviewCoordinatorEvent) => {
    if (event.type === "question" && event.event.type === "question_confirmed") questions.push(event.event.question);
    if (event.type === "realtime_message" && event.message.type === "runtime_error") errors.push(event.message.message);
  });
  await coordinator.start({ profileId: "replay", url: "wss://replay.test", runtimeMode: "ACCURATE_INTERVIEW", automationMode: "AUTO", answerMode: "NORMAL" });
  let id = 0;
  return { coordinator, questions, requests, errors, async push(text: string, wait = 5000) {
    realtime.emit("transcript", {}, { id: `seg-${++id}`, source: "remote", text, rawText: text, final: true, startMs: id * 1000, endMs: id * 1000 + 500, confidence: 0.98, endpoint: true });
    await vi.advanceTimersByTimeAsync(wait);
  } };
}
describe("complete ordinary interview questions without a project lock", () => {
  it.each(["这有什么优势啊？", "你的优点是什么？", "你的缺点是什么", "你为什么离职？", "你期望的薪资是多少？", "TypeScript 有什么特点？", "你如何处理同事之间的分歧？"])("answers %s after the speaker stops", async text => {
    const s = await setup();
    try { await s.push(text); expect(s.questions).toHaveLength(1); expect(s.requests).toHaveLength(1); }
    finally { await s.coordinator.stop(); }
  });
  it("does not merge a complete HR question with the next project overview", async () => {
    const s = await setup();
    try { await s.push("你的优点是什么？"); await s.push("你做过什么项目？"); expect(s.questions).toHaveLength(2); expect(new Set(s.requests).size).toBe(2); expect(s.errors.join(" ")).not.toContain("项目尚未确定"); }
    finally { await s.coordinator.stop(); }
  });
  it("combines a real unfinished clause with its completion", async () => {
    const s = await setup();
    try { await s.push("你觉得你的。", 900); expect(s.requests).toHaveLength(0); await s.push("优势是什么？"); expect(s.questions).toHaveLength(1); expect(s.requests).toHaveLength(1); }
    finally { await s.coordinator.stop(); }
  });
  it("answers a project overview and then an advantage question even when project routing has no exact match", async () => {
    const blockedPlan = (): AnswerContextInput => ({
      profileSummary: "候选人上传的简历摘要",
      projectEvidence: ["FOC 电机控制项目：负责控制算法与嵌入式实现"],
      answerSourcePlan: { mode: "project_qa_no_match", projectAnchorAvailable: false, projectQuestionRequested: true, qaMatchLevel: "none", preserveStoredAnswerFacts: false, allowProjectKnowledge: false, allowGeneralKnowledge: false, allowSessionEvidence: false, answerRewriteUsed: false, strictProjectQa: true }
    });
    const s = await setup(blockedPlan);
    try {
      await s.push("可以讲述一下你这个项目吗？");
      await s.push("你有什么优势？");
      expect(s.questions).toHaveLength(2);
      expect(new Set(s.requests)).toEqual(new Set(["可以讲述一下你这个项目吗？", "你有什么优势？"]));
      expect(s.errors.join(" ")).not.toMatch(/项目未确定|没有项目资料|未找到对应项目/u);
    } finally { await s.coordinator.stop(); }
  });
});
