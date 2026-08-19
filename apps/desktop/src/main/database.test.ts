import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteConversationRepository, SqliteDatabase, SqliteInterviewHistoryRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectRepository } from "./database";

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

  it("reopens a real database file after debounced writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interview-copilot-db-"));
    const filePath = join(directory, "reopen.sqlite");
    try {
      const first = await SqliteDatabase.open(filePath);
      const profiles = new SqliteProfileRepository(first);
      const history = new SqliteInterviewHistoryRepository(first);
      const profile = profiles.save({ name: "磁盘 Profile", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const interview = history.createInterview({ profileId: profile.id, startedAt: 100, status: "running", language: "zh-CN", automationMode: "AUTO" }, 100);
      const question = history.addQuestion({ interviewId: interview.id, text: "磁盘问题？", confidence: "high", source: "rules", detectedAt: 120, status: "confirmed" });
      history.addAnswer({ questionId: question.id, text: "磁盘回答", model: "disk-model", mode: "FAST", startedAt: 130, firstTokenAt: 150, finishedAt: 180, latencyFirstToken: 30, latencyTotal: 50, createdAt: 180 });
      first.close();
      const second = await SqliteDatabase.open(filePath);
      try {
        expect(new SqliteProfileRepository(second).get(profile.id)?.name).toBe("磁盘 Profile");
        expect(new SqliteInterviewHistoryRepository(second).snapshot(interview.id).answers[0]).toMatchObject({ model: "disk-model", startedAt: 130, firstTokenAt: 150, finishedAt: 180 });
      } finally { second.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps multiple knowledge bases and their chunks isolated", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const knowledge = new SqliteKnowledgeRepository(database);
      const first = knowledge.createKnowledgeBase("项目");
      const second = knowledge.createKnowledgeBase("算法");
      knowledge.saveDocument({ id: "doc-first", knowledgeBaseId: first.id, filename: "a.md", mimeType: "text/markdown", sha256: "a", text: "项目内容", sections: [], status: "ready" });
      knowledge.replaceChunks("doc-first", [{ id: "chunk-first", text: "项目内容", metadata: { documentId: "doc-first", filename: "a.md" } }]);
      knowledge.saveDocument({ id: "doc-second", knowledgeBaseId: second.id, filename: "b.md", mimeType: "text/markdown", sha256: "b", text: "算法内容", sections: [], status: "ready" });
      knowledge.replaceChunks("doc-second", [{ id: "chunk-second", text: "算法内容", metadata: { documentId: "doc-second", filename: "b.md" } }]);
      expect(knowledge.listChunks([first.id]).map((chunk) => chunk.text)).toEqual(["项目内容"]);
      expect(knowledge.listChunks([second.id]).map((chunk) => chunk.text)).toEqual(["算法内容"]);
    } finally { database.close(); }
  });

  it("persists projects and streaming chat messages", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const projects = new SqliteProjectRepository(database);
      const conversations = new SqliteConversationRepository(database);
      const profile = new SqliteProfileRepository(database).save({ name: "测试 Profile", language: "zh-CN", skills: [], knowledgeBaseIds: [] }, 9);
      const project = projects.create("嵌入式项目", profile.id, 10);
      const conversation = conversations.create(profile.id, project.id, "简历分析", 11);
      const message = conversations.addMessage({ conversationId: conversation.id, role: "assistant", content: "正在生成", status: "streaming", model: "mock" }, 12);
      conversations.updateMessage(message.id, "已完成", "completed", 13);
      expect(projects.list()[0]).toMatchObject({ id: project.id, name: "嵌入式项目", profileId: profile.id });
      expect(conversations.get(conversation.id)?.messages[0]).toMatchObject({ content: "已完成", status: "completed", model: "mock" });
      projects.rename(project.id, "新项目", 14);
      expect(projects.get(project.id)?.name).toBe("新项目");
      projects.delete(project.id);
      expect(projects.get(project.id)).toBeUndefined();
    } finally { database.close(); }
  });
});
