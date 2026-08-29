import { describe, expect, it } from "vitest";
import { analyzeAnswerIntent } from "./answer-intent";
import { analyzeProjectQuestionIntent } from "./project-question-intent";
import { planAnswerSource } from "./project-answer-source-planner";

const projectId = "foc";

function decision(question: string, followUpContext?: Parameters<typeof analyzeProjectQuestionIntent>[0]["followUpContext"]) {
  return analyzeProjectQuestionIntent({
    question,
    targetProjectId: projectId,
    answerIntent: analyzeAnswerIntent(question),
    questionAnalysisType: /项目|负责|你这个/.test(question) ? "project" : "technical",
    followUpContext
  });
}

describe("project question intent gate", () => {
  it.each(["volatile 有什么作用？", "C++ 虚函数怎么实现？", "RTOS 优先级反转怎么解决？", "CAN 怎么仲裁？"])("keeps %s on the general route even with a selected project", (question) => {
    expect(decision(question)).toMatchObject({ projectAnchorAvailable: true, projectQuestionRequested: false });
  });

  it("opens the project route for an explicit project implementation question", () => {
    expect(decision("你这个 FOC 项目里 ADC 怎么保证实时性？")).toMatchObject({ projectAnchorAvailable: true, projectQuestionRequested: true, explicitProjectMention: true });
  });

  it("opens the project route for a direct personal engineering metric", () => {
    expect(decision("你的电流环频率多少？")).toMatchObject({ projectAnchorAvailable: true, projectQuestionRequested: true });
  });

  it("hard-blocks a standalone technical prefix even if the legacy analyzer says project", () => {
    expect(analyzeProjectQuestionIntent({ question: "RTOS 优先级反转怎么解决？", targetProjectId: projectId, answerIntent: analyzeAnswerIntent("RTOS 优先级反转怎么解决？"), questionAnalysisType: "project" })).toMatchObject({ projectAnchorAvailable: true, projectQuestionRequested: false });
  });

  it("inherits a project thread for a connected follow-up", () => {
    expect(decision("为什么一定放在 PWM 中点？", {
      rootQuestion: "你这个项目里 ADC 怎么保证实时性？",
      parentQuestion: "你这个项目里 ADC 怎么保证实时性？",
      parentAnswer: "PWM 中点触发 ADC，再用 DMA 搬运。",
      currentQuestion: "为什么一定放在 PWM 中点？",
      relatedProject: projectId,
      relatedTechnicalTopic: "ADC 实时性"
    })).toMatchObject({ projectQuestionRequested: true, projectAnchoredFollowUp: true });
  });

  it("stops inheriting the project after a generic technical topic switch", () => {
    expect(decision("那 volatile 有什么作用？", {
      rootQuestion: "你这个项目里 ADC 怎么保证实时性？",
      parentQuestion: "为什么放 PWM 中点？",
      parentAnswer: "PWM 中点可以减少采样噪声。",
      currentQuestion: "那 volatile 有什么作用？",
      relatedProject: projectId,
      relatedTechnicalTopic: "ADC 实时性"
    })).toMatchObject({ projectQuestionRequested: false, projectAnchoredFollowUp: false });
  });

  it("keeps a personal identity follow-up out of the project route", () => {
    const result = decision("那说一下你参加的比赛", {
      rootQuestion: "你这个项目里 ADC 怎么保证实时性？",
      parentQuestion: "你项目里主要负责什么？",
      parentAnswer: "我主要负责控制链路。",
      currentQuestion: "那说一下你参加的比赛",
      relatedProject: projectId,
      relatedTechnicalTopic: "ADC 实时性"
    });
    expect(result).toMatchObject({ projectAnchorAvailable: true, projectQuestionRequested: false, projectAnchoredFollowUp: false });
  });

  it("preserves the real-interview route sequence", () => {
    const projectThread = {
      rootQuestion: "你这个项目里 ADC 怎么保证实时性？",
      parentQuestion: "你项目里主要负责什么？",
      parentAnswer: "我主要负责控制链路。",
      currentQuestion: "那说一下你参加的比赛",
      relatedProject: projectId,
      relatedTechnicalTopic: "ADC 实时性"
    };
    const first = decision("你这个项目里 ADC 怎么保证实时性？");
    const followUp = decision("为什么一定放在 PWM 中点？", { ...projectThread, currentQuestion: "为什么一定放在 PWM 中点？" });
    const genericVolatile = decision("volatile 有什么作用？");
    const genericCpp = decision("C++ 虚函数怎么实现？");
    const ownership = decision("你项目里主要负责什么？");
    const identity = decision("你参加过什么比赛？");
    const identityFollowUp = decision("那说一下你参加的比赛", projectThread);
    expect(first.projectQuestionRequested).toBe(true);
    expect(followUp.projectQuestionRequested).toBe(true);
    expect(genericVolatile.projectQuestionRequested).toBe(false);
    expect(genericCpp.projectQuestionRequested).toBe(false);
    expect(ownership.projectQuestionRequested).toBe(true);
    expect(identity.projectQuestionRequested).toBe(false);
    expect(identityFollowUp.projectQuestionRequested).toBe(false);
    expect(planAnswerSource({ projectId, projectQuestion: false, personalQuestion: true }).mode).toBe("personal_experience");
  });
});
