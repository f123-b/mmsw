import { describe, expect, it } from "vitest";
import { QuestionTrace } from "./question-trace";

describe("QuestionTrace", () => {
  it("computes safe stage timings without retaining question text", () => {
    const trace = new QuestionTrace({ questionTraceId: "trace-1", asrFinalAt: 100, questionScore: 0.92, questionType: "follow-up", followUp: true, projectId: "p1" });
    trace.mark("utteranceFinalized", 140).mark("questionDetected", 160).mark("questionConfirmed", 180).mark("retrievalStarted", 190).mark("retrievalEnded", 205).mark("llmRequestStarted", 210).mark("firstToken", 260).mark("answerEnded", 700);
    expect(trace.snapshot()).toEqual(expect.objectContaining({ questionTraceId: "trace-1", questionType: "follow-up", projectId: "p1", speechEndAt: 140, retrievalFinishedAt: 205, llmRequestAt: 210, answerFinishedAt: 700 }));
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

  it("keeps only bounded text metadata and answer-source diagnostics", () => {
    const trace = new QuestionTrace({ questionTraceId: "candidate-1", source: "remote", textLength: 18, textHash: "a1b2c3d4", speechAct: "QUESTION", ruleScore: 0.8, semanticScore: 0.9, localClassifierScore: 0.88, llmScore: 0.86, contextTopic: "DMA", isFollowUp: false, finalScore: 0.87, decision: "answer", decisionReason: "decision-question", answerSource: "question-bank" });
    const snapshot = trace.snapshot();
    expect(snapshot).toMatchObject({ source: "remote", textLength: 18, textHash: "a1b2c3d4", speechAct: "QUESTION", contextTopic: "DMA", finalScore: 0.87, decision: "answer", answerSource: "question-bank" });
    expect((snapshot as unknown as Record<string, unknown>).rawText).toBeUndefined();
    expect((snapshot as unknown as Record<string, unknown>).normalizedText).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("secret-value");
  });

  it("tracks question-bank lookup without fabricating LLM latency", () => {
    const trace = new QuestionTrace({ questionTraceId: "bank-1", answerSource: "question-bank" });
    trace.mark("answerLookupStarted", 100).mark("answerVisible", 135).mark("answerEnded", 135);
    expect(trace.snapshot()).toMatchObject({ answerSource: "question-bank", answerLookupStartedAt: 100, answerVisibleAt: 135 });
    expect(trace.snapshot().llmRequestAt).toBeUndefined();
    expect(trace.snapshot().firstTokenAt).toBeUndefined();
    expect(trace.snapshot().metrics.answerLookupMs).toBe(35);
  });
});
