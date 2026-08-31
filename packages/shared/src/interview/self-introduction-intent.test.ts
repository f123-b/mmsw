import { describe, expect, it } from "vitest";
import { detectSelfIntroductionIntent, isSelfIntroductionRequest } from "./self-introduction-intent";

describe("self introduction intent", () => {
  it("recognizes narrow self-introduction prompts locally", () => {
    expect(isSelfIntroductionRequest("请你先做个自我介绍")).toBe(true);
    expect(detectSelfIntroductionIntent("简单介绍一下自己，控制在 60 秒，用英文")).toMatchObject({ matched: true, targetDurationSeconds: 60, language: "en-US", style: "simple", hasAdditionalConstraint: true });
  });

  it("keeps project and responsibility questions out of the self-intro lane", () => {
    expect(isSelfIntroductionRequest("介绍一下你的 FOC 项目")).toBe(false);
    expect(isSelfIntroductionRequest("介绍一下 DMA")).toBe(false);
    expect(isSelfIntroductionRequest("说说你在项目里负责什么")).toBe(false);
    expect(isSelfIntroductionRequest("介绍一下自己在项目中负责的工作")).toBe(false);
  });
});
