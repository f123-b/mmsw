import { describe, expect, it } from "vitest";
import { detectExplicitQuestionBoundary, splitIntraSegmentQuestions } from "./intra-segment-question-splitter";

describe("intra-segment question splitter", () => {
  it("keeps punctuation-separated slots together by default", () => {
    const result = splitIntraSegmentQuestions("你会怎么快速定位？重点讲 ADC/PWM 同步。", { technicalAnchors: ["ADC", "PWM"] });
    expect(result).toHaveLength(1);
  });

  it("keeps same-anchor multi-slot questions together", () => {
    expect(splitIntraSegmentQuestions("什么是 CAN 仲裁？为什么说 CAN 需要优先级？")).toHaveLength(1);
  });

  it("does not split ordinary prose or fragments without independent question shape", () => {
    expect(splitIntraSegmentQuestions("这个项目使用 STM32。随后继续。")).toHaveLength(1);
  });

  it("splits only after an explicit new-question marker with an independent nucleus", () => {
    expect(detectExplicitQuestionBoundary("先问 UART 怎么配置？第二个问题，CAN 总线仲裁原理是什么？")).toMatchObject({ shouldSplit: true, reason: "enumerated-independent-question" });
    expect(splitIntraSegmentQuestions("这个问题先到这里。换个问题，HardFault 怎么定位？")).toHaveLength(2);
  });

  it("does not let a technical entity create a topic boundary", () => {
    expect(splitIntraSegmentQuestions("上电自检有哪些项目？失败后的降级策略是什么？")).toHaveLength(1);
    expect(splitIntraSegmentQuestions("优先级反转是什么？在 RTOS 里怎么避免？")).toHaveLength(1);
  });
});
