import { describe, expect, it } from "vitest";
import { classifyQuestionSemanticFrame } from "./semantic-frame";

describe("question semantic frames", () => {
  it.each([
    ["volatile 是什么？", "keyword"],
    ["为什么 PWM 要和 ADC 同步？", "cause"],
    ["CAN 总线如何仲裁？", "mechanism"],
    ["DMA 异常怎么排查？", "troubleshooting"],
    ["MCU 用的什么芯片？主频是多少？", "multi_slot"],
    ["你负责的项目遇到什么问题？", "personal_fact"],
    ["你对我们公司了解多少？", "company"],
    ["你的薪资期望是多少？", "salary"]
  ] as const)("classifies %s as %s", (text, expected) => {
    expect(classifyQuestionSemanticFrame(text)).toBe(expected);
  });
});
