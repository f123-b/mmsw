import { describe, expect, it } from "vitest";
import { analyzeInterview, InterviewHistoryStore, isSafeUpdate, SessionRecovery } from "./history";

describe("interview history and metrics", () => {
  it("does not persist partial transcripts and calculates answer metrics", () => {
    const store = new InterviewHistoryStore();
    const interview = store.createInterview({ profileId: "p1", startedAt: 1_000, status: "running", language: "zh-CN", automationMode: "AUTO" }, 1_000);
    store.addTranscript({ interviewId: interview.id, source: "remote", text: "为什么要同步采样？", startMs: 0, endMs: 800, final: false }, 1_100);
    store.addTranscript({ interviewId: interview.id, source: "remote", text: "为什么要同步采样？", startMs: 0, endMs: 800, final: true }, 1_100);
    store.addTranscript({ interviewId: interview.id, source: "mic", text: "因为要降低抖动", startMs: 1_000, endMs: 1_500, final: true }, 1_500);
    const question = store.addQuestion({ interviewId: interview.id, text: "为什么要同步采样？", confidence: "high", source: "rules", detectedAt: 1_000, status: "confirmed" });
    store.addAnswer({ questionId: question.id, text: "核心回答", model: "fast-v1", latencyFirstToken: 400, latencyTotal: 900, createdAt: 2_000 });
    const ended = store.endInterview(interview.id, "ended", 3_000);
    const metrics = analyzeInterview(store.snapshot(interview.id));
    expect(ended.endedAt).toBe(3_000);
    expect(metrics.remoteTranscriptCount).toBe(1);
    expect(metrics.answerRate).toBe(1);
    expect(metrics.averageFirstTokenMs).toBe(400);
  });
});

describe("recovery and updater policy", () => {
  it("caps reconnect delays and rejects unsigned or non-upgrade manifests", () => {
    const recovery = new SessionRecovery();
    expect([0, 1, 2, 3, 4, 5].map(() => recovery.nextDelayMs())).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
    expect(isSafeUpdate("1.0.0", { version: "1.1.0", url: "https://example.test/app.exe", sha256: "a".repeat(64), signature: "signed" })).toBe(true);
    expect(isSafeUpdate("1.1.0", { version: "1.0.0", url: "https://example.test/app.exe", sha256: "a".repeat(64), signature: "signed" })).toBe(false);
    expect(isSafeUpdate("1.0.0", { version: "1.1.0", url: "https://example.test/app.exe", sha256: "bad", signature: "" })).toBe(false);
  });
});
