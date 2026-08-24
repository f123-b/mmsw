import { describe, expect, it } from "vitest";
import { SqliteDatabase, SqliteInterviewHistoryRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectMemoryRepository } from "./database";
import { ProjectMemoryService } from "./project-memory";

describe("ProjectMemoryService project isolation", () => {
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
      const interview = history.createInterview({ profileId: profile.id, startedAt: 1, status: "ended", language: "zh-CN", automationMode: "AUTO" }, 1);
      const question = history.addQuestion({ interviewId: interview.id, text: "你做过什么？", confidence: "high", source: "rules", detectedAt: 2, status: "confirmed" });
      history.addAnswer({ questionId: question.id, text: "我还做过 Linux 和 MQTT 项目", model: "mock", createdAt: 3 });
      const service = new ProjectMemoryService(profiles, knowledge, history, memories, undefined, undefined, analyses);
      const focAssignment = service.assignDocument(profile.id, foc.id);
      const espAssignment = service.assignDocument(profile.id, esp.id);
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
    } finally {
      database.close();
    }
  });
});
