import { describe, expect, it } from "vitest";
import { splitIntraSegmentQuestions } from "./intra-segment-question-splitter";

describe("intra-segment question splitter", () => {
  it("splits independently anchored question clauses", () => {
    const result = splitIntraSegmentQuestions("你会怎么快速定位？重点讲 ADC/PWM 同步。", { technicalAnchors: ["ADC", "PWM"] });
    expect(result.map((item) => item.text)).toEqual(["你会怎么快速定位？", "重点讲 ADC/PWM 同步。"]);
  });

  it("keeps same-anchor multi-slot questions together", () => {
    expect(splitIntraSegmentQuestions("什么是 CAN 仲裁？为什么说 CAN 需要优先级？")).toHaveLength(1);
  });

  it("does not split ordinary prose or fragments without independent question shape", () => {
    expect(splitIntraSegmentQuestions("这个项目使用 STM32。随后继续。")).toHaveLength(1);
  });
});

