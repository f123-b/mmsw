import { decideTurnCompletion, type TurnCompletionContext, type TurnCompletionDecision } from "./turn-completion-gate";

export type UtteranceCompleteness = "COMPLETE" | "INCOMPLETE" | "AMBIGUOUS" | "NON_QUESTION";

export interface UtteranceCompletenessDecision extends TurnCompletionDecision {
  completeness: UtteranceCompleteness;
  isComplete: boolean;
}

export function assessUtteranceCompleteness(text: string, context: TurnCompletionContext = {}): UtteranceCompletenessDecision {
  const decision = decideTurnCompletion(text, context);
  const completeness = decision.state === "complete" ? "COMPLETE" : decision.state === "incomplete" ? "INCOMPLETE" : decision.state === "ambiguous" ? "AMBIGUOUS" : "NON_QUESTION";
  return { ...decision, completeness, isComplete: completeness === "COMPLETE" };
}

export class UtteranceCompletenessGate {
  assess(text: string, context: TurnCompletionContext = {}): UtteranceCompletenessDecision { return assessUtteranceCompleteness(text, context); }
}
