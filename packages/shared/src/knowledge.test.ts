import { describe, expect, it } from "vitest";
import { chunkText, DocumentMemoryCache, DocumentParserRegistry, HybridRetriever, inferKnowledgeDocumentType, plainTextDocumentParser } from "./knowledge";

describe("knowledge preparation", () => {
  it("chunks long text with bounded size and overlap", () => {
    const text = Array.from({ length: 4_000 }, (_, index) => `token${index}`).join(" ");
    const chunks = chunkText(text, { documentId: "doc-1", filename: "notes.md" }, { maxTokens: 500, overlapTokens: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 2_000)).toBe(true);
    expect(chunks[0]?.metadata.filename).toBe("notes.md");
  });

  it("parses and caches the same document by sha256", async () => {
    const registry = new DocumentParserRegistry().register(["text/plain", "text/markdown"], plainTextDocumentParser);
    const cache = new DocumentMemoryCache();
    const input = { documentId: "doc-1", filename: "notes.md", mimeType: "text/markdown", sha256: "abc", bytes: new TextEncoder().encode("# Heading\n\ncontent") };
    const first = await cache.getOrParse(input, registry);
    const second = await cache.getOrParse({ ...input, bytes: new TextEncoder().encode("different") }, registry);
    expect(second).toBe(first);
    expect(first.sections[0]).toBe("Heading");
  });

  it("infers common interview document categories", () => {
    expect(inferKnowledgeDocumentType("嵌入式简历.pdf", "教育经历\n项目经历\n求职方向")).toBe("resume");
    expect(inferKnowledgeDocumentType("FOC项目说明.md", "项目目标\n技术栈\n项目职责")).toBe("project");
    expect(inferKnowledgeDocumentType("嵌入式面试题.md", "面试官：请解释一下中断和任务的区别？")).toBe("interview-question");
    expect(inferKnowledgeDocumentType("FreeRTOS技能卡.md", "技能知识\n任务通知\n工作原理")).toBe("skill");
    expect(inferKnowledgeDocumentType("foc2-codex-foc-studio-submit.zip", "文件：README.md\nFOC")).toBe("project");
  });
});

describe("hybrid retrieval", () => {
  it("combines keyword and vector signals and returns top-k", () => {
    const chunks = [
      { id: "1", text: "Clarke Park 变换与 FOC 电流采样", metadata: { documentId: "d", filename: "f" }, embedding: [1, 0] },
      { id: "2", text: "Linux 进程调度", metadata: { documentId: "d", filename: "f" }, embedding: [0, 1] }
    ];
    const results = new HybridRetriever().search("FOC 电流采样", chunks, { topK: 1, embeddingProvider: { embed: () => [1, 0] } });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("1");
    expect(results[0]?.keywordScore).toBeGreaterThan(0);
  });

  it("uses MMR-style diversity when nearby chunks repeat the same passage", () => {
    const chunks = [
      { id: "near-1", text: "中断服务程序要短，避免阻塞", metadata: { documentId: "d1", filename: "a" } },
      { id: "near-2", text: "中断服务程序应当快速返回，避免阻塞任务", metadata: { documentId: "d1", filename: "a" } },
      { id: "other", text: "通过消息队列把工作交给任务上下文", metadata: { documentId: "d2", filename: "b" } }
    ];
    const results = new HybridRetriever().search("中断 任务 消息 队列", chunks, { topK: 2 });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.metadata.documentId)).size).toBe(2);
  });
});
