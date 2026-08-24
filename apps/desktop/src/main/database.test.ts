import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteConversationRepository, SqliteDatabase, SqliteInterviewHistoryRepository, SqliteJobTargetRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileBuilderRepository, SqliteProfileRepository, SqliteProjectMemoryRepository, SqliteProjectRepository, SqliteQuestionBankRepository, SqliteRetrievalRepository } from "./database";

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

  it("normalizes the active JD into a searchable job target", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profile = new SqliteProfileRepository(database).save({ name: "JD 测试", language: "zh-CN", jobDescription: { rawContent: "岗位职责：负责 C++ 和 FreeRTOS 开发\n任职要求：熟悉嵌入式系统和 CAN 通信", summary: "嵌入式开发工程师" }, skills: [], knowledgeBaseIds: [] }, 10);
      const jobs = new SqliteJobTargetRepository(database);
      expect(jobs.get(`job-target-${profile.id}`)).toMatchObject({ profileId: profile.id, name: "嵌入式开发工程师", status: "active" });
      expect(jobs.get(`job-target-${profile.id}`)?.requirements.map((item) => item.requirement)).toEqual(expect.arrayContaining([expect.stringContaining("FreeRTOS")]));
      expect(jobs.searchRequirements(profile.id, "FreeRTOS 开发").length).toBeGreaterThan(0);
    } finally { database.close(); }
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

  it("reports pending flush, size and duration diagnostics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interview-copilot-flush-"));
    const filePath = join(directory, "flush.sqlite");
    const diagnostics: string[] = [];
    try {
      const database = await SqliteDatabase.open(filePath, undefined, { onDiagnostic: (code) => diagnostics.push(code) });
      database.run("CREATE TABLE flush_probe(value TEXT)");
      database.flush();
      expect(database.getFlushDiagnostics().pendingFlush).toBe(true);
      database.flushNow();
      expect(database.getFlushDiagnostics()).toMatchObject({ pendingFlush: false });
      expect(database.getFlushDiagnostics().databaseSize).toBeGreaterThan(0);
      expect(database.getFlushDiagnostics().databaseFlushDurationMs).toBeGreaterThanOrEqual(0);
      expect(diagnostics).not.toContain("DATABASE_FLUSH_SLOW");
      database.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps multiple knowledge bases and their chunks isolated", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const knowledge = new SqliteKnowledgeRepository(database);
      const first = knowledge.createKnowledgeBase("项目");
      const second = knowledge.createKnowledgeBase("算法");
      knowledge.saveDocument({ id: "doc-first", knowledgeBaseId: first.id, filename: "a.md", mimeType: "text/markdown", sha256: "a", text: "项目内容", sections: [], documentType: "project", status: "ready" });
      knowledge.replaceChunks("doc-first", [{ id: "chunk-first", text: "项目内容", metadata: { documentId: "doc-first", filename: "a.md", documentType: "project" } }]);
      knowledge.saveDocument({ id: "doc-second", knowledgeBaseId: second.id, filename: "b.md", mimeType: "text/markdown", sha256: "b", text: "算法内容", sections: [], status: "ready" });
      knowledge.replaceChunks("doc-second", [{ id: "chunk-second", text: "算法内容", metadata: { documentId: "doc-second", filename: "b.md" } }]);
      expect(knowledge.listChunks([first.id]).map((chunk) => chunk.text)).toEqual(["项目内容"]);
      expect(knowledge.listChunks([second.id]).map((chunk) => chunk.text)).toEqual(["算法内容"]);
      expect(knowledge.listDocuments(first.id)[0]?.documentType).toBe("project");
      knowledge.updateDocumentType("doc-first", "technical-doc");
      expect(knowledge.listDocuments(first.id)[0]?.documentType).toBe("technical-doc");
      expect(knowledge.listChunks([first.id])[0]?.metadata.documentType).toBe("technical-doc");
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

  it("recovers messages left streaming after an interrupted app process", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const conversations = new SqliteConversationRepository(database);
      const conversation = conversations.create(undefined, undefined, "中断恢复", 20);
      conversations.addMessage({ conversationId: conversation.id, role: "assistant", content: "部分回答", status: "streaming", model: "mock" }, 21);
      expect(conversations.recoverInterruptedMessages(22)).toBe(1);
      expect(conversations.get(conversation.id)?.messages[0]).toMatchObject({ content: "部分回答", status: "error" });
    } finally { database.close(); }
  });

  it("persists Profile Builder artifacts without changing legacy records", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "画像测试", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const builder = new SqliteProfileBuilderRepository(database);
      const artifact = { version: 1 as const, profileId: profile.id, generatedAt: 10, status: "ready" as const, sourceIds: ["resume-1"], skillGraph: { nodes: [], edges: [] }, projectGraph: { nodes: [], edges: [] }, answerMaterials: [], faqs: [], warnings: [] };
      builder.save({ profileId: profile.id, status: "ready", sourceSnapshot: { sources: ["resume-1"] }, artifact, now: 10 });
      expect(builder.get(profile.id)?.artifact?.profileId).toBe(profile.id);
      expect(profiles.get(profile.id)?.name).toBe("画像测试");
      builder.invalidate(profile.id, 20);
      expect(builder.get(profile.id)?.status).toBe("partial");
    } finally { database.close(); }
  });

  it("persists structured project memory in the migration tables", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      new SqliteProfileRepository(database).save({ id: "profile-1", name: "项目记忆", language: "zh-CN", skills: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1 });
      const memory = new SqliteProjectMemoryRepository(database);
      const snapshot = memory.replaceSnapshot("profile-1", {
        projects: [{ id: "memory-project-foc", profileId: "profile-1", name: "FOC", description: "电机控制", role: "负责固件", hardware: ["STM32F405"], software: ["FreeRTOS"], technologyStack: ["FOC", "DMA"], sourceIds: ["doc-1"], confidence: 0.9 }],
        modules: [{ id: "module-1", projectId: "memory-project-foc", moduleName: "电流环", description: "PWM同步采样", sourceIds: ["doc-1"] }],
        technicalPoints: [{ id: "point-1", projectId: "memory-project-foc", topic: "ADC", content: "DMA搬运采样数据", importance: "high", sourceIds: ["doc-1"] }],
        problems: [{ id: "problem-1", projectId: "memory-project-foc", problem: "低速抖动", cause: "量化噪声", solution: "速度观测器", result: "运行稳定", sourceIds: ["doc-1"] }],
        interviewQuestions: [{ id: "question-1", projectId: "memory-project-foc", question: "为什么这么设计？", answerPoints: ["基于实时性约束"], keywords: ["设计"], sourceIds: ["doc-1"] }]
      });
      expect(snapshot.projects[0]?.technologyStack).toEqual(["FOC", "DMA"]);
      expect(memory.stats("profile-1")).toEqual({ projects: 1, modules: 1, technicalPoints: 1, problems: 1, interviewQuestions: 1 });
      expect(memory.listFacts("profile-1").some((fact) => fact.type === "challenge" && fact.title === "低速抖动")).toBe(true);
      expect(memory.searchFacts("profile-1", "DMA 采样").some((item) => item.fact.title === "ADC" || item.fact.content.includes("DMA"))).toBe(true);
      const firstEmbeddingRun = await memory.embedFacts("profile-1", async () => [1, 0, 0], { model: "test-embedding", version: "project-facts-v1" });
      expect(firstEmbeddingRun.embedded).toBeGreaterThan(0);
      expect(memory.listFacts("profile-1").every((fact) => fact.embedding?.length && fact.embeddingModel === "test-embedding")).toBe(true);
      const semanticMatches = memory.searchFacts("profile-1", "完全不同的表述", { queryEmbedding: [1, 0, 0], limit: 3, minScore: 0 });
      expect(semanticMatches[0]?.vectorScore).toBeGreaterThan(0.99);
      const secondEmbeddingRun = await memory.embedFacts("profile-1", async () => { throw new Error("should reuse persisted vectors"); }, { model: "test-embedding", version: "project-facts-v1" });
      expect(secondEmbeddingRun).toMatchObject({ embedded: 0, failed: 0 });
      const questionBank = new SqliteQuestionBankRepository(database);
      expect(questionBank.getQuestion("question-1")).toMatchObject({ scope: "project", profileId: "profile-1", projectId: "memory-project-foc", source: "generated" });
      expect(questionBank.getQuestion("question-1")?.answerCards[0]?.keyPoints).toEqual(["基于实时性约束"]);
      const retrievals = new SqliteRetrievalRepository(database);
      const run = retrievals.record({ profileId: "profile-1", query: "DMA 采样", route: "personal-evidence-first", metadata: { totalRetrievalMs: 12, embeddingTimedOut: true }, hits: [{ resultType: "project-fact", resultId: "point-1-fact", score: 0.9, preview: "DMA搬运采样数据", verified: false }], now: 20 });
      expect(retrievals.get(run.id)?.hits[0]).toMatchObject({ resultType: "project-fact", resultId: "point-1-fact", rank: 1, score: 0.9 });
      expect(retrievals.get(run.id)?.metadata).toEqual({ totalRetrievalMs: 12, embeddingTimedOut: true });
      const analyses = new SqliteKnowledgeAnalysisRepository(database);
      analyses.record({ id: "analysis-1", profileId: "profile-1", runType: "project-memory", inputHash: "hash-1", status: "completed", inputSnapshot: { sourceIds: ["doc-1"] }, output: snapshot, now: 30 });
      expect(analyses.list("profile-1")[0]).toMatchObject({ id: "analysis-1", status: "completed", inputHash: "hash-1" });
      const confirmedFact = memory.listFacts("profile-1").find((fact) => fact.type === "responsibility");
      expect(confirmedFact).toBeDefined();
      memory.setFactVerification(confirmedFact?.id ?? "", true, 40);
      memory.replaceSnapshot("profile-1", snapshot, 50);
      expect(memory.getFact(confirmedFact?.id ?? "")?.verified).toBe(true);
      expect(memory.getSnapshot("other").projects).toHaveLength(0);
    } finally { database.close(); }
  });

  it("stores question bank answer cards and matches variants", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const questionBank = new SqliteQuestionBankRepository(database);
      const question = questionBank.saveQuestion({ canonicalText: "IIC 通讯读不到数据时如何定位？", type: "troubleshooting", variants: ["I2C 总线没有数据怎么排查"] });
      questionBank.saveAnswerCard({ questionId: question.id, content: "先检查硬件连接、上拉、电平、时序、地址和 ACK，再看超时恢复。", verified: true });
      const match = questionBank.matchQuestion("iic通信读不到数据怎么排查");
      expect(match?.question.id).toBe(question.id);
      expect(match?.question.answerCards[0]?.verified).toBe(true);
      expect(questionBank.listQuestions({ type: "troubleshooting" })).toHaveLength(1);
    } finally { database.close(); }
  });

  it("imports consecutive question lists, filters project questions, and merges duplicates", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const questionBank = new SqliteQuestionBankRepository(database);
      const result = questionBank.importText(`五、FreeRTOS\n1. 任务切换的时候上下文保存了哪些东西？\n2. 项目里的任务如何设计？\n3. volatile 的作用是什么？\n4. volatile 的作用是什么？`);
      expect(result.recognizedQuestions).toBe(4);
      expect(result.importedQuestions).toBe(2);
      expect(result.filteredProjectQuestions).toBe(1);
      expect(result.duplicatesMerged).toBe(1);
      expect(questionBank.listQuestions({ limit: 5000 })).toHaveLength(2);
    } finally { database.close(); }
  });
});
