import { describe, expect, it } from "vitest";
import { planAnswerSource } from "./project-answer-source-planner";
import { matchCoreTechnicalQa } from "./core-technical-qa";
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
  it("routes verified high-risk general facts before project evidence", () => {
    const core = matchCoreTechnicalQa("CAN 总线如何仲裁？");
    expect(core?.verified).toBe(true);
    expect(planAnswerSource({ projectId: "foc", projectAnchorAvailable: true, projectQuestion: false, coreTechnicalQa: core }).mode).toBe("general_core_qa");
  });
  it("keeps a selected project as an anchor without routing a generic question to project QA", () => {
    expect(planAnswerSource({ projectId: "foc", projectAnchorAvailable: true, projectQuestion: false }).mode).toBe("general_technical");
    expect(planAnswerSource({ projectId: "foc", projectAnchorAvailable: true, projectQuestion: false })).toMatchObject({ projectAnchorAvailable: true, projectQuestionRequested: false, allowProjectKnowledge: false });
  });
  it("keeps identity questions personal without requesting project facts", () => {
    expect(planAnswerSource({ projectId: "foc", projectAnchorAvailable: true, projectQuestion: false, personalQuestion: true })).toMatchObject({ mode: "personal_experience", projectQuestionRequested: false, allowProjectKnowledge: false });
  });
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

  it("holds a project question when accurate mode has no verified project match", () => {
    const route = projectQa("partial");
    route.top = route.hits[0];
    expect(planAnswerSource({ projectId: "foc", projectQuestion: true, projectQa: route, strictProjectQa: true })).toMatchObject({
      mode: "project_qa_no_match",
      allowProjectKnowledge: false,
      allowGeneralKnowledge: false,
      allowSessionEvidence: false
    });
  });

  it("accepts an exact verified project QA match in accurate mode", () => {
    const route = projectQa("exact");
    route.top = route.hits[0];
    expect(planAnswerSource({ projectId: "foc", projectQuestion: true, projectQa: route, strictProjectQa: true }).mode).toBe("project_qa_direct");
  });
});
