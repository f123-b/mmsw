import { describe, expect, it } from "vitest";
import { AnswerScheduler } from "./answer-scheduler";

const q1 = { id: "q1", text: "为什么使用 DMA？", groupId: "g1" };
const q2 = { id: "q2", text: "那如果换成 RTOS？", groupId: "g1", relationType: "FOLLOW_UP" as const };

describe("AnswerScheduler", () => {
  it("queues follow-ups and protects an effective visible answer", () => {
    const scheduler = new AnswerScheduler();
    expect(scheduler.request(q1, { now: 1_000 }).action).toBe("start");
    scheduler.observeOutput("DMA 可以降低 CPU 参与搬运数据的开销。");

    const followUp = scheduler.request(q2, { relationType: "FOLLOW_UP", now: 1_100 });
    expect(followUp.action).toBe("queue");
    expect(followUp.queueDepth).toBe(1);
    expect(scheduler.canCancel("asr_revision")).toBe(false);
    expect(scheduler.cancel("asr_revision").cancelled).toBe(false);
    expect(scheduler.complete("q1")?.id).toBe("q2");
    expect(scheduler.active?.id).toBe("q2");
  });

  it("permits a same-utterance ASR replacement before visible output", () => {
    const scheduler = new AnswerScheduler();
    scheduler.request(q1, { now: 1_000 });
    expect(scheduler.canCancel("asr_revision")).toBe(true);
    expect(scheduler.cancel("asr_revision")).toMatchObject({ cancelled: true });
    expect(scheduler.request({ id: "q1-revision", text: "为什么要使用 DMA？", relationType: "ASR_REVISION" }).action).toBe("start");
  });

  it("merges an augmentation into the active plan instead of queueing", () => {
    const scheduler = new AnswerScheduler();
    scheduler.request(q1, { now: 1_000 });
    const augmentation = scheduler.request({ id: "q2", text: "以及常见误区？", groupId: "g1", relationType: "SAME_QUESTION_AUGMENTATION" }, { relationType: "SAME_QUESTION_AUGMENTATION" });
    expect(augmentation.action).toBe("merge");
    expect(scheduler.queueDepth).toBe(0);
    expect(scheduler.active?.plan.constraints).toContain("以及常见误区？");
    expect(scheduler.metrics()).toMatchObject({ requestCount: 2, mergeCount: 1, answerPlanMergeRate: 0.5 });
    expect(scheduler.cancel("session_stop").cancelled).toBe(true);
  });

  it("queues a same-group follow-up after visible output without replacing the active plan", () => {
    const scheduler = new AnswerScheduler();
    scheduler.request(q1, { now: 1_000 });
    scheduler.observeOutput("DMA 可以降低 CPU 参与搬运数据的开销。");
    const followUp = scheduler.request({ id: "q3", text: "那函数传参呢？", groupId: "g1", relationType: "FOLLOW_UP" }, { relationType: "FOLLOW_UP" });
    expect(followUp.action).toBe("queue");
    expect(scheduler.active?.id).toBe("q1");
    expect(scheduler.queue).toHaveLength(1);
  });

  it("does not merge an augmentation after the provider request was sent", () => {
    const scheduler = new AnswerScheduler();
    scheduler.request(q1, { now: 1_000 });
    expect(scheduler.markRequestSent("q1")).toBe(true);

    const augmentation = scheduler.request({ id: "q4", text: "再补充一个边界条件。", groupId: "g1", relationType: "SAME_QUESTION_AUGMENTATION" }, { relationType: "SAME_QUESTION_AUGMENTATION" });
    expect(augmentation.action).toBe("queue");
    expect(augmentation.reason).toBe("active-answer-protected");
    expect(scheduler.active?.plan.constraints).toEqual([]);
    expect(scheduler.queue.map((item) => item.id)).toEqual(["q4"]);
  });
});
