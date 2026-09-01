import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerLengthController,
  AnswerPlanCoverageChecker,
  AnswerPlanner,
  AnswerQualityChecker,
  CanonicalRemoteTurnAssembler,
  ContextAnchorStore,
  ContextRouter,
  QuestionUnderstanding,
  SemanticTurnGate,
  UnresolvedAsrGate,
  planAnswerSource
} from "../index";

function segment(id: string, text: string, startMs: number): TranscriptSegment {
  return { id, source: "remote", text, startMs, endMs: startMs + 260, final: true };
}

describe("Question Runtime 4.2 real interview replay", () => {
  it("replays acceptance fixtures 01-08 and reports the hard-gate metrics", () => {
    const gate = new UnresolvedAsrGate();
    const semantic = new SemanticTurnGate();
    const results = [
      gate.assess("高速的 S P A 吗？", { confidence: 1, possibleTerms: [], corrections: [] }).quality === "unresolved"
        && gate.assess("高速的 S P I 吗？", { confidence: 1, possibleTerms: [], corrections: [] }, { currentTopic: "SPI" }).shouldAnswer
        && gate.assess("在非二G的时里，会看哪些信息？", { confidence: 1, possibleTerms: [], corrections: [] }).shouldAnswer === false,
      (() => {
        const previous = { id: "q-i2c", text: "I2C 的时序怎么保证？", normalizedText: "i2c 的时序怎么保证？", topic: "I2C", entities: ["I2C"], speechAct: "QUESTION" as const, createdAt: 1_000, expiresAt: 12_000, confidence: 0.96 };
        const understanding = new QuestionUnderstanding().understand({
          text: "C语言里指针和数组有什么区别？",
          semantic: semantic.decide("C语言里指针和数组有什么区别？", { currentTopic: "I2C" }),
          anchors: { latestAnchor: previous, lastConfirmedQuestion: previous, currentTopic: "I2C", anchors: [previous] }
        });
        return understanding.contextRelation === "standalone" && understanding.explicitTopic === "C语言";
      })(),
      (() => {
        const store = new ContextAnchorStore(() => 1_000);
        store.addAnchor({ text: "我们切到 C语言", speechAct: "TOPIC_ANCHOR", topic: "C语言", createdAt: 1_000 });
        const understanding = new QuestionUnderstanding().understand({
          text: "有什么区别？",
          semantic: semantic.decide("有什么区别？", { currentTopic: "C语言" }),
          anchors: store.snapshot(1_100)
        });
        return understanding.canonicalQuestion.includes("C语言") && understanding.primaryQuestion === understanding.canonicalQuestion;
      })(),
      (() => {
        const assembler = new CanonicalRemoteTurnAssembler({ maxGapMs: 1_600 });
        assembler.push(segment("p1", "你这个项目。", 0), 0);
        assembler.push(segment("p2", "有几个人？", 300), 300);
        assembler.push(segment("p3", "主要负责什么？", 600), 600);
        assembler.push(segment("p4", "怎么分工？", 900), 900);
        const turn = assembler.flush("interviewer", 2_000)[0];
        return Boolean(turn && turn.fragments.length === 4 && turn.text.includes("有几个人") && turn.text.includes("怎么分工"));
      })(),
      (() => {
        const plan = planAnswerSource({ projectQuestion: true, projectAnchorAvailable: false });
        const routed = new ContextRouter().route("你这个项目有几个人？", {
          answerSourcePlan: plan,
          projectQaEvidence: ["不应泄露的项目答案"],
          projectEvidence: ["不应注入的项目资料"],
          retrievedKnowledge: ["不应注入的项目检索"]
        });
        return plan.mode === "project_context_unresolved" && routed.projectQaEvidence.length === 0 && routed.projectEvidence.length === 0 && routed.retrievedKnowledge.length === 0;
      })(),
      (() => {
        const planner = new AnswerPlanner();
        const plan = planner.plan({ question: "什么是 SPI？", interviewMode: "NORMAL" });
        const quality = new AnswerQualityChecker().check({ question: "什么是 SPI？", answer: "SPI 是协议。", mode: "NORMAL", kind: "concept" });
        const deep = planner.plan({ question: "那具体怎么保证同步采样？", questionType: "deep-follow-up", interviewMode: "NORMAL" });
        const coverage = new AnswerPlanCoverageChecker().check(plan, "SPI 是一种同步通信协议。工程上要注意时序。");
        return plan.length.minCharacters >= 120 && quality.needsRepair && coverage.needsRepair && deep.durationRangeSec.max === 50;
      })(),
      (() => {
        const controller = new AnswerLengthController();
        const normalFollowUp = new AnswerPlanner().plan({ question: "还有哪些工程风险？", questionType: "follow-up", interviewMode: "NORMAL" });
        return normalFollowUp.complexity !== "low" && controller.durationRange("NORMAL", "short-clarification").max === 30;
      })(),
      planAnswerSource({ projectQuestion: false, projectAnchorAvailable: true, projectId: "p1" }).mode === "general_technical"
    ];
    const metrics = {
      fixtureCount: results.length,
      passed: results.filter(Boolean).length,
      asrTrustGatePassRate: results[0] ? 1 : 0,
      topicBoundaryPassRate: Number((results.slice(1, 3).filter(Boolean).length / 2).toFixed(3)),
      compoundQuestionPassRate: results[3] ? 1 : 0,
      projectHardGatePassRate: results[4] ? 1 : 0,
      answerQualityPassRate: results.slice(5).filter(Boolean).length / 3
    };
    console.log(`QUESTION_RUNTIME_42_METRICS ${JSON.stringify(metrics)}`);
    expect(results).toEqual([true, true, true, true, true, true, true, true]);
  });
});
