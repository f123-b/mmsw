import { describe, expect, it } from "vitest";
import { inferQuestionBankBankType, inferQuestionBankType, normalizeQuestionBankText, parseQuestionBankText, questionBankSimilarity } from "./question-bank";

describe("question bank", () => {
  it("normalizes technical terms before matching", () => {
    expect(normalizeQuestionBankText("IIC 通讯怎么排查？")).toBe(normalizeQuestionBankText("iic通信怎么排查"));
    expect(questionBankSimilarity("IIC 通讯怎么排查？", "iic通信怎么排查")).toBe(1);
  });

  it("infers common interview question types", () => {
    expect(inferQuestionBankType("请手写二叉树遍历并说明复杂度")).toBe("code");
    expect(inferQuestionBankType("如果 IIC 读不到数据，如何定位故障")).toBe("troubleshooting");
    expect(inferQuestionBankType("为什么选择这个项目架构")).toBe("project");
  });

  it("maps legacy question records into the phase-two bank categories", () => {
    expect(inferQuestionBankBankType({ scope: "project", projectId: "project-a", type: "project" })).toBe("project");
    expect(inferQuestionBankBankType({ scope: "job", jobProfileId: "job-a" })).toBe("job");
    expect(inferQuestionBankBankType({ type: "behavioral" })).toBe("behavioral");
    expect(inferQuestionBankBankType({ type: "general" })).toBe("general");
    expect(inferQuestionBankBankType({ type: "technical", skillIds: ["skill-linux"] })).toBe("skill");
  });

  it("parses consecutive numbered questions without blank lines", () => {
    const entries = parseQuestionBankText(`五、FreeRTOS\n1. 任务切换的上下文保存了什么？\n2. 优先级反转是什么，怎么解决？\n3. IIC 时序怎么排查？`);
    expect(entries.map((entry) => entry.question)).toEqual([
      "任务切换的上下文保存了什么？",
      "优先级反转是什么，怎么解决？",
      "IIC 时序怎么排查？"
    ]);
  });

  it("keeps inline answers attached to their question", () => {
    const entries = parseQuestionBankText("问题：什么是 volatile？\n答案：用于禁止编译器优化对变量访问的假设。\n它常见于中断或硬件寄存器场景。");
    expect(entries[0]).toMatchObject({ question: "什么是 volatile？", answer: expect.stringContaining("硬件寄存器") });
  });

  it("supports unlabeled answers and dash-style Q/A labels", () => {
    const entries = parseQuestionBankText("Q - ADC 怎么保证实时性？\nPWM 中点触发 ADC，并通过 DMA 搬运。\n\nQuestion: DMA 怎么减少 CPU 开销？\nAnswer - 通过硬件搬运数据。");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.answer).toContain("DMA 搬运");
    expect(entries[1]?.answer).toContain("硬件搬运");
  });
});
