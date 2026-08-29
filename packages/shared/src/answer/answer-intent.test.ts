import { describe, expect, it } from "vitest";
import { analyzeAnswerIntent, requiresPersonalClaimEvidence } from "./answer-intent";

describe("AnswerIntent", () => {
  it("keeps project implementation questions answerable with general knowledge", () => {
    const intent = analyzeAnswerIntent("FOC 项目中的 ADC 如何保证实时性？");
    expect(intent.asksProjectImplementation).toBe(true);
    expect(intent.asksGeneralTechnicalKnowledge).toBe(true);
    expect(requiresPersonalClaimEvidence(intent)).toBe(false);
    expect(intent.allowsProjectEvidence).toBe(true);
    expect(intent.allowsGeneralKnowledge).toBe(true);
  });

  it("requires personal claims for behavioral episodes but does not require a stored exact match", () => {
    const intent = analyzeAnswerIntent("分享一个资源有限但仍完成高目标的案例。");
    expect(intent.asksBehavioralEpisode).toBe(true);
    expect(intent.requiresPersonalOwnership).toBe(true);
    expect(intent.allowsSessionEvidence).toBe(true);
    expect(intent.allowsResumeEvidence).toBe(true);
    expect(intent.allowsGeneralKnowledge).toBe(true);
  });

  it("marks identity questions as abstain-capable and excludes generic knowledge", () => {
    const intent = analyzeAnswerIntent("有没有论文或者专利？");
    expect(intent.requiresPersonalIdentity).toBe(true);
    expect(intent.allowsGeneralKnowledge).toBe(false);
  });

  it("keeps a standalone technical question independent from personal evidence", () => {
    const intent = analyzeAnswerIntent("DMA 和中断有什么区别？");
    expect(requiresPersonalClaimEvidence(intent)).toBe(false);
    expect(intent.asksGeneralTechnicalKnowledge).toBe(true);
  });

  it("recognizes direct personal engineering metric questions", () => {
    const intent = analyzeAnswerIntent("你的电流环频率多少？");
    expect(intent.requiresPersonalMetric).toBe(true);
    expect(intent.allowsProjectEvidence).toBe(true);
  });
});
