import { describe, expect, it } from "vitest";
import { chunkText, DocumentMemoryCache, DocumentParserRegistry, HybridRetriever, plainTextDocumentParser } from "./knowledge";

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
});
