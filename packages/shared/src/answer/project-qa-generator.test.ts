import { describe, expect, it } from "vitest";
import { buildProjectQaGenerationPrompt, parseProjectQaGeneration } from "./project-qa-generator";

describe("project QA generator", () => {
  it("requires grounded fact ids and rejects unknown references", () => {
    const candidates = parseProjectQaGeneration(JSON.stringify([
      { question: "ADC 如何保证实时性？", answer: "通过中点采样和固定触发时序控制采样窗口。", factIds: ["adc-fact", "unknown"] },
      { question: "没有事实的问题", answer: "这段答案没有可追溯依据。", factIds: [] }
    ]), ["adc-fact"]);
    expect(candidates).toEqual([{ question: "ADC 如何保证实时性？", answer: "通过中点采样和固定触发时序控制采样窗口。", factIds: ["adc-fact"] }]);
  });

  it("makes the independent, no-remote-retrieval contract explicit", () => {
    const prompt = buildProjectQaGenerationPrompt({ projectName: "FOC", facts: [{ id: "f1", type: "technology", title: "采样", content: "ADC 在 PWM 中点触发" }] });
    expect(prompt).toContain("只能使用提供的事实");
    expect(prompt).toContain("不要从远程资料");
    expect(prompt).toContain("factIds");
  });
});
