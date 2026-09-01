export type ExpectedRuntimeTurn = "QUESTION" | "ANSWER_REQUEST" | "FOLLOW_UP_REQUEST" | "STATEMENT" | "BACKCHANNEL" | "INCOMPLETE" | "ASR_NOISE";

export interface QuestionRuntimeKpiRecord {
  expected: ExpectedRuntimeTurn;
  actualSpeechAct: ExpectedRuntimeTurn;
  expectedCanonical?: string;
  actualCanonical?: string;
  expectedDependency?: string;
  actualDependency?: string;
  commitLatencyMs?: number;
  earlyTrigger?: boolean;
}

export interface QuestionRuntimeKpi {
  sampleCount: number;
  questionRecall: number;
  questionPrecision: number;
  canonicalAccuracy: number;
  splitMergeAccuracy: number;
  answerRequestRecall: number;
  statementFalseTriggerRate: number;
  backchannelFalseTriggerRate: number;
  incompleteEarlyTriggerRate: number;
  followUpRelationAccuracy: number;
  commitLatencyP50Ms: number;
  commitLatencyP95Ms: number;
}

const QUESTION_LIKE = new Set<ExpectedRuntimeTurn>(["QUESTION", "ANSWER_REQUEST", "FOLLOW_UP_REQUEST"]);
const ratio = (value: number, total: number): number => total ? Number((value / total).toFixed(4)) : 1;
const percentile = (values: number[], p: number): number => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!.toFixed(2)) : 0;
};

/** Computes the acceptance metrics printed by the Runtime 4.1 replay. */
export function calculateQuestionRuntimeKpi(records: QuestionRuntimeKpiRecord[]): QuestionRuntimeKpi {
  const expectedQuestions = records.filter((record) => QUESTION_LIKE.has(record.expected));
  const actualQuestions = records.filter((record) => QUESTION_LIKE.has(record.actualSpeechAct));
  const correctlyDetected = records.filter((record) => QUESTION_LIKE.has(record.expected) && QUESTION_LIKE.has(record.actualSpeechAct)).length;
  const canonicalSamples = records.filter((record) => record.expectedCanonical !== undefined);
  const splitMergeSamples = records.filter((record) => record.expectedDependency !== undefined);
  const answerRequests = records.filter((record) => record.expected === "ANSWER_REQUEST");
  const statements = records.filter((record) => record.expected === "STATEMENT");
  const backchannels = records.filter((record) => record.expected === "BACKCHANNEL");
  const incomplete = records.filter((record) => record.expected === "INCOMPLETE");
  const followUps = records.filter((record) => record.expected === "FOLLOW_UP_REQUEST");
  const latency = records.map((record) => record.commitLatencyMs ?? NaN).filter(Number.isFinite);
  return {
    sampleCount: records.length,
    questionRecall: ratio(correctlyDetected, expectedQuestions.length),
    questionPrecision: ratio(correctlyDetected, actualQuestions.length),
    canonicalAccuracy: ratio(canonicalSamples.filter((record) => record.actualCanonical === record.expectedCanonical).length, canonicalSamples.length),
    splitMergeAccuracy: ratio(splitMergeSamples.filter((record) => record.actualDependency === record.expectedDependency).length, splitMergeSamples.length),
    answerRequestRecall: ratio(answerRequests.filter((record) => record.actualSpeechAct === "ANSWER_REQUEST" || record.actualSpeechAct === "QUESTION").length, answerRequests.length),
    statementFalseTriggerRate: ratio(statements.filter((record) => QUESTION_LIKE.has(record.actualSpeechAct)).length, statements.length),
    backchannelFalseTriggerRate: ratio(backchannels.filter((record) => QUESTION_LIKE.has(record.actualSpeechAct)).length, backchannels.length),
    incompleteEarlyTriggerRate: ratio(incomplete.filter((record) => record.earlyTrigger || QUESTION_LIKE.has(record.actualSpeechAct)).length, incomplete.length),
    followUpRelationAccuracy: ratio(followUps.filter((record) => record.actualDependency === "DEPENDS_ON_PREVIOUS" || record.actualDependency === "CONTINUATION").length, followUps.length),
    commitLatencyP50Ms: percentile(latency, 0.5),
    commitLatencyP95Ms: percentile(latency, 0.95)
  };
}

export class QuestionRuntimeKpiCalculator {
  calculate(records: QuestionRuntimeKpiRecord[]): QuestionRuntimeKpi { return calculateQuestionRuntimeKpi(records); }
}
