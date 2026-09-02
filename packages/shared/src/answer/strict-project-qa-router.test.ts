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
  it("matches spoken whole-project questions to numbered verified headings without broadening component queries", () => {
    const router = new StrictProjectQaRouter();
    const candidates = [record("role", "Q003｜你在项目里负责什么"), record("architecture", "Q004｜项目架构怎么设计的"), record("axis", "Q086：Axis 模块主要负责什么？")];
    expect(router.match("你来讲一讲，你这个FOC项目，你主要负责了什么？", candidates, "p1")).toMatchObject({ level: "EXACT", route: { top: { question: { id: "role" } } } });
    expect(router.match("那系统的架构是什么？", candidates, "p1")).toMatchObject({ level: "EXACT", route: { top: { question: { id: "architecture" } } } });
    expect(router.match("项目里ADC模块负责什么？", candidates, "p1").level).not.toBe("EXACT");
    expect(router.match("项目架构为什么这样设计？", candidates, "p1").level).not.toBe("EXACT");
  });
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
