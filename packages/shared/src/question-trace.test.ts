import { describe, expect, it } from "vitest";
import { QuestionTrace } from "./question-trace";

describe("QuestionTrace", () => {
  it("computes safe stage timings without retaining question text", () => {
    const trace = new QuestionTrace({ questionTraceId: "trace-1", asrFinalAt: 100, questionScore: 0.92, questionType: "follow-up", followUp: true, projectId: "p1" });
    trace.mark("utteranceFinalized", 140).mark("questionDetected", 160).mark("questionConfirmed", 180).mark("retrievalStarted", 190).mark("retrievalEnded", 205).mark("llmRequestStarted", 210).mark("firstToken", 260).mark("answerEnded", 700);
    expect(trace.snapshot()).toEqual(expect.objectContaining({ questionTraceId: "trace-1", questionType: "follow-up", projectId: "p1" }));
    expect(trace.snapshot().metrics).toEqual({ asrToQuestionMs: 80, questionToRetrievalMs: 10, retrievalMs: 15, llmFirstTokenMs: 50, answerTotalMs: 490, endToEndMs: 600 });
    expect(JSON.stringify(trace.snapshot())).not.toContain("敏感");
  });
});
