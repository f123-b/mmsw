import type { ProjectFact } from "./types";

/** Central policy used by retrieval, project views and question generation. */
export function isFactEligible(fact: ProjectFact): boolean {
  if (fact.stale || fact.status !== "active" || !fact.evidence?.some((item) => item.quote.trim() && item.relation !== "refute")) return false;
  if (fact.conflictStatus === "conflicting" || fact.conflictStatus === "pending_review") return false;
  if (fact.type === "responsibility") return fact.ownership === "self" && (fact.evidenceLevel === "confirmed-user" || fact.evidenceLevel === "confirmed-code" || fact.verified);
  if (fact.type === "result" || fact.type === "metric") return fact.evidenceLevel === "confirmed-user" || fact.evidenceLevel === "confirmed-document";
  return fact.evidenceLevel === "confirmed-user" || fact.evidenceLevel === "confirmed-code" || fact.evidenceLevel === "confirmed-document" || fact.verified;
}

export function isFactReviewRequired(fact: ProjectFact): boolean {
  return !isFactEligible(fact) && !fact.stale && fact.status !== "rejected";
}

export function factPriority(fact: ProjectFact): number {
  if (fact.type === "responsibility") return 100;
  if (fact.conflictStatus === "conflicting" || fact.conflictStatus === "pending_review") return 95;
  if (fact.type === "result" || fact.type === "metric") return 90;
  if (fact.evidenceLevel === "risk" || fact.evidenceLevel === "pending") return 80;
  return 10;
}
