import { describe, expect, it } from "vitest";
import { TurnBuilder } from "./turn-builder";
import type { QuestionCandidate } from "../index";

function question(id: string, text: string, extras: Partial<QuestionCandidate> = {}): QuestionCandidate {
  return { id, text, confidence: "high", score: 0.96, source: "extractor", detectedAt: 1_000, status: "confirmed", ...extras };
}

describe("TurnBuilder", () => {
  it("creates a stable turn and exposes parallel question boundaries", () => {
    const turn = new TurnBuilder().build({ id: "turn-1", source: "remote", text: "为什么分层？如何验证？最后怎么排查？", segmentIds: ["s1"], startMs: 10, endMs: 900, finalizedAt: 1_000 });
    expect(turn).toMatchObject({ id: "turn-1", source: "remote", segmentIds: ["s1"], startMs: 10, endMs: 900 });
    expect(turn.questionTexts).toEqual(["为什么分层？", "如何验证？", "最后怎么排查？"]);
  });

  it("recognizes an ASR revision for the same utterance", () => {
    const builder = new TurnBuilder();
    const result = builder.classifyRelation({
      previousQuestion: question("q1", "为什么使用 DMA？", { utteranceId: "u1" }),
      currentQuestion: question("q2", "为什么要使用 DMA？", { utteranceId: "u1" }),
      previousTurn: builder.build({ id: "u1", text: "为什么使用 DMA？", startMs: 0, endMs: 600 }),
      currentTurn: builder.build({ id: "u1", text: "为什么要使用 DMA？", startMs: 0, endMs: 700 })
    });
    expect(result.type).toBe("ASR_REVISION");
  });

  it.each([
    ["那如果换成 RTOS？", "FOLLOW_UP"],
    ["以及常见误区？", "SAME_QUESTION_AUGMENTATION"],
    ["如何验证采样时序？", "PARALLEL_SUBQUESTION"],
    ["换个话题，介绍一下你的项目？", "NEW_TOPIC"]
  ] as const)("classifies %s as %s", (text, expected) => {
    const builder = new TurnBuilder();
    const result = builder.classifyRelation({
      previousQuestion: question("q1", "为什么使用 DMA？", { utteranceId: "u1" }),
      currentQuestion: question("q2", text, { utteranceId: "u2" }),
      previousTurn: builder.build({ id: "u1", text: "为什么使用 DMA？", startMs: 0, endMs: 600 }),
      currentTurn: builder.build({ id: "u1", text, startMs: 800, endMs: 1_300 })
    });
    expect(result.type).toBe(expected);
  });
});
