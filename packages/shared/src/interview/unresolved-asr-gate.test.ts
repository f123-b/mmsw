import { describe, expect, it } from "vitest";
import { UnresolvedAsrGate } from "./unresolved-asr-gate";

describe("UnresolvedAsrGate", () => {
  const gate = new UnresolvedAsrGate();

  it("does not answer a garbled technical question with high confidence", () => {
    const result = gate.assess("在非二G的时里，会看哪些信息？", { confidence: 1, possibleTerms: [], corrections: [] });
    expect(result).toMatchObject({ quality: "unresolved", shouldAnswer: false });
    expect(result.confidence).toBeLessThan(0.7);
  });

  it("holds a conflicting terminology candidate for repair", () => {
    const result = gate.assess("study 关键字作用是什么？", { confidence: 0.64, possibleTerms: [{ value: "static", score: 0.64 }], corrections: [] });
    expect(result).toMatchObject({ quality: "repairable", shouldAnswer: false });
  });
});
