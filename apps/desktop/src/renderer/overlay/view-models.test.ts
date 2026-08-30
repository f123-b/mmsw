import { describe, expect, it } from "vitest";
import { buildAnswerOverlayViewModel, buildQuestionOverlayViewModel } from "./view-models";

describe("overlay view models", () => {
  it("keeps the question surface focused on the current group and folds history", () => {
    const view = buildQuestionOverlayViewModel([
      { id: "old", primaryQuestion: "旧问题", displayable: true, items: [] },
      { id: "current", primaryQuestion: "当前问题", displayable: true, items: [{ text: "补充一下？", type: "FOLLOW_UP", answerable: true }] }
    ], "current");
    expect(view).toMatchObject({ currentQuestion: "当前问题", currentFollowUp: "补充一下？", hasHistory: true, historyCount: 1, status: "detected" });
  });

  it("keeps only the latest answer visible while exposing an older-answer affordance", () => {
    const view = buildAnswerOverlayViewModel([
      { groupId: "old", questionId: "old-q", title: "旧问题", answers: [{ answerId: "old-a", questionId: "old-q", groupId: "old", questionText: "旧问题", answerText: "旧回答", relation: "PRIMARY", status: "complete", visible: true, startedAt: 0, finishedAt: 0 }], createdAt: 0, updatedAt: 0 },
      { groupId: "current", questionId: "current-q", title: "当前问题", answers: [{ answerId: "current-a", questionId: "current-q", groupId: "current", questionText: "当前问题", answerText: "当前回答", relation: "PRIMARY", status: "complete", visible: true, startedAt: 0, finishedAt: 0 }], createdAt: 0, updatedAt: 0 }
    ], "current");
    expect(view).toMatchObject({ question: "当前问题", answer: "当前回答", streaming: false, hasOlderAnswers: true, olderAnswerCount: 1 });
  });
});
