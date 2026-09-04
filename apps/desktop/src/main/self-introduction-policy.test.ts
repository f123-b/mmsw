import { describe, expect, it } from "vitest";
import { canUseSelfIntroduction } from "./self-introduction-policy";

describe("user-controlled self introduction", () => {
  it.each(["manual", "uploaded"] as const)("uses saved %s text including legacy drafts and changed resumes", (source) => {
    expect(canUseSelfIntroduction({ text: "我保存的原稿。", source, approved: false, status: "stale" })).toBe(true);
  });
  it("requires acceptance for AI drafts and falls back when cleared", () => {
    expect(canUseSelfIntroduction({ text: "AI 草稿", source: "ai_generated", approved: false, status: "current" })).toBe(false);
    expect(canUseSelfIntroduction({ text: "已选用的 AI 稿", source: "ai_generated", approved: true, status: "current" })).toBe(true);
    expect(canUseSelfIntroduction({ text: "  ", source: "manual", approved: true, status: "current" })).toBe(false);
    expect(canUseSelfIntroduction(undefined)).toBe(false);
  });
});
