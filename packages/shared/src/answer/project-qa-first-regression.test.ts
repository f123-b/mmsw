import { describe, expect, it } from "vitest";
import { ClaimGate } from "./claim-gate";
import { PromptBuilder, ContextRouter } from "../answer";
import { createEvidenceSnapshot } from "./evidence-context";
import { planAnswerSource } from "./project-answer-source-planner";
import { QuestionBankRouter } from "../question-bank-router";
import { normalizeQuestionBankText, type QuestionBankQuestionRecord } from "../question-bank";

const projectId = "foc-project";

function qa(input: { id: string; text: string; verified?: boolean; stale?: boolean; answer?: string; variants?: string[]; projectId?: string | null }): QuestionBankQuestionRecord {
  const verified = input.verified ?? true;
  const stale = input.stale ?? false;
  const isProject = input.projectId !== null;
  const candidateProjectId = input.projectId ?? projectId;
  return {
    id: input.id,
    canonicalText: input.text,
    normalizedText: normalizeQuestionBankText(input.text),
    type: isProject ? "project" : "technical",
    bankType: isProject ? "project" : "general",
    category: isProject ? "project" : "technical",
    scope: isProject ? "project" : "global",
    ...(candidateProjectId ? { projectId: candidateProjectId } : {}),
    difficulty: "medium",
    source: verified ? "imported" : "ai-generated",
    status: "active",
    confidence: 1,
    verified,
    stale,
    variants: input.variants ?? [],
    relations: [],
    followUps: [],
    answerCards: input.answer === undefined ? [] : [{ id: `${input.id}-card`, questionId: input.id, mode: "standard", content: input.answer, keyPoints: [], sourceType: verified ? "imported" : "ai-generated", verified, stale, version: 1, createdAt: 1, updatedAt: 1 }],
    skillIds: [],
    factIds: [],
    frequency: 0,
    mastery: 0,
    createdAt: 1,
    updatedAt: 1
  };
}

interface ProjectQaRegressionCase {
  name: string;
  text: string;
  canonical: string;
  expected: "exact" | "strong" | "partial" | "none";
  stage: "project" | "fallback";
  stale?: boolean;
  ai?: boolean;
  noAnswer?: boolean;
  otherProject?: boolean;
  fallback?: boolean;
}

const cases: ProjectQaRegressionCase[] = [
  { name: "canonical exact", text: "ADC 怎么保证实时性？", canonical: "ADC 怎么保证实时性？", expected: "exact", stage: "project" },
  { name: "stored variant exact", text: "PWM 和 ADC 怎么同步？", canonical: "ADC 怎么保证实时性？", expected: "exact", stage: "project" },
  { name: "strong spoken paraphrase", text: "你这里 PWM 跟 ADC 到底是怎么同步的？", canonical: "ADC 怎么保证实时性？", expected: "strong", stage: "project" },
  { name: "strong short paraphrase", text: "实时性怎么保证？", canonical: "ADC 怎么保证实时性？", expected: "strong", stage: "project" },
  { name: "partial neighboring topic", text: "采样时序怎么验证？", canonical: "ADC 怎么采样？", noAnswer: true, expected: "partial", stage: "project" },
  { name: "partial follow-up", text: "那这个采样时序怎么验证？", canonical: "ADC 怎么采样？", noAnswer: true, expected: "partial", stage: "project" },
  { name: "none goes to fallback", text: "volatile 的作用是什么？", canonical: "ADC 怎么保证实时性？", expected: "none", stage: "fallback" },
  { name: "none does not use another project", text: "EtherCAT 拓扑怎么配置？", canonical: "ADC 怎么保证实时性？", expected: "none", stage: "fallback" },
  { name: "stale QA is not routable", text: "ADC 怎么保证实时性？", canonical: "ADC 怎么保证实时性？", stale: true, expected: "none", stage: "fallback" },
  { name: "unverified AI remains non-authoritative", text: "你这里 PWM 跟 ADC 到底是怎么同步的？", canonical: "ADC 怎么保证实时性？", ai: true, expected: "partial", stage: "project" },
  { name: "partial keeps global fallback available", text: "采样时序怎么验证？", canonical: "ADC 怎么采样？", noAnswer: true, fallback: true, expected: "partial", stage: "project" },
  { name: "unrelated project cannot outrank global", text: "SPI 读不到数据怎么排查？", canonical: "ADC 怎么保证实时性？", otherProject: true, expected: "none", stage: "fallback" }
];

describe("Project QA first real-interview regression", () => {
  it.each(cases)("routes $name", ({ text, canonical, expected, stage, stale, ai, noAnswer, otherProject, fallback }) => {
    const project = qa({ id: "adc-qa", text: canonical, stale, verified: !ai, answer: noAnswer ? "" : "PWM 中点触发 ADC，并通过 DMA 搬运采样数据。", variants: canonical === "ADC 怎么保证实时性？" ? ["PWM 和 ADC 怎么同步？"] : [] });
    const candidates = [
      project,
      ...(otherProject ? [qa({ id: "other-project", text: "SPI 读不到数据怎么排查？", projectId: "other-project", answer: "检查地址、时序和 ACK。" })] : []),
      qa({ id: "global", text: fallback ? "采样时序怎么验证？" : "DMA 如何搬运采样数据？", projectId: null, answer: "DMA 由硬件完成数据搬运，减少 CPU 介入。", variants: ["DMA 怎么减少 CPU 开销？"] })
    ];
    const result = new QuestionBankRouter().routeProjectQaFirst(text, candidates, { projectId });
    expect(result.stage).toBe(stage);
    expect(result.projectQa?.level).toBe(expected);
    if (fallback) expect(result.fallback?.top?.question.id).toBe("global");
    if (stale || otherProject) expect(result.projectQa?.top?.question.id).not.toBe(otherProject ? "other-project" : "adc-qa");
    if (ai) expect(planAnswerSource({ projectId, projectQuestion: true, projectQa: result.projectQa }).mode).not.toBe("project_qa_direct");
  });

  it("keeps direct QA facts in the rewrite prompt and validates the rewritten result", () => {
    const stored = "项目中使用 PWM 中点触发 ADC，并通过 DMA 搬运采样数据。";
    const route = new QuestionBankRouter().routeProjectQaFirst("ADC 怎么保证实时性？", [qa({ id: "direct", text: "ADC 怎么保证实时性？", answer: stored })], { projectId });
    const plan = planAnswerSource({ projectId, projectQuestion: true, projectQa: route.projectQa });
    const context = new ContextRouter().route("ADC 怎么保证实时性？", { answerSourcePlan: plan, preparedAnswer: { content: stored, score: .95, verified: true }, projectQaEvidence: [stored], retrievedKnowledge: ["不应使用的普通资料"], evidenceSnapshot: createEvidenceSnapshot({ questionId: "direct", projectId, answerSourcePlan: plan, projectQaEvidence: [stored], retrievedKnowledge: ["不应使用的普通资料"] }) });
    const prompt = new PromptBuilder().build({ id: "direct", text: "ADC 怎么保证实时性？" }, "NORMAL", context).map((section) => section.content).join("\n");
    expect(plan.mode).toBe("project_qa_direct");
    expect(prompt).toContain(stored);
    expect(prompt).not.toContain("不应使用的普通资料");
    expect(new ClaimGate().check({ question: "ADC 怎么保证实时性？", answer: stored, evidenceSnapshot: context.evidenceSnapshot }).allowed).toBe(true);
  });

  it("uses a verified partial QA as an augmented source instead of a direct copy", () => {
    const stored = "PWM 中点触发 ADC，并通过 DMA 搬运采样数据。";
    const route = new QuestionBankRouter().routeProjectQaFirst("如果 DMA 数据来不及处理怎么办？", [qa({ id: "partial", text: "ADC 怎么采样？", answer: stored, variants: ["PWM 和 ADC 怎么同步？"] })], { projectId });
    const plan = planAnswerSource({ projectId, projectQuestion: true, projectQa: route.projectQa });
    const context = new ContextRouter().route("如果 DMA 数据来不及处理怎么办？", { answerSourcePlan: plan, preparedAnswer: { content: stored, score: route.projectQa?.top?.score ?? 0, verified: true }, projectQaEvidence: [stored], projectEvidence: ["项目控制周期固定，需要在 deadline 前完成搬运"], retrievedKnowledge: ["通用方法：使用 half/full interrupt、双缓冲和 overrun 监测。"] });
    const prompt = new PromptBuilder().build({ id: "partial", text: "如果 DMA 数据来不及处理怎么办？" }, "NORMAL", context).map((section) => section.content).join("\n");
    expect(route.projectQa?.level).toBe("partial");
    expect(plan.mode).toBe("project_qa_augmented");
    expect(prompt).toContain(stored);
    expect(prompt).toContain("overrun");
    expect(prompt).toContain("项目控制周期固定");
  });

  it("reports project-first routing quality and latency", () => {
    const repetitions = 100;
    const router = new QuestionBankRouter();
    const startedAt = performance.now();
    let samples = 0;
    let projectHits = 0;
    let strongPredictions = 0;
    let strongCorrect = 0;
    let directPlans = 0;
    let augmentedPlans = 0;
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      for (const testCase of cases) {
        const project = qa({ id: "adc-qa", text: testCase.canonical, stale: testCase.stale, verified: !testCase.ai, answer: testCase.noAnswer ? "" : "PWM 中点触发 ADC，并通过 DMA 搬运采样数据。", variants: testCase.canonical === "ADC 怎么保证实时性？" ? ["PWM 和 ADC 怎么同步？"] : [] });
        const candidates = [
          project,
          ...(testCase.otherProject ? [qa({ id: "other-project", text: "SPI 读不到数据怎么排查？", projectId: "other-project", answer: "检查地址、时序和 ACK。" })] : []),
          qa({ id: "global", text: testCase.fallback ? "采样时序怎么验证？" : "DMA 如何搬运采样数据？", projectId: null, answer: "DMA 由硬件完成数据搬运，减少 CPU 介入。", variants: ["DMA 怎么减少 CPU 开销？"] })
        ];
        const result = router.routeProjectQaFirst(testCase.text, candidates, { projectId });
        const level = result.projectQa?.level ?? "none";
        if (level !== "none") projectHits += 1;
        if (level === "strong") {
          strongPredictions += 1;
          if (testCase.expected === "strong") strongCorrect += 1;
        }
        const plan = planAnswerSource({ projectId, projectQuestion: true, projectQa: result.projectQa });
        if (plan.mode === "project_qa_direct") directPlans += 1;
        if (plan.mode === "project_qa_augmented") augmentedPlans += 1;
        samples += 1;
      }
    }
    const totalMs = performance.now() - startedAt;
    const strongPrecision = strongPredictions === 0 ? 1 : strongCorrect / strongPredictions;
    console.log("PROJECT_QA_FIRST_BENCHMARK", JSON.stringify({ samples, totalMs: Number(totalMs.toFixed(2)), avgMs: Number((totalMs / samples).toFixed(4)), projectQaHitRate: Number((projectHits / samples).toFixed(4)), projectQaStrongMatchPrecision: Number(strongPrecision.toFixed(4)), projectQaDirectAnswerRate: Number((directPlans / samples).toFixed(4)), projectQaAugmentedAnswerRate: Number((augmentedPlans / samples).toFixed(4)) }));
    expect(totalMs).toBeLessThan(5_000);
  });
});
