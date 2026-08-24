import { describe, expect, it } from "vitest";
import { PromptBuilder, ContextRouter } from "./answer";
import { FollowUpContextResolver } from "./follow-up-context";
import { InterviewMemory } from "./interview-memory";

describe("FollowUpContextResolver", () => {
  it("keeps root, parent answer and current topic without dumping all turns", () => {
    const memory = new InterviewMemory();
    memory.recordQuestion("介绍一下 FOC 项目", { questionId: "q1", rootQuestionId: "q1", topic: "FOC / 电机控制" });
    memory.recordAnswer("我负责电流采样和控制链路。", { question: "介绍一下 FOC 项目" });
    memory.recordQuestion("为什么使用 DMA？", { questionId: "q2", parentQuestionId: "q1", rootQuestionId: "q1" });
    memory.recordAnswer("DMA 可以减少 CPU 搬运，保证采样时序。", { question: "为什么使用 DMA？" });
    memory.recordQuestion("那低速呢？", { questionId: "q3", parentQuestionId: "q2", rootQuestionId: "q1" });
    const context = new FollowUpContextResolver().resolve({ id: "q3", parentQuestionId: "q2", rootQuestionId: "q1", text: "那低速呢？" }, memory.snapshot());
    expect(context).toMatchObject({
      rootQuestion: "介绍一下 FOC 项目",
      parentQuestion: "为什么使用 DMA？",
      parentAnswer: "DMA 可以减少 CPU 搬运，保证采样时序。",
      currentQuestion: "那低速呢？",
      currentTopic: "实时采样与中断"
    });
  });

  it("renders a bounded follow-up-context prompt section", () => {
    const context = new FollowUpContextResolver().resolve(
      { text: "为什么？" },
      { recentQuestions: [], recentAnswers: [], topics: [], entities: [], turns: [{ question: "介绍项目", answer: "项目回答" }], currentTopic: "DMA" },
      { relatedProject: "project-1" }
    );
    const sections = new PromptBuilder().build({ id: "q", text: "为什么？", kind: "follow-up" }, "FAST", ContextRouter.prototype.route.call(new ContextRouter(), "为什么？", { followUpContext: context, recentTranscript: ["不应注入的长历史"] }));
    const followUp = sections.find((section) => section.name === "follow-up-context");
    expect(followUp?.content).toContain("Parent Answer：项目回答");
    expect(followUp?.content).toContain("Related Project：project-1");
    expect(sections.some((section) => section.name === "recent-transcript")).toBe(false);
  });
});
