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

    expect(state.snapshot.visibleAnswers.map((answer) => answer.text)).toEqual([
      "指针保存地址，数组代表连续内存。",
      "sizeof 数组得到整个数组大小。"
    ]);
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

  it("keeps conditional context, constraints, examples and explicit topic switches in the right groups", () => {
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    const contextTurn = builder.build({ id: "conditional-context", text: "如果有多个任务同时访问设备状态。", startMs: 0, endMs: 400 });
    const questionTurn = builder.build({ id: "conditional-question", text: "你怎么设计？", startMs: 500, endMs: 800 });
    const context = manager.add({ turn: contextTurn, question: question("conditional-context-q", contextTurn.text), now: 1_000 });
    const nucleus = manager.add({ turn: questionTurn, question: question("conditional-question-q", questionTurn.text), now: 1_100 });
    const constraint = manager.add({ turn: questionTurn, question: question("constraint-q", "请从空间大小和常见风险这几个角度也说一下"), now: 1_200 });
    const example = manager.add({ turn: questionTurn, question: question("example-q", "比如任务栈溢出和竞态条件"), now: 1_300 });
    const nextTopic = manager.add({ turn: builder.build({ id: "new-topic", text: "下一个问题，讲CAN", startMs: 1_500, endMs: 1_800 }), question: question("new-topic-q", "下一个问题，讲CAN"), now: 1_800 });

    expect(nucleus.group.id).toBe(context.group.id);
    expect(nucleus.group.primaryQuestion).toBe("如果有多个任务同时访问设备状态你怎么设计？");
    expect(constraint.group.constraints).toContain("请从空间大小和常见风险这几个角度也说一下");
    expect(example.group.examples).toContain("比如任务栈溢出和竞态条件");
    expect(nextTopic.group.id).not.toBe(context.group.id);
    expect(nextTopic.relation?.type).toBe("NEW_TOPIC");
  });

  it("reports slot coverage independently from the number of generated answers", () => {
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    const turn = builder.build({ id: "coverage", text: "malloc怎么用？free怎么配对？", startMs: 0, endMs: 500 });
    const first = manager.add({ turn, question: question("coverage-1", "malloc怎么用？"), now: 1_000 });
    const second = manager.add({ turn, question: question("coverage-2", "free怎么配对？"), now: 1_100 });
    manager.mark(first.item.question.id, "answered");
    manager.mark(second.item.question.id, "queued");

    expect(manager.slotCoverage(first.group.id)).toMatchObject({ total: 2, covered: 2, answered: 1, pending: 0, rate: 1 });
  });
});
