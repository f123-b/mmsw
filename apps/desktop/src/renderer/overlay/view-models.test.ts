import { describe, expect, it } from "vitest";
import { buildAnswerOverlayViewModel, buildDialogueOverlayViewModel, buildQuestionOverlayViewModel } from "./view-models";

describe("overlay view models", () => {
  it("keeps the question surface focused on the current group and folds history", () => {
    const view = buildQuestionOverlayViewModel([
      { id: "old", primaryQuestion: "旧问题", displayable: true, items: [] },
      { id: "current", primaryQuestion: "当前问题", displayable: true, items: [{ text: "补充一下？", type: "FOLLOW_UP", answerable: true }] }
    ], "current");
    expect(view).toMatchObject({ currentQuestion: "当前问题", currentFollowUp: "补充一下？", hasHistory: true, historyCount: 1, status: "detected" });
  });

  it("retains all answers in chronological order and identifies the latest", () => {
    const view = buildAnswerOverlayViewModel([
      { groupId: "old", questionId: "old-q", title: "旧问题", answers: [{ answerId: "old-a", questionId: "old-q", groupId: "old", questionText: "旧问题", answerText: "旧回答", relation: "PRIMARY", status: "complete", visible: true, startedAt: 0, finishedAt: 0 }], createdAt: 0, updatedAt: 0 },
      { groupId: "current", questionId: "current-q", title: "当前问题", answers: [{ answerId: "current-a", questionId: "current-q", groupId: "current", questionText: "当前问题", answerText: "当前回答", relation: "PRIMARY", status: "complete", visible: true, startedAt: 0, finishedAt: 0 }], createdAt: 0, updatedAt: 0 }
    ], "current");
    expect(view).toMatchObject({ question: "当前问题", answer: "当前回答", streaming: false, hasOlderAnswers: true, olderAnswerCount: 1 });
    expect(view.items.map(item => [item.question, item.answer])).toEqual([["旧问题", "旧回答"], ["当前问题", "当前回答"]]);
  });

  it("shows queued and evidence-blocked questions without dropping or duplicating them", () => {
    const view = buildAnswerOverlayViewModel([], undefined, undefined, "", false, [{ items: [
      { questionId: "queued", text: "DMA 是什么？", answerable: true, state: "queued" },
      { questionId: "blocked", text: "项目参数是多少？", answerable: true, state: "cancelled" },
      { questionId: "blocked", text: "重复事件", answerable: true, state: "cancelled" },
      { questionId: "noise", text: "嗯", answerable: false, state: "confirmed" }
    ] }], { blocked: "当前项目资料不足，请补充确认后重试。" });
    expect(view.items).toHaveLength(2);
    expect(view.items[0]).toMatchObject({ questionId: "queued", status: "queued" });
    expect(view.items[1]).toMatchObject({ questionId: "blocked", status: "blocked", answer: expect.stringContaining("资料不足") });
  });

  it("keeps more than eight dialogue blocks and replaces a growing partial in place", () => {
    const remote = { source: "remote" as const, final: Array.from({ length: 58 }, (_, id) => ({ id: `${id}`, source: "remote" as const, text: `面试问题 ${id}`, startMs: id * 1000, endMs: id * 1000 + 100, final: true })), partial: { id: "live", source: "remote" as const, text: "新的", startMs: 60000, endMs: 60100, final: false } };
    expect(buildDialogueOverlayViewModel(remote, undefined)).toHaveLength(59);
    remote.partial.text = "新的实时提问继续更新";
    const blocks = buildDialogueOverlayViewModel(remote, undefined);
    expect(blocks).toHaveLength(59);
    expect(blocks.at(-1)).toMatchObject({ id: "remote-partial-live", text: "新的实时提问继续更新" });
  });

  it("projects recent interviewer and candidate speaking blocks in chronological order", () => {
    const blocks = buildDialogueOverlayViewModel(
      { source: "remote", final: [1, 2, 3, 4, 5].map((id) => ({ id: `r${id}`, source: "remote" as const, text: `问题 ${id}`, startMs: id * 20, endMs: id * 20 + 10, final: true })) },
      { source: "mic", final: [1, 2, 3, 4, 5].map((id) => ({ id: `m${id}`, source: "mic" as const, text: `回答 ${id}`, startMs: id * 20 + 5, endMs: id * 20 + 15, final: true })) },
      8
    );
    expect(blocks).toHaveLength(8);
    expect(blocks[0]).toMatchObject({ id: "remote-r2", label: "面试官" });
    expect(blocks[1]).toMatchObject({ id: "mic-m2", label: "我" });
    expect(blocks.at(-1)).toMatchObject({ id: "mic-m5", speaker: "candidate" });
  });

  it("includes a current partial utterance without growing beyond the recent-block cap", () => {
    const blocks = buildDialogueOverlayViewModel(
      { source: "remote", final: [], partial: { id: "partial", source: "remote", text: "正在追问", startMs: 100, endMs: 110, final: false } },
      { source: "mic", final: [] },
      4
    );
    expect(blocks).toEqual([{ id: "remote-partial-partial", speaker: "interviewer", label: "面试官", text: "正在追问", startMs: 100 }]);
  });

  it("keeps older answers from the same question group in the answer stack count", () => {
    const view = buildAnswerOverlayViewModel([{ groupId: "same", questionId: "q", title: "同一问题", answers: [
      { answerId: "a1", questionId: "q", groupId: "same", questionText: "同一问题", answerText: "第一次回答", relation: "PRIMARY", status: "complete", visible: true, startedAt: 0, finishedAt: 1 },
      { answerId: "a2", questionId: "q", groupId: "same", questionText: "同一问题", answerText: "第二次回答", relation: "FOLLOW_UP", status: "complete", visible: true, startedAt: 2, finishedAt: 3 }
    ], createdAt: 0, updatedAt: 3 }], "same");
    expect(view).toMatchObject({ answer: "第二次回答", hasOlderAnswers: true, olderAnswerCount: 1 });
  });
});
