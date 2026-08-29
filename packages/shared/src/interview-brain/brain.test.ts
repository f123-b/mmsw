import { describe, expect, it } from "vitest";
import { InterviewMemory } from "../interview-memory";
import { LocalQuestionClassifier, QuestionDetector, SemanticQuestionAnalyzer } from "../question";
import { InterviewBrain } from "./brain";
import { routeAnswerTask } from "./router";

describe("InterviewBrain", () => {
  it("understands an elliptical follow-up from the current topic", () => {
    const memory = new InterviewMemory();
    memory.recordQuestion("介绍一下你的FOC项目");
    const analysis = new QuestionDetector().analyzeSync("好，说说", memory.contextText(), true, { memory: memory.snapshot() });
    const decision = new InterviewBrain().analyze({ text: "好，说说", analysis, memory: memory.snapshot() });
    expect(decision.isQuestion).toBe(true);
    expect(decision.type).toBe("follow_up");
    expect(decision.normalizedQuestion).toBe("好，说说");
    expect(decision.inheritedTopic).toBe("电机控制/FOC");
    expect(decision.contextRelation).toBe("follow_up");
    expect(decision.answerTask?.context.join("\n")).toContain("介绍一下你的FOC项目");
  });

  it("keeps the parent question when normalizing a short follow-up", () => {
    const memory = new InterviewMemory();
    memory.recordQuestion("如果 IIC 问题再次出现，你会怎么一步步定位和验证？");
    memory.recordAnswer("我会先复现并记录关键波形。");
    const decision = new InterviewBrain().analyze({ text: "怎么验证？", memory: memory.snapshot() });
    expect(decision.isQuestion).toBe(true);
    expect(decision.normalizedQuestion).toBe("怎么验证？");
    expect(decision.contextRelation).toBe("follow_up");
    expect(decision.inheritedTopic).toBe("嵌入式通信");
  });

  it("does not promote acknowledgement or repair meta text to a question", () => {
    const memory = new InterviewMemory();
    memory.recordQuestion("介绍一下你的 IIC 项目");
    expect(new InterviewBrain().analyze({ text: "那。", memory: memory.snapshot() }).isQuestion).toBe(false);
    expect(new InterviewBrain().analyze({ text: "怎么回答？", memory: memory.snapshot() }).isQuestion).toBe(false);
  });

  it("does not turn a standalone acknowledgement into a question", () => {
    const memory = new InterviewMemory();
    const decision = new InterviewBrain().analyze({ text: "嗯", memory: memory.snapshot() });
    expect(decision.isQuestion).toBe(false);
  });

  it("routes system design questions to deep mode", () => {
    expect(routeAnswerTask({ question: "如果重新设计这个系统，你会怎么优化？", type: "follow_up", context: [] }).mode).toBe("DEEP");
  });

  it("keeps the local classifier replaceable", async () => {
    const analyzer = new SemanticQuestionAnalyzer({ predict: async () => ({ type: "FOLLOW_UP", confidence: 0.95 }) });
    await expect(analyzer.analyze("那为什么不用 UART？")).resolves.toEqual({ type: "FOLLOW_UP", confidence: 0.95 });
    await expect(new LocalQuestionClassifier().predict("CAN是一种通信协议")).resolves.toMatchObject({ type: "STATEMENT" });
  });
});
