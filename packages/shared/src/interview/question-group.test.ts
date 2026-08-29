import { describe, expect, it } from "vitest";
import { QuestionGroupManager } from "./question-group";
import { TurnBuilder } from "./turn-builder";
import type { QuestionCandidate } from "../index";

function question(id: string, text: string, extras: Partial<QuestionCandidate> = {}): QuestionCandidate {
  return { id, text, confidence: "high", score: 0.96, source: "extractor", detectedAt: 1_000, status: "confirmed", ...extras };
}

describe("QuestionGroupManager", () => {
  it("keeps parallel sub-questions in one turn group with explicit relations", () => {
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    const turn = builder.build({ id: "turn-1", text: "为什么分层？如何验证？", startMs: 0, endMs: 900 });
    const first = manager.add({ turn, question: question("q1", "为什么分层？"), now: 1_000 });
    const second = manager.add({ turn, question: question("q2", "如何验证？"), now: 1_100 });

    expect(first.isNewGroup).toBe(true);
    expect(second.isNewGroup).toBe(false);
    expect(second.relation?.type).toBe("PARALLEL_SUBQUESTION");
    expect(second.group.items.map((item) => item.question.id)).toEqual(["q1", "q2"]);
  });

  it("links follow-ups across turns but starts a new topic group", () => {
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    const firstTurn = builder.build({ id: "turn-1", text: "为什么使用 DMA？", startMs: 0, endMs: 600 });
    const followUpTurn = builder.build({ id: "turn-2", text: "那如果换成 RTOS？", startMs: 900, endMs: 1_500 });
    const newTopicTurn = builder.build({ id: "turn-3", text: "换个话题，介绍一下你的项目？", startMs: 2_000, endMs: 2_800 });
    const first = manager.add({ turn: firstTurn, question: question("q1", firstTurn.text), now: 1_000 });
    const followUp = manager.add({ turn: followUpTurn, question: question("q2", followUpTurn.text, { speechAct: "FOLLOW_UP" }), now: 1_600 });
    const newTopic = manager.add({ turn: newTopicTurn, question: question("q3", newTopicTurn.text), now: 2_900 });

    expect(followUp.group.id).toBe(first.group.id);
    expect(followUp.relation?.type).toBe("FOLLOW_UP");
    expect(newTopic.group.id).not.toBe(first.group.id);
    expect(newTopic.relation?.type).toBe("NEW_TOPIC");
    expect(manager.list()).toHaveLength(2);
  });

  it("records ASR revisions without losing the original question item", () => {
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    const firstTurn = builder.build({ id: "utterance-remote-u1", text: "IIC 通讯失败？", startMs: 0, endMs: 500 });
    const revisedTurn = builder.build({ id: "utterance-remote-u1", text: "IIC 通讯偶发读不到数据？", startMs: 0, endMs: 650 });
    manager.add({ turn: firstTurn, question: question("q1", firstTurn.text, { utteranceId: firstTurn.id, segmentIds: ["same-segment"] }), now: 1_000 });
    const revised = manager.add({ turn: revisedTurn, question: question("q2", revisedTurn.text, { utteranceId: revisedTurn.id, segmentIds: ["same-segment"] }), now: 1_050 });

    expect(revised.relation?.type).toBe("ASR_REVISION");
    expect(revised.group.items).toHaveLength(2);
  });
});
