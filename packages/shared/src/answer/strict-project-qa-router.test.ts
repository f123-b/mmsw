import { describe, expect, it } from "vitest";
import { StrictProjectQaRouter } from "./strict-project-qa-router";
import type { QuestionBankQuestionRecord } from "../question-bank";

function record(id: string, text: string, projectId = "p1"): QuestionBankQuestionRecord {
  return {
    id,
    canonicalText: text,
    normalizedText: text.toLowerCase(),
    type: "project",
    bankType: "project",
    category: "project",
    scope: "project",
    projectId,
    difficulty: "medium",
    source: "verified",
    status: "active",
    confidence: 1,
    verified: true,
    variants: [],
    relations: [],
    followUps: [],
    answerCards: [{ id: `${id}-answer`, questionId: id, mode: "standard", content: "已验证的项目回答。", keyPoints: [], sourceType: "verified", verified: true, stale: false, version: 1, createdAt: 1, updatedAt: 1 }],
    skillIds: [],
    frequency: 0,
    mastery: 0,
    createdAt: 1,
    updatedAt: 1
  };
}

describe("StrictProjectQaRouter", () => {
  it("never searches another project", () => {
    const result = new StrictProjectQaRouter().match("DMA 在项目里怎么用？", [record("other", "DMA 在项目里怎么用？", "p2")], "p1");
    expect(result.level).toBe("NO_MATCH");
    expect(result.route.hits).toHaveLength(0);
  });

  it("accepts an exact verified project question", () => {
    const result = new StrictProjectQaRouter().match("DMA 在项目里怎么用？", [record("p1-qa", "DMA 在项目里怎么用？")], "p1");
    expect(result.level).toBe("EXACT");
  });
});
