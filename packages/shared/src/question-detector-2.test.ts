import { describe, expect, it } from "vitest";
import { QuestionDetector2 } from "./question-detector-2";

describe("Question Detection 2.0", () => {
  it("confirms a clear interview question", async () => {
    const result = await new QuestionDetector2().analyze("介绍一下你的项目");
    expect(result.isQuestion).toBe(true);
    expect(result.score.finalScore).toBeGreaterThanOrEqual(0.85);
  });

  it("rejects filler speech", async () => {
    const result = await new QuestionDetector2().analyze("嗯");
    expect(result.isQuestion).toBe(false);
    expect(result.score.finalScore).toBe(0);
  });

  it("only invokes the LLM on the low-confidence band", async () => {
    let calls = 0;
    const detector = new QuestionDetector2({ llmConfirmer: async () => { calls += 1; return { isQuestion: true, confidence: 0.94 }; } });
    await detector.analyze("介绍一下你的项目");
    expect(calls).toBe(1);
  });
});

