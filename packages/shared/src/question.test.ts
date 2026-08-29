import { describe, expect, it } from "vitest";
import { QuestionDetector, QuestionDetector2, classifyQuestion, questionFingerprint, questionSimilarity, scoreQuestion } from "./index";
import { QuestionDetector as SemanticQuestionDetector } from "./question/question-detector";

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
    expect(detector.flush(13_200)[0]?.type).toBe("question_confirmed");
  });

  it("confirms a complete pending question before a new aggregated utterance replaces it", () => {
    const detector = new QuestionDetector();
    detector.observe({ text: "如果 IIC 通讯偶发读不到数据，你会怎么排查？", final: true, startMs: 0, endMs: 2_000, utteranceId: "u1" }, 1_000);
    const events = detector.observe({ text: "那。", final: true, startMs: 2_100, endMs: 2_300, utteranceId: "u2" }, 1_100);
    expect(events[0]).toMatchObject({ type: "question_confirmed", question: { text: "如果 IIC 通讯偶发读不到数据，你会怎么排查？" } });
  });

  it("keeps a distinct follow-up as another confirmed question", () => {
    const detector = new QuestionDetector();
    detector.observe({ text: "什么是 volatile？", final: true, startMs: 0, endMs: 500 }, 500);
    detector.flush(1_100);
    detector.observe({ text: "它和 const 有什么区别？", final: true, startMs: 2_000, endMs: 2_600 }, 2_600);
    expect(detector.flush(3_200)[0]?.type).toBe("question_confirmed");
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
    expect(detector.flush(11_300)[0]?.type).toBe("question_confirmed");
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

  it.each([
    "讲一下 SPI",
    "请解释 volatile",
    "DMA 和中断采样相比，各自的优缺点是什么？",
    "围绕 FOC 项目，好，说说",
    "SPI 有哪几种模式？"
  ])("confirms concise real interview prompt: %s", (text) => {
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
    const labeled = new SemanticQuestionDetector().analyzeSync("手动模式问题：不要自动回答", "", true);
    expect(labeled).toMatchObject({ isQuestion: true, shouldAnswer: true, score: { finalScore: 0.86 } });
    expect(scoreQuestion("手动模式问题：不要自动回答", true).score).toBeGreaterThanOrEqual(0.82);
  });

  it.each([
    "你主要负责什么",
    "这个方案有什么风险",
    "你做过哪些优化",
    "你能讲一下电流环怎么设计吗"
  ])("recognizes spoken questions without relying on terminal punctuation: %s", (text) => {
    expect(classifyQuestion(text, "上一轮面试官在追问项目细节", true).isQuestion).toBe(true);
  });

  it.each([
    "系统原理是通过状态机切换。",
    "我先说明一下原理。",
    "这次优化之后延迟下降了。",
    "好的，继续",
    "尽量用你项目里的例子来说。",
    "好，下一个问题，中段里。"
  ])("rejects technical statements and bare continuation: %s", (text) => {
    expect(classifyQuestion(text, "面试官：介绍一下你的项目？", true).isQuestion).toBe(false);
  });

  it("does not let an answerable speech act bypass explicit signal checks", async () => {
    const detector = new QuestionDetector2({
      classifier: { classify: () => ({ isQuestion: false, confidence: 0, category: "technical", questionText: "", reason: "forced-negative" }) }
    });
    const result = await detector.analyze("介绍一下你的项目", "", true);
    expect(result.isQuestion).toBe(true);
    expect(result.reason).toContain("decision-answer_request");
  });

  it.each([
    "那你这个项目低速的时候……",
    "你在这个地方主要负责……",
    "如果速度再低一点……",
    "CAN 这里你具体讲……",
    "那 FreeRTOS 这个……"
  ])("allows local/context signals to rescue a low-confidence speech act: %s", async (text) => {
    const detector = new QuestionDetector2({
      localClassifier: { predict: async () => ({ type: "QUESTION", confidence: 0.96 }) }
    });
    const result = await detector.analyze(text, "面试官：请介绍一下 FOC 项目。候选人：我负责控制环和 RTOS 任务。", true);
    expect(result.isQuestion).toBe(true);
    expect(result.speechAct).toMatch(/QUESTION|FOLLOW_UP/);
    expect(result.score.localClassifierScore).toBe(0.96);
  });

  it.each(["嗯", "好的", "下一个问题", "现在考你一个代码题", "CAN"]) ("rejects conflicting non-answer speech acts: %s", async (text) => {
    const result = await new QuestionDetector2().analyze(text, "当前主题：CAN", true);
    expect(result.isQuestion).toBe(false);
    expect(result.shouldAnswer).toBe(false);
  });

  it("passes the semantic detector result through the temporal gate", () => {
    const detector = new QuestionDetector();
    const analysis = new QuestionDetector2().analyzeSync("你主要负责什么", "面试官：介绍一下你的项目？", true);
    const events = detector.observe({ text: "你主要负责什么", final: true, startMs: 0, endMs: 900, analysis }, 900);
    expect(events[0]?.type).toBe("question_candidate");
    expect(events[0]).toMatchObject({ question: { detectionType: "project", speechAct: "QUESTION", source: "extractor" } });
  });
});
