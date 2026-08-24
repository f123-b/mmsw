import { describe, expect, it } from "vitest";
import { QuestionTrace } from "./question-trace";

describe("QuestionTrace", () => {
  it("computes safe stage timings without retaining question text", () => {
    const trace = new QuestionTrace({ questionTraceId: "trace-1", asrFinalAt: 100, questionScore: 0.92, questionType: "follow-up", followUp: true, projectId: "p1" });
    trace.mark("utteranceFinalized", 140).mark("questionDetected", 160).mark("questionConfirmed", 180).mark("retrievalStarted", 190).mark("retrievalEnded", 205).mark("llmRequestStarted", 210).mark("firstToken", 260).mark("answerEnded", 700);
    expect(trace.snapshot()).toEqual(expect.objectContaining({ questionTraceId: "trace-1", questionType: "follow-up", projectId: "p1" }));
    expect(trace.snapshot().metrics).toEqual({
      asrFinalToUtteranceMs: 40,
      utteranceToDetectionMs: 20,
      detectionToConfirmationMs: 20,
      confirmationToRetrievalMs: 10,
      asrToQuestionMs: 80,
      questionToRetrievalMs: 10,
      retrievalMs: 15,
      llmFirstTokenMs: 50,
      answerGenerationMs: 490,
      answerTotalMs: 490,
      endToEndMs: 600
    });
    expect(JSON.stringify(trace.snapshot())).not.toContain("敏感");
  });

  it("reports runtime ASR, detection and confirmation stages separately from audio offsets", () => {
    const trace = new QuestionTrace({ questionTraceId: "runtime-1", asrFinalReceivedAt: 10_000, utteranceFinalizedAt: 10_180 });
    trace.mark("questionDetectionStarted", 10_190).mark("questionDetected", 10_210).mark("questionConfirmed", 10_260).mark("retrievalStarted", 10_270).mark("retrievalEnded", 10_300).mark("llmRequestStarted", 10_305).mark("firstToken", 10_360).mark("answerEnded", 10_700);
    expect(trace.snapshot().metrics).toMatchObject({ asrFinalToUtteranceMs: 180, utteranceToDetectionMs: 30, detectionToConfirmationMs: 50, confirmationToRetrievalMs: 10, endToEndMs: 700 });
    expect((trace.snapshot() as unknown as Record<string, unknown>).startMs).toBeUndefined();
  });
});
