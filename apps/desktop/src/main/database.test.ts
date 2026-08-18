import { describe, expect, it } from "vitest";
import { SqliteDatabase, SqliteInterviewHistoryRepository, SqliteProfileRepository } from "./database";

describe("SQLite persistence", () => {
  it("persists profile CRUD, clone and active selection", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "嵌入式面试", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      expect(profiles.get(profile.id)?.name).toBe("嵌入式面试");
      const clone = profiles.clone(profile.id, "嵌入式面试副本");
      profiles.setActive(clone.id);
      expect(profiles.active()?.id).toBe(clone.id);
      profiles.delete(profile.id);
      expect(profiles.list().map((item) => item.name)).toEqual(["嵌入式面试副本"]);
    } finally {
      database.close();
    }
  });

  it("stores interview transcripts, questions and answers in the same database", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const history = new SqliteInterviewHistoryRepository(database);
      const interview = history.createInterview({ profileId: "profile-1", startedAt: 1_000, status: "running", language: "zh-CN", automationMode: "AUTO" }, 1_000);
      history.addTranscript({ interviewId: interview.id, source: "remote", text: "请介绍项目", startMs: 0, endMs: 800, final: true }, 1_000);
      const question = history.addQuestion({ interviewId: interview.id, text: "请介绍项目", confidence: "high", source: "rules", detectedAt: 1_000, status: "confirmed" });
      history.addAnswer({ questionId: question.id, text: "核心回答", model: "test-model", createdAt: 1_100, latencyTotal: 100 });
      history.endInterview(interview.id, "ended", 2_000);
      const snapshot = history.snapshot(interview.id);
      expect(snapshot.transcripts).toHaveLength(1);
      expect(snapshot.questions).toHaveLength(1);
      expect(snapshot.answers[0]?.text).toBe("核心回答");
    } finally {
      database.close();
    }
  });
});
