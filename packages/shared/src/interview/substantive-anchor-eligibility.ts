export interface SubstantiveAnchorEligibilityInput {
  answerabilityState?: string;
  shouldAnswer?: boolean;
  answerable?: boolean;
  speechAct?: string;
  threadItemType?: string;
  relationType?: string;
}

export interface SubstantiveAnchorEligibilityDecision {
  eligible: boolean;
  reason: string;
}

const HARD_NEGATIVE_STATES = new Set([
  "FILLER",
  "STYLE_ONLY",
  "SETUP_ONLY",
  "META_CONVERSATION",
  "TOPIC_ANNOUNCEMENT",
  "OPEN_PREDICATE",
  "INCOMPLETE",
  "ANSWER_CONSTRAINT",
  "TOPIC_FRAGMENT"
]);

const HARD_NEGATIVE_SPEECH_ACTS = new Set([
  "ACKNOWLEDGEMENT",
  "CONTROL",
  "META_CONVERSATION",
  "TOPIC_ANNOUNCEMENT",
  "INSTRUCTION_MODIFIER",
  "TOPIC_TRANSITION"
]);

export function evaluateSubstantiveAnchorEligibility(input: SubstantiveAnchorEligibilityInput): SubstantiveAnchorEligibilityDecision {
  if (input.shouldAnswer !== true || input.answerable !== true) return { eligible: false, reason: "not-answerable" };
  if (input.answerabilityState && HARD_NEGATIVE_STATES.has(input.answerabilityState)) return { eligible: false, reason: `semantic-${input.answerabilityState.toLowerCase()}` };
  if (input.speechAct && HARD_NEGATIVE_SPEECH_ACTS.has(input.speechAct)) return { eligible: false, reason: `speech-act-${input.speechAct.toLowerCase()}` };
  if (input.threadItemType && ["TOPIC_FRAGMENT", "ANSWER_CONSTRAINT", "EXAMPLE", "ASR_REVISION"].includes(input.threadItemType)) return { eligible: false, reason: `thread-item-${input.threadItemType.toLowerCase()}` };
  if (input.relationType && ["ANSWER_CONSTRAINT", "EXAMPLE", "ASR_REVISION"].includes(input.relationType)) return { eligible: false, reason: `relation-${input.relationType.toLowerCase()}` };
  if (input.answerabilityState && !["ANSWERABLE", "CONTEXT_DEPENDENT"].includes(input.answerabilityState)) return { eligible: false, reason: "semantic-state-not-substantive" };
  return { eligible: true, reason: "substantive-answerable-question" };
}

export function isSubstantiveAnchorEligible(input: SubstantiveAnchorEligibilityInput): boolean {
  return evaluateSubstantiveAnchorEligibility(input).eligible;
}
