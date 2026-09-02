import { describe, expect, it } from "vitest";
import fixture from "../../../../tests/fixtures/real-interview-20260902.json";
import { AnswerPlanCoverageChecker } from "../answer/answer-plan-coverage-checker";
import { AnswerPlanner } from "../answer/answer-planner";
import { ActiveProjectResolver } from "./active-project-resolver";
import { InterviewUnderstandingStateMachine, type ActiveProjectContext, type UnderstandingEvent } from "./interview-understanding-state-machine";

const foc: ActiveProjectContext = {
  id: "foc-motor-control",
  name: "FOC / 电机控制",
  lockState: "LOCKED",
  confidence: 0.99,
  entities: ["FOC", "电机", "STM32F405", "STM32F4", "DMA", "ADC", "PWM", "Cortex-M"],
  topics: ["FOC", "MCU 选型", "中断"],
  source: "manual"
};

function replayV31(item: typeof fixture[number]): UnderstandingEvent[] {
  const machine = new InterviewUnderstandingStateMachine({
    activeProject: ["case-2-f405-selection", "case-8-dma-multi-slot", "case-10-f4-core-asr", "case-11-vector-interrupt-context"].includes(item.id) ? foc : undefined,
    sessionId: `gold-${item.id}`,
    now: () => 1_000
  });
  return item.segments.map((segment) => machine.process({
    id: `${item.id}-${segment.segmentOrder}`,
    text: segment.rawAsrText,
    rawText: segment.rawAsrText,
    rawSegments: [segment.rawAsrText],
    segmentIds: [`${item.id}-${segment.segmentOrder}`],
    final: segment.final,
    speaker: "interviewer",
    timestamp: segment.timestamp
  }, []));
}

function legacyLexicalAnswerable(text: string): boolean {
  return /[？?]$/.test(text.trim()) && /(?:为什么|为何|怎么|如何|什么|哪个|多久|吗|区别|原理|原因)/iu.test(text);
}

describe("real interview context understanding V3.1 replay", () => {
  it("reports replay KPIs against the pre-context lexical baseline", () => {
    const byId = new Map(fixture.map((item) => [item.id, replayV31(item)]));
    const answerable = fixture.filter((item) => item.expected.expectedQuestionAction === "COMMIT");
    const nonAnswerable = fixture.filter((item) => item.expected.expectedQuestionAction !== "COMMIT");
    const committed = (id: string) => (byId.get(id) ?? []).filter((event) => event.type === "QUESTION_COMMITTED");
    const v31TruePositive = answerable.filter((item) => committed(item.id).length > 0).length;
    const v31FalsePositive = nonAnswerable.filter((item) => committed(item.id).length > 0).length;
    // These two cases are one semantic question split by ASR; case-5 contains
    // two independent questions and is intentionally not an early-commit case.
    const multiFragment = fixture.filter((item) => ["case-2-f405-selection", "case-9-retrospective-reference"].includes(item.id));
    const v31EarlyCommit = multiFragment.filter((item) => committed(item.id).some((event) => event.frame.rawSegments.length < item.segments.length)).length;
    const legacySegments = fixture.flatMap((item) => item.segments.map((segment) => ({ item, segment })));
    const legacyFalsePositive = nonAnswerable.filter((item) => item.segments.some((segment) => legacyLexicalAnswerable(segment.rawAsrText))).length;
    const legacyEarlyCommit = multiFragment.filter((item) => legacyLexicalAnswerable(item.segments[0].rawAsrText)).length;

    const vectorFrame = committed("case-11-vector-interrupt-context")[0]?.frame;
    const vectorPlan = new AnswerPlanner().plan({
      question: vectorFrame?.canonicalQuestion ?? "向量中断和非向量中断的区别是什么？",
      questionRequirements: vectorFrame?.requirements,
      interviewMode: "NORMAL"
    });
    const vectorAnswer = "向量中断是通过向量表直接得到入口，非向量中断需要软件判断和分发；硬件分发与软件分发的机制不同。向量表保存入口地址，硬件和软件的差异会影响 NVIC 的处理。响应延迟和实时性需要权衡，STM32 中可以用中断服务函数作为例子。";
    const coverage = new AnswerPlanCoverageChecker().check(vectorPlan, vectorAnswer);
    const requiredSlots = vectorPlan.questionRequirements.filter((item) => item.required);
    const coveredSlots = requiredSlots.filter((item) => coverage.coveredFacets.includes(item.id));

    const projects = [
      { id: "foc-motor-control", name: "STM32F405 FOC 电机控制项目", aliases: ["FOC 项目"], entities: ["FOC", "电机", "STM32F405"] },
      { id: "linux-gateway", name: "Linux 多协议设备管理系统", aliases: ["Linux 网关"], entities: ["Linux", "Modbus", "设备管理"] }
    ];
    const projectResolver = new ActiveProjectResolver();
    projectResolver.observe({ text: "我介绍一下 FOC 项目", speaker: "candidate", projects, now: 1 });
    const switchResult = projectResolver.observe({ text: "下面看 Linux 网关的协议链路", speaker: "interviewer", projects, now: 2 });
    const contextSnapshot = vectorFrame?.contextSnapshot;
    const metrics = {
      samples: fixture.length,
      validQuestionRecall: Number((v31TruePositive / Math.max(1, answerable.length)).toFixed(4)),
      falseQuestionRate: Number((v31FalsePositive / Math.max(1, nonAnswerable.length)).toFixed(4)),
      earlyCommitRate: Number((v31EarlyCommit / Math.max(1, multiFragment.length)).toFixed(4)),
      unresolvedReferenceHoldRate: Number(((["case-12-low-confidence-core-future", "case-13-f4-core-without-context"].filter((id) => committed(id).length === 0).length) / 2).toFixed(4)),
      unsafeAsrAnswerRate: Number(((["case-4-asr-unresolved", "case-12-low-confidence-core-future", "case-13-f4-core-without-context"].filter((id) => committed(id).length > 0).length) / 3).toFixed(4)),
      crossProjectAccuracy: switchResult.activeProject?.projectId === "linux-gateway" ? 1 : 0,
      slotCoverage: Number((coveredSlots.length / Math.max(1, requiredSlots.length)).toFixed(4)),
      contextSnapshotComplete: Boolean(contextSnapshot?.id && contextSnapshot.sessionId && contextSnapshot.activeEntities && contextSnapshot.inherited),
      baseline: { lexicalFalseQuestionRate: Number((legacyFalsePositive / Math.max(1, nonAnswerable.length)).toFixed(4)), lexicalEarlyCommitRate: Number((legacyEarlyCommit / Math.max(1, multiFragment.length)).toFixed(4)), lexicalSegments: legacySegments.length }
    };
    console.log(`REAL_INTERVIEW_CONTEXT_V31_REPLAY ${JSON.stringify(metrics)}`);
    expect(metrics.validQuestionRecall).toBe(1);
    expect(metrics.falseQuestionRate).toBe(0);
    expect(metrics.earlyCommitRate).toBe(0);
    expect(metrics.unresolvedReferenceHoldRate).toBe(1);
    expect(metrics.unsafeAsrAnswerRate).toBe(0);
    expect(metrics.crossProjectAccuracy).toBe(1);
    expect(metrics.slotCoverage).toBe(1);
    expect(metrics.contextSnapshotComplete).toBe(true);
    expect(metrics.baseline.lexicalFalseQuestionRate).toBeGreaterThan(metrics.falseQuestionRate);
    expect(metrics.baseline.lexicalEarlyCommitRate).toBeGreaterThan(metrics.earlyCommitRate);
  });
});
