import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import dataset from "../../../tests/fixtures/interview-question-dataset.json";
import { QuestionDetector } from "./question/question-detector";

interface QuestionFixture {
  segments: string[];
  context?: string[];
  source?: "mic" | "remote";
  expectedQuestion: string;
  expectedType: "question" | "follow_up" | "statement" | "control";
  shouldAnswer: boolean;
}

function asPredictedType(isAnswerable: boolean, speechAct: string): QuestionFixture["expectedType"] {
  if (!isAnswerable) return speechAct === "CONTROL" || speechAct === "INSTRUCTION" ? "control" : "statement";
  return speechAct === "FOLLOW_UP" ? "follow_up" : "question";
}

describe("Question Detection benchmark", () => {
  it("reports precision, recall, follow-up accuracy and failed samples", async () => {
    const fixtures = dataset as QuestionFixture[];
    expect(fixtures.length).toBeGreaterThanOrEqual(100);
    const detector = new QuestionDetector();
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    let trueNegative = 0;
    let followUpCorrect = 0;
    let followUpTotal = 0;
    let totalLatencyMs = 0;
    const failures: Array<{ text: string; expected: string; predicted: string; reason: string }> = [];

    for (const fixture of fixtures) {
      const text = fixture.segments.join("");
      const startedAt = performance.now();
      const analysis = fixture.source === "mic"
        ? { isQuestion: false, speechAct: "CONTROL", reason: "mic-excluded" }
        : await detector.analyze(text, fixture.context?.join(" | ") ?? "", true, { recentTranscript: fixture.context });
      totalLatencyMs += performance.now() - startedAt;
      const predictedAnswer = analysis.isQuestion;
      if (fixture.shouldAnswer && predictedAnswer) truePositive += 1;
      else if (!fixture.shouldAnswer && predictedAnswer) falsePositive += 1;
      else if (fixture.shouldAnswer) falseNegative += 1;
      else trueNegative += 1;

      const predictedType = asPredictedType(predictedAnswer, analysis.speechAct);
      if (fixture.expectedType === "follow_up") {
        followUpTotal += 1;
        if (predictedType === "follow_up") followUpCorrect += 1;
      }
      if (fixture.shouldAnswer !== predictedAnswer || (fixture.expectedType === "follow_up" && predictedType !== "follow_up")) {
        failures.push({ text, expected: `${fixture.expectedType}/${fixture.shouldAnswer}`, predicted: `${predictedType}/${predictedAnswer}`, reason: analysis.reason });
      }
    }

    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    const f1 = 2 * precision * recall / Math.max(0.0001, precision + recall);
    const falsePositiveRate = falsePositive / Math.max(1, falsePositive + trueNegative);
    const missRate = falseNegative / Math.max(1, truePositive + falseNegative);
    const followUpAccuracy = followUpCorrect / Math.max(1, followUpTotal);
    const metrics = {
      samples: fixtures.length,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1: Number(f1.toFixed(4)),
      falsePositiveRate: Number(falsePositiveRate.toFixed(4)),
      missRate: Number(missRate.toFixed(4)),
      followUpAccuracy: Number(followUpAccuracy.toFixed(4)),
      averageConfirmationLatencyMs: Number((totalLatencyMs / fixtures.length).toFixed(3)),
      truePositive,
      falsePositive,
      falseNegative,
      trueNegative,
      failedSamples: failures
    };
    console.log(`QUESTION_BENCHMARK ${JSON.stringify(metrics)}`);
    expect(precision, JSON.stringify(failures.slice(0, 20))).toBeGreaterThanOrEqual(0.95);
    expect(recall, JSON.stringify(failures.slice(0, 20))).toBeGreaterThanOrEqual(0.95);
    expect(followUpAccuracy, JSON.stringify(failures.slice(0, 20))).toBeGreaterThanOrEqual(0.9);
  });
});
