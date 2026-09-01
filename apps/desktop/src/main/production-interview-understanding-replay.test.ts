import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  AnswerAgent,
  ModelRouter,
  SessionStateMachine,
  type AnswerProvider,
  type QuestionCandidate
} from "@interview-copilot/shared";
import { InterviewCoordinator } from "./interview-coordinator";
import type { RuntimeTraceEvent } from "./runtime-diagnostics";

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

interface ReplaySegment {
  text: string;
  at: number;
  startMs: number;
  endMs: number;
}

interface ReplayCase {
  id: string;
  segments: ReplaySegment[];
  expectedGroups: number;
  expectedAnswers: number;
}

interface GroupSnapshot {
  groupId: string;
  primaryQuestion: string;
  items: Array<{ text: string; type: string; answerable: boolean }>;
}

interface ReplayResult {
  confirmed: QuestionCandidate[];
  groups: GroupSnapshot[];
  providerRequests: string[];
  traceNames: string[];
  trace: RuntimeTraceEvent[];
}

const REAL_INTERVIEW_FIXTURE: ReplayCase[] = [
  {
    id: "meta-setup",
    segments: [{ text: "好，那我直接来几个偏基础，大家很常问的，我一个个问，问完你答，然后我再继续追问。", at: 0, startMs: 0, endMs: 1_200 }],
    expectedGroups: 0,
    expectedAnswers: 0
  },
  {
    id: "volatile",
    segments: [
      { text: "那第一个 volatile 是干什么的？", at: 0, startMs: 0, endMs: 700 },
      { text: "什么时候必须用？不用会出什么问题。", at: 3_000, startMs: 3_000, endMs: 3_800 }
    ],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "priority-inversion",
    segments: [{ text: "优先级反转是什么？在 RTOS 里怎么避免？", at: 0, startMs: 0, endMs: 900 }],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "dma",
    segments: [{ text: "DMA 半传输和全传输中断分别怎么用？在高频采样里该怎么选？", at: 0, startMs: 0, endMs: 1_000 }],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "watchdog",
    segments: [
      { text: "看门狗应该什么时候喂？哪些场景绝对不能喂。", at: 0, startMs: 0, endMs: 800 },
      { text: "怎么避免假？", at: 1_000, startMs: 1_000, endMs: 1_300 },
      { text: "活真死。", at: 1_200, startMs: 1_200, endMs: 1_450 }
    ],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "i2c-spi",
    segments: [{ text: "I2C 和 SPI 你怎么选？在抗干扰、速率、布线复杂度上怎么取舍？", at: 0, startMs: 0, endMs: 900 }],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "isr-lock",
    segments: [
      { text: "再来，中断里能不能用。", at: 0, startMs: 0, endMs: 450 },
      { text: "或是锁，如果不能，你会用什么机制和任务安全交互？举个你会用的例子。", at: 500, startMs: 500, endMs: 1_300 }
    ],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "power-on-self-test",
    segments: [{ text: "上电自检你会做哪些关键项？比如时钟、Flash校验、外设自检，失败后的降级策略是什么？", at: 0, startMs: 0, endMs: 1_000 }],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "hardfault",
    segments: [{ text: "HardFault，现场没调试器，你会先加哪些日志或保护去定位？优先级怎么排？", at: 0, startMs: 0, endMs: 900 }],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "foc",
    segments: [{ text: "FOC Current Loop 参数不稳的时候，你怎么判断是采样时刻、滤波还是参数的问题？先动哪一个？为什么？", at: 0, startMs: 0, endMs: 1_000 }],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "bare-metal-to-rtos",
    segments: [{ text: "如果让你把电机控制从裸机迁到 RTOS，你怎么划分任务优先级和通信机制？最担心的坑是什么？", at: 0, startMs: 0, endMs: 1_000 }],
    expectedGroups: 1,
    expectedAnswers: 1
  },
  {
    id: "late-modifier",
    segments: [
      { text: "你在系统跑久了，偶发死机时，第一步会怎么缩小范围？", at: 0, startMs: 0, endMs: 800 },
      { text: "只说你会立刻做的两件事。", at: 600, startMs: 600, endMs: 850 },
      { text: "越具体越好。", at: 800, startMs: 800, endMs: 950 }
    ],
    expectedGroups: 1,
    expectedAnswers: 1
  }
];

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

async function advanceRuntime(ms: number): Promise<void> {
  // Advance in small slices so timers and promise continuations scheduled at
  // t+220ms run at their production-time boundary instead of all microtasks
  // being deferred until the next large fixture jump.
  let remaining = Math.max(0, ms);
  while (remaining > 0) {
    const step = Math.min(20, remaining);
    vi.advanceTimersByTime(step);
    await settle();
    remaining -= step;
  }
}

async function replay(item: ReplayCase): Promise<ReplayResult> {
  const audio = new ReplayAudio();
  const realtime = new ReplayRealtime();
  const confirmed: QuestionCandidate[] = [];
  const providerRequests: string[] = [];
  const groups = new Map<string, GroupSnapshot>();
  const provider: AnswerProvider = {
    stream: async function* (request) {
      providerRequests.push(request.sections.find((section) => section.name === "question")?.content ?? "");
      yield "先确认现象，再检查复现条件和关键日志。";
    }
  };
  const coordinator = new InterviewCoordinator({
    audio,
    realtime,
    session: new SessionStateMachine(),
    answerAgent: new AnswerAgent({ "low-latency": provider }, new ModelRouter({ "low-latency": "replay-model" })),
    questionSilenceMs: 180
  });
  coordinator.on("event", (event: { type: string; event?: { type?: string; question?: QuestionCandidate }; message?: { type?: string; groupId?: string; primaryQuestion?: string; items?: Array<{ text: string; type: string; answerable: boolean }> } }) => {
    if (event.type === "question" && event.event?.type === "question_confirmed" && event.event.question) confirmed.push(event.event.question);
    if (event.type === "realtime_message" && event.message?.type === "question_group_updated" && event.message.groupId) {
      groups.set(event.message.groupId, {
        groupId: event.message.groupId,
        primaryQuestion: event.message.primaryQuestion ?? "",
        items: event.message.items ?? []
      });
    }
  });
  await coordinator.start({ profileId: "production-replay", url: "wss://replay.test", automationMode: "AUTO", answerMode: "NORMAL" });
  let previousAt = 0;
  for (const segment of item.segments) {
    await advanceRuntime(Math.max(0, segment.at - previousAt));
    previousAt = segment.at;
    realtime.emit("transcript", {}, { id: `${item.id}-${segment.startMs}`, source: "remote", text: segment.text, startMs: segment.startMs, endMs: segment.endMs, final: true });
    await settle();
  }
  await advanceRuntime(2_000);
  const trace = coordinator.getRuntimeTrace(500);
  const traceNames = trace.map((event) => event.name);
  await coordinator.stop();
  return { confirmed, groups: [...groups.values()], providerRequests, traceNames, trace };
}

function substantiveGroupCount(result: ReplayResult): number {
  return result.groups.filter((group) => Boolean(group.primaryQuestion.trim())).length;
}

const MULTI_SLOT_REQUIREMENTS: Record<string, string[]> = {
  volatile: ["volatile", "什么时候必须用", "会出什么问题"],
  "priority-inversion": ["优先级反转", "RTOS", "怎么避免"],
  dma: ["半传输", "全传输", "高频采样"],
  watchdog: ["看门狗", "不能喂", "活真死"],
  "i2c-spi": ["I2C", "SPI", "取舍"],
  "isr-lock": ["中断里能不能用", "锁", "任务安全交互"],
  "power-on-self-test": ["上电自检", "Flash", "降级策略"],
  hardfault: ["HardFault", "日志", "保护"],
  foc: ["采样时刻", "滤波", "参数"],
  "bare-metal-to-rtos": ["任务优先级", "通信机制", "坑"],
  "late-modifier": ["偶发死机", "两件事", "越具体"]
};

function groupText(result: ReplayResult): string {
  return result.groups.flatMap((group) => [group.primaryQuestion, ...group.items.map((item) => item.text)]).join(" ");
}

function preservesMultiSlotQuestion(result: ReplayResult, requirements: string[]): boolean {
  return substantiveGroupCount(result) === 1
    && result.providerRequests.length === 1
    && requirements.every((fragment) => groupText(result).includes(fragment));
}

function percentile95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function firstVisibleLatencies(result: ReplayResult): number[] {
  return result.trace
    .filter((event) => event.name === "ANSWER_REQUEST_CREATED" && event.questionId)
    .flatMap((request) => {
      const confirmed = result.trace.find((event) => event.name === "QUESTION_CONFIRMED" && event.questionId === request.questionId);
      const visible = result.trace.find((event) => event.name === "FIRST_VISIBLE_TOKEN" && event.questionId === request.questionId);
      return confirmed && visible ? [Math.max(0, visible.timestamp - confirmed.timestamp)] : [];
    });
}

describe("production interview understanding pipeline replay", () => {
  it("replays the real interviewer fixture through InterviewCoordinator", async () => {
    vi.useFakeTimers();
    const results: Array<ReplayResult & { fixture: ReplayCase }> = [];
    for (const fixture of REAL_INTERVIEW_FIXTURE) results.push({ ...(await replay(fixture)), fixture });

    const baseMetrics = results.reduce((summary, result) => {
      const actualGroups = substantiveGroupCount(result);
      const actualAnswers = result.providerRequests.length;
      summary.expectedSubstantiveGroups += result.fixture.expectedGroups;
      summary.actualSubstantiveGroups += actualGroups;
      summary.expectedPrimaryAnswers += result.fixture.expectedAnswers;
      summary.actualPrimaryAnswers += actualAnswers;
      summary.falsePositiveQuestionCount += result.fixture.expectedGroups === 0 && actualGroups > 0 ? actualGroups : 0;
      summary.falseNegativeQuestionCount += result.fixture.expectedGroups > 0 && actualGroups === 0 ? 1 : 0;
      summary.overSplitCount += Math.max(0, actualGroups - result.fixture.expectedGroups);
      summary.underMergeCount += Math.max(0, result.fixture.expectedGroups - actualGroups);
      summary.duplicatePrimaryAnswerCount += Math.max(0, actualAnswers - result.fixture.expectedAnswers);
      return summary;
    }, {
      expectedSubstantiveGroups: 0,
      actualSubstantiveGroups: 0,
      expectedPrimaryAnswers: 0,
      actualPrimaryAnswers: 0,
      falsePositiveQuestionCount: 0,
      falseNegativeQuestionCount: 0,
      overSplitCount: 0,
      underMergeCount: 0,
      duplicatePrimaryAnswerCount: 0
    });
    const volatileCase = results.find((result) => result.fixture.id === "volatile");
    const volatileFollowUp = volatileCase?.confirmed.at(-1);
    const wrongAnchorCount = volatileCase && volatileFollowUp && volatileCase.confirmed.length >= 2
      && volatileFollowUp.anchorId === volatileCase.confirmed[0]?.id
      && volatileFollowUp.inheritedTopic?.toLowerCase().includes("volatile")
      ? 0
      : 1;
    const multiSlotResults = Object.entries(MULTI_SLOT_REQUIREMENTS).map(([id, requirements]) => {
      const result = results.find((item) => item.fixture.id === id);
      return result && preservesMultiSlotQuestion(result, requirements) ? 1 : 0;
    });
    const isrLockCase = results.find((result) => result.fixture.id === "isr-lock");
    const openPredicateEarlyAnswerCount = isrLockCase?.trace.some((event) => event.name === "ANSWER_REQUEST_CREATED" && event.timestamp < 500) ? 1 : 0;
    const lateModifierCase = results.find((result) => result.fixture.id === "late-modifier");
    const lateModifierSlots = lateModifierCase?.groups[0]?.items.filter((item) => item.type === "ANSWER_CONSTRAINT") ?? [];
    const firstVisibleLatencySamples = results.flatMap(firstVisibleLatencies);
    const metaCaseCount = results.filter((result) => result.fixture.expectedGroups === 0).length;
    const metrics = {
      ...baseMetrics,
      wrongAnchorCount,
      metaQuestionFalsePositiveRate: metaCaseCount ? baseMetrics.falsePositiveQuestionCount / metaCaseCount : 0,
      multiSlotQuestionPreservationRate: multiSlotResults.length ? multiSlotResults.reduce((sum: number, value) => sum + value, 0) / multiSlotResults.length : 1,
      openPredicateEarlyAnswerCount,
      lateModifierAttachRate: lateModifierSlots.length / 2,
      firstVisibleLatencyP95Ms: percentile95(firstVisibleLatencySamples),
      firstVisibleLatencySamples
    };
    console.log(`PRODUCTION_INTERVIEW_UNDERSTANDING_REPLAY ${JSON.stringify({
      ...metrics,
      cases: results.map((result) => ({
        id: result.fixture.id,
        input: result.fixture.segments.map((segment) => segment.text),
        expectedGroup: result.fixture.expectedGroups,
        actualGroup: substantiveGroupCount(result),
        expectedAnswers: result.fixture.expectedAnswers,
        actualAnswers: result.providerRequests.length,
        confirmed: result.confirmed.map((question) => question.text),
        groups: result.groups,
        answerTask: result.providerRequests
      }))
    })}`);

    for (const result of results) {
      const actualGroups = substantiveGroupCount(result);
      expect(actualGroups, result.fixture.id).toBe(result.fixture.expectedGroups);
      expect(result.providerRequests.length, result.fixture.id).toBe(result.fixture.expectedAnswers);
    }
    expect(metrics.wrongAnchorCount).toBe(0);
    expect(metrics.metaQuestionFalsePositiveRate).toBe(0);
    expect(metrics.multiSlotQuestionPreservationRate).toBe(1);
    expect(metrics.openPredicateEarlyAnswerCount).toBe(0);
    expect(metrics.lateModifierAttachRate).toBe(1);
    expect(metrics.firstVisibleLatencyP95Ms).toBeLessThanOrEqual(500);

    const meta = results.find((result) => result.fixture.id === "meta-setup")!;
    expect(meta.confirmed).toHaveLength(0);
    expect(meta.groups).toHaveLength(0);

    const volatile = results.find((result) => result.fixture.id === "volatile")!;
    expect(volatile.confirmed.some((question) => question.text.includes("volatile"))).toBe(true);
    expect(volatile.confirmed.at(-1)?.inheritedTopic?.toLowerCase()).toContain("volatile");
    expect(volatile.confirmed.at(-1)?.anchorId).toBe(volatile.confirmed[0]?.id);

    const priority = results.find((result) => result.fixture.id === "priority-inversion")!;
    expect(priority.groups[0]?.primaryQuestion).toContain("RTOS");
    expect(priority.providerRequests).toHaveLength(1);

    const powerOn = results.find((result) => result.fixture.id === "power-on-self-test")!;
    expect(powerOn.groups[0]?.primaryQuestion).toContain("Flash");
    expect(powerOn.providerRequests).toHaveLength(1);

    const watchdog = results.find((result) => result.fixture.id === "watchdog")!;
    expect(watchdog.groups[0]?.items.some((item) => item.text.includes("活真死"))).toBe(true);
    expect(watchdog.providerRequests).toHaveLength(1);

    const isrLock = results.find((result) => result.fixture.id === "isr-lock")!;
    expect(isrLock.confirmed).toHaveLength(1);
    expect(isrLock.confirmed[0]?.text).toContain("中断里能不能用");
    expect(isrLock.providerRequests[0]).toContain("锁");

    const lateModifier = results.find((result) => result.fixture.id === "late-modifier")!;
    expect(lateModifier.groups[0]?.items.filter((item) => item.type === "ANSWER_CONSTRAINT").map((item) => item.text)).toEqual(expect.arrayContaining(["只说你会立刻做的两件事。", "越具体越好。"]));
    expect(lateModifier.providerRequests).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not split a semantic multi-slot utterance without an explicit topic switch", async () => {
    vi.useFakeTimers();
    const cases = [
      "优先级反转是什么？在 RTOS 里怎么避免？",
      "上电自检有哪些项目？失败后的降级策略是什么？",
      "FOC 不稳怎么排查？先调什么？为什么？",
      "UART 和 SPI 有什么区别？什么时候用哪个？",
      "电机迁 RTOS 怎么分任务？最大风险是什么？"
    ];
    for (const [index, text] of cases.entries()) {
      const result = await replay({ id: `multislot-${index}`, segments: [{ text, at: 0, startMs: 0, endMs: 900 }], expectedGroups: 1, expectedAnswers: 1 });
      expect(result.groups).toHaveLength(1);
      expect(result.providerRequests).toHaveLength(1);
    }
    vi.useRealTimers();
  });
});
