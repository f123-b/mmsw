import { describe, expect, it } from "vitest";
import { generatePostInterviewAnalysis } from "./analysis";
import type { AnswerProvider } from "./answer";

describe("post interview analysis", () => {
  it("parses an optional model analysis without blocking the interview state", async () => {
    const provider: AnswerProvider = { stream: async function* () { yield JSON.stringify({ technicalTopics: ["中断"], answerCoverage: 0.5, unansweredQuestions: ["Q2"], weakAnswers: [], studyRecommendations: ["复习 ISR"], frequentDirections: ["嵌入式"] }); } };
    const result = await generatePostInterviewAnalysis({ interview: { id: "i", profileId: "p", startedAt: 0, status: "ended", language: "zh-CN", automationMode: "AUTO", createdAt: 0 }, transcripts: [], questions: [{ id: "q", interviewId: "i", text: "Q2", confidence: "high", source: "rules", detectedAt: 1, status: "confirmed" }], answers: [] }, provider, "test-model");
    expect(result).toMatchObject({ technicalTopics: ["中断"], answerCoverage: 0.5, unansweredQuestions: ["Q2"] });
  });
});
