import { describe, expect, it } from "vitest";
import { planAnswerSource } from "./project-answer-source-planner";
import type { ProjectQaRouteResult } from "../question-bank-router";

const projectQa = (level: ProjectQaRouteResult["level"], verified = true): ProjectQaRouteResult => ({
  projectId: "foc",
  level,
  hits: [{
    question: {
      id: "qa-question",
      canonicalText: "ADC 怎么保证实时性？",
      normalizedText: "adc怎么保证实时性",
      type: "project",
      bankType: "project",
      category: "project",
      scope: "project",
      projectId: "foc",
      difficulty: "medium",
      source: verified ? "imported" : "ai-generated",
      status: "active",
      confidence: 1,
      verified,
      variants: [],
      relations: [],
      followUps: [],
      answerCards: [{ id: "qa-card", questionId: "qa-question", mode: "standard", content: "PWM 中点触发 ADC，并通过 DMA 搬运。", keyPoints: [], sourceType: verified ? "imported" : "ai-generated", verified, stale: false, version: 1, createdAt: 1, updatedAt: 1 }],
      skillIds: [],
      frequency: 0,
      mastery: 0,
      createdAt: 1,
      updatedAt: 1
    },
    score: 0.9,
    exact: level === "exact",
    semanticScore: 0.9,
    rankScore: 1,
    priority: 100,
    reasons: [],
    matchLevel: level
  }],
  top: undefined
});

describe("Project QA answer source planner", () => {
  it("selects direct rewrite for verified exact/strong project QA", () => {
    const route = projectQa("strong");
    route.top = route.hits[0];
    expect(planAnswerSource({ projectId: "foc", projectQuestion: true, projectQa: route })).toMatchObject({ mode: "project_qa_direct", preserveStoredAnswerFacts: true, allowProjectKnowledge: false, answerRewriteUsed: true, qaMatch: { answerCardId: "qa-card", verified: true } });
  });

  it("selects augmented mode for partial QA", () => {
    const route = projectQa("partial");
    route.top = route.hits[0];
    expect(planAnswerSource({ projectId: "foc", projectQuestion: true, projectQa: route }).mode).toBe("project_qa_augmented");
  });

  it("does not promote unverified AI QA to an authoritative answer", () => {
    const route = projectQa("strong", false);
    route.top = route.hits[0];
    expect(planAnswerSource({ projectId: "foc", projectQuestion: true, projectQa: route }).mode).toBe("project_knowledge_generated");
  });
});
