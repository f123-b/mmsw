import { describe, expect, it } from "vitest";
import { SessionEvidenceStore } from "./session-evidence";

describe("SessionEvidenceStore", () => {
  it("records candidate assertions with provenance and extracted high-risk claims", () => {
    const store = new SessionEvidenceStore();
    const statement = store.recordCandidateStatement({ sessionId: "s1", questionId: "q1", text: "我的语音识别准确率大约98%。", confidence: 0.95, createdAt: 100 });
    expect(statement).toMatchObject({ source: "candidate_statement", verification: "candidate_asserted", sessionId: "s1", questionId: "q1", confidence: 0.95 });
    expect(statement?.extractedClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ provenance: "personal_metric", risk: "high" })
    ]));
  });

  it("deduplicates repeated statements and keeps a bounded recent window", () => {
    const store = new SessionEvidenceStore(2);
    store.recordCandidateStatement({ sessionId: "s1", text: "我做过 CAN 调试", createdAt: 1 });
    store.recordCandidateStatement({ sessionId: "s1", text: "我做过 CAN 调试", createdAt: 2 });
    store.recordCandidateStatement({ sessionId: "s1", text: "我做过 DMA 调试", createdAt: 3 });
    store.recordCandidateStatement({ sessionId: "s1", text: "我做过 ADC 调试", createdAt: 4 });
    expect(store.size).toBe(2);
    expect(store.snapshot().map((item) => item.text)).toEqual(["我做过 DMA 调试", "我做过 ADC 调试"]);
  });
});
