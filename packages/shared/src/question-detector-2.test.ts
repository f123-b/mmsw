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

  it("uses an injected local classifier for contextual spoken follow-ups", async () => {
    const detector = new QuestionDetector2({
      localClassifier: {
        predict: async () => ({ type: "FOLLOW_UP", confidence: 0.96 })
      }
    });
    const result = await detector.analyze("好，说说", "当前主题：FOC 项目", true, { recentTranscript: ["面试官：介绍一下你的 FOC 项目。"] });
    expect(result.isQuestion).toBe(true);
    expect(result.speechAct).toBe("FOLLOW_UP");
  });

  it("passes memory context to the local classifier when recent transcript is empty", async () => {
    let receivedContext: string[] = [];
    const detector = new QuestionDetector2({
      localClassifier: {
        predict: async (_text, context) => {
          receivedContext = context ?? [];
          return { type: "FOLLOW_UP", confidence: 0.96 };
        }
      }
    });
    await detector.analyze("好，说说", "当前主题：FOC 项目", true, { recentTranscript: [] });
    expect(receivedContext).toEqual(["当前主题：FOC 项目"]);
  });

  it("only invokes the LLM on the low-confidence band", async () => {
    let calls = 0;
    const detector = new QuestionDetector2({ llmConfirmer: async () => { calls += 1; return { isQuestion: true, confidence: 0.94 }; } });
    await detector.analyze("介绍一下你的项目");
    expect(calls).toBe(1);
  });

  it("does not let a meta prompt replace a substantive interview question", async () => {
    const detector = new QuestionDetector2({ localClassifier: { predict: async () => ({ type: "FOLLOW_UP", confidence: 0.96 }) } });
    const result = await detector.analyze("怎么回答？", "当前技术主题：嵌入式通信", true, { recentTranscript: ["面试官：IIC 通讯偶发读不到数据，你会怎么排查？"] });
    expect(result.isQuestion).toBe(false);
  });

  it("keeps a clear technical question when the optional LLM confirmer disagrees", async () => {
    const detector = new QuestionDetector2({ llmConfirmer: async () => ({ isQuestion: false, confidence: 0.4 }) });
    const result = await detector.analyze("IIC 通讯偶发读不到数据，你会怎么排查？", "", true);
    expect(result.isQuestion).toBe(true);
    expect(result.score.finalScore).toBeGreaterThanOrEqual(0.85);
  });
});

