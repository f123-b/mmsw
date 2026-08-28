import { describe, expect, it } from "vitest";
import { ClaimGate } from "./claim-gate";
import { createEvidenceSnapshot } from "./evidence-context";

describe("ClaimGate", () => {
  it("allows a personal answer whose high-risk claims match personal evidence", () => {
    const result = new ClaimGate().check({
      question: "说说你负责的通信模块",
      answer: "我负责通信模块，使用 CAN 做实时通信，延迟 5ms。",
      evidenceSnapshot: createEvidenceSnapshot({ questionId: "q1", personalMemoryEvidence: ["我负责通信模块，使用 CAN 做实时通信，延迟 5ms。"] }),
      requiresPersonalEvidence: true
    });
    expect(result.allowed).toBe(true);
    expect(result.decision).toBe("allow");
  });

  it("rewrites an unsupported personal claim without rejecting the whole answer", () => {
    const result = new ClaimGate().check({ question: "说说你负责的项目", answer: "我主导了 STM32 项目并负责降低延迟。", requiresPersonalEvidence: true });
    expect(result.allowed).toBe(true);
    expect(["rewrite", "partial"]).toContain(result.decision);
    expect(result.rewrittenAnswer).toBeTruthy();
    expect(result.rewrittenAnswer).not.toContain("降低延迟");
    expect(result.issues).toContain("missing-personal-evidence");
  });

  it("blocks conflicting hardware and metric claims", () => {
    const result = new ClaimGate().check({
      question: "说说项目结果",
      answer: "我主导了 STM32 项目，延迟降低了 50%。",
      evidenceSnapshot: createEvidenceSnapshot({ questionId: "q2", personalMemoryEvidence: ["我参与 RK3568 项目，延迟降低了 20%。"] }),
      requiresPersonalEvidence: true
    });
    expect(result.allowed).toBe(true);
    expect(["rewrite", "partial"]).toContain(result.decision);
    expect(result.blockedClaims.some((claim) => claim.status === "conflicting")).toBe(true);
    expect(result.issues).toContain("claim-evidence-conflicting");
  });

  it("abstains only for an unverified personal identity claim", () => {
    const result = new ClaimGate().check({ question: "有没有论文或专利？", answer: "我发表过一篇论文并拥有一项专利。" });
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("abstain");
    expect(result.fallbackAnswer).toContain("不能编造");
    expect(result.blockedClaims.every((claim) => claim.provenance === "personal_identity")).toBe(true);
  });

  it("accepts a candidate statement as session personal evidence", () => {
    const snapshot = createEvidenceSnapshot({
      questionId: "q3",
      sessionEvidence: [{
        id: "statement-98",
        text: "我的语音识别准确率大约98%。",
        source: "candidate_statement",
        trust: "personal",
        verified: true,
        sessionId: "session-1",
        extractedClaims: [{ claim: "我的语音识别准确率大约98%", provenance: "personal_metric", risk: "high" }],
        createdAt: 1,
        confidence: 0.95,
        verification: "candidate_asserted"
      }]
    });
    const result = new ClaimGate().check({ question: "这个98%是怎么做到的？", answer: "我的语音识别准确率大约98%。", evidenceSnapshot: snapshot });
    expect(result.decision).toBe("allow");
    expect(result.allowed).toBe(true);
  });

  it("does not block a generic technical answer merely because personal evidence is absent", () => {
    const result = new ClaimGate().check({ question: "DMA 的作用是什么？", answer: "DMA 可以减少 CPU 搬运数据的开销。", requiresPersonalEvidence: false });
    expect(result.allowed).toBe(true);
  });

  it("does not use project source as proof of personal ownership", () => {
    const result = new ClaimGate().check({
      question: "你负责这个项目的哪一部分？",
      answer: "我负责 ADC 采样和 DMA 传输。",
      evidenceSnapshot: createEvidenceSnapshot({ questionId: "q4", projectEvidence: ["项目使用 ADC 和 DMA 完成采样传输。"] })
    });
    expect(result.allowed).toBe(true);
    expect(["rewrite", "partial"]).toContain(result.decision);
    expect(result.blockedClaims.some((claim) => claim.provenance === "personal_ownership")).toBe(true);
  });
});
