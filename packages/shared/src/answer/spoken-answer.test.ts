import { describe, expect, it } from "vitest";
import { AnswerPlanner } from "./answer-planner";
import { SpokenAnswerFormatter } from "./spoken-answer-formatter";
import { SpokenQualityChecker } from "./spoken-quality-checker";

describe("spoken answer formatting and quality", () => {
  it("removes presentation scaffolding while preserving technical terms", () => {
    const formatter = new SpokenAnswerFormatter();
    expect(formatter.instructions("FAST")).toContain("15~25");
    const formatted = formatter.format(
      "这个问题可以从以下几个方面回答：\n### 结论\n- 首先，STM32 通过 DMA 搬运 ADC 数据。\n- 其次，CAN 用于多节点通信。",
      "FAST",
      "technical"
    );

    expect(formatted).not.toContain("###");
    expect(formatted).not.toMatch(/(^|\n)\s*[-*]\s/);
    expect(formatted).not.toContain("这个问题可以从以下几个方面回答");
    expect(formatted).toContain("STM32");
    expect(formatted).toContain("DMA");
    expect(formatted).toContain("CAN");
    expect(formatted).toContain("我一般先");
  });

  it("splits long spoken sentences into readable blocks", () => {
    const formatter = new SpokenAnswerFormatter();
    const plan = new AnswerPlanner().plan({ question: "为什么使用 CAN？", interviewMode: "NORMAL" });
    const formatted = formatter.format(
      "CAN 的优势是支持多节点通信，所以我会先看仲裁和总线负载，再看收发器状态和终端电阻，最后用固定报文做回归验证，确保问题不是偶发的时序抖动。",
      "NORMAL",
      "technical",
      plan
    );

    expect(formatted).toContain("\n\n");
    expect(formatted.split("\n").every((line) => line.length <= plan.length.maxSentenceCharacters)).toBe(true);
  });

  it("flags answers that are formal, indirect, or unsupported by personal evidence", () => {
    const question = "介绍一下你负责的项目";
    const plan = new AnswerPlanner().plan({ question, questionType: "project", interviewMode: "FAST" });
    const result = new SpokenQualityChecker().check({
      question,
      answer: "首先，这个项目可以从以下几个方面回答。我负责这个项目，性能提升了 50%。",
      mode: "FAST",
      kind: "project",
      plan
    });

    expect(result.issues).toEqual(expect.arrayContaining(["too-formal", "missing-personal-evidence", "unverified-quantitative-claim"]));
    expect(result.needsRepair).toBe(true);
  });

  it("accepts a concise grounded first-person answer", () => {
    const question = "介绍一下你负责的项目";
    const projectEvidence = ["我负责这个项目的电机控制模块，主要做电流采样和 CAN 通信链路。"];
    const plan = new AnswerPlanner().plan({ question, questionType: "project", projectEvidence, interviewMode: "FAST" });
    const answer = "我负责这个项目的电机控制模块，主要做电流采样和 CAN 通信链路。遇到低速抖动时，我先对齐采样时序，再检查 DMA 和中断负载，最后用固定工况回归验证。";
    const result = new SpokenQualityChecker().check({ question, answer, mode: "FAST", kind: "project", plan, projectEvidence });

    expect(result.issues).not.toContain("missing-personal-evidence");
    expect(result.issues).not.toContain("unverified-quantitative-claim");
    expect(result.issues).not.toContain("not-first-person");
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });
});
