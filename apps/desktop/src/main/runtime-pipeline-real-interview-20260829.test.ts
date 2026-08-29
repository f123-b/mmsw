import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { analyzeAnswerIntent, analyzeInterview, analyzeQuestionNucleus, analyzeProjectQuestionIntent, AnswerAgent, ClaimGate, ModelRouter, SessionStateMachine, TechnicalAccuracyGuard, type AnswerProvider, type InterviewSnapshot } from "@interview-copilot/shared";
import { InterviewCoordinator } from "./interview-coordinator";
import { formatInterviewMarkdown } from "./history-export";

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
  questionTraces: Array<Record<string, unknown>>;
  groupUpdates: Array<{ primaryQuestion: string; items: Array<{ type: string; answerable: boolean }>; slots: Array<{ status: string }> }>;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function replay(segments: Array<{ text: string; at: number; startMs: number; endMs: number }>, pauseBeforeNextMs = 0): Promise<ReplayResult> {
  const audio = new ReplayAudio();
  const realtime = new ReplayRealtime();
  const answers: string[] = [];
  const confirmed: string[] = [];
  const questionTraces: Array<Record<string, unknown>> = [];
  const groupUpdates: ReplayResult["groupUpdates"] = [];
  const provider: AnswerProvider = {
    stream: async function* (request) {
      answers.push(request.sections.find((section) => section.name === "question")?.content ?? "");
      yield "先确认现象，再检查任务阻塞、复现条件和复位原因，并通过日志与回归测试验证。";
    }
  };
  const coordinator = new InterviewCoordinator({
    audio,
    realtime,
    session: new SessionStateMachine(),
    answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "replay-model" })),
    questionSilenceMs: 180
  });
  coordinator.on("event", (event: { type: string; name?: string; fields?: Record<string, unknown>; event?: { type?: string; question?: { text: string } } }) => {
    if (event.type === "question" && event.event?.type === "question_confirmed") confirmed.push(event.event.question?.text ?? "");
    if (event.type === "telemetry" && event.name === "QUESTION_TRACE" && event.fields) questionTraces.push(event.fields);
    if (event.type === "realtime_message" && "message" in event) {
      const message = (event as { message?: { type?: string; primaryQuestion?: string; items?: Array<{ type: string; answerable: boolean }>; slots?: Array<{ status: string }> } }).message;
      if (message?.type === "question_group_updated") groupUpdates.push({ primaryQuestion: message.primaryQuestion ?? "", items: message.items ?? [], slots: message.slots ?? [] });
    }
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
  return { answers, confirmed, traceNames, questionTraces, groupUpdates };
}

describe("2026-08-29 real interview runtime pipeline replay", () => {
  it("keeps the real coordinator replay within the acceptance contract", async () => {
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
      const actualAnswers = result.traceNames.filter((name) => name === "ANSWER_REQUEST_CREATED").length;
      results.push({ id: item.id, expectedAnswers: item.expected, actualAnswers, firstSegment: item.segments[0]?.text, confirmed: result.confirmed, traces: result.traceNames.filter((name) => ["QUESTION_CONFIRMED", "ANSWER_REQUEST_CREATED"].includes(name)) });
    }
    const failures = results.filter((item) => item.expectedAnswers !== item.actualAnswers);
    const metrics = {
      caseCount: cases.length,
      failures: failures.length,
      prematureAnswers: results.filter((item) => ["A", "B", "C"].includes(String(item.id)) && (item.confirmed as string[] | undefined)?.includes(String(item.firstSegment))).length,
      results
    };
    console.log(`RUNTIME_PIPELINE_REAL_INTERVIEW_REPLAY_20260829 ${JSON.stringify(metrics)}`);
    expect(metrics.caseCount).toBe(14);
    expect(metrics.failures).toBe(0);
    expect(metrics.prematureAnswers).toBe(0);
    vi.useRealTimers();
  });

  it("replays the requested A-N hardening sequences", async () => {
    vi.useFakeTimers();
    const answerCount = (result: ReplayResult): number => result.traceNames.filter((name) => name === "ANSWER_REQUEST_CREATED").length;

    const a = await replay([
      { text: "如果通信任务持有互斥锁。", at: 0, startMs: 0, endMs: 500 },
      { text: "导致高优先级控制任务被阻塞，你会怎么处理？", at: 900, startMs: 900, endMs: 1_500 }
    ], 900);
    expect(answerCount(a)).toBe(1);
    expect(a.confirmed).toHaveLength(1);
    expect(a.confirmed[0]).toContain("导致高优先级控制任务被阻塞");

    const b = await replay([
      { text: "继续问一个系统设计问题。", at: 0, startMs: 0, endMs: 400 },
      { text: "如果多个线程同时访问设备状态，你怎么设计？", at: 900, startMs: 900, endMs: 1_500 }
    ], 900);
    expect(answerCount(b)).toBe(1);
    expect(b.confirmed[0]).toContain("多个线程同时访问设备状态");
    expect(b.confirmed[0]).not.toContain("继续问一个");

    const c = await replay([
      { text: "你会怎么保证关键任务持续性？", at: 0, startMs: 0, endMs: 500 },
      { text: "请你重点讲一下。", at: 900, startMs: 900, endMs: 1_200 }
    ], 900);
    expect(answerCount(c)).toBe(1);
    expect(c.confirmed.every((text) => text !== "请你重点讲一下")).toBe(true);

    const d = await replay([
      { text: "FOC", at: 0, startMs: 0, endMs: 100 },
      { text: "电炉环通常放最高优先级。", at: 100, startMs: 100, endMs: 500 },
      { text: "为什么电流环必须最高优先级？", at: 600, startMs: 600, endMs: 1_200 }
    ], 0);
    expect(answerCount(d)).toBe(1);
    expect(d.confirmed.some((text) => text.includes("电流环"))).toBe(true);
    expect(d.questionTraces.some((trace) => Number(trace.terminologyCorrectionCount ?? 0) > 0)).toBe(true);

    const e = await replay([
      { text: "请重点说明数据帧格式。", at: 0, startMs: 0, endMs: 400 },
      { text: "比如针头长度、命令字、序号、CRC。", at: 100, startMs: 100, endMs: 700 }
    ], 0);
    expect(answerCount(e)).toBe(0);
    expect(e.questionTraces.some((trace) => Number(trace.terminologyCorrectionCount ?? 0) > 0)).toBe(true);

    const f = await replay([
      { text: "固件版本", at: 0, startMs: 0, endMs: 120 },
      { text: "Woodloader版本。", at: 100, startMs: 100, endMs: 300 }
    ], 0);
    expect(answerCount(f)).toBe(0);
    expect(f.questionTraces.some((trace) => Number(trace.terminologyCorrectionCount ?? 0) > 0)).toBe(true);

    const g = await replay([{ text: "在非二G的时里，会看哪些信息？", at: 0, startMs: 0, endMs: 500 }]);
    expect(answerCount(g)).toBe(0);
    expect(g.questionTraces.some((trace) => trace.unresolvedAsr === true && trace.asrUnderstandingQuality === "unresolved")).toBe(true);

    const hText = "你简历里做过FOC项目，FOC基本原理是什么？";
    const hNucleus = analyzeQuestionNucleus(hText);
    const hIntent = analyzeAnswerIntent(hText);
    expect(hNucleus).toMatchObject({ nucleus: "FOC基本原理是什么", intent: "technical" });
    expect(hIntent.technicalNucleusWithProjectAnchor).toBe(true);
    expect(hIntent.requiresPersonalOwnership).toBe(false);

    const iIntent = analyzeAnswerIntent("在你的嵌入式项目中，如果要设计异常恢复机制，你会怎么做？");
    const iMode = analyzeProjectQuestionIntent({
      question: "在你的嵌入式项目中，如果要设计异常恢复机制，你会怎么做？",
      targetProjectId: "embedded-project",
      answerIntent: iIntent,
      questionAnalysisType: "project"
    });
    expect(iMode.projectQuestionMode).toBe("hypothetical_project_design");
    expect(iIntent.requiresPersonalOwnership).toBe(false);

    const j = new ClaimGate().check({ question: "分享一次排查经历", answer: "我之前项目里定位到过一个中断竞态，加锁以后就解决了。" });
    expect(j.unsupportedPastPersonalActionCount).toBeGreaterThan(0);
    expect(j.rewrittenAnswer).not.toContain("我之前项目里定位到过一个中断竞态");

    const k = new ClaimGate().check({ question: "MQTT 延迟是多少？", answer: "MQTT延迟降低到20ms。", requiresPersonalEvidence: true });
    expect(k.rewrittenAnswer).not.toMatch(/具体量化结果未记录|具体数值|相关硬件/);

    const l = new TechnicalAccuracyGuard().check({ question: "CAN 和 UART 的可靠性有什么区别？", answer: "CAN保证关键指令不丢，UART做不到这一点。" });
    expect(l.decision).toBe("rewrite");
    const m = new TechnicalAccuracyGuard().check({ question: "DMA 有什么作用？", answer: "DMA搬数据不占用CPU。" });
    expect(m.decision).toBe("rewrite");

    const nSnapshot: InterviewSnapshot = {
      interview: { id: "runtime-n", profileId: "replay", startedAt: Date.now(), endedAt: null as unknown as undefined, status: "running", language: "zh-CN", automationMode: "AUTO", createdAt: Date.now() },
      transcripts: [],
      questions: [],
      answers: []
    };
    expect(formatInterviewMarkdown(nSnapshot, analyzeInterview(nSnapshot))).toContain("- 结束时间：—");
    vi.useRealTimers();
  });

  it("keeps a continuous question and its explicit sub-questions in one runtime group", async () => {
    vi.useFakeTimers();
    const result = await replay([
      { text: "C语言里，指针和数组。", at: 0, startMs: 0, endMs: 350 },
      { text: "有什么区别？", at: 900, startMs: 900, endMs: 1_000 },
      { text: "空间大小和常见风险这几个角度也说一下。", at: 1_800, startMs: 1_800, endMs: 2_300 },
      { text: "下一个问题，讲CAN。", at: 2_700, startMs: 2_700, endMs: 3_100 }
    ], 900);

    expect(result.groupUpdates.some((group) => group.primaryQuestion.includes("指针和数组") && group.primaryQuestion.includes("有什么区别"))).toBe(true);
    expect(result.groupUpdates.some((group) => group.items.some((item) => item.type === "ANSWER_CONSTRAINT" && item.answerable === false))).toBe(true);
    expect([...result.groupUpdates].reverse().find((group: ReplayResult["groupUpdates"][number]) => group.primaryQuestion.includes("下一个问题，讲CAN"))?.primaryQuestion).toContain("下一个问题，讲CAN");
    expect(result.traceNames.filter((name) => name === "ANSWER_REQUEST_CREATED")).toHaveLength(2);
    vi.useRealTimers();
  });
});
