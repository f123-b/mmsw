import { describe, expect, it } from "vitest";
import { AnswerThreadStore } from "./answer-thread-store";

describe("AnswerThreadStore", () => {
  it("retains visible primary, augmentation and follow-up cards in one group", () => {
    const store = new AnswerThreadStore();
    store.start({ answerId: "a", questionId: "q1", groupId: "g1", title: "C语言 · 指针和数组", questionText: "指针和数组有什么区别？" });
    store.delta("a", "主回答：指针保存地址。");
    store.complete("a", "主回答：指针保存地址。");
    store.start({ answerId: "b", questionId: "q2", groupId: "g1", questionText: "sizeof 为什么不同？", relation: "AUGMENTATION" });
    store.delta("b", "补充回答：数组和指针的 sizeof 不同。");
    store.complete("b", "补充回答：数组和指针的 sizeof 不同。");
    store.start({ answerId: "c", questionId: "q3", groupId: "g1", questionText: "函数传参会怎样？", relation: "FOLLOW_UP" });

    expect(store.get("g1")?.answers.map((answer) => answer.answerId)).toEqual(["a", "b", "c"]);
    expect(store.get("g1")?.answers[0].answerText).toContain("指针保存地址");
    expect(store.metrics()).toMatchObject({ visibleAnswerRetentionRate: 1, answerOverwriteRate: 0 });
  });

  it("keeps a visible answer when a later card is cancelled", () => {
    const store = new AnswerThreadStore();
    store.start({ answerId: "a", questionId: "q1", groupId: "g1", questionText: "主问题" });
    store.complete("a", "已经可见的答案");
    store.start({ answerId: "b", questionId: "q2", groupId: "g1", questionText: "追问", relation: "FOLLOW_UP" });
    store.cancel("b");

    expect(store.get("g1")?.answers).toEqual(expect.arrayContaining([
      expect.objectContaining({ answerId: "a", answerText: "已经可见的答案", visible: true }),
      expect.objectContaining({ answerId: "b", status: "cancelled" })
    ]));
  });
});
