import { describe, expect, it } from "vitest";
import { StableAnswerStateMachine } from "../answer";
import { AnswerScheduler } from "./answer-scheduler";
import { QuestionGroupManager } from "./question-group";
import { TurnBuilder } from "./turn-builder";
import type { QuestionCandidate } from "../index";

function question(id: string, text: string, extras: Partial<QuestionCandidate> = {}): QuestionCandidate {
  return { id, text, confidence: "high", score: 0.98, source: "extractor", detectedAt: 1_000, status: "confirmed", ...extras };
}

describe("Non-destructive Answer Stack real interview regressions", () => {
  it("assembles C pointer/array fragments into one primary question thread", () => {
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    const topicTurn = builder.build({ id: "c-topic", text: "C语言里，指针和数组。", startMs: 0, endMs: 300 });
    const nucleusTurn = builder.build({ id: "c-nucleus", text: "有什么区别？", startMs: 400, endMs: 700 });
    const topic = manager.add({ turn: topicTurn, question: question("c-topic-q", topicTurn.text), now: 1_000 });
    const nucleus = manager.add({ turn: nucleusTurn, question: question("c-nucleus-q", nucleusTurn.text, { speechAct: "FOLLOW_UP" }), now: 1_100 });
    const view = nucleus.group as unknown as { primaryQuestion?: string; items: Array<{ itemType?: string; answerable?: boolean }> };

    expect(topic.isNewGroup).toBe(true);
    expect(nucleus.group.id).toBe(topic.group.id);
    expect(view.primaryQuestion).toBe("C语言里，指针和数组有什么区别？");
    expect(view.items[0]).toMatchObject({ itemType: "TOPIC_FRAGMENT", answerable: false });
  });

  it("does not create a second pre-token answer for an augmentation", () => {
    const scheduler = new AnswerScheduler();
    scheduler.request({ id: "c-main", text: "C语言里，指针和数组有什么区别？", groupId: "c-group" }, { now: 1_000 });
    const merge = scheduler.request({ id: "c-example", text: "比如 array 和 sizeof p。", groupId: "c-group", relationType: "SAME_QUESTION_AUGMENTATION" }, { now: 1_050, relationType: "SAME_QUESTION_AUGMENTATION" });

    expect(merge.action).toBe("merge");
    expect(scheduler.queueDepth).toBe(0);
    expect(scheduler.active?.plan?.examples).toContain("比如 array 和 sizeof p。");
  });

  it("retains every answer that has become visible when a follow-up starts", () => {
    const state = new StableAnswerStateMachine();
    state.start("answer-a");
    state.delta("answer-a", "指针保存地址，数组代表连续内存。");
    state.start("answer-b");
    state.delta("answer-b", "sizeof 数组得到整个数组大小。");

    expect(state.snapshot.displayedText).toContain("指针保存地址");
    expect(state.snapshot.displayedText).toContain("sizeof 数组");
  });

  it("tracks explicit malloc/free sub-question slots instead of only answer count", () => {
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    const turn = builder.build({ id: "memory-slots", text: "malloc和free怎么使用？常见内存问题有哪些？你平时怎么避免？", startMs: 0, endMs: 1_200 });
    manager.add({ turn, question: question("memory-1", "malloc和free怎么使用？"), now: 1_000 });
    manager.add({ turn, question: question("memory-2", "常见内存问题有哪些？"), now: 1_050 });
    const group = manager.add({ turn, question: question("memory-3", "你平时怎么避免？"), now: 1_100 }).group as unknown as { slots?: Array<{ text: string; status: string }> };

    expect(group.slots).toHaveLength(3);
    expect(group.slots?.map((slot) => slot.status)).toEqual(["pending", "pending", "pending"]);
  });
});
