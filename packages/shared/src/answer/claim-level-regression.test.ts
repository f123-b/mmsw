import { describe, expect, it } from "vitest";
import { AnswerAgent, ModelRouter, type AnswerProvider } from "../answer";
import { ClaimGate } from "./claim-gate";
import { createEvidenceSnapshot } from "./evidence-context";
import { SessionEvidenceStore } from "./session-evidence";

const WHOLE_ANSWER_FALLBACK = /具体个人事实当前没有被确认|当前已确认的项目资料中没有足够证据/;

async function answer(question: string, draft: string, context = {}): Promise<string> {
  const provider: AnswerProvider = { stream: async function* () { yield draft; } };
  let result = "";
  for await (const event of new AnswerAgent({ normal: provider }, new ModelRouter({ normal: "regression-model" })).stream({ id: `regression-${question}`, text: question }, "NORMAL", context)) {
    if (event.type === "answer_end") result = event.text;
  }
  return result;
}

describe("Claim-level grounding regression", () => {
  it("keeps generic project implementation answers available without project evidence", async () => {
    const answers = await Promise.all([
      answer("FOC 项目中的 ADC 如何保证实时性？", "可以让 PWM 中点触发 ADC，再用 DMA 搬运数据，最后检查中断抖动和采样窗口。"),
      answer("C++ 驱动层怎么封装？", "可以用接口类隔离硬件访问，再用模板或组合复用通用驱动逻辑。"),
      answer("项目出现异常时如何定位？", "先稳定复现并记录日志、波形和时序，再按硬件、驱动、任务链路逐层缩小范围。")
    ]);
    expect(answers.every((item) => item && !WHOLE_ANSWER_FALLBACK.test(item))).toBe(true);
    expect(answers[0]).toContain("ADC");
    expect(answers[1]).toContain("接口");
    expect(answers[2]).toContain("复现");
  });

  it("inherits candidate-stated metrics into the next follow-up", async () => {
    const store = new SessionEvidenceStore();
    store.recordCandidateStatement({ sessionId: "s1", text: "我的语音识别准确率大约98%。", createdAt: 1 });
    store.recordCandidateStatement({ sessionId: "s1", text: "系统最后实现7×24小时运行。", createdAt: 2 });
    const snapshot = createEvidenceSnapshot({ questionId: "follow-up", sessionEvidence: store.snapshot(), projectEvidence: ["项目资料没有记录具体准确率"] });
    const accuracy = await answer("这个98%是怎么做到的？", "我的语音识别准确率大约98%，我会从数据质量、标注和验证集说明。", { evidenceSnapshot: snapshot });
    const availability = await answer("你为7×24小时运行做了什么？", "系统最后实现7×24小时运行，我重点做了异常恢复和长时间回归。", { evidenceSnapshot: snapshot });
    expect(accuracy).toContain("98%");
    expect(availability).toContain("7×24");
    expect(accuracy).not.toContain("没有被确认");
    expect(availability).not.toContain("没有被确认");
  });

  it("rewrites partial metrics and abstains on unsupported identity claims", () => {
    const rewrite = new ClaimGate().check({
      question: "说说这个项目结果",
      answer: "我负责 AS5047P 编码器驱动，并通过滤波把误差降低了40%。",
      evidenceSnapshot: createEvidenceSnapshot({
        questionId: "rewrite",
        personalMemoryEvidence: ["我做过编码器相关工作。"],
        projectEvidence: ["项目使用 AS5047P 编码器。"]
      })
    });
    expect(rewrite.decision).toBe("rewrite");
    expect(rewrite.rewrittenAnswer).toContain("AS5047P");
    expect(rewrite.rewrittenAnswer).not.toContain("40%");

    const identity = new ClaimGate().check({ question: "有没有比赛？", answer: "我参加过电子设计竞赛。" });
    expect(identity.decision).toBe("abstain");
    expect(identity.allowed).toBe(false);
  });

  it("keeps behavioral answers useful without inventing identity facts", async () => {
    const answers = await Promise.all([
      answer("分享一个资源有限但仍完成高目标的案例。", "我会先拆解目标和约束，优先保障关键路径，再用阶段性结果确认方向。"),
      answer("分享一次自主学习新技术的经历。", "我会先明确要解决的问题，再用最小实验验证新技术，最后把结果沉淀成可复用的方法。"),
      answer("有没有论文或者专利？", "我发表过一篇论文并拥有一项专利。")
    ]);
    expect(answers[0]).toContain("拆解目标");
    expect(answers[1]).toContain("最小实验");
    expect(answers[0]).not.toMatch(WHOLE_ANSWER_FALLBACK);
    expect(answers[1]).not.toMatch(WHOLE_ANSWER_FALLBACK);
    // Identity abstentions remain an internal ClaimGate decision. The live
    // stream must not surface the audit/safety fallback copy.
    expect(answers[2]).not.toContain("不能编造");
    expect(answers[2]).not.toMatch(WHOLE_ANSWER_FALLBACK);
  });
});
