import { describe, expect, it } from "vitest";
import { decideSemanticAnswerability } from "./semantic-answerability";
import { QuestionDetector2 } from "../question-detector-2";

const recent = { currentTopic: "RTOS", latestQuestionText: "RTOS 问题", hasRecentQuestion: true };

describe("semantic answerability gate", () => {
  it("rejects bare answer requests and keeps the legacy detector from promoting them", () => {
    const decision = decideSemanticAnswerability("来个基础的，你说说。", recent);
    expect(decision).toMatchObject({ state: "SETUP_ONLY", shouldAnswer: false, shouldBuffer: true });
    expect(new QuestionDetector2().analyzeSync("来个基础的，你说说。", "RTOS", true).isQuestion).toBe(false);
  });

  it("accepts a substantive technical request without adding a wait", () => {
    expect(decideSemanticAnswerability("说说 I2C 的仲裁。", recent)).toMatchObject({ state: "ANSWERABLE", shouldAnswer: true });
  });

  it("classifies styles as non-answering modifiers", () => {
    expect(decideSemanticAnswerability("简单说说就行。", recent)).toMatchObject({ state: "STYLE_ONLY", shouldAnswer: false, shouldAttachToPrevious: true });
  });

  it("keeps a conditional clause and a dangling tail open", () => {
    expect(decideSemanticAnswerability("如果系统间歇性卡死。", recent).state).toBe("SETUP_ONLY");
    expect(decideSemanticAnswerability("你说说 UART 和 SPI 的主要区别，以及什么时候。", recent).state).toBe("INCOMPLETE");
  });

  it("attaches 哪一个 to the recent question context", () => {
    const result = decideSemanticAnswerability("你会更倾向于用哪一个？", recent);
    expect(result).toMatchObject({ state: "CONTEXT_DEPENDENT", shouldAnswer: true, shouldAttachToPrevious: true });
  });

  it("accepts complete elliptical follow-ups without treating them as style-only", () => {
    expect(decideSemanticAnswerability("好，说说", { ...recent, speechAct: "FOLLOW_UP" })).toMatchObject({ state: "CONTEXT_DEPENDENT", shouldAnswer: true });
    expect(decideSemanticAnswerability("那如果换成 RTOS？", { ...recent, speechAct: "FOLLOW_UP" })).toMatchObject({ state: "CONTEXT_DEPENDENT", shouldAnswer: true });
  });

  it("rejects predicate-only questions that are missing their object", () => {
    expect(decideSemanticAnswerability("中断里能不能用。", recent)).toMatchObject({ state: "OPEN_PREDICATE", shouldAnswer: false, shouldBuffer: true });
    expect(decideSemanticAnswerability("这里怎么配置。", recent).state).toBe("OPEN_PREDICATE");
  });

  it("does not allow a strong local classifier to rescue a hard negative", () => {
    expect(decideSemanticAnswerability("来个基础的，你说说。", { ...recent, localClassifierConfidence: 0.99 }).state).toBe("SETUP_ONLY");
    expect(decideSemanticAnswerability("中断里能不能用。", { ...recent, localClassifierConfidence: 0.99 }).state).toBe("OPEN_PREDICATE");
  });

  it("holds a short ASR object that is likely to be completed by the next fragment", () => {
    expect(decideSemanticAnswerability("怎么避免假？", recent)).toMatchObject({ state: "INCOMPLETE", shouldAnswer: false, isDangling: true });
  });
});
