import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@interview-copilot/protocol";
import {
  AnswerLengthController,
  AnswerPlanCoverageChecker,
  AnswerPlanner,
  AnswerDepthRepair,
  CanonicalRemoteTurnAssembler,
  QuestionRuntimeKpiCalculator,
  RealInterviewQuestionReplay,
  SemanticTurnGate,
  canonicalizeQuestion
} from "../index";

function segment(id: string, text: string, startMs: number, final = true): TranscriptSegment {
  return { id, source: "remote", text, startMs, endMs: startMs + 280, final };
}

describe("Question Runtime 4.1", () => {
  it("canonicalizes the spoken fragment orders from the real interview cases", () => {
    expect(canonicalizeQuestion("内存泄漏。是什么？", ["内存泄漏。", "是什么？"])).toBe("什么是内存泄漏？");
    expect(canonicalizeQuestion("什么是？内存溢出。", ["什么是？", "内存溢出。"])).toBe("什么是内存溢出？");
    expect(canonicalizeQuestion("软件分层。是具体怎么？来做的。", ["软件分层。", "是具体怎么？", "来做的。"])).toContain("具体是怎么来做的？");
    expect(canonicalizeQuestion("如果在中断里面。调用 malloc。会有什么问题？", ["如果在中断里面。", "调用 malloc。", "会有什么问题？"])).toContain("会有什么问题？");
  });

  it("keeps fragments, revisions and independent questions on one commit path", () => {
    const assembler = new CanonicalRemoteTurnAssembler({ maxGapMs: 1_500 });
    const first = assembler.push(segment("q-1", "内存泄漏。", 0), 0);
    expect(first.current?.fragments).toEqual(["内存泄漏。"]);
    const merged = assembler.push(segment("q-2", "是什么？", 300), 180);
    expect(merged.completed).toHaveLength(0);
    expect(merged.current?.fragments).toEqual(["内存泄漏。", "是什么？"]);
    const revision = assembler.push({ ...segment("q-2", "是什么原因？", 300), final: true }, 220);
    expect(revision.reason).toBe("revised");
    expect(revision.current?.text).toContain("是什么原因");
    const boundary = assembler.push(segment("q-3", "什么是 SPI？", 650), 320);
    expect(boundary.reason).toBe("semantic-boundary");
    expect(boundary.completed[0]?.text).toContain("内存泄漏");
    expect(assembler.flush("interviewer", 900)).toHaveLength(1);
  });

  it("rejects backchannels/statements, waits for dependent tails, and accepts answer requests", () => {
    const gate = new SemanticTurnGate();
    const backchannel = gate.decide("嗯嗯。", {});
    const statement = gate.decide("我先说一下项目背景。", {});
    const setup = gate.decide("如果系统间歇性卡死。", {});
    const tail = gate.decide("你会怎么排查？", { previousInterviewerTurn: setup.reason });
    const answerRequest = gate.decide("你说说 DMA 的工作原理。", {});
    expect(backchannel.speechAct).toBe("BACKCHANNEL");
    expect(backchannel.shouldAnswer).toBe(false);
    expect(statement.shouldAnswer).toBe(false);
    expect(setup.dependency).toBe("EXPECTS_NEXT");
    expect(tail.shouldAnswer).toBe(true);
    expect(answerRequest.shouldAnswer).toBe(true);
    expect(answerRequest.speechAct).toBe("ANSWER_REQUEST");
  });

  it("replays real voice-style cases and emits measurable runtime KPIs", () => {
    const replay = new RealInterviewQuestionReplay({ maxGapMs: 1_600 });
    replay.push({ segment: segment("a-1", "嗯嗯。", 0), receivedAt: 0 });
    replay.push({ segment: segment("a-2", "内存泄漏。", 500), receivedAt: 500 });
    replay.push({ segment: segment("a-3", "是什么？", 800), receivedAt: 700 });
    replay.push({ segment: segment("b-1", "I2C 和 SPI 的主要区别是什么？", 1_400), receivedAt: 1_600 });
    replay.push({ segment: segment("c-1", "如果在中断里面。", 2_200), receivedAt: 2_200 });
    replay.push({ segment: segment("c-2", "调用 malloc。会有什么问题？", 2_500), receivedAt: 2_400 });
    const result = replay.flush(4_000);
    const questions = result.commits.filter((item) => item.semantic.shouldAnswer);
    expect(questions).toHaveLength(3);
    expect(questions[0]?.understanding.canonicalQuestion).toBe("什么是内存泄漏？");
    expect(questions[2]?.understanding.canonicalQuestion).toContain("会有什么问题？");
    expect(result.rejectedTurns).toBeGreaterThanOrEqual(1);
    expect(Math.max(...result.commitLatencyMs)).toBeLessThanOrEqual(4_000);

    const kpi = new QuestionRuntimeKpiCalculator().calculate([
      { expected: "STATEMENT", actualSpeechAct: "STATEMENT", commitLatencyMs: 420 },
      { expected: "BACKCHANNEL", actualSpeechAct: "BACKCHANNEL", commitLatencyMs: 150 },
      { expected: "QUESTION", actualSpeechAct: "QUESTION", expectedCanonical: "什么是内存泄漏？", actualCanonical: "什么是内存泄漏？", expectedDependency: "INDEPENDENT", actualDependency: "INDEPENDENT", commitLatencyMs: 420 },
      { expected: "ANSWER_REQUEST", actualSpeechAct: "ANSWER_REQUEST", commitLatencyMs: 420 },
      { expected: "FOLLOW_UP_REQUEST", actualSpeechAct: "FOLLOW_UP_REQUEST", expectedDependency: "DEPENDS_ON_PREVIOUS", actualDependency: "DEPENDS_ON_PREVIOUS", commitLatencyMs: 1_100 },
      { expected: "INCOMPLETE", actualSpeechAct: "INCOMPLETE", earlyTrigger: false, commitLatencyMs: 1_700 }
    ]);
    console.log(`QUESTION_RUNTIME_41_KPI ${JSON.stringify(kpi)}`);
    expect(kpi.questionRecall).toBe(1);
    expect(kpi.questionPrecision).toBe(1);
    expect(kpi.statementFalseTriggerRate).toBe(0);
    expect(kpi.backchannelFalseTriggerRate).toBe(0);
    expect(kpi.incompleteEarlyTriggerRate).toBe(0);
    expect(kpi.followUpRelationAccuracy).toBe(1);
  });

  it("enforces planned answer facets and separates short/deep follow-up duration bands", async () => {
    const planner = new AnswerPlanner();
    const checker = new AnswerPlanCoverageChecker();
    const concept = planner.plan({ question: "什么是 SPI？", interviewMode: "NORMAL" });
    const comparison = planner.plan({ question: "I2C 和 SPI 有什么区别？", interviewMode: "NORMAL" });
    const deep = planner.plan({ question: "那具体怎么保证同步采样？", questionType: "deep-follow-up", interviewMode: "NORMAL" });
    const coverage = checker.check(concept, "SPI 是一种同步串行通信协议，靠时钟同步收发数据。工程上要注意时序和片选。");
    expect(coverage.requiredFacets).toEqual(expect.arrayContaining(["definition", "mechanism", "key_characteristics", "practical_consideration"]));
    expect(coverage.coveredFacets).toEqual(expect.arrayContaining(["definition", "mechanism", "practical_consideration"]));
    expect(checker.check(comparison, "").requiredFacets).toEqual(expect.arrayContaining(["key_differences", "common_causes", "consequences", "embedded_example"]));
    expect(deep.kind).toBe("deep-follow-up");
    expect(deep.durationRangeSec).toEqual({ min: 30, max: 50 });
    expect(new AnswerLengthController().durationRange("NORMAL", "short-clarification")).toEqual({ min: 10, max: 30, target: 20 });

    let instruction = "";
    const repair = new AnswerDepthRepair({ generate: async (value) => { instruction = value; return "工程上要抓波形验证 CPOL 和 CPHA，并说明片选边界。"; } });
    const supplement = await repair.repair({ question: concept.question, existingAnswer: "SPI 是一种同步通信协议。", missingFacets: ["mechanism", "practical_consideration"], targetCharacters: concept.length.targetCharacters });
    expect(instruction).toContain("只补这些缺失方面：mechanism、practical_consideration");
    expect(supplement).toContain("抓波形");
  });
});
