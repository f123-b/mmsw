import { describe, expect, it } from "vitest";
import { InterviewMemory, TranscriptStabilizer } from "@interview-copilot/shared";
import { SqliteDatabase, SqliteInterviewHistoryRepository, SqliteProfileRepository } from "./database";

describe("repository persistence volume", () => {
  it("keeps bounded storage and memory across 3,000 synthetic ASR records and 300 stored answers", async () => {
    const database = await SqliteDatabase.open(":memory:");
    const startedAt = performance.now();
    const memory = new InterviewMemory(12);
    const stabilizer = new TranscriptStabilizer();
    const profiles = new SqliteProfileRepository(database);
    const profile = profiles.save({ id: "soak-profile", name: "soak", language: "zh-CN", skills: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1 }, 1);
    const history = new SqliteInterviewHistoryRepository(database);
    const interview = history.createInterview({ profileId: profile.id, startedAt: 0, status: "running", language: "zh-CN", automationMode: "AUTO" }, 0);
    const latencySamples: number[] = [];
    let reconnects = 0;
    let cancelledAnswers = 0;
    const questionIds: string[] = [];
    const rootQuestionId = { value: "" };

    for (let segmentIndex = 0; segmentIndex < 3_000; segmentIndex += 1) {
      const source = segmentIndex % 2 === 0 ? "remote" : "mic";
      const text = source === "remote" ? `第 ${Math.floor(segmentIndex / 10)} 题` : "我补充一个实现细节";
      const segment = { id: `segment-${segmentIndex}`, source: source as "remote" | "mic", text, startMs: segmentIndex * 1_200, endMs: segmentIndex * 1_200 + 800, final: true };
      stabilizer.upsert(segment);
      history.addTranscript({ interviewId: interview.id, source, text, startMs: segment.startMs, endMs: segment.endMs, final: true }, segment.endMs);
      if (segmentIndex % 10 !== 0) continue;

      const questionIndex = segmentIndex / 10;
      const isFollowUp = questionIndex > 0 && questionIndex % 3 === 0;
      const question = history.addQuestion({ interviewId: interview.id, text: isFollowUp ? `那第 ${questionIndex} 个细节呢？` : `第 ${questionIndex} 题怎么实现？`, confidence: "high", source: "rules", detectedAt: segment.endMs, status: "confirmed", ...(isFollowUp && questionIds.at(-1) ? { parentQuestionId: questionIds.at(-1), rootQuestionId: rootQuestionId.value } : {}) });
      questionIds.push(question.id);
      if (!rootQuestionId.value) rootQuestionId.value = question.id;
      memory.recordQuestion(question.text, { questionId: question.id, ...(isFollowUp ? { parentQuestionId: questionIds.at(-2), rootQuestionId: rootQuestionId.value } : { rootQuestionId: question.id }) });
      const answerStarted = segment.endMs + 40;
      const answerFinished = answerStarted + 180 + (questionIndex % 40);
      history.addAnswer({ questionId: question.id, text: `第 ${questionIndex} 题的可验证回答。`, model: "soak-model", mode: "FAST", startedAt: answerStarted, firstTokenAt: answerStarted + 35, finishedAt: answerFinished, latencyFirstToken: 35, latencyTotal: answerFinished - segment.endMs, createdAt: answerFinished });
      memory.recordAnswer(`第 ${questionIndex} 题的可验证回答。`, { question: question.text, createdAt: answerFinished });
      latencySamples.push(answerFinished - segment.endMs);
      if (questionIndex > 0 && questionIndex % 31 === 0) cancelledAnswers += 1;
      if (questionIndex > 0 && questionIndex % 100 === 0) reconnects += 1;
    }

    const snapshot = history.snapshot(interview.id);
    const sortedLatencies = [...latencySamples].sort((left, right) => left - right);
    const p95 = sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))] ?? 0;
    const metrics = {
      peakMemoryMb: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
      questionCount: snapshot.questions.length,
      answerCount: snapshot.answers.length,
      averageLatencyMs: Math.round(latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length),
      p95LatencyMs: p95,
      reconnects,
      cancelledAnswers,
      duplicateQuestions: snapshot.questions.length - new Set(snapshot.questions.map((question) => question.text)).size,
      durationMs: Math.round(performance.now() - startedAt)
    };
    console.log("SOAK_METRICS", JSON.stringify(metrics));
    expect(metrics.questionCount).toBe(300);
    expect(metrics.answerCount).toBe(300);
    expect(metrics.duplicateQuestions).toBe(0);
    expect(memory.snapshot().turns.length).toBeLessThanOrEqual(12);
    expect(stabilizer.history("remote").length).toBeGreaterThan(1_000);
    database.close();
  });
});
