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
});
