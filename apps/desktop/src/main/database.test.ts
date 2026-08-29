import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteConversationRepository, SqliteDatabase, SqliteInterviewHistoryRepository, SqliteJobTargetRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileBuilderRepository, SqliteProfileRepository, SqliteProjectAnalysisJobRepository, SqliteProjectMemoryRepository, SqliteProjectRepository, SqliteQuestionBankRepository, SqliteRetrievalRepository } from "./database";
import type { ProjectUnderstanding } from "@interview-copilot/shared";

describe("SQLite persistence", () => {
  it("persists profile CRUD, clone and active selection", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "嵌入式面试", language: "zh-CN", expressionLevel: "standard", explainAdvancedTerms: false, skills: [], knowledgeBaseIds: [] });
      expect(profiles.get(profile.id)).toMatchObject({ name: "嵌入式面试", expressionLevel: "standard", explainAdvancedTerms: false });
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

  it("round-trips question groups and answer thread relations without losing legacy history", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const history = new SqliteInterviewHistoryRepository(database);
      const interview = history.createInterview({ profileId: "profile-thread", startedAt: 2_000, status: "running", language: "zh-CN", automationMode: "AUTO" }, 2_000);
      const question = history.addQuestion({
        interviewId: interview.id,
        text: "C语言里，指针和数组有什么区别？",
        confidence: "high",
        source: "extractor",
        detectedAt: 2_100,
        status: "confirmed",
        groupId: "question-group-1",
        relationType: "SAME_QUESTION_AUGMENTATION",
        threadItemType: "QUESTION_NUCLEUS"
      });
      history.addAnswer({
        questionId: question.id,
        text: "指针是对象，数组是连续元素集合。",
        model: "thread-model",
        groupId: "question-group-1",
        relation: "PRIMARY",
        answerRunId: "answer-run-1",
        createdAt: 2_200
      });

      const snapshot = history.snapshot(interview.id);
      expect(snapshot.questions[0]).toMatchObject({ groupId: "question-group-1", relationType: "SAME_QUESTION_AUGMENTATION", threadItemType: "QUESTION_NUCLEUS" });
      expect(snapshot.answers[0]).toMatchObject({ groupId: "question-group-1", relation: "PRIMARY", answerRunId: "answer-run-1" });
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
      expect(conversations.get(conversation.id)?.messages[0]).toMatchObject({ content: "部分回答", status: "partial_error", errorCode: "CHAT_RELOADED_DURING_STREAM" });
    } finally { database.close(); }
  });

  it("persists Profile Builder artifacts without changing legacy records", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "画像测试", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const builder = new SqliteProfileBuilderRepository(database);
      const artifact = { version: 1 as const, profileId: profile.id, generatedAt: 10, status: "ready" as const, analysisQuality: "model" as const, sourceIds: ["resume-1"], skillGraph: { nodes: [], edges: [] }, projectGraph: { nodes: [], edges: [] }, answerMaterials: [], faqs: [], warnings: [] };
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
        interviewQuestions: [{ id: "question-1", projectId: "memory-project-foc", question: "为什么这么设计？", answerPoints: ["基于实时性约束"], keywords: ["设计"], sourceIds: ["doc-1"], factIds: ["fact-responsibility"] }],
        facts: [
          { id: "fact-background", projectId: "memory-project-foc", type: "background", title: "项目背景", content: "电机控制", confidence: 0.9, verified: false, sourceIds: ["doc-1"], evidence: [{ sourceId: "doc-1", quote: "电机控制" }] },
          { id: "fact-responsibility", projectId: "memory-project-foc", type: "responsibility", title: "个人职责", content: "负责固件", confidence: 0.9, verified: false, sourceIds: ["doc-1"], evidence: [{ sourceId: "doc-1", quote: "负责固件" }] },
          { id: "fact-technology", projectId: "memory-project-foc", type: "technology", title: "ADC", content: "DMA搬运采样数据", confidence: 0.9, verified: false, sourceIds: ["doc-1"], evidence: [{ sourceId: "doc-1", quote: "DMA搬运采样数据" }] },
          { id: "fact-challenge", projectId: "memory-project-foc", type: "challenge", title: "低速抖动", content: "原因：量化噪声\n解决：速度观测器\n结果：运行稳定", confidence: 0.9, verified: false, sourceIds: ["doc-1"], evidence: [{ sourceId: "doc-1", quote: "低速抖动" }] }
        ]
      });
      expect(snapshot.projects[0]?.technologyStack).toEqual(["ADC"]);
      expect(memory.stats("profile-1")).toMatchObject({ projects: 1, modules: 1, technicalPoints: 1, problems: 1, interviewQuestions: 1 });
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
      expect(questionBank.getQuestion("question-1")?.stale).toBe(true);
      expect(questionBank.getQuestion("question-1")?.answerCards[0]?.stale).toBe(true);
      memory.replaceSnapshot("profile-1", snapshot, 50);
      expect(memory.getFact(confirmedFact?.id ?? "")?.verified).toBe(true);
      expect(memory.getSnapshot("other").projects).toHaveLength(0);
    } finally { database.close(); }
  });

  it("applies migration 23 ownership and technical memory semantics", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      expect(database.first<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(33);
      expect(database.all<{ name: string }>("PRAGMA table_info(projects)").map((row) => row.name)).toEqual(expect.arrayContaining(["ownership_mode", "ownership_note"]));
      expect(database.all<{ name: string }>("PRAGMA table_info(project_facts)").map((row) => row.name)).toEqual(expect.arrayContaining(["experience_relation", "value_json"]));
      new SqliteProfileRepository(database).save({ id: "profile-v4", name: "V4", language: "zh-CN", skills: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1 });
      const memory = new SqliteProjectMemoryRepository(database);
      const created = memory.createProject("profile-v4", "团队项目", 2, "team", "我负责控制链路");
      expect(created).toMatchObject({ ownershipMode: "team", ownershipNote: "我负责控制链路" });
      memory.replaceSnapshot("profile-v4", { projects: [{ id: created.id, profileId: "profile-v4", name: created.name, description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: [], confidence: 1, ownershipMode: "personal" }], modules: [], technicalPoints: [], problems: [], interviewQuestions: [], facts: [] }, 3);
      expect(memory.getProject(created.id)?.ownershipMode).toBe("team");
      const parameter = memory.addCandidateFact({ id: "v4-parameter", projectId: created.id, type: "parameter", title: "CAN 波特率", content: "CAN 波特率 500 kbps", confidence: 1, verified: false, sourceIds: ["v4-source"], evidence: [{ sourceId: "v4-source", quote: "CAN 波特率 500 kbps" }] });
      expect(parameter).toMatchObject({ type: "parameter", canonicalKey: "communication.can.bitrate", experienceRelation: "configured", value: { kind: "scalar", value: 500_000, unit: "bit/s" } });
      const repaired = memory.repairProjectTechnicalSemantics(created.id);
      expect(repaired.find((fact) => fact.id === "v4-parameter")?.value).toMatchObject({ kind: "scalar", value: 500_000, unit: "bit/s" });
    } finally { database.close(); }
  });

  it("round-trips repository files in dedicated tables without putting source text in documents", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const knowledge = new SqliteKnowledgeRepository(database);
      const base = knowledge.createKnowledgeBase("源码");
      knowledge.saveDocument({
        id: "repo-roundtrip",
        knowledgeBaseId: base.id,
        filename: "foc2.zip",
        mimeType: "application/zip",
        sha256: "archive-sha",
        text: "Repository archive: foc2.zip\nFiles: 2",
        sections: ["Core/main.c"],
        documentType: "project",
        status: "ready",
        repositoryFiles: [
          { documentId: "repo-roundtrip", path: "Core/main.c", kind: "source", language: "C", size: 25, sha256: "file-sha", text: "void foc_control(void) {}" },
          { documentId: "repo-roundtrip", path: "Core/main.h", kind: "header", language: "C", size: 18, sha256: "header-sha", text: "void foc_control(void);" }
        ],
        repositoryManifest: { archiveName: "foc2.zip", archiveSha256: "archive-sha", fileCount: 2, eligibleFileCount: 2, skippedFileCount: 0, totalSourceBytes: 43, languages: ["C"], directories: ["Core"], configFiles: [], testFiles: [], documentFiles: [], importedAt: 1 },
        repositorySkippedFiles: [{ path: "image.bin", reason: "binary-content" }]
      });
      expect(knowledge.listDocuments(base.id)[0]?.repositoryFiles).toBeUndefined();
      const loaded = knowledge.getDocument("repo-roundtrip");
      expect(loaded).toMatchObject({ text: "Repository archive: foc2.zip\nFiles: 2", repositoryManifest: { archiveSha256: "archive-sha" } });
      expect(loaded?.repositoryFiles).toEqual(expect.arrayContaining([expect.objectContaining({ path: "Core/main.c", text: "void foc_control(void) {}" })]));
      expect(knowledge.findDocumentBySha256("archive-sha", base.id)?.id).toBe("repo-roundtrip");

      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "源码任务", language: "zh-CN", skills: [], knowledgeBaseIds: [base.id] });
      const project = new SqliteProjectMemoryRepository(database).createProject(profile.id, "FOC");
      const jobs = new SqliteProjectAnalysisJobRepository(database);
      jobs.save({ id: "job-roundtrip", profileId: profile.id, projectId: project.id, status: "queued", stage: "queued", createdAt: 1, updatedAt: 1, progress: 0, filesTotal: 2, filesExplored: 0, toolCalls: 0, modelTurns: 0, cancelRequested: false });
      expect(jobs.get("job-roundtrip")).toMatchObject({ projectId: project.id, status: "queued", filesTotal: 2 });
      expect(jobs.recoverInterrupted(2)).toBe(1);
      expect(jobs.get("job-roundtrip")).toMatchObject({ status: "failed", errorCode: "PROJECT_ANALYSIS_INTERRUPTED" });
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

  it("stores categorized project questions, modules, relations and route metadata", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const questionBank = new SqliteQuestionBankRepository(database);
      const root = questionBank.saveQuestion({ id: "project-root", canonicalText: "FOC 项目为什么要同步采样？", type: "project", bankType: "project", category: "project", scope: "project", projectId: "foc", moduleId: "current-loop", verified: true });
      const followUp = questionBank.saveQuestion({ id: "project-follow-up", canonicalText: "具体怎么验证采样时序？", type: "troubleshooting", bankType: "project", category: "troubleshooting", scope: "project", projectId: "foc", moduleId: "current-loop" });
      questionBank.saveAnswerCard({ questionId: root.id, content: "我会用示波器核对 PWM 触发点和 ADC 采样点，再用同一工况回归。", verified: true });
      const relation = questionBank.saveRelation({ sourceQuestionId: root.id, targetQuestionId: followUp.id, relationType: "FOLLOW_UP" });

      expect(questionBank.listQuestions({ bankType: "project", projectId: "foc", moduleId: "current-loop" })).toHaveLength(2);
      expect(questionBank.getQuestion(root.id)).toMatchObject({ bankType: "project", category: "project", projectId: "foc", moduleId: "current-loop", frequency: 0, mastery: 0 });
      expect(questionBank.getQuestion(root.id)?.relations).toEqual([expect.objectContaining({ id: relation.id, relationType: "FOLLOW_UP", targetQuestionId: followUp.id })]);
      expect(questionBank.getQuestion(root.id)?.followUps).toHaveLength(1);
      expect(questionBank.routeQuestion("FOC 项目为什么要同步采样？", { projectId: "foc" }).top?.question.id).toBe(root.id);
    } finally { database.close(); }
  });

  it("imports trusted project QA into the existing question-bank schema without blanket invalidation", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "项目 QA", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const project = new SqliteProjectMemoryRepository(database).createProject(profile.id, "FOC");
      const questionBank = new SqliteQuestionBankRepository(database);
      const report = questionBank.importProjectText(profile.id, project.id, "问题：ADC 怎么保证实时性？\n答案：PWM 中点触发 ADC，并通过 DMA 搬运。", "foc-questions.md");

      expect(report).toMatchObject({ projectId: project.id, sourceRole: "question_bank", verified: true, recognizedQuestions: 1, importedAnswers: 1 });
      expect(questionBank.listQuestions({ scope: "project", projectId: project.id, exactProject: true, status: "all" })).toHaveLength(1);
      expect(questionBank.listQuestions({ scope: "project", projectId: "another-project", exactProject: true, status: "all" })).toHaveLength(0);
      expect(questionBank.listQuestions({ status: "all" })).toHaveLength(1);
      const saved = questionBank.listQuestions({ scope: "project", projectId: project.id, exactProject: true, status: "all" })[0];
      expect(saved).toMatchObject({ scope: "project", projectId: project.id, bankType: "project", source: "imported", verified: true, stale: false });
      expect(saved?.answerCards[0]).toMatchObject({ sourceType: "imported", verified: true, stale: false });

      expect(questionBank.markProjectQuestionBankStale(project.id, 100)).toBe(0);
      expect(questionBank.getQuestion(saved?.id ?? "")).toMatchObject({ stale: false });
      expect(questionBank.getQuestion(saved?.id ?? "")?.answerCards[0]).toMatchObject({ stale: false });
    } finally { database.close(); }
  });

  it("invalidates only project QA that depends on changed facts", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profile = new SqliteProfileRepository(database).save({ name: "事实依赖", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const memory = new SqliteProjectMemoryRepository(database);
      const project = memory.createProject(profile.id, "FOC");
      const pwmFact = memory.addCandidateFact({ id: "fact-pwm-frequency", projectId: project.id, profileId: profile.id, type: "parameter", title: "PWM 频率", content: "10kHz", confidence: 1, verified: false, sourceIds: ["doc-pwm"], evidence: [{ sourceId: "doc-pwm", quote: "PWM 频率 10kHz" }] });
      const canFact = memory.addCandidateFact({ id: "fact-can-arbitration", projectId: project.id, profileId: profile.id, type: "technology", title: "CAN 仲裁", content: "显性位优先", confidence: 1, verified: false, sourceIds: ["doc-can"], evidence: [{ sourceId: "doc-can", quote: "CAN 使用显性位仲裁" }] });
      const questionBank = new SqliteQuestionBankRepository(database);
      const pwmQuestion = questionBank.saveQuestion({ id: "qa-pwm", canonicalText: "PWM 频率是多少？", type: "project", bankType: "project", category: "project", scope: "project", profileId: profile.id, projectId: project.id, source: "imported", verified: true, factIds: [pwmFact.id] });
      questionBank.saveAnswerCard({ id: "qa-pwm-card", questionId: pwmQuestion.id, content: "10kHz", sourceType: "imported", verified: true, factIds: [pwmFact.id] });
      const canQuestion = questionBank.saveQuestion({ id: "qa-can", canonicalText: "CAN 怎么仲裁？", type: "project", bankType: "project", category: "project", scope: "project", profileId: profile.id, projectId: project.id, source: "imported", verified: true, factIds: [canFact.id] });
      questionBank.saveAnswerCard({ id: "qa-can-card", questionId: canQuestion.id, content: "显性位优先。", sourceType: "imported", verified: true, factIds: [canFact.id] });
      const unrelatedQuestion = questionBank.saveQuestion({ id: "qa-unrelated", canonicalText: "ADC 怎么保证实时性？", type: "project", bankType: "project", category: "project", scope: "project", profileId: profile.id, projectId: project.id, source: "manual", verified: true });
      questionBank.saveAnswerCard({ id: "qa-unrelated-card", questionId: unrelatedQuestion.id, content: "PWM 中点采样。", sourceType: "manual", verified: true });

      expect(questionBank.invalidateProjectQaDependencies(project.id, [pwmFact.id], 100)).toBe(1);
      expect(questionBank.getQuestion(pwmQuestion.id)).toMatchObject({ stale: true });
      expect(questionBank.getQuestion(pwmQuestion.id)?.answerCards[0]).toMatchObject({ stale: true });
      expect(questionBank.getQuestion(canQuestion.id)).toMatchObject({ stale: false });
      expect(questionBank.getQuestion(unrelatedQuestion.id)).toMatchObject({ stale: false });
    } finally { database.close(); }
  });

  it("keeps question verification independent from answer-card verification", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const questionBank = new SqliteQuestionBankRepository(database);
      const question = questionBank.saveQuestion({ id: "qa-independent", canonicalText: "项目如何验证采样？", type: "project", bankType: "project", scope: "project", projectId: "project-independent", source: "ai-generated", verified: false });
      questionBank.saveAnswerCard({ id: "qa-independent-a", questionId: question.id, content: "答案 A，待单独确认。", sourceType: "manual", verified: false });
      questionBank.saveAnswerCard({ id: "qa-independent-b", questionId: question.id, content: "答案 B，待单独确认。", sourceType: "manual", verified: false });
      questionBank.bulkUpdate([question.id], { verified: true });
      questionBank.saveAnswerCard({ id: "qa-independent-a", questionId: question.id, content: "答案 A，已由候选人核对。", sourceType: "manual", verified: true });
      const saved = questionBank.getQuestion(question.id);
      expect(saved).toMatchObject({ verified: true });
      expect(saved?.answerCards.find((card) => card.id === "qa-independent-a")).toMatchObject({ verified: true });
      expect(saved?.answerCards.find((card) => card.id === "qa-independent-b")).toMatchObject({ verified: false });
    } finally { database.close(); }
  });

  it("uses the unified question bank for project snapshots without legacy question writes", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "统一题库", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const memory = new SqliteProjectMemoryRepository(database);
      const project = memory.createProject(profile.id, "统一项目");
      const projectSnapshot = memory.getSnapshot(profile.id).projects[0];
      expect(projectSnapshot).toBeDefined();
      memory.replaceSnapshot(profile.id, {
        projects: [projectSnapshot!],
        modules: [],
        technicalPoints: [],
        problems: [],
        interviewQuestions: [{ id: "unified-project-question", projectId: project.id, question: "项目如何验证采样时序？", answerPoints: ["用示波器核对触发点"], keywords: ["采样时序"], sourceIds: [], factIds: ["unified-fact"] }],
        facts: [{ id: "unified-fact", projectId: project.id, profileId: profile.id, type: "technology", title: "采样时序", content: "用示波器核对触发点", confidence: 1, verified: false, sourceIds: [] }]
      }, 10, project.id);

      const loaded = memory.getSnapshot(profile.id);
      expect(loaded.interviewQuestions).toMatchObject([{ id: "unified-project-question", question: "项目如何验证采样时序？" }]);
      expect(new SqliteQuestionBankRepository(database).getQuestion("unified-project-question")).toMatchObject({ scope: "project", projectId: project.id, source: "generated" });
      expect(database.first<{ count: number }>("SELECT COUNT(*) AS count FROM interview_questions")?.count).toBe(0);
    } finally { database.close(); }
  });

  it("repairs legacy trust defaults when migration 21 is applied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "interview-copilot-migration-"));
    const filePath = join(directory, "legacy.sqlite");
    try {
      const first = await SqliteDatabase.open(filePath);
      const profile = new SqliteProfileRepository(first).save({ id: "profile-migration", name: "迁移", language: "zh-CN", skills: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1 });
      const memory = new SqliteProjectMemoryRepository(first);
      memory.replaceSnapshot(profile.id, { projects: [{ id: "project-migration", profileId: profile.id, name: "Legacy", description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: ["legacy-doc"], confidence: 1 }], modules: [], technicalPoints: [], problems: [], interviewQuestions: [], facts: [
        { id: "legacy-code", projectId: "project-migration", type: "technology", title: "CAN", content: "CAN", confidence: 1, verified: false, sourceIds: ["legacy-doc"], evidence: [{ sourceId: "legacy-doc", quote: "CAN" }] },
        { id: "legacy-role", projectId: "project-migration", type: "responsibility", title: "个人职责", content: "负责驱动", confidence: 1, verified: true, sourceIds: ["legacy-doc"], evidence: [{ sourceId: "legacy-doc", quote: "负责驱动" }] }
      ] });
      memory.assignSource({ projectId: "project-migration", sourceType: "repository", sourceId: "legacy-doc", relationship: "primary", sourceRole: "code", confidence: 1, verified: true });
      const questionBank = new SqliteQuestionBankRepository(first);
      questionBank.saveQuestion({ id: "legacy-project-question", canonicalText: "Legacy 项目如何实现？", type: "project", scope: "project", profileId: profile.id, projectId: "project-migration", source: "generated", factIds: ["legacy-code"] });
      questionBank.saveAnswerCard({ id: "legacy-answer-card", questionId: "legacy-project-question", content: "保留旧答案卡", verified: true, factIds: ["legacy-code"] });
      const history = new SqliteInterviewHistoryRepository(first);
      const interview = history.createInterview({ profileId: profile.id, projectId: "project-migration", startedAt: 1, status: "running", language: "zh-CN", automationMode: "AUTO" }, 2);
      const historyQuestion = history.addQuestion({ interviewId: interview.id, text: "Legacy 面试题", confidence: "high", source: "rules", detectedAt: 3, status: "confirmed" });
      history.addTranscript({ interviewId: interview.id, source: "remote", text: "Legacy 转写", startMs: 0, endMs: 100, final: true, confidence: 1 }, 4);
      history.addAnswer({ questionId: historyQuestion.id, text: "Legacy 回答", model: "legacy-model", createdAt: 5 });
      first.run("UPDATE project_facts SET evidence_level='pending', conflict_status='pending_review', ownership='project' WHERE project_id='project-migration'");
      first.run("UPDATE project_facts SET verified=1 WHERE id='legacy-role'");
      first.run("DELETE FROM schema_migrations WHERE version IN (21, 22)");
      first.flushNow();
      first.close();
      const second = await SqliteDatabase.open(filePath);
      try {
      expect(second.first<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(33);
        const repaired = new SqliteProjectMemoryRepository(second);
        repaired.repairProjectTechnicalSemantics("project-migration");
        expect(repaired.listFacts(profile.id, "project-migration", { includeStale: true, includeRejected: true })).toHaveLength(2);
        expect(repaired.getFact("legacy-code")).toMatchObject({ evidenceLevel: "confirmed-code", conflictStatus: "confirmed" });
        expect(repaired.getFact("legacy-code")?.evidence).toEqual([expect.objectContaining({ sourceId: "legacy-doc", quote: "CAN" })]);
        expect(repaired.getFact("legacy-role")).toMatchObject({ evidenceLevel: "confirmed-user", ownership: "self", verified: true });
        expect(repaired.listProjectSources("project-migration")).toHaveLength(1);
        expect(new SqliteQuestionBankRepository(second).getQuestion("legacy-project-question")?.answerCards[0]).toMatchObject({ content: "保留旧答案卡", verified: true });
        expect(new SqliteInterviewHistoryRepository(second).snapshot(interview.id)).toMatchObject({ transcripts: [expect.objectContaining({ text: "Legacy 转写" })], questions: [expect.objectContaining({ text: "Legacy 面试题" })], answers: [expect.objectContaining({ text: "Legacy 回答" })] });
      } finally { second.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("round-trips rich project fact fields and evidence relations", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      new SqliteProfileRepository(database).save({ id: "profile-rich", name: "Rich", language: "zh-CN", skills: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1 });
      const memory = new SqliteProjectMemoryRepository(database);
      memory.replaceSnapshot("profile-rich", { projects: [{ id: "project-rich", profileId: "profile-rich", name: "Rich", description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: ["doc-a", "doc-b"], confidence: 1 }], modules: [], technicalPoints: [], problems: [], interviewQuestions: [], facts: [{ id: "fact-rich", projectId: "project-rich", type: "technology", title: "MCU", content: "STM32G431", confidence: .9, verified: false, sourceIds: ["doc-a", "doc-b"], evidence: [{ sourceId: "doc-a", quote: "STM32G431", relation: "support" }, { sourceId: "doc-b", quote: "STM32F405", relation: "refute" }], evidenceLevel: "confirmed-document", scope: "architecture", sectionPath: ["架构", "主控"], subtype: "mcu", conflictStatus: "conflicting", conflictGroupId: "group-mcu", ownership: "project", stale: false, status: "conflicting" }] });
      const fact = memory.getFact("fact-rich");
      expect(fact).toMatchObject({ evidenceLevel: "confirmed-document", scope: "architecture", sectionPath: ["架构", "主控"], subtype: "mcu", conflictStatus: "conflicting", conflictGroupId: "group-mcu", ownership: "project", stale: false });
      expect(fact?.evidence?.map((item) => item.relation)).toEqual(["support", "refute"]);
    } finally { database.close(); }
  });

  it("stores and reuses project understanding snapshots by input hash", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ id: "profile-understanding", name: "理解快照", language: "zh-CN", skills: [], knowledgeBaseIds: [], createdAt: 1, updatedAt: 1 });
      const memory = new SqliteProjectMemoryRepository(database);
      const project = memory.createProject(profile.id, "FOC", 2);
      const understanding = { projectId: project.id, schemaVersion: 1, status: "completed", identity: { name: "FOC" }, summary: "这是一个可缓存的项目理解摘要，用于验证快照版本和输入复用。", architecture: { components: [], relationships: [] }, runtimeFlows: [], dataFlows: [], controlFlows: [], technologies: [], parameters: [], decisions: [], problems: [], interfaces: [], protections: [], tests: [], results: [], limitations: [], unknowns: [], evidenceRefs: [], quality: { architectureCoverage: 0, flowCoverage: 0, parameterCoverage: 0, decisionCoverage: 0, problemCoverage: 0, groundingCoverage: 0, sufficient: false }, trace: { toolCalls: 1, filesRead: 1, modelTurns: 0, elapsedMs: 1, stages: ["completed"] } } as ProjectUnderstanding;
      const saved = memory.saveUnderstandingSnapshot({ projectId: project.id, inputHash: "hash-a", understanding, now: 10 });
      expect(saved).toMatchObject({ projectId: project.id, inputHash: "hash-a", version: 1, status: "completed" });
      expect(memory.getUnderstandingSnapshot(project.id, "hash-a")?.understanding.summary).toContain("可缓存");
      expect(memory.getSnapshot(profile.id).understandings?.[0]?.projectId).toBe(project.id);
      expect(memory.getUnderstandingSnapshot(project.id, "different-hash")).toBeUndefined();
      expect(database.first<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations")?.version).toBe(33);
    } finally { database.close(); }
  });

  it("persists answer telemetry and revision timestamps for history diagnostics", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const events: Array<{ revision: number; createdAt?: number }> = [];
      const history = new SqliteInterviewHistoryRepository(database, (event) => events.push(event));
      const interview = history.createInterview({ profileId: "telemetry-profile", startedAt: 1, status: "running", language: "zh-CN", automationMode: "AUTO" }, 1);
      const question = history.addQuestion({ interviewId: interview.id, text: "C 语言里 static 有什么作用？", confidence: "high", source: "rules", detectedAt: 2, status: "confirmed", rawTranscript: "study 有什么作用", normalizedQuestion: "static 有什么作用", canonicalQuestion: "static 有什么作用？", contextRelation: "standalone", semanticFrame: "keyword", terminologyCorrections: [{ raw: "study", canonical: "static", source: "phonetic", confidence: 0.97 }] });
      history.addAnswer({ questionId: question.id, text: "static 影响存储期或链接范围。", model: "core", telemetry: { rawText: "study 有什么作用", normalizedText: "static 有什么作用", canonicalText: "static 有什么作用？", terminologyCorrectionCount: 1, terminologyConfidence: 0.97, semanticFrame: "keyword", answerSourceMode: "general_core_qa", historyRevision: history.getRevision(interview.id) }, createdAt: 3 });
      const saved = history.snapshot(interview.id).answers[0];
      expect(saved?.telemetry).toMatchObject({ canonicalText: "static 有什么作用？", terminologyCorrectionCount: 1, answerSourceMode: "general_core_qa" });
      expect(events.every((event) => typeof event.createdAt === "number")).toBe(true);
      expect(history.getRevision(interview.id)).toBe(3);
    } finally { database.close(); }
  });

  it("supports server-side question pagination, bulk review and duplicate merge", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const questionBank = new SqliteQuestionBankRepository(database);
      const canonical = questionBank.saveQuestion({ canonicalText: "volatile 有什么作用？", type: "technical" });
      const duplicate = questionBank.saveQuestion({ canonicalText: "volatile 有什么作用", type: "technical", variants: ["volatile 关键字的作用"] });
      questionBank.saveAnswerCard({ questionId: duplicate.id, content: "限制编译器和 CPU 对访问的重排。", verified: true });
      expect(questionBank.countQuestions({ status: "active" })).toBe(2);
      expect(questionBank.listQuestions({ status: "active", limit: 1, offset: 1 })).toHaveLength(1);
      expect(questionBank.bulkUpdate([canonical.id], { verified: true, stale: true })).toBe(1);
      expect(questionBank.getQuestion(canonical.id)).toMatchObject({ verified: true, stale: true });
      expect(questionBank.duplicateClusters()).toHaveLength(1);
      const merged = questionBank.mergeDuplicates(canonical.id, [duplicate.id]);
      expect(merged?.variants).toContain("volatile 关键字的作用");
      expect(questionBank.getQuestion(duplicate.id)?.status).toBe("archived");
      expect(merged?.answerCards.some((card) => card.verified)).toBe(true);
    } finally { database.close(); }
  });

  it("persists structured chat responses and calculates skill coverage", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "覆盖分析", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const conversations = new SqliteConversationRepository(database);
      const conversation = conversations.create(profile.id);
      conversations.addMessage({ conversationId: conversation.id, role: "user", content: "分析题库覆盖", status: "completed" });
      const questionBank = new SqliteQuestionBankRepository(database);
      const skill = questionBank.saveSkill({ name: "Linux" });
      questionBank.saveSkillPoint({ skillId: skill.id, title: "进程调度", content: "调度与上下文切换", verified: true });
      const question = questionBank.saveQuestion({ canonicalText: "Linux 进程调度如何定位？", verified: true });
      questionBank.linkQuestionSkill(question.id, skill.id);
      questionBank.saveAnswerCard({ questionId: question.id, content: "分析调度策略和上下文切换。", verified: true });
      const response = { text: "覆盖不错", cards: [{ id: "coverage-card", kind: "coverage" as const, title: "Linux" }], actions: [{ id: "action-1", type: "create_question" as const, label: "加入题库", payload: { canonicalText: "补充内存管理" }, requiresConfirmation: true as const, status: "pending" as const }] };
      const assistant = conversations.addMessage({ conversationId: conversation.id, role: "assistant", content: response.text, status: "completed", structuredResponse: response });
      expect(conversations.get(conversation.id)?.messages.find((message) => message.id === assistant.id)?.structuredResponse).toEqual(response);
      expect(questionBank.coverage().overallCoverage).toBe(100);
    } finally { database.close(); }
  });
});
