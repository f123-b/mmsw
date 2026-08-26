import { describe, expect, it } from "vitest";
import { factPriority, isFactEligible } from "./project-fact-eligibility";
import type { ProjectFact } from "./types";

const base: ProjectFact = { id: "f", projectId: "p", type: "technology", title: "CAN", content: "CAN", confidence: 1, verified: false, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: "CAN" }], status: "active", evidenceLevel: "confirmed-document" };

describe("project fact eligibility", () => {
  it("allows evidenced code/document facts without a manual click", () => {
    expect(isFactEligible(base)).toBe(true);
    expect(isFactEligible({ ...base, stale: true })).toBe(false);
    expect(isFactEligible({ ...base, evidence: [{ sourceId: "s", quote: "CAN", relation: "refute" }] })).toBe(false);
  });
  it("requires self ownership for responsibility and evidence for results", () => {
    expect(isFactEligible({ ...base, type: "responsibility", evidenceLevel: "confirmed-user", ownership: "unknown" })).toBe(false);
    expect(isFactEligible({ ...base, type: "responsibility", evidenceLevel: "confirmed-user", ownership: "self" })).toBe(true);
    expect(isFactEligible({ ...base, type: "result", evidenceLevel: "pending" })).toBe(false);
    expect(factPriority({ ...base, type: "responsibility" })).toBe(100);
  });
});
