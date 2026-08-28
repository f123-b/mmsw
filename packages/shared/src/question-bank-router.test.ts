import { describe, expect, it } from "vitest";
import { normalizeQuestionBankText, type QuestionBankQuestionRecord } from "./question-bank";
import { QuestionBankRouter } from "./question-bank-router";

function question(partial: Partial<QuestionBankQuestionRecord> & Pick<QuestionBankQuestionRecord, "id" | "canonicalText">): QuestionBankQuestionRecord {
  const now = 1;
  const base: QuestionBankQuestionRecord = {
    id: partial.id,
    canonicalText: partial.canonicalText,
    normalizedText: normalizeQuestionBankText(partial.canonicalText),
    type: "technical",
    bankType: "general",
    category: "technical",
    scope: "global",
    difficulty: "medium",
    source: "manual",
    status: "active",
    confidence: 1,
    verified: false,
    variants: [],
    relations: [],
    followUps: [],
    answerCards: [],
    skillIds: [],
    frequency: 0,
    mastery: 0,
    createdAt: now,
    updatedAt: now
  };
  return { ...base, ...partial, id: partial.id, canonicalText: partial.canonicalText, normalizedText: normalizeQuestionBankText(partial.canonicalText) };
}

describe("QuestionBankRouter", () => {
  it("prioritizes a matching current-project question over a generic duplicate", () => {
    const router = new QuestionBankRouter();
    const result = router.route("为什么要同步采样？", [
      question({ id: "generic", canonicalText: "为什么要同步采样？" }),
      question({ id: "project", canonicalText: "为什么要同步采样？", bankType: "project", scope: "project", projectId: "foc" })
    ], { projectId: "foc" });

    expect(result.top?.question.id).toBe("project");
    expect(result.top?.reasons).toContain("current-project");
  });

  it("boosts skill-overlapping records and excludes stale or archived records", () => {
    const result = new QuestionBankRouter().route("Linux 进程调度如何定位？", [
      question({ id: "skill", canonicalText: "Linux 进程调度如何定位？", bankType: "skill", skillIds: ["linux"] }),
      question({ id: "stale", canonicalText: "Linux 进程调度如何定位？", stale: true, verified: true }),
      question({ id: "archived", canonicalText: "Linux 进程调度如何定位？", status: "archived" })
    ], { skillIds: ["linux"] });

    expect(result.hits.map((hit) => hit.question.id)).toEqual(["skill"]);
    expect(result.top?.reasons).toContain("matched-skill");
  });

  it("uses follow-up relations as a routing signal", () => {
    const result = new QuestionBankRouter().route("具体怎么验证？", [question({
      id: "follow-up",
      canonicalText: "具体怎么验证？",
      relations: [{ id: "relation", sourceQuestionId: "root", targetQuestionId: "follow-up", relationType: "FOLLOW_UP", confidence: 1, source: "manual", createdAt: 1, updatedAt: 1 }],
      followUps: []
    })], { followUpQuestionId: "root", threshold: 0.3 });

    expect(result.top?.reasons).toContain("follow-up-relation");
  });

  it("routes exact and variant project QA before any global record", () => {
    const projectQuestion = question({
      id: "foc-qa",
      canonicalText: "ADC 怎么保证实时性？",
      bankType: "project",
      scope: "project",
      projectId: "foc",
      verified: true,
      variants: ["PWM 和 ADC 怎么同步？"],
      answerCards: [{ id: "foc-card", questionId: "foc-qa", mode: "standard", content: "PWM 中点触发 ADC，并通过 DMA 搬运。", keyPoints: [], sourceType: "imported", verified: true, stale: false, version: 1, createdAt: 1, updatedAt: 1 }]
    });
    const globalQuestion = question({ id: "global-qa", canonicalText: "ADC 怎么保证实时性？", verified: true });
    const result = new QuestionBankRouter().routeProjectQaFirst("你这里 PWM 跟 ADC 到底是怎么同步的？", [globalQuestion, projectQuestion], { projectId: "foc" });

    expect(result.stage).toBe("project");
    expect(result.matchLevel).toBe("strong");
    expect(result.top?.question.id).toBe("foc-qa");
    expect(result.top?.exact).toBe(false);
  });

  it("keeps a related project QA as partial instead of treating it as direct", () => {
    const result = new QuestionBankRouter().routeProjectFirst("采样时序怎么验证？", [question({
      id: "adc",
      canonicalText: "ADC 怎么采样？",
      scope: "project",
      bankType: "project",
      projectId: "foc",
      verified: true,
      answerCards: [{ id: "adc-card", questionId: "adc", mode: "standard", content: "PWM 中点触发 ADC，DMA 搬运。", keyPoints: [], sourceType: "imported", verified: true, stale: false, version: 1, createdAt: 1, updatedAt: 1 }]
    })], "foc");

    expect(result.level).toBe("partial");
    expect(result.top?.matchLevel).toBe("partial");
  });
});
