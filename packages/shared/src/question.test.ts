import { describe, expect, it } from "vitest";
import { QuestionDetector, classifyQuestion, questionFingerprint, questionSimilarity, scoreQuestion } from "./index";

describe("QuestionDetector", () => {
  it("waits for silence before confirming a complete remote question", () => {
    const detector = new QuestionDetector();
    const candidate = detector.observe({ text: "为什么 FOC 需要 Clarke 和 Park 变换？", final: true, startMs: 0, endMs: 1_000 }, 1_000);
    expect(candidate[0]?.type).toBe("question_candidate");
    expect(detector.flush(1_300)[0]?.type).toBe("question_ignored");
    expect(detector.flush(1_600)[0]?.type).toBe("question_confirmed");
    expect(detector.state).toBe("CONFIRMED");
  });

  it("deduplicates the same question inside the ten-second window", () => {
    const detector = new QuestionDetector();
    detector.observe({ text: "为什么需要同步采样？", final: true, startMs: 0, endMs: 600 }, 600);
    expect(detector.flush(1_200)[0]?.type).toBe("question_confirmed");
    detector.observe({ text: "为什么需要同步采样？", final: true, startMs: 2_000, endMs: 2_600 }, 2_600);
    expect(detector.flush(3_200)[0]).toMatchObject({ type: "question_ignored", reason: "duplicate" });
    detector.observe({ text: "为什么需要同步采样？", final: true, startMs: 12_000, endMs: 12_600 }, 12_600);
    expect(detector.flush(13_200)[0]?.type).toBe("question_superseded");
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

  it("recognizes implicit interview prompts without a question mark", () => {
    const detector = new QuestionDetector();
    detector.observe({ text: "请介绍一下你做过的实时音频项目", final: true, startMs: 0, endMs: 900 }, 900);
    expect(detector.flush(1_500)[0]?.type).toBe("question_confirmed");
  });

  it("keeps wall-clock silence separate from ASR audio timeline", () => {
    const detector = new QuestionDetector();
    detector.observe({ text: "为什么使用 DMA？", final: true, startMs: 0, endMs: 900 }, 10_000);
    expect(detector.flush(10_400)[0]?.type).toBe("question_ignored");
    expect(detector.flush(10_600)[0]?.type).toBe("question_confirmed");
    detector.observe({ text: "如果换成 FreeRTOS 呢？", final: true, startMs: 2_000, endMs: 2_900 }, 10_700);
    expect(detector.flush(11_300)[0]?.type).toBe("question_superseded");
  });

  it.each([
    "介绍一下你的项目",
    "为什么选择这个方案",
    "低速运行出现抖动，你怎么排查？",
    "如果重新设计，你会怎么优化？"
  ])("confirms interview prompt: %s", (text) => {
    const detector = new QuestionDetector();
    detector.observe({ text, final: true, startMs: 0, endMs: 900 }, 900);
    expect(detector.flush(1_500)[0]?.type).toBe("question_confirmed");
  });

  it("uses partial speech for early classification but waits for final before confirming", () => {
    const detector = new QuestionDetector();
    expect(detector.observe({ text: "如果重新设计", final: false, startMs: 0, endMs: 500 }, 500)[0]).toMatchObject({ type: "question_candidate" });
    expect(detector.flush(1_100)).toEqual([]);
    detector.observe({ text: "如果重新设计，你会怎么优化？", final: true, startMs: 0, endMs: 900 }, 900);
    expect(detector.flush(1_500)[0]?.type).toBe("question_confirmed");
  });

  it("classifies long-background questions and emits structured diagnostics", () => {
    const classification = classifyQuestion("如果重新设计，你会怎么优化？", "你这个项目先解决了采样时序问题，随后又做了稳定性测试。", true);
    expect(classification).toMatchObject({ isQuestion: true, category: "technical" });
    expect(classification.confidence).toBeGreaterThan(0.7);
    const detector = new QuestionDetector();
    const events = detector.observe({ text: "这个项目主要负责采样和通信。", final: true, startMs: 0, endMs: 900 }, 900);
    expect(events.find((event) => event.type === "question_diagnostic")).toMatchObject({ candidate: false, confirmed: false });
    expect(questionFingerprint("为什么选择这个方案？")).toBe(questionFingerprint("为什么选择这个方案"));
  });

  it("keeps short semantic questions and contextual follow-ups", () => {
    expect(classifyQuestion("为什么？", "", true)).toMatchObject({ isQuestion: true, category: "followup" });
    expect(classifyQuestion("然后呢？", "前面的问题已经解释了同步采样和缓存策略。", true)).toMatchObject({ isQuestion: true, category: "followup" });
    expect(scoreQuestion("手动模式问题：不要自动回答", true).score).toBeGreaterThanOrEqual(0.82);
  });
});
