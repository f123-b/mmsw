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

  it("falls back when a personal answer has no supporting evidence", () => {
    const result = new ClaimGate().check({ question: "说说你负责的项目", answer: "我主导了 STM32 项目并负责降低延迟。", requiresPersonalEvidence: true });
    expect(result.allowed).toBe(false);
    expect(result.decision).toBe("fallback");
    expect(result.fallbackAnswer).toContain("没有足够证据");
    expect(result.issues).toContain("missing-personal-evidence");
  });

  it("blocks conflicting hardware and metric claims", () => {
    const result = new ClaimGate().check({
      question: "说说项目结果",
      answer: "我主导了 STM32 项目，延迟降低了 50%。",
      evidenceSnapshot: createEvidenceSnapshot({ questionId: "q2", personalMemoryEvidence: ["我参与 RK3568 项目，延迟降低了 20%。"] }),
      requiresPersonalEvidence: true
    });
    expect(result.allowed).toBe(false);
    expect(result.blockedClaims.some((claim) => claim.status === "conflicting")).toBe(true);
    expect(result.issues).toContain("claim-evidence-conflicting");
  });

  it("does not block a generic technical answer merely because personal evidence is absent", () => {
    const result = new ClaimGate().check({ question: "DMA 的作用是什么？", answer: "DMA 可以减少 CPU 搬运数据的开销。", requiresPersonalEvidence: false });
    expect(result.allowed).toBe(true);
  });
});
