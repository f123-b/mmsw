import { describe, expect, it } from "vitest";
import { decomposeQuestion, multiSlotPrompt } from "./question-decomposer";

describe("question decomposition", () => {
  it("splits a compound hardware question into ordered answer slots", () => {
    const result = decomposeQuestion("MCU 用的什么芯片？主频是多少？Flash 多大？为什么主频会影响 MCU 性能？");
    expect(result.isMultiSlot).toBe(true);
    expect(result.slots).toHaveLength(4);
    expect(result.slots.map((slot) => slot.intent)).toEqual(["fact", "fact", "fact", "why"]);
    expect(multiSlotPrompt(result)).toContain("必须按顺序覆盖每个子问题");
  });

  it("keeps a single question as one slot", () => {
    const result = decomposeQuestion("为什么 CAN 需要终端电阻？");
    expect(result.isMultiSlot).toBe(false);
    expect(result.slots[0]).toMatchObject({ intent: "why", semanticFrame: "cause", evidenceScope: "general" });
  });
});
