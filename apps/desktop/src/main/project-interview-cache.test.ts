import { describe, expect, it } from "vitest";
import type { KnowledgeChunk, QuestionBankQuestionRecord } from "@interview-copilot/shared";
import { ProjectInterviewCache } from "./project-interview-cache";

function question(id: string, text: string): QuestionBankQuestionRecord {
  return { id, canonicalText: text, normalizedText: text.toLocaleLowerCase(), variants: [], type: "technical", bankType: "project", category: "project", scope: "project", projectId: "p1", difficulty: "medium", source: "manual", followUps: [], status: "active", confidence: 1, verified: true, stale: false, embedding: undefined, frequency: 0, mastery: 0, answerCards: [{ id: `${id}-answer`, questionId: id, content: "已确认答案", mode: "standard", keyPoints: [], sourceType: "manual", version: 1, verified: true, stale: false, createdAt: 1, updatedAt: 1 }], relations: [], skillIds: [], factIds: [], createdAt: 1, updatedAt: 1 };
}

const chunk: KnowledgeChunk = { id: "chunk-1", text: "支付项目使用 DMA 搬运采样数据。", metadata: { documentId: "doc-1", filename: "overview.md", documentType: "project" } };

describe("ProjectInterviewCache", () => {
  it("routes project QA and retrieves overview lexically without remote work", () => {
    const cache = new ProjectInterviewCache();
    cache.prepare({ profileId: "profile", projects: [{ id: "p1", name: "支付项目", aliases: ["支付"], questionBankIndex: [question("q1", "支付项目如何使用 DMA？")], questionAnswers: [], overviewChunks: [chunk] }] });
    expect(cache.routeProjectQuestion("支付项目如何使用 DMA？", "p1")?.level).toBe("strong");
    expect(cache.searchOverview("DMA 采样", "p1")).toEqual([chunk]);
  });

  it("gives session and confirmed link priority and leaves ambiguous names unresolved", () => {
    const cache = new ProjectInterviewCache();
    cache.prepare({ profileId: "profile", projects: [{ id: "p1", name: "支付", aliases: [], questionBankIndex: [], questionAnswers: [], overviewChunks: [] }, { id: "p2", name: "支付平台", aliases: [], questionBankIndex: [], questionAnswers: [], overviewChunks: [] }], resumeProjects: [{ id: "r1", name: "旧支付系统" }], links: [{ id: "l1", profileId: "profile", resumeHash: "h", resumeProjectId: "r1", projectId: "p2", source: "manual", confidence: 1, confirmed: true, createdAt: 1, updatedAt: 1 }] });
    expect(cache.resolveProject("旧支付系统如何做？").projectId).toBe("p2");
    expect(cache.resolveProject("支付平台怎么做？").ambiguous).toBe(true);
    expect(cache.resolveProject("任意问题", { explicitProjectId: "p1" }).reason).toBe("session");
  });
});
