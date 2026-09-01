import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AnswerAgent,
  ModelRouter,
  SessionStateMachine,
  type AnswerContextInput,
  type AnswerProvider,
  type QuestionCandidate
} from "@interview-copilot/shared";
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

interface ReplayCase {
  id: string;
  segments: Array<{ text: string; startMs: number; endMs: number }>;
  expectedAnswers: number;
  projectId?: string;
  contextProvider?: (question: QuestionCandidate) => AnswerContextInput;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

async function replay(item: ReplayCase): Promise<{ answers: string[]; confirmed: QuestionCandidate[]; questionTraces: Array<Record<string, unknown>>; runtimeNames: string[] }> {
  const audio = new ReplayAudio();
  const realtime = new ReplayRealtime();
  const answers: string[] = [];
  const confirmed: QuestionCandidate[] = [];
  const questionTraces: Array<Record<string, unknown>> = [];
  const provider: AnswerProvider = {
    stream: async function* (request) {
      answers.push(request.sections.find((section) => section.name === "question")?.content ?? "");
      yield item.id === "08-quality" ? "SPI 是协议。" : "先给结论，再说明机制、工程边界和验证方法。";
    }
  };
  const coordinator = new InterviewCoordinator({
    audio,
    realtime,
    session: new SessionStateMachine(),
    answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "runtime-42-model" })),
    questionSilenceMs: 180,
    ...(item.contextProvider ? { contextProvider: item.contextProvider } : {})
  });
  coordinator.on("event", (event: { type: string; name?: string; fields?: Record<string, unknown>; event?: { type?: string; question?: QuestionCandidate } }) => {
    if (event.type === "question" && event.event?.type === "question_confirmed" && event.event.question) confirmed.push(event.event.question);
    if (event.type === "telemetry" && event.name === "QUESTION_TRACE" && event.fields) questionTraces.push(event.fields);
  });
  await coordinator.start({ profileId: "runtime-42", ...(item.projectId ? { projectId: item.projectId } : {}), url: "wss://runtime-42.test", automationMode: "AUTO", answerMode: "NORMAL" });
  let previousStart = 0;
  for (const [index, segment] of item.segments.entries()) {
    vi.advanceTimersByTime(Math.max(0, segment.startMs - previousStart));
    previousStart = segment.startMs;
    realtime.emit("transcript", {}, { id: `${item.id}-${index}`, source: "remote", text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true });
    await settle();
  }
  vi.advanceTimersByTime(2_200);
  await settle();
  const runtimeNames = coordinator.getRuntimeTrace(500).map((event) => event.name);
  await coordinator.stop();
  return { answers, confirmed, questionTraces, runtimeNames };
}

describe("2026-09-02 Runtime 4.2 real interview replay", () => {
  it("passes the eight real-chain acceptance fixtures and exposes hard-gate metrics", async () => {
    vi.useFakeTimers();
    const cases: ReplayCase[] = [
      { id: "01-spa-unresolved", segments: [{ text: "高速的 S P A 吗？", startMs: 0, endMs: 500 }], expectedAnswers: 0 },
      { id: "02-spi-accepted", segments: [{ text: "高速的 S P I 吗？", startMs: 0, endMs: 500 }], expectedAnswers: 1 },
      { id: "03-c-language-switch", segments: [{ text: "I2C 的时序怎么保证？", startMs: 0, endMs: 500 }, { text: "C语言里指针和数组有什么区别？", startMs: 1_500, endMs: 2_100 }], expectedAnswers: 2 },
      { id: "04-pending-topic", segments: [{ text: "C语言。", startMs: 0, endMs: 250 }, { text: "有什么区别？", startMs: 700, endMs: 1_000 }], expectedAnswers: 1 },
      { id: "05-compound-project", segments: [{ text: "你这个项目。", startMs: 0, endMs: 250 }, { text: "有几个人？", startMs: 300, endMs: 550 }, { text: "主要负责什么？", startMs: 600, endMs: 850 }, { text: "怎么分工？", startMs: 900, endMs: 1_150 }], expectedAnswers: 1 },
      { id: "06-general-route", segments: [{ text: "SPI 和 I2C 有什么区别？", startMs: 0, endMs: 550 }], expectedAnswers: 1 },
      {
        id: "07-project-unresolved",
        segments: [{ text: "你这个项目有几个人？", startMs: 0, endMs: 550 }],
        expectedAnswers: 1,
        contextProvider: () => ({
          preparedAnswer: { content: "不应绕过项目硬门的答案", score: 1, verified: true },
          projectEvidence: ["不应注入的随机项目资料"],
          answerSourcePlan: { mode: "project_qa_direct", projectAnchorAvailable: true, projectQuestionRequested: true, projectId: "wrong-project", qaMatchLevel: "exact", preserveStoredAnswerFacts: true, allowProjectKnowledge: false, allowGeneralKnowledge: false, allowSessionEvidence: true, answerRewriteUsed: false }
        })
      },
      { id: "08-quality", segments: [{ text: "什么是 SPI？", startMs: 0, endMs: 500 }], expectedAnswers: 1 }
    ];
    const results = [];
    for (const item of cases) results.push({ item, result: await replay(item) });
    const failures = results.filter(({ item, result }) => result.answers.length !== item.expectedAnswers);
    const metrics = {
      fixtureCount: cases.length,
      failures: failures.length,
      answerRecall: Number((results.filter(({ item, result }) => result.answers.length === item.expectedAnswers).length / cases.length).toFixed(3)),
      spaBlocked: results[0].result.answers.length === 0 && results[0].result.questionTraces.some((trace) => trace.asrTrustDecision === "UNRESOLVED"),
      cLanguageStandalone: results[2].result.confirmed.at(-1)?.contextRelation === "standalone",
      compoundNucleiPreserved: results[4].result.confirmed[0]?.subQuestions?.length === 3
        && results[4].result.confirmed[0]?.questionDecomposition?.isMultiSlot === true,
      projectHardGate: results[6].result.runtimeNames.includes("PROJECT_CONTEXT_UNRESOLVED"),
      answerRuntimeTrace: results[7].result.runtimeNames.includes("ANSWER_RUNTIME_TRACE")
    };
    console.log(`RUNTIME_PIPELINE_REAL_INTERVIEW_REPLAY_20260902 ${JSON.stringify(metrics)}`);
    expect(metrics).toMatchObject({ fixtureCount: 8, failures: 0, answerRecall: 1, spaBlocked: true, cLanguageStandalone: true, compoundNucleiPreserved: true, projectHardGate: true, answerRuntimeTrace: true });
    vi.useRealTimers();
  });
});
