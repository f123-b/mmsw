import { normalizeTechnicalTerms } from "./terminology";

export const KNOWLEDGE_DOCUMENT_TYPES = ["resume", "project", "interview-question", "skill", "job-description", "technical-doc", "other"] as const;
export type KnowledgeDocumentType = typeof KNOWLEDGE_DOCUMENT_TYPES[number];
export type KnowledgeDocumentTypeOption = KnowledgeDocumentType | "auto";

export const KNOWLEDGE_DOCUMENT_TYPE_LABELS: Record<KnowledgeDocumentType, string> = {
  resume: "简历",
  project: "项目经历",
  "interview-question": "面试题",
  skill: "技能知识",
  "job-description": "岗位 JD",
  "technical-doc": "技术文档",
  other: "其他"
};

/** Infer a document category for the upload flow; users can always override it. */
export function inferKnowledgeDocumentType(filename: string, text: string): KnowledgeDocumentType {
  const name = filename.toLowerCase();
  if (/\.zip$|github|repository|repo/.test(name)) return "project";
  const content = text.toLowerCase();
  if (/简历|resume|cv/.test(name) || /求职方向|教育经历|工作经历|项目经历/.test(content)) return "resume";
  if (/岗位|职位|jd|job-description|招聘/.test(name) || /任职要求|岗位职责|职位描述/.test(content)) return "job-description";
  if (/面试题|题库|question|q&a|问答/.test(name) || /面试官|请解释一下|常见问题|参考答案/.test(content)) return "interview-question";
  if (/技能|skill|knowledge|知识点/.test(name) || /技能要求|知识点|基础概念|工作原理/.test(content)) return "skill";
  if (/项目|project|foc|rk3506/.test(name) || /项目背景|项目目标|项目职责|技术栈|系统架构/.test(content)) return "project";
  if (/技术|architecture|design|spec|api|doc/.test(name) || /系统设计|接口说明|技术方案|实现原理/.test(content)) return "technical-doc";
  return "other";
}

export interface DocumentMetadata {
  documentId: string;
  filename: string;
  documentType?: KnowledgeDocumentType;
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
  const normalized = normalizeTechnicalTerms(text.replace(/\r\n/g, "\n"));
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
    return { text, sections: text.split(/\n(?=#{1,6}\s)/).filter(Boolean).map((section) => (section.split("\n", 1)[0] ?? "").replace(/^#{1,6}\s+/, "").trim()) };
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

export interface KnowledgeRetriever {
  search(query: string): Promise<RetrievalResult[]>;
}

export interface AsyncEmbeddingProvider {
  embed(text: string): number[] | Promise<number[]>;
}

export interface KnowledgeRetrieverOptions {
  chunks: KnowledgeChunk[];
  embeddingProvider?: AsyncEmbeddingProvider;
  reranker?: Reranker;
  candidateK?: number;
  topK?: number;
}

function keywordScore(query: string, text: string): number {
  const queryTerms = query.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/gi) ?? [];
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

function textSimilarity(left: string, right: string): number {
  const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/gi) ?? []);
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

export interface RetrievalResult extends KnowledgeChunk {
  score: number;
  keywordScore: number;
  vectorScore: number;
}

export class HybridRetriever {
  search(query: string, chunks: KnowledgeChunk[], options: { topK?: number; candidateK?: number; embeddingProvider?: EmbeddingProvider; reranker?: Reranker } = {}): RetrievalResult[] {
    const queryEmbedding = options.embeddingProvider?.embed(query);
    const scored = chunks
      .map((chunk) => {
        const keywords = keywordScore(query, chunk.text);
        const vector = queryEmbedding && chunk.embedding ? Math.max(0, cosineSimilarity(queryEmbedding, chunk.embedding)) : 0;
        const baseScore = queryEmbedding && chunk.embedding ? vector * 0.65 + keywords * 0.35 : keywords;
        const score = options.reranker ? options.reranker.score(query, chunk) * 0.5 + baseScore * 0.5 : baseScore;
        return { ...chunk, score, keywordScore: keywords, vectorScore: vector };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, options.candidateK ?? Math.max(16, (options.topK ?? 6) * 3));
    const selected: RetrievalResult[] = [];
    const topK = options.topK ?? 6;
    while (selected.length < topK && scored.length > 0) {
      let bestIndex = 0;
      let bestValue = Number.NEGATIVE_INFINITY;
      scored.forEach((candidate, index) => {
        const redundancy = selected.reduce((maximum, previous) => Math.max(maximum, textSimilarity(candidate.text, previous.text)), 0);
        const diversityValue = candidate.score * 0.78 - redundancy * 0.22;
        if (diversityValue > bestValue) { bestValue = diversityValue; bestIndex = index; }
      });
      selected.push(scored.splice(bestIndex, 1)[0]);
    }
    return selected;
  }
}

/** Async retrieval facade: embedding/keyword candidates -> reranker -> final top K. */
export class HybridKnowledgeRetriever implements KnowledgeRetriever {
  private readonly hybrid = new HybridRetriever();

  constructor(private readonly options: KnowledgeRetrieverOptions) {}

  async search(query: string): Promise<RetrievalResult[]> {
    const queryEmbedding = this.options.embeddingProvider ? await this.options.embeddingProvider.embed(query) : undefined;
    const candidates = this.hybrid.search(query, this.options.chunks, {
      candidateK: this.options.candidateK ?? 20,
      topK: this.options.candidateK ?? 20,
      embeddingProvider: queryEmbedding ? { embed: () => queryEmbedding } : undefined
    });
    const reranker = this.options.reranker ?? new KeywordReranker();
    return candidates
      .map((candidate) => ({ ...candidate, score: candidate.score * 0.4 + reranker.score(query, candidate) * 0.6 }))
      .sort((left, right) => right.score - left.score)
      .slice(0, this.options.topK ?? 5);
  }
}

export class KeywordReranker implements Reranker {
  score(query: string, chunk: KnowledgeChunk): number {
    return keywordScore(query, `${chunk.metadata.filename} ${chunk.metadata.section || ""} ${chunk.text}`);
  }
}
