import { describe, expect, it } from "vitest";
import { QuestionDetector, questionSimilarity, scoreQuestion } from "./index";

describe("QuestionDetector", () => {
  it("waits for silence before confirming a complete remote question", () => {
    const detector = new QuestionDetector();
    const candidate = detector.observe({ text: "为什么 FOC 需要 Clarke 和 Park 变换？", final: true, startMs: 0, endMs: 1_000 }, 1_000);
    expect(candidate[0]?.type).toBe("question_candidate");
    expect(detector.flush(1_300)[0]?.type).toBe("question_ignored");
    expect(detector.flush(1_600)[0]?.type).toBe("question_confirmed");
    expect(detector.state).toBe("CONFIRMED");
  });

  it("deduplicates the same question inside the fifteen-second window", () => {
    const detector = new QuestionDetector();
    detector.observe({ text: "为什么需要同步采样？", final: true, startMs: 0, endMs: 600 }, 600);
    expect(detector.flush(1_200)[0]?.type).toBe("question_confirmed");
    detector.observe({ text: "为什么需要同步采样？", final: true, startMs: 2_000, endMs: 2_600 }, 2_600);
    expect(detector.flush(3_200)[0]).toMatchObject({ type: "question_ignored", reason: "duplicate" });
  });

  it("emits supersede for a distinct follow-up question", () => {
    const detector = new QuestionDetector();
    detector.observe({ text: "什么是 volatile？", final: true, startMs: 0, endMs: 500 }, 500);
    detector.flush(1_100);
    detector.observe({ text: "它和 const 有什么区别？", final: true, startMs: 2_000, endMs: 2_600 }, 2_600);
    expect(detector.flush(3_200)[0]?.type).toBe("question_superseded");
  });
});

describe("question scoring", () => {
  it("recognizes complete questions and compares token overlap", () => {
    expect(scoreQuestion("为什么中断服务程序应该尽量短？", true).score).toBeGreaterThanOrEqual(0.82);
    expect(questionSimilarity("Clarke 和 Park 变换有什么区别？", "Clarke Park 变换区别")).toBeGreaterThan(0.3);
  });
});
