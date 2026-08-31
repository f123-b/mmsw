import type { TerminologyCandidate } from "./terminology-types";

export type ConfidenceGateDecision = "apply" | "candidate" | "reject";

export interface ConfidenceGateResult {
  decision: ConfidenceGateDecision;
  candidate: TerminologyCandidate;
}

export class ConfidenceGate {
  constructor(private readonly highThreshold = 0.9, private readonly mediumThreshold = 0.7) {}

  evaluate(candidate: TerminologyCandidate): ConfidenceGateResult {
    if (candidate.confidence >= this.highThreshold) return { decision: "apply", candidate };
    if (candidate.confidence >= this.mediumThreshold) return { decision: "candidate", candidate };
    return { decision: "reject", candidate };
  }
}
