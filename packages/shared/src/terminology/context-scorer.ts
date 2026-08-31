import type { TechnicalTerm, TerminologyCandidate } from "./terminology-types";
import type { DomainRoute } from "./terminology-types";

export interface ContextScoreInput {
  candidate: TerminologyCandidate;
  term: TechnicalTerm;
  route: DomainRoute;
  contextText: string;
  currentTopic?: string;
}

export class ContextScorer {
  score(input: ContextScoreInput): TerminologyCandidate {
    const { candidate, term, route } = input;
    let score = candidate.confidence;
    const primaryHit = term.domains.some((domain) => route.primaryDomains.includes(domain));
    const secondaryHit = term.domains.some((domain) => route.secondaryDomains.includes(domain));
    if (primaryHit) score += 0.025;
    else if (secondaryHit) score += 0.012;
    if (term.source === "user") score += 0.04;
    if (term.source === "project" && input.contextText.toLocaleLowerCase().includes(term.canonical.toLocaleLowerCase())) score += 0.02;
    if (input.currentTopic && input.currentTopic.toLocaleLowerCase().includes(term.canonical.toLocaleLowerCase())) score += 0.01;
    return { ...candidate, confidence: Math.min(0.999, score), reason: primaryHit ? `${candidate.reason}+primary-domain` : candidate.reason };
  }
}
