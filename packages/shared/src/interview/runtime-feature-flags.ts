export type InterviewRuntimeMode = "ACCURATE_INTERVIEW" | "FAST_PRACTICE";

export interface InterviewFeatureFlags {
  understandingV3: boolean;
  questionCommitGateV3: boolean;
  contextualAsrRepair: boolean;
  strictProjectQa: boolean;
  answerQualityV2: boolean;
  decisionTrace: boolean;
}

export const ACCURATE_INTERVIEW_FEATURES: InterviewFeatureFlags = {
  understandingV3: true,
  questionCommitGateV3: true,
  contextualAsrRepair: true,
  strictProjectQa: true,
  answerQualityV2: true,
  decisionTrace: true
};

export const FAST_PRACTICE_FEATURES: InterviewFeatureFlags = {
  understandingV3: false,
  questionCommitGateV3: false,
  contextualAsrRepair: false,
  strictProjectQa: false,
  answerQualityV2: false,
  decisionTrace: false
};

export function resolveInterviewFeatureFlags(
  mode: InterviewRuntimeMode = "ACCURATE_INTERVIEW",
  overrides: Partial<InterviewFeatureFlags> = {}
): InterviewFeatureFlags {
  return { ...(mode === "FAST_PRACTICE" ? FAST_PRACTICE_FEATURES : ACCURATE_INTERVIEW_FEATURES), ...overrides };
}
