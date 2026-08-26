import { describe, expect, it } from "vitest";
import { factPriority, isFactEligible, isFactReviewRequired, isFactUserActionRequired } from "./project-fact-eligibility";
import type { ProjectFact } from "./types";

const base: ProjectFact = { id: "f", projectId: "p", type: "technology", title: "CAN", content: "CAN", confidence: 1, verified: false, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: "CAN" }], status: "active", evidenceLevel: "confirmed-document" };

describe("project fact eligibility", () => {
  it("allows evidenced code/document facts without a manual click", () => {
    expect(isFactEligible(base)).toBe(true);
    expect(isFactEligible({ ...base, evidenceLevel: "confirmed-code" })).toBe(true);
    expect(isFactEligible({ ...base, evidenceLevel: "confirmed-document" })).toBe(true);
    expect(isFactEligible({ ...base, verified: true, evidenceLevel: "pending" })).toBe(true);
    expect(isFactEligible({ ...base, stale: true })).toBe(false);
    expect(isFactEligible({ ...base, status: "conflicting", conflictStatus: "conflicting" })).toBe(false);
    expect(isFactEligible({ ...base, evidence: [{ sourceId: "s", quote: "CAN", relation: "refute" }] })).toBe(false);
  });
  it("requires self ownership for responsibility and evidence for results", () => {
    expect(isFactEligible({ ...base, type: "responsibility", evidenceLevel: "confirmed-user", ownership: "unknown" })).toBe(false);
    expect(isFactEligible({ ...base, type: "responsibility", evidenceLevel: "confirmed-user", ownership: "self" })).toBe(true);
    expect(isFactEligible({ ...base, type: "responsibility", evidenceLevel: "confirmed-code", ownership: "self" })).toBe(false);
    expect(isFactEligible({ ...base, type: "responsibility", evidenceLevel: "confirmed-user", ownership: "unknown" })).toBe(false);
    expect(isFactEligible({ ...base, type: "result", evidenceLevel: "pending" })).toBe(false);
    expect(factPriority({ ...base, type: "responsibility" })).toBe(100);
  });
  it("keeps personal responsibility optional but requires team boundaries", () => {
    expect(isFactUserActionRequired({ ...base, evidenceLevel: "pending", status: "pending_review" })).toBe(false);
    expect(isFactUserActionRequired({ ...base, type: "responsibility", evidenceLevel: "pending", status: "pending_review" })).toBe(false);
    expect(isFactUserActionRequired({ ...base, type: "responsibility", evidenceLevel: "pending", status: "pending_review" }, "team")).toBe(true);
    expect(isFactUserActionRequired({ ...base, type: "metric", evidenceLevel: "risk", status: "pending_review" })).toBe(true);
    expect(isFactUserActionRequired({ ...base, type: "metric", evidenceLevel: "not-measured", status: "active" })).toBe(false);
    expect(isFactReviewRequired({ ...base, type: "metric", evidenceLevel: "not-measured", status: "active" })).toBe(false);
    expect(isFactUserActionRequired({ ...base, status: "conflicting", conflictStatus: "conflicting" })).toBe(true);
  });
});
