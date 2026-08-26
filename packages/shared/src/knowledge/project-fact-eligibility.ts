import type { ProjectFact } from "./types";

/** Central policy used by retrieval, project views and question generation. */
export function isFactEligible(fact: ProjectFact): boolean {
  if (fact.stale || fact.status !== "active" || !fact.evidence?.some((item) => item.quote.trim() && item.relation !== "refute")) return false;
  if (fact.conflictStatus === "conflicting" || fact.conflictStatus === "pending_review") return false;
  if (fact.type === "responsibility") return fact.ownership === "self" && (fact.evidenceLevel === "confirmed-user" || fact.verified);
  if (fact.type === "result" || fact.type === "metric") return fact.evidenceLevel === "confirmed-user" || fact.evidenceLevel === "confirmed-document";
  return fact.evidenceLevel === "confirmed-user" || fact.evidenceLevel === "confirmed-code" || fact.evidenceLevel === "confirmed-document" || fact.verified;
}

export function isFactReviewRequired(fact: ProjectFact): boolean {
  return !isFactEligible(fact) && fact.evidenceLevel !== "not-measured" && !fact.stale && fact.status !== "rejected";
}

/**
 * Narrower than governance review: this is the set of facts for which the
 * candidate must make a personal decision. Ordinary inferred technology or
 * architecture candidates can remain in system review without interrupting
 * the user.
 */
export function isFactUserActionRequired(fact: ProjectFact): boolean {
  if (fact.stale || fact.status === "rejected" || isFactEligible(fact)) return false;
  if (fact.status === "conflicting" || fact.conflictStatus === "conflicting") return true;
  if (fact.type === "responsibility") return true;
  if (fact.type === "result" || fact.type === "metric") {
    return fact.evidenceLevel !== "not-measured" && ["pending", "inferred", "risk"].includes(fact.evidenceLevel ?? "pending");
  }
  // A first-person, high-risk claim needs the candidate's explicit approval;
  // a normal technical candidate does not.
  if (fact.ownership === "self" && ["pending", "inferred", "risk"].includes(fact.evidenceLevel ?? "pending")) return true;
  return false;
}

export function factPriority(fact: ProjectFact): number {
  if (fact.type === "responsibility") return 100;
  if (fact.conflictStatus === "conflicting" || fact.conflictStatus === "pending_review") return 95;
  if (fact.type === "result" || fact.type === "metric") return 90;
  if (fact.evidenceLevel === "risk" || fact.evidenceLevel === "pending") return 80;
  return 10;
}
