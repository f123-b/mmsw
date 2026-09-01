import { describe, expect, it } from "vitest";
import { AnswerLengthController } from "./answer-length-controller";
import { AnswerPlanner } from "./answer-planner";
import { answerStrategyFor, classifyAnswerQuestion } from "./answer-strategy";

describe("Answer planning and strategy selection", () => {
  const planner = new AnswerPlanner();

  it("selects a first-person project strategy only when project context is relevant", () => {
    const plan = planner.plan({
      question: "介绍一下你负责的 FOC 项目",
      currentProject: "FOC 电机控制",
      projectEvidence: ["我负责电流采样和 CAN 通信链路"],
      interviewMode: "NORMAL"
    });

    expect(plan.questionType).toBe("project");
    expect(plan.strategy.id).toBe("project");
    expect(plan.mustUseFirstPerson).toBe(true);
    expect(plan.useCurrentProject).toBe(true);
    expect(plan.requiredEvidence).toEqual(expect.arrayContaining(["personal_project_fact", "technical_fact"]));
    expect(plan.structure).toEqual(expect.arrayContaining(["personal_responsibility", "challenge", "result"]));
  });

  it("upgrades project debugging to a grounded troubleshooting strategy", () => {
    const question = "在 FOC 项目中遇到低速抖动怎么排查？";
    const plan = planner.plan({
      question,
      currentProject: "FOC 电机控制",
      projectEvidence: ["低速抖动与采样时序和 DMA 链路有关"],
      interviewMode: "DEEP"
    });

    expect(classifyAnswerQuestion(question)).toBe("embedded-debugging");
    expect(plan.questionType).toBe("project_troubleshooting");
    expect(plan.kind).toBe("embedded-debugging");
    expect(plan.mustUseFirstPerson).toBe(true);
    expect(plan.structure).toEqual(expect.arrayContaining(["root_cause", "fix", "verification"]));
    expect(answerStrategyFor("troubleshooting", question, true).id).toBe("project_troubleshooting");
  });

  it("keeps short clarifications short without collapsing normal follow-ups", () => {
    const plan = planner.plan({
      question: "具体一点",
      questionType: "follow-up",
      followUpContext: {
        rootQuestion: "为什么使用 CAN？",
        parentQuestion: "为什么使用 CAN？",
        parentAnswer: "因为它支持仲裁并且适合多节点实时通信。",
        currentQuestion: "具体一点",
        currentTopic: "CAN 总线"
      },
      interviewMode: "FAST"
    });

    expect(plan.complexity).toBe("medium");
    expect(plan.durationRangeSec).toEqual({ min: 15, max: 25 });
    expect(plan.targetDurationSec).toBe(20);
    expect(plan.requiredEvidence).toContain("follow_up_context");
    const short = planner.plan({ question: "还有呢？", questionType: "short-clarification", interviewMode: "FAST" });
    expect(short.complexity).toBe("low");
    expect(short.durationRangeSec.max).toBeLessThanOrEqual(30);
  });

  it("maps speaking time to a stable character band", () => {
    const controller = new AnswerLengthController();
    const policy = controller.policy("NORMAL", "technical");

    expect(policy).toMatchObject({ min: 30, max: 60, target: 45, minCharacters: 120, maxCharacters: 288 });
    expect(policy.targetCharacters).toBe(189);
    expect(controller.estimateDurationSec("CAN 用于多节点实时通信。" )).toBeGreaterThan(0);
  });
});
