import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { QuestionCandidate } from "../index";
import { QuestionGroupManager } from "./question-group";
import { SpeechActClassifier } from "./speech-act-classifier";
import { TurnBuilder } from "./turn-builder";

type RegressionTurn = { id: string; text: string; expected: string };

function loadTurns(): RegressionTurn[] {
  return JSON.parse(readFileSync(new URL("../../../../tests/fixtures/live-interview-turn-regression.json", import.meta.url), "utf8")) as RegressionTurn[];
}

describe("live interview turn regression fixture", () => {
  it("keeps transition markers out of groups and preserves all substantive questions", () => {
    const turns = loadTurns();
    const classifier = new SpeechActClassifier();
    const builder = new TurnBuilder();
    const manager = new QuestionGroupManager(builder);
    let pendingTransition = false;
    let currentTopic: string | undefined;
    const results: Array<{ text: string; displayable: boolean; groupId?: string; relation?: string }> = [];

    for (const [index, fixture] of turns.entries()) {
      const speech = classifier.classify(fixture.text, { currentTopic });
      expect(speech.shouldAnswer, fixture.text).toBe(fixture.expected === "answerable" || fixture.expected === "answerable-new-topic" || fixture.expected === "follow-up");
      if (fixture.expected === "topic-transition") {
        expect(speech.speechAct).toBe("TOPIC_TRANSITION");
        pendingTransition = true;
        continue;
      }
      if (fixture.expected === "control") {
        expect(speech.shouldAnswer).toBe(false);
        continue;
      }
      const turn = builder.build({ id: fixture.id, text: fixture.text, startMs: index * 1_000, endMs: index * 1_000 + 800 });
      const question: QuestionCandidate = {
        id: `${fixture.id}-question`,
        text: fixture.text,
        confidence: "high",
        score: 0.98,
        source: "extractor",
        detectedAt: index * 1_000,
        status: "confirmed",
        speechAct: speech.speechAct,
        shouldAnswer: speech.shouldAnswer,
        answerable: speech.shouldAnswer,
        topic: speech.topic,
        ...(fixture.expected === "follow-up" ? { contextRelation: "follow_up" as const } : {})
      };
      const result = manager.add({ turn, question, now: index * 1_000, ...(pendingTransition ? { relationType: "NEW_TOPIC" as const } : {}) });
      pendingTransition = false;
      results.push({ text: fixture.text, displayable: result.displayable, groupId: result.displayable ? result.group.id : undefined, relation: result.relation?.type });
      currentTopic = speech.topic ?? (fixture.text.includes("低速") ? "低速抖动" : currentTopic);
    }

    expect(results.filter((result) => result.displayable)).toHaveLength(5);
    expect(new Set(results.filter((result) => result.displayable).map((result) => result.groupId))).toHaveLength(4);
    expect(results.find((result) => result.text === "下一个问题")).toBeUndefined();
    expect(results.find((result) => result.text.includes("下个问题，如果"))?.relation).toBe("NEW_TOPIC");
    expect(manager.list().every((group) => group.displayable && group.primaryQuestion)).toBe(true);
  });
});
