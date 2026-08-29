import { describe, expect, it } from "vitest";
import { detectTopicBoundary, hasStandaloneTopicSubject } from "./topic-boundary-detector";

describe("TopicBoundaryDetector", () => {
  it.each([
    ["中断完整过程", "说一下 CAN 总线", "NEW_TOPIC"],
    ["PWM 中心对齐", "ADC 为什么和 PWM 同步", "RELATED_TOPIC"],
    ["ADC 同步", "为什么这样采样", "SAME_TOPIC"],
    ["CAN", "仲裁呢", "SAME_TOPIC"],
    ["CAN", "TCP 和 UDP 区别", "NEW_TOPIC"]
  ] as const)("classifies %s -> %s as %s", (previousText, currentText, relation) => {
    expect(detectTopicBoundary({ previousText, currentText }).relation).toBe(relation);
  });

  it("recognizes standalone subjects inside answer-request wording", () => {
    expect(hasStandaloneTopicSubject("说一下 CAN 总线")).toBe(true);
    expect(hasStandaloneTopicSubject("讲一下 ARM 架构")).toBe(true);
    expect(hasStandaloneTopicSubject("具体怎么做？")).toBe(false);
  });

  it("does not treat the active old topic as an entity in the new turn", () => {
    const decision = detectTopicBoundary({
      previousText: "中断是怎么触发的？",
      previousTopic: "实时采样与中断",
      currentTopic: "实时采样与中断",
      currentText: "说一下 CAN 总线"
    });
    expect(decision.relation).toBe("NEW_TOPIC");
    expect(decision.currentEntities).toEqual(["CAN"]);
    expect(decision.previousEntities).toContain("中断");
  });
});
