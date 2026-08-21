import { describe, expect, it } from "vitest";
import { InterviewMemory } from "./interview-memory";
import { AnswerQualityChecker } from "./answer/answer-quality-checker";
import { InterviewAnswerFormatter } from "./answer/interview-answer-formatter";
import { HybridKnowledgeRetriever, type KnowledgeChunk } from "./knowledge";
import { QuestionDetector } from "./question/question-detector";

describe("Interview Copilot core upgrade", () => {
  it("classifies statements, technical questions and redesign follow-ups", async () => {
    const detector = new QuestionDetector();
    expect((await detector.analyze("你这个项目为什么使用CAN")).type).toBe("technical");
    expect((await detector.analyze("如果重新设计你会怎么做")).type).toBe("follow_up");
    expect((await detector.analyze("CAN主要用于工业通信")).isQuestion).toBe(false);
  });

  it("uses the previous topic for a short follow-up question", async () => {
    const memory = new InterviewMemory();
    memory.recordQuestion("介绍一下你的FOC项目");
    const result = await new QuestionDetector().analyze("为什么不用编码器？", memory.contextText(), true, { memory: memory.snapshot() });
    expect(result.isQuestion).toBe(true);
    expect(result.type).toBe("follow_up");
    expect(result.speechAct).toBe("FOLLOW_UP");
  });

  it("keeps only the recent ten interview turns", () => {
    const memory = new InterviewMemory();
    for (let index = 0; index < 12; index += 1) memory.recordQuestion(`问题${index}`);
    expect(memory.snapshot().recentQuestions).toEqual(["问题2", "问题3", "问题4", "问题5", "问题6", "问题7", "问题8", "问题9", "问题10", "问题11"]);
  });

  it("keeps grounded entities for follow-up resolution", () => {
    const memory = new InterviewMemory();
    memory.recordQuestion("介绍一下你的FOC项目，里面用了DMA和CAN");
    expect(memory.snapshot().entities).toEqual(expect.arrayContaining(["FOC", "DMA", "CAN"]));
  });

  it("formats spoken answer prompts and checks answer quality", () => {
    const formatter = new InterviewAnswerFormatter();
    expect(formatter.instructions("FAST")).toContain("30~80");
    expect(formatter.format("# 第一部分\n- 我会先看采样时序。", "FAST")).toBe("我会先看采样时序。");
    const quality = new AnswerQualityChecker().check({ question: "为什么使用CAN", answer: "CAN用于工业通信。", mode: "NORMAL" });
    expect(quality.issues).toContain("not-first-person");
    expect(quality.needsRepair).toBe(true);
    expect(formatter.format("首先，这个项目需要进行优化。因此要关注实时性。", "NORMAL")).toContain("我一般先");
  });

  it("runs candidate retrieval, reranking and returns top five", async () => {
    const chunks: KnowledgeChunk[] = Array.from({ length: 24 }, (_, index) => ({
      id: `chunk-${index}`,
      text: index === 3 ? "CAN仲裁机制和实时通信设计" : `普通项目内容 ${index}`,
      metadata: { documentId: "doc", filename: `doc-${index}.md` }
    }));
    const result = await new HybridKnowledgeRetriever({ chunks, candidateK: 20, topK: 5 }).search("CAN通信");
    expect(result).toHaveLength(5);
    expect(result[0].text).toContain("CAN");
  });
});
