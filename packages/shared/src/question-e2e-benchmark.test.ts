import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import dataset from "../../../tests/fixtures/question-e2e-dataset.json";
import { InterviewBrain } from "./interview-brain";
import { InterviewMemory } from "./interview-memory";
import { QuestionDetector2 } from "./question-detector-2";
import { TranscriptStabilizer } from "./index";
import { QuestionDetector } from "./index";
import { TranscriptAggregator, type TranscriptUtterance } from "./transcript-aggregator";
import type { TranscriptSegment } from "@interview-copilot/protocol";

interface E2EFixture {
  id: string;
  events: Array<TranscriptSegment & { at: number }>;
  expected: { confirmed: number; followUps?: number; utterances: number; shouldAnswer: boolean; duplicateFinals?: number; expectMerge?: boolean; expectSplit?: boolean };
}

interface FixtureResult {
  id: string;
  utterances: number;
  confirmed: number;
  followUps: number;
  duplicateFinals: number;
  classificationsMs: number[];
  confirmationLatenciesMs: number[];
  expected: E2EFixture["expected"];
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

async function runFixture(fixture: E2EFixture): Promise<FixtureResult> {
  const stabilizer = new TranscriptStabilizer();
  const aggregator = new TranscriptAggregator();
  const detector2 = new QuestionDetector2();
  const brain = new InterviewBrain();
  const temporalDetector = new QuestionDetector({ silenceMs: 500 });
  const memory = new InterviewMemory(10);
  const result: FixtureResult = { id: fixture.id, utterances: 0, confirmed: 0, followUps: 0, duplicateFinals: 0, classificationsMs: [], confirmationLatenciesMs: [], expected: fixture.expected };

  const processUtterance = async (utterance: TranscriptUtterance): Promise<void> => {
    result.utterances += 1;
    const recentTranscript = memory.snapshot().recentQuestions.slice(-4);
    const startedAt = performance.now();
    const analysis = await detector2.analyze(utterance.text, memory.contextText(recentTranscript), true, { memory: memory.snapshot(), recentTranscript });
    result.classificationsMs.push(Math.max(0, performance.now() - startedAt));
    const decision = brain.analyze({ text: utterance.text, analysis, memory: memory.snapshot(), recentTranscript });
    if (!decision.isQuestion) return;
    const effectiveAnalysis = analysis.isQuestion
      ? analysis
      : { ...analysis, isQuestion: true, type: decision.type, speechAct: decision.type === "follow_up" ? "FOLLOW_UP" as const : "QUESTION" as const, confidence: Math.max(analysis.confidence, decision.confidence), normalizedQuestion: decision.normalizedQuestion, score: { ...analysis.score, finalScore: Math.max(analysis.score.finalScore, decision.confidence), semanticScore: Math.max(analysis.score.semanticScore, decision.confidence) } };
    const finalizedAt = utterance.finalizedAt ?? Date.now();
    const inputText = decision.normalizedQuestion || utterance.text;
    const observedEvents = temporalDetector.observe({ text: inputText, final: true, startMs: utterance.startMs, endMs: utterance.endMs, confidence: effectiveAnalysis.confidence, analysis: effectiveAnalysis, utteranceId: utterance.id }, finalizedAt);
    const flushAt = finalizedAt + 600;
    const events = [...observedEvents, ...temporalDetector.flush(flushAt)];
    for (const event of events) {
      if (event.type !== "question_confirmed" && event.type !== "question_superseded") continue;
      result.confirmed += 1;
      if (event.question.speechAct === "FOLLOW_UP") result.followUps += 1;
      result.confirmationLatenciesMs.push(Math.max(0, flushAt - (utterance.lastFinalReceivedAt ?? finalizedAt)));
      memory.recordQuestion(event.question.text, { questionId: event.question.id, parentQuestionId: event.question.parentQuestionId, rootQuestionId: event.question.rootQuestionId, createdAt: flushAt });
    }
  };

  for (const event of fixture.events) {
    const update = stabilizer.upsert(event);
    if (!event.final) continue;
    if (event.source === "remote" && update.segment.id !== event.id) continue;
    if (event.source !== "remote") continue;
    if (stabilizer.history("remote").filter((segment) => segment.id === event.id).length > 1) result.duplicateFinals += 1;
    aggregator.push(update.segment, event.at);
    for (const utterance of aggregator.drainCompleted("remote")) await processUtterance(utterance);
  }
  for (const utterance of aggregator.flush("remote", (fixture.events.at(-1)?.at ?? 0) + 600)) await processUtterance(utterance);
  // The stabilizer replaces revisions by id, so duplicate final delivery must
  // not create a second assembled utterance or a second confirmation.
  result.duplicateFinals = Math.max(0, fixture.events.filter((event) => event.final && event.source === "remote").length - stabilizer.history("remote").length);
  return result;
}

describe("Question Detection true E2E benchmark", () => {
  it("measures the complete transcript-to-confirmation pipeline", async () => {
    const results = await Promise.all((dataset as E2EFixture[]).map(runFixture));
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    let trueNegative = 0;
    let followUpCorrect = 0;
    let followUpTotal = 0;
    let assemblyCorrect = 0;
    let wrongMerge = 0;
    let wrongSplit = 0;
    const classificationLatencies = results.flatMap((result) => result.classificationsMs);
    const confirmationLatencies = results.flatMap((result) => result.confirmationLatenciesMs);
    const failures: Array<{ id: string; expected: unknown; actual: unknown }> = [];

    for (const result of results) {
      const predictedAnswer = result.confirmed > 0;
      if (result.expected.shouldAnswer && predictedAnswer) truePositive += 1;
      else if (!result.expected.shouldAnswer && predictedAnswer) falsePositive += 1;
      else if (result.expected.shouldAnswer) falseNegative += 1;
      else trueNegative += 1;
      const expectedFollowUps = result.expected.followUps ?? 0;
      if (expectedFollowUps > 0) {
        followUpTotal += expectedFollowUps;
        followUpCorrect += Math.min(expectedFollowUps, result.followUps);
      }
      if (result.utterances === result.expected.utterances) assemblyCorrect += 1;
      if (result.expected.expectMerge && result.utterances !== result.expected.utterances) wrongMerge += 1;
      if (result.expected.expectSplit && result.utterances !== result.expected.utterances) wrongSplit += 1;
      if (result.confirmed !== result.expected.confirmed || result.followUps !== expectedFollowUps || result.utterances !== result.expected.utterances) failures.push({ id: result.id, expected: result.expected, actual: { confirmed: result.confirmed, followUps: result.followUps, utterances: result.utterances } });
    }

    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    const f1 = 2 * precision * recall / Math.max(0.0001, precision + recall);
    const duplicateQuestionRate = results.reduce((sum, result) => sum + Math.max(0, result.confirmed - result.expected.confirmed), 0) / Math.max(1, results.reduce((sum, result) => sum + (result.expected.duplicateFinals ?? 0), 0));
    const metrics = {
      samples: results.length,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
      followUpAccuracy: Number((followUpCorrect / Math.max(1, followUpTotal)).toFixed(4)),
      utteranceAssemblyAccuracy: Number((assemblyCorrect / Math.max(1, results.length)).toFixed(4)),
      duplicateQuestionRate: Number(duplicateQuestionRate.toFixed(4)),
      wrongMergeRate: Number((wrongMerge / Math.max(1, results.filter((result) => result.expected.expectMerge).length)).toFixed(4)),
      wrongSplitRate: Number((wrongSplit / Math.max(1, results.filter((result) => result.expected.expectSplit).length)).toFixed(4)),
      confirmationLatencyP50Ms: Number(percentile(confirmationLatencies, 0.5).toFixed(3)),
      confirmationLatencyP95Ms: Number(percentile(confirmationLatencies, 0.95).toFixed(3)),
      classificationLatencyP50Ms: Number(percentile(classificationLatencies, 0.5).toFixed(3)),
      classificationLatencyP95Ms: Number(percentile(classificationLatencies, 0.95).toFixed(3)),
      truePositive,
      falsePositive,
      falseNegative,
      trueNegative,
      failedFixtures: failures
    };
    console.log(`QUESTION_E2E_BENCHMARK ${JSON.stringify(metrics)}`);
    expect(metrics.precision, JSON.stringify(failures)).toBeGreaterThanOrEqual(0.9);
    expect(metrics.recall, JSON.stringify(failures)).toBeGreaterThanOrEqual(0.9);
    expect(metrics.f1, JSON.stringify(failures)).toBeGreaterThanOrEqual(0.9);
    expect(metrics.followUpAccuracy, JSON.stringify(failures)).toBeGreaterThanOrEqual(0.8);
    expect(metrics.utteranceAssemblyAccuracy, JSON.stringify(failures)).toBeGreaterThanOrEqual(0.9);
    expect(metrics.duplicateQuestionRate).toBe(0);
    expect(metrics.wrongMergeRate).toBe(0);
    expect(metrics.wrongSplitRate).toBe(0);
    expect(failures, JSON.stringify(metrics)).toHaveLength(0);
  });
});
