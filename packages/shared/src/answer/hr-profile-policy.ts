import { classifyQuestionSemanticFrame } from "../question/semantic-frame";
import type { SalaryExpectation } from "../profile";

export const NO_COMPANY_CONTEXT_FALLBACK = "目前没有足够的公司和业务资料，我不想凭空猜测；如果补充具体产品、业务或岗位信息，我可以再做针对性回答。";
export const NO_SALARY_CONTEXT_FALLBACK = "我的薪资期望会结合岗位职责、整体薪酬和发展空间综合评估；目前没有配置具体数字，所以不先给未经确认的金额。";

function salaryText(expectation: SalaryExpectation): string {
  const currency = expectation.currency ?? "";
  const period = expectation.period === "year" ? "年薪" : "月薪";
  if (expectation.min !== undefined && expectation.max !== undefined) return `我的期望大致是${currency}${expectation.min}到${currency}${expectation.max}，按${period}口径，具体也可以结合岗位职责和整体薪酬沟通。`;
  if (expectation.min !== undefined) return `我的期望下限大致是${currency}${expectation.min}，按${period}口径，具体可以结合岗位职责和整体薪酬沟通。`;
  if (expectation.max !== undefined) return `我的期望上限大致是${currency}${expectation.max}，按${period}口径，具体可以结合岗位职责和整体薪酬沟通。`;
  return NO_SALARY_CONTEXT_FALLBACK;
}

export function enforceHrProfilePolicy(input: { question: string; answer: string; companyContext?: string; salaryExpectation?: SalaryExpectation }): { answer: string; rewritten: boolean; reason?: string } {
  const frame = classifyQuestionSemanticFrame(input.question);
  if (frame === "company" && !input.companyContext?.trim()) return { answer: NO_COMPANY_CONTEXT_FALLBACK, rewritten: true, reason: "company-context-missing" };
  if (frame !== "salary") return { answer: input.answer, rewritten: false };
  if (!input.salaryExpectation || Object.values(input.salaryExpectation).every((value) => value === undefined || value === "")) return { answer: NO_SALARY_CONTEXT_FALLBACK, rewritten: true, reason: "salary-expectation-missing" };
  const configuredNumbers = Object.values(input.salaryExpectation).filter((value): value is number => typeof value === "number").map(String);
  const answerNumbers = input.answer.match(/\d+(?:\.\d+)?/g) ?? [];
  if (answerNumbers.some((value) => !configuredNumbers.includes(value))) return { answer: salaryText(input.salaryExpectation), rewritten: true, reason: "salary-number-not-configured" };
  return { answer: input.answer, rewritten: false };
}
