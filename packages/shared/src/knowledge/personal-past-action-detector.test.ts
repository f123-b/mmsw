import { describe, expect, it } from "vitest";
import { PersonalPastActionDetector } from "./personal-past-action-detector";

describe("PersonalPastActionDetector", () => {
  const detector = new PersonalPastActionDetector();

  it("flags unsupported historical actions but ignores hypothetical plans", () => {
    expect(detector.detect("我之前调过 DMA，最后解决了丢帧问题。", []).unsupportedCount).toBe(1);
    expect(detector.detect("我会先看日志，再确认 DMA 的中断配置。", []).unsupportedCount).toBe(0);
  });

  it("accepts a historical action when evidence overlaps", () => {
    expect(detector.detect("我之前调过 DMA，最后解决了丢帧问题。", ["候选人之前调过 DMA 并解决丢帧问题。"]).unsupportedCount).toBe(0);
  });
});
