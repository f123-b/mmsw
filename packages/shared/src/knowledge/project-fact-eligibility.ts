import type { ProjectFact, ProjectOwnershipMode } from "./types";

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
export function isFactUserActionRequired(fact: ProjectFact, projectOwnershipMode: ProjectOwnershipMode = "personal"): boolean {
  if (fact.stale || fact.status === "rejected" || isFactEligible(fact)) return false;
  if (fact.status === "conflicting" || fact.conflictStatus === "conflicting") return true;
  if (fact.type === "responsibility") return projectOwnershipMode === "team" || projectOwnershipMode === "partial";
  if (fact.type === "result" || fact.type === "metric") {
    return fact.evidenceLevel !== "not-measured" && ["pending", "inferred", "risk"].includes(fact.evidenceLevel ?? "pending");
  }
  // Ordinary technical facts remain system-managed. Only conflicts, high-risk
  // outcomes/metrics, and team/partial responsibility boundaries interrupt the
  // user for a decision.
  return false;
}

export function factPriority(fact: ProjectFact): number {
  if (fact.type === "responsibility") return 100;
  if (fact.conflictStatus === "conflicting" || fact.conflictStatus === "pending_review") return 95;
  if (fact.type === "result" || fact.type === "metric") return 90;
  if (fact.evidenceLevel === "risk" || fact.evidenceLevel === "pending") return 80;
  return 10;
}
