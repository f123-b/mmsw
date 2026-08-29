import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AnswerAgent, ModelRouter, SessionStateMachine, type AnswerProvider } from "@interview-copilot/shared";
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

interface ReplayResult {
  answers: string[];
  confirmed: string[];
  traceNames: string[];
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function replay(segments: Array<{ text: string; at: number; startMs: number; endMs: number }>, pauseBeforeNextMs = 0): Promise<ReplayResult> {
  const audio = new ReplayAudio();
  const realtime = new ReplayRealtime();
  const answers: string[] = [];
  const confirmed: string[] = [];
  const provider: AnswerProvider = {
    stream: async function* (request) {
      answers.push(request.sections.find((section) => section.name === "question")?.content ?? "");
      yield "回放答案";
    }
  };
  const coordinator = new InterviewCoordinator({
    audio,
    realtime,
    session: new SessionStateMachine(),
    answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "replay-model" })),
    questionSilenceMs: 180
  });
  coordinator.on("event", (event: { type: string; event?: { type?: string; question?: { text: string } } }) => {
    if (event.type === "question" && event.event?.type === "question_confirmed") confirmed.push(event.event.question?.text ?? "");
  });
  await coordinator.start({ profileId: "replay-profile", url: "wss://replay.test", automationMode: "AUTO", answerMode: "NORMAL" });
  for (const [index, segment] of segments.entries()) {
    vi.advanceTimersByTime(index === 0 ? 0 : pauseBeforeNextMs);
    realtime.emit("transcript", {}, { id: `replay-${index}`, source: "remote", text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true });
    await settle();
  }
  vi.advanceTimersByTime(2_000);
  await settle();
  const traceNames = coordinator.getRuntimeTrace(500).map((event) => event.name);
  await coordinator.stop();
  return { answers, confirmed, traceNames };
}

describe("2026-08-29 real interview runtime pipeline baseline", () => {
  it("records the pre-fix failure baseline across real coordinator replay", async () => {
    vi.useFakeTimers();
    const cases = [
      { id: "A", segments: [{ text: "如果通信任务持有互斥锁。", at: 0, startMs: 0, endMs: 500 }, { text: "导致网络请求阻塞，应该怎么排查？", at: 900, startMs: 900, endMs: 1_500 }], expected: 1 },
      { id: "B", segments: [{ text: "在你的嵌入式项目中，如果系统出现偶发死机。", at: 0, startMs: 0, endMs: 700 }, { text: "但没有复现条件时，你会怎么定位？", at: 900, startMs: 900, endMs: 1_600 }], expected: 1 },
      { id: "C", segments: [{ text: "网络断开或设备重启。", at: 0, startMs: 0, endMs: 500 }, { text: "怎么判断是看门狗复位还是链路异常？", at: 900, startMs: 900, endMs: 1_500 }], expected: 1 },
      { id: "D", segments: [{ text: "下面聊一下 RTOS。", at: 0, startMs: 0, endMs: 300 }], expected: 0 },
      { id: "E", segments: [{ text: "请重点讲一下异常恢复。", at: 0, startMs: 0, endMs: 400 }], expected: 0 },
      { id: "F", segments: [{ text: "好的，开始面试。", at: 0, startMs: 0, endMs: 300 }], expected: 0 },
      { id: "G", segments: [{ text: "请你先做一分钟自我介绍。", at: 0, startMs: 0, endMs: 500 }], expected: 1 },
      { id: "H", segments: [{ text: "FOC 的电炉环怎么调？", at: 0, startMs: 0, endMs: 500 }], expected: 1 },
      { id: "I", segments: [{ text: "RTOS 的 T O S 任务调度是什么？", at: 0, startMs: 0, endMs: 500 }], expected: 1 },
      { id: "J", segments: [{ text: "你项目里的季度战怎么做？", at: 0, startMs: 0, endMs: 500 }], expected: 1 },
      { id: "K", segments: [{ text: "协议的针头长度字段怎么解析？", at: 0, startMs: 0, endMs: 500 }], expected: 1 },
      { id: "L", segments: [{ text: "固件里的 Woodloader 怎么启动？", at: 0, startMs: 0, endMs: 500 }], expected: 1 },
      { id: "M", segments: [{ text: "非二G的时里怎么处理？", at: 0, startMs: 0, endMs: 500 }], expected: 0 },
      { id: "N", segments: [{ text: "你简历里做过 FOC，FOC 原理是什么？", at: 0, startMs: 0, endMs: 600 }], expected: 1 }
    ];
    const results: Array<Record<string, unknown>> = [];
    for (const item of cases) {
      const result = await replay(item.segments, item.id <= "C" ? 900 : 0);
      results.push({ id: item.id, expectedAnswers: item.expected, actualAnswers: result.answers.length, confirmed: result.confirmed, traces: result.traceNames.filter((name) => ["QUESTION_CONFIRMED", "ANSWER_REQUEST_CREATED"].includes(name)) });
    }
    const failures = results.filter((item) => item.expectedAnswers !== item.actualAnswers);
    const metrics = {
      caseCount: cases.length,
      failures: failures.length,
      prematureAnswers: results.filter((item) => ["A", "B", "C"].includes(String(item.id)) && Number(item.actualAnswers) > 0 && String(item.confirmed[0] ?? "").endsWith("。" )).length,
      results
    };
    console.log(`RUNTIME_PIPELINE_REAL_INTERVIEW_BASELINE_20260829 ${JSON.stringify(metrics)}`);
    expect(metrics.caseCount).toBe(14);
    vi.useRealTimers();
  });
});
