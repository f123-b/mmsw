export interface DocumentMetadata {
  documentId: string;
  filename: string;
  section?: string;
  page?: number;
}

export interface ParsedDocument {
  documentId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  text: string;
  sections: string[];
}

export interface KnowledgeChunk {
  id: string;
  text: string;
  metadata: DocumentMetadata;
  embedding?: number[];
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

const TOKEN_CHARS = 4;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / TOKEN_CHARS));
}

export function chunkText(text: string, metadata: DocumentMetadata, options: ChunkOptions = {}): KnowledgeChunk[] {
  const maxTokens = options.maxTokens ?? 800;
  const overlapTokens = Math.min(options.overlapTokens ?? 120, maxTokens - 1);
  const maxChars = maxTokens * TOKEN_CHARS;
  const overlapChars = overlapTokens * TOKEN_CHARS;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  let index = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > start + maxChars * 0.5) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push({ id: `${metadata.documentId}-chunk-${index++}`, text: chunk, metadata: { ...metadata } });
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

export interface DocumentParser {
  parse(input: { filename: string; mimeType: string; bytes: Uint8Array }): Promise<{ text: string; sections?: string[] }>;
}

export class DocumentParserRegistry implements DocumentParser {
  private readonly parsers = new Map<string, DocumentParser>();

  register(mimeTypes: string | string[], parser: DocumentParser): this {
    for (const mimeType of Array.isArray(mimeTypes) ? mimeTypes : [mimeTypes]) this.parsers.set(mimeType, parser);
    return this;
  }

  async parse(input: { filename: string; mimeType: string; bytes: Uint8Array }): Promise<{ text: string; sections?: string[] }> {
    const parser = this.parsers.get(input.mimeType) ?? this.parsers.get("*");
    if (!parser) throw new Error(`No document parser registered for ${input.mimeType}`);
    return parser.parse(input);
  }
}

export const plainTextDocumentParser: DocumentParser = {
  async parse(input) {
    const text = new TextDecoder().decode(input.bytes).replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return { text, sections: text.split(/\n(?=#{1,6}\s)|(?=#{1,6}\s)/).filter(Boolean).map((section) => (section.split("\n", 1)[0] ?? "").replace(/^#{1,6}\s+/, "").trim()) };
  }
};

export class DocumentMemoryCache {
  private readonly values = new Map<string, ParsedDocument>();

  get(sha256: string): ParsedDocument | undefined { return this.values.get(sha256); }

  async getOrParse(input: { documentId: string; filename: string; mimeType: string; sha256: string; bytes: Uint8Array }, parser: DocumentParser): Promise<ParsedDocument> {
    const cached = this.values.get(input.sha256);
    if (cached) return cached;
    const parsed = await parser.parse(input);
    const document = { ...input, text: parsed.text, sections: parsed.sections ?? [] };
    this.values.set(input.sha256, document);
    return document;
  }
}

export interface EmbeddingProvider {
  embed(text: string): number[];
}

export interface Reranker {
  score(query: string, chunk: KnowledgeChunk): number;
}

function keywordScore(query: string, text: string): number {
  const queryTerms = query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean);
  if (queryTerms.length === 0) return 0;
  const normalized = text.toLowerCase();
  return queryTerms.filter((term) => normalized.includes(term)).length / queryTerms.length;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export interface RetrievalResult extends KnowledgeChunk {
  score: number;
  keywordScore: number;
  vectorScore: number;
}

export class HybridRetriever {
  search(query: string, chunks: KnowledgeChunk[], options: { topK?: number; embeddingProvider?: EmbeddingProvider; reranker?: Reranker } = {}): RetrievalResult[] {
    const queryEmbedding = options.embeddingProvider?.embed(query);
    return chunks
      .map((chunk) => {
        const keywords = keywordScore(query, chunk.text);
        const vector = queryEmbedding && chunk.embedding ? Math.max(0, cosineSimilarity(queryEmbedding, chunk.embedding)) : 0;
        const baseScore = queryEmbedding && chunk.embedding ? vector * 0.65 + keywords * 0.35 : keywords;
        const score = options.reranker ? options.reranker.score(query, chunk) * 0.5 + baseScore * 0.5 : baseScore;
        return { ...chunk, score, keywordScore: keywords, vectorScore: vector };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.topK ?? 6);
  }
}
