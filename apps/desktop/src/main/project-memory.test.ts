import { describe, expect, it } from "vitest";
import { SqliteDatabase, SqliteInterviewHistoryRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectMemoryRepository, SqliteQuestionBankRepository } from "./database";
import { ProjectMemoryService } from "./project-memory";

describe("ProjectMemoryService project isolation", () => {
  it("does not auto-create a project on the real upload path", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const knowledge = new SqliteKnowledgeRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const base = knowledge.createKnowledgeBase("资料");
      const profile = profiles.save({ name: "严格绑定", language: "zh-CN", skills: [], knowledgeBaseIds: [base.id] });
      const document = knowledge.saveDocument({ id: "doc-unassigned", knowledgeBaseId: base.id, filename: "新项目说明.md", mimeType: "text/markdown", sha256: "x", text: "项目背景：一个新项目", sections: [], documentType: "project", status: "ready" });
      const service = new ProjectMemoryService(profiles, knowledge, new SqliteInterviewHistoryRepository(database), memories);
      const result = service.assignDocument(profile.id, document.id);
      expect(result.status).toBe("needs_assignment");
      expect(memories.listProjects(profile.id)).toHaveLength(0);
    } finally { database.close(); }
  });

  it("marks derived facts stale when a bound source is removed", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const profile = profiles.save({ name: "失效测试", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      memories.replaceSnapshot(profile.id, { projects: [{ id: "project-stale", profileId: profile.id, name: "项目", description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: ["doc-1"], confidence: 1 }], modules: [], technicalPoints: [], problems: [], interviewQuestions: [], facts: [{ id: "fact-stale", projectId: "project-stale", profileId: profile.id, type: "technology", title: "CAN", content: "CAN", confidence: 1, verified: false, sourceIds: ["doc-1"], evidence: [{ sourceId: "doc-1", quote: "CAN" }], evidenceLevel: "confirmed-document", status: "active" }] });
      memories.assignSource({ projectId: "project-stale", sourceType: "document", sourceId: "doc-1", relationship: "primary", sourceRole: "code", assignmentMethod: "explicit", confidence: 1, verified: true });
      memories.unassignSource("project-stale", "document", "doc-1");
      expect(memories.getFact("fact-stale")?.stale).toBe(true);
      expect(memories.listFacts(profile.id, "project-stale")).toHaveLength(0);
      expect(memories.listFacts(profile.id, "project-stale", { includeStale: true })).toHaveLength(1);
    } finally { database.close(); }
  });

  it("stores manual responsibility as an eligible confirmed-user fact", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const profile = profiles.save({ name: "职责确认", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const project = memories.createProject(profile.id, "项目");
      const fact = memories.addUserResponsibility(profile.id, project.id, "我负责 CAN 驱动和故障恢复");
      expect(fact).toMatchObject({ type: "responsibility", ownership: "self", evidenceLevel: "confirmed-user", status: "active", conflictStatus: "confirmed" });
    } finally { database.close(); }
  });

  it("confirms pending facts through one human-confirmation path", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const profile = profiles.save({ name: "统一确认", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const project = memories.createProject(profile.id, "项目");
      memories.assignSource({ projectId: project.id, sourceType: "document", sourceId: "doc", relationship: "primary", sourceRole: "overview", confidence: 1, verified: true });
      const pending = memories.addCandidateFact({ id: "pending-tech", projectId: project.id, profileId: profile.id, type: "technology", title: "ADC", content: "ADC DMA", confidence: .8, verified: false, sourceIds: ["doc"], evidence: [{ sourceId: "doc", quote: "ADC DMA" }], evidenceLevel: "pending", ownership: "project", status: "pending_review" });
      const confirmed = memories.confirmFactAsUser(pending.id);
      expect(confirmed).toMatchObject({ verified: true, status: "active", conflictStatus: "confirmed", evidenceLevel: "confirmed-user" });
      const responsibility = memories.addCandidateFact({ id: "pending-role", projectId: project.id, profileId: profile.id, type: "responsibility", title: "个人职责", content: "负责 ADC", confidence: .8, verified: false, sourceIds: ["doc"], evidence: [{ sourceId: "doc", quote: "负责 ADC" }], evidenceLevel: "pending", ownership: "unknown", status: "pending_review" });
      expect(memories.confirmFactAsUser(responsibility.id)).toMatchObject({ ownership: "self", evidenceLevel: "confirmed-user", verified: true, status: "active" });
    } finally { database.close(); }
  });

  it("keeps a fact and its questions valid when one of multiple supports is unbound", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const questions = new SqliteQuestionBankRepository(database);
      const profile = profiles.save({ name: "多证据", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const project = memories.createProject(profile.id, "项目");
      memories.assignSource({ projectId: project.id, sourceType: "document", sourceId: "readme", relationship: "primary", sourceRole: "overview", confidence: 1, verified: true });
      memories.assignSource({ projectId: project.id, sourceType: "repository", sourceId: "repo", relationship: "supporting", sourceRole: "code", confidence: 1, verified: true });
      const fact = memories.addCandidateFact({ id: "multi-support", projectId: project.id, profileId: profile.id, type: "technology", title: "CAN", content: "CAN 总线", confidence: .9, verified: false, sourceIds: ["readme", "repo"], evidence: [{ sourceId: "readme", quote: "CAN 总线" }, { sourceId: "repo", quote: "CAN 总线" }], evidenceLevel: "pending", status: "pending_review" });
      memories.confirmFactAsUser(fact.id);
      const question = questions.saveQuestion({ id: "multi-question", canonicalText: "项目 CAN 如何实现？", type: "project", scope: "project", profileId: profile.id, projectId: project.id, factIds: [fact.id] });
      questions.saveAnswerCard({ id: "multi-card", questionId: question.id, content: "CAN 总线", factIds: [fact.id] });
      memories.unassignSource(project.id, "document", "readme");
      expect(memories.getFact(fact.id)).toMatchObject({ stale: false, evidenceLevel: "confirmed-user" });
      expect(questions.getQuestion(question.id)?.stale).toBe(false);
      expect(questions.getQuestion(question.id)?.answerCards[0]?.stale).toBe(false);
    } finally { database.close(); }
  });

  it("isolates project document allow-lists and exposes explicit references", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const knowledge = new SqliteKnowledgeRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const base = knowledge.createKnowledgeBase("资料");
      const profile = profiles.save({ name: "RAG 隔离", language: "zh-CN", skills: [], knowledgeBaseIds: [base.id] });
      const a = knowledge.saveDocument({ id: "doc-a", knowledgeBaseId: base.id, filename: "A.md", mimeType: "text/markdown", sha256: "a", text: "STM32F405 ADC DMA", sections: [], documentType: "project", status: "ready" });
      const b = knowledge.saveDocument({ id: "doc-b", knowledgeBaseId: base.id, filename: "B.md", mimeType: "text/markdown", sha256: "b", text: "STM32G431 ADC injected", sections: [], documentType: "project", status: "ready" });
      const reference = knowledge.saveDocument({ id: "doc-ref", knowledgeBaseId: base.id, filename: "ADC 手册.md", mimeType: "text/markdown", sha256: "r", text: "ADC 通用参考", sections: [], documentType: "technical-doc", status: "ready" });
      knowledge.replaceChunks(a.id, [{ id: "chunk-a", text: "STM32F405 ADC DMA", metadata: { documentId: a.id, filename: a.filename, documentType: "project" } }]);
      knowledge.replaceChunks(b.id, [{ id: "chunk-b", text: "STM32G431 ADC injected", metadata: { documentId: b.id, filename: b.filename, documentType: "project" } }]);
      knowledge.replaceChunks(reference.id, [{ id: "chunk-ref", text: "ADC 通用参考", metadata: { documentId: reference.id, filename: reference.filename, documentType: "technical-doc" } }]);
      const projectA = memories.createProject(profile.id, "A");
      const projectB = memories.createProject(profile.id, "B");
      memories.assignSource({ projectId: projectA.id, sourceType: "document", sourceId: a.id, relationship: "primary", sourceRole: "overview", confidence: 1, verified: true });
      memories.assignSource({ projectId: projectB.id, sourceType: "document", sourceId: b.id, relationship: "primary", sourceRole: "overview", confidence: 1, verified: true });
      memories.assignSource({ projectId: projectA.id, sourceType: "document", sourceId: reference.id, relationship: "reference", sourceRole: "reference", confidence: 1, verified: true });
      expect(memories.listProjectDocumentIds(projectA.id)).toEqual([a.id]);
      expect(memories.listProjectDocumentIds(projectA.id)).not.toContain(b.id);
      expect(memories.listReferenceDocumentIds(profile.id)).toContain(reference.id);
      expect(knowledge.listChunksByDocumentIds(memories.listProjectDocumentIds(projectA.id)).map((chunk) => chunk.id)).toEqual(["chunk-a"]);
      expect(memories.stats(profile.id, projectA.id)).toMatchObject({ projects: 1, facts: 0, questions: 0, userActionRequiredFacts: 0 });
    } finally { database.close(); }
  });

  it("reconciles ProjectSkill relationships and preserves them across Profile edits", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const profile = profiles.save({ name: "技能生命周期", language: "zh-CN", instructions: "原始", skills: [{ id: "skill-rtos", name: "FreeRTOS", description: "", content: "任务调度", tags: [] }, { id: "skill-stm", name: "STM32", description: "", content: "MCU", tags: [] }], knowledgeBaseIds: [] });
      const project = memories.createProject(profile.id, "项目");
      memories.assignSource({ projectId: project.id, sourceType: "document", sourceId: "code", relationship: "primary", sourceRole: "code", confidence: 1, verified: true });
      const fact = memories.addCandidateFact({ id: "rtos-fact", projectId: project.id, profileId: profile.id, type: "technology", title: "RTOS", content: "FreeRTOS", confidence: .9, verified: false, sourceIds: ["code"], evidence: [{ sourceId: "code", quote: "FreeRTOS" }], evidenceLevel: "confirmed-code", status: "pending_review" });
      memories.confirmFactAsUser(fact.id);
      expect(memories.listProjectSkills(project.id)).toEqual([expect.objectContaining({ skillId: "skill-rtos", sourceFactId: fact.id })]);
      profiles.save({ ...profile, name: "技能生命周期更新", instructions: "新的说明" });
      expect(memories.listProjectSkills(project.id)).toEqual([expect.objectContaining({ skillId: "skill-rtos" })]);
      memories.setFactReviewStatus(fact.id, "rejected");
      expect(memories.listProjectSkills(project.id)).toHaveLength(0);
      profiles.save({ ...profile, name: "删除技能", skills: [{ id: "skill-stm", name: "STM32", description: "", content: "MCU", tags: [] }] });
      expect(memories.listProjectSkills(project.id)).toHaveLength(0);
    } finally { database.close(); }
  });

  it("assigns documents to separate projects and never uses interview answers as facts", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const knowledge = new SqliteKnowledgeRepository(database);
      const history = new SqliteInterviewHistoryRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const analyses = new SqliteKnowledgeAnalysisRepository(database);
      const base = knowledge.createKnowledgeBase("项目资料");
      const profile = profiles.save({ name: "隔离测试", language: "zh-CN", skills: [], knowledgeBaseIds: [base.id] });
      const foc = knowledge.saveDocument({ id: "doc-foc", knowledgeBaseId: base.id, filename: "基于STM32F405的实时FOC电机控制系统.md", mimeType: "text/markdown", sha256: "foc", text: "项目背景：实现 PMSM 矢量控制\n个人职责：负责电流环\n技术栈：STM32F405、FOC、SVPWM、DMA\n", sections: [], documentType: "project", status: "ready" });
      const esp = knowledge.saveDocument({ id: "doc-esp", knowledgeBaseId: base.id, filename: "ESP32 MQTT 网关.md", mimeType: "text/markdown", sha256: "esp", text: "项目背景：实现 MQTT 网关\n个人职责：负责通信模块\n技术栈：ESP32、MQTT、FreeRTOS\n", sections: [], documentType: "project", status: "ready" });
      const focContainer = memories.createProject(profile.id, "基于STM32F405的实时FOC电机控制系统");
      const espContainer = memories.createProject(profile.id, "ESP32 MQTT 网关");
      const interview = history.createInterview({ profileId: profile.id, startedAt: 1, status: "ended", language: "zh-CN", automationMode: "AUTO" }, 1);
      const question = history.addQuestion({ interviewId: interview.id, text: "你做过什么？", confidence: "high", source: "rules", detectedAt: 2, status: "confirmed" });
      history.addAnswer({ questionId: question.id, text: "我还做过 Linux 和 MQTT 项目", model: "mock", createdAt: 3 });
      const service = new ProjectMemoryService(profiles, knowledge, history, memories, undefined, undefined, analyses);
      const focAssignment = service.assignDocument(profile.id, foc.id, focContainer.id);
      const espAssignment = service.assignDocument(profile.id, esp.id, espContainer.id);
      expect(focAssignment.status).toBe("assigned");
      expect(espAssignment.status).toBe("assigned");
      await service.rebuildProject(focAssignment.projectId as string);
      const focSnapshot = memories.getSnapshot(profile.id);
      const focProject = focSnapshot.projects.find((item) => item.id === focAssignment.projectId);
      expect(focProject?.name).toBe("基于STM32F405的实时FOC电机控制系统");
      expect(focProject?.technologyStack).toEqual(expect.arrayContaining(["FOC", "SVPWM", "DMA"]));
      expect(focProject?.technologyStack).not.toContain("MQTT");
      expect(focSnapshot.facts?.filter((fact) => fact.projectId === focAssignment.projectId).every((fact) => fact.sourceIds.includes(foc.id))).toBe(true);
      expect(focSnapshot.facts?.some((fact) => fact.content.includes("Linux"))).toBe(false);
      expect(memories.listProjectSources(focAssignment.projectId as string).map((source) => source.sourceId)).toEqual([foc.id]);
      expect(memories.listFacts(profile.id, espAssignment.projectId)).toHaveLength(0);
      await service.rebuildProject(espAssignment.projectId as string);
      expect(memories.getSnapshot(profile.id).projects.some((project) => project.id === focAssignment.projectId)).toBe(true);
      expect(memories.getSnapshot(profile.id).projects.some((project) => project.id === espAssignment.projectId)).toBe(true);
      expect(memories.listProjectSources(focAssignment.projectId as string)[0]?.sourceRole).toBe("overview");
    } finally {
      database.close();
    }
  });

  it("persists a project with multiple bound sources without duplicate derived ids", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const knowledge = new SqliteKnowledgeRepository(database);
      const history = new SqliteInterviewHistoryRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const analyses = new SqliteKnowledgeAnalysisRepository(database);
      const base = knowledge.createKnowledgeBase("多来源项目资料");
      const profile = profiles.save({ name: "多来源测试", language: "zh-CN", skills: [], knowledgeBaseIds: [base.id] });
      const primary = knowledge.saveDocument({ id: "doc-primary", knowledgeBaseId: base.id, filename: "FOC.md", mimeType: "text/markdown", sha256: "primary", text: "项目背景：实时电机控制系统\n个人职责：负责控制固件\n技术栈：STM32F405、FOC、ADC、DMA\n## 核心模块\n- 电流环\n问题：低速抖动\n解决方案：增加观测器", sections: [], documentType: "project", status: "ready" });
      const supporting = knowledge.saveDocument({ id: "doc-supporting", knowledgeBaseId: base.id, filename: "FOC-notes.md", mimeType: "text/markdown", sha256: "supporting", text: "项目背景：实时电机控制系统补充说明\n个人职责：负责保护逻辑\n技术栈：CAN、UART\n## 核心模块\n- 保护状态机\n问题：通信超时\n解决方案：增加重试", sections: [], documentType: "technical-doc", status: "ready" });
      const project = memories.createProject(profile.id, "FOC");
      const service = new ProjectMemoryService(profiles, knowledge, history, memories, undefined, undefined, analyses);
      const assignment = service.assignDocument(profile.id, primary.id, project.id);
      expect(assignment.projectId).toBeTruthy();
      service.assignSource({ profileId: profile.id, projectId: assignment.projectId as string, sourceType: "document", sourceId: supporting.id, relationship: "supporting" });
      await expect(service.rebuildProject(assignment.projectId as string)).resolves.toBeTruthy();
      const snapshot = memories.getSnapshot(profile.id);
      expect(snapshot.modules.length).toBeGreaterThan(0);
      expect(new Set(snapshot.modules.map((item) => item.id)).size).toBe(snapshot.modules.length);
      expect(new Set(snapshot.technicalPoints.map((item) => item.id)).size).toBe(snapshot.technicalPoints.length);
      expect(new Set(snapshot.problems.map((item) => item.id)).size).toBe(snapshot.problems.length);
      expect(new Set(snapshot.interviewQuestions.map((item) => item.id)).size).toBe(snapshot.interviewQuestions.length);
    } finally {
      database.close();
    }
  });

  it("counts conflict groups and user actions instead of candidate facts", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const profile = profiles.save({ name: "V3 统计", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const project = memories.createProject(profile.id, "FOC");
      memories.assignSource({ projectId: project.id, sourceType: "document", sourceId: "doc", relationship: "primary", sourceRole: "overview", confidence: 1, verified: true });
      for (const [id, content] of [["f405", "STM32F405"], ["g431", "STM32G431"]] as const) memories.addCandidateFact({ id, projectId: project.id, profileId: profile.id, type: "hardware", title: "MCU", content, confidence: 1, verified: false, sourceIds: ["doc"], evidence: [{ sourceId: "doc", quote: content }], evidenceLevel: "confirmed-document", status: "conflicting", conflictStatus: "conflicting", conflictGroupId: `conflict:${project.id}:mcu.main` });
      const stats = memories.stats(profile.id, project.id);
      expect(stats.conflictingFacts).toBe(2);
      expect(stats.conflictGroups).toBe(1);
      expect(stats.userActions).toBe(1);
      expect(stats.userActionRequiredFacts).toBe(1);
    } finally { database.close(); }
  });

  it("requires variant context when keeping both conflict candidates", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const memories = new SqliteProjectMemoryRepository(database);
      const profile = profiles.save({ name: "V3 版本", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const project = memories.createProject(profile.id, "版本项目");
      memories.assignSource({ projectId: project.id, sourceType: "document", sourceId: "doc", relationship: "primary", sourceRole: "overview", confidence: 1, verified: true });
      for (const [id, content] of [["f405", "STM32F405"], ["g431", "STM32G431"]] as const) memories.addCandidateFact({ id, projectId: project.id, profileId: profile.id, type: "hardware", title: "MCU", content, confidence: 1, verified: false, sourceIds: ["doc"], evidence: [{ sourceId: "doc", quote: content }], evidenceLevel: "confirmed-document", status: "conflicting", conflictStatus: "conflicting", conflictGroupId: `conflict:${project.id}:mcu.main` });
      await expect(Promise.resolve().then(() => memories.resolveConflict(`conflict:${project.id}:mcu.main`, "f405", true))).rejects.toThrow("PROJECT_CONFLICT_VARIANT_CONTEXT_REQUIRED");
      memories.resolveConflict(`conflict:${project.id}:mcu.main`, "f405", true, { f405: "early-version", g431: "later-version" });
      expect(memories.stats(profile.id, project.id)).toMatchObject({ conflictGroups: 0, userActions: 0 });
      expect(memories.getFact("f405")).toMatchObject({ status: "active", conflictStatus: "confirmed", variantContext: "early-version" });
      expect(memories.getFact("g431")).toMatchObject({ status: "active", conflictStatus: "confirmed", variantContext: "later-version" });
      memories.repairProjectFactSemantics(project.id);
      expect(memories.stats(profile.id, project.id)).toMatchObject({ conflictGroups: 0, userActions: 0 });
      expect(memories.getFact("f405")).toMatchObject({ status: "active", conflictStatus: "confirmed", variantContext: "early-version" });
      expect(memories.getFact("g431")).toMatchObject({ status: "active", conflictStatus: "confirmed", variantContext: "later-version" });
    } finally { database.close(); }
  });
});
