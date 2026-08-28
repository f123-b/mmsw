import { describe, expect, it } from "vitest";
import { enforceHrProfilePolicy, NO_COMPANY_CONTEXT_FALLBACK, NO_SALARY_CONTEXT_FALLBACK } from "./hr-profile-policy";

describe("HR profile policy", () => {
  it("does not guess company facts without company context", () => {
    expect(enforceHrProfilePolicy({ question: "你对我们公司了解多少？", answer: "贵公司主要做智能汽车。" })).toMatchObject({ answer: NO_COMPANY_CONTEXT_FALLBACK, rewritten: true });
  });

  it("does not invent a salary number without configured expectation", () => {
    expect(enforceHrProfilePolicy({ question: "你的薪资期望是多少？", answer: "我期望月薪 30K。" })).toMatchObject({ answer: NO_SALARY_CONTEXT_FALLBACK, rewritten: true });
  });

  it("only allows configured salary numbers", () => {
    const result = enforceHrProfilePolicy({ question: "你的薪资期望是多少？", answer: "我期望 30K 到 35K。", salaryExpectation: { min: 25, max: 30, currency: "K", period: "month" } });
    expect(result.reason).toBe("salary-number-not-configured");
    expect(result.answer).toContain("K25到K30");
  });
});
