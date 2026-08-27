import type { SqliteDatabase } from "../database";

function retrievalId(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RetrievalHitInput {
  resultType: "question" | "project-fact" | "project-understanding" | "document-chunk" | "job-requirement";
  resultId: string;
  score: number;
  verified?: boolean;
  preview: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievalRunRecord {
  id: string;
  interviewId?: string;
  questionId?: string;
  profileId?: string;
  query: string;
  route: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  hits: Array<RetrievalHitInput & { id: string; rank: number }>;
}

export class SqliteRetrievalRepository {
  constructor(private readonly database: SqliteDatabase) {}

  record(input: { query: string; route: string; profileId?: string; interviewId?: string; questionId?: string; metadata?: Record<string, unknown>; hits: RetrievalHitInput[]; now?: number }): RetrievalRunRecord {
    const now = input.now ?? Date.now();
    const runId = retrievalId("retrieval", now);
    this.database.run("INSERT INTO retrieval_runs(id, interview_id, question_id, profile_id, query, route, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [runId, input.interviewId ?? null, input.questionId ?? null, input.profileId ?? null, input.query, input.route, JSON.stringify(input.metadata ?? {}), now]);
    const hits = input.hits.slice(0, 20).map((hit, index) => {
      const hitId = retrievalId("retrieval-hit", now + index);
      this.database.run("INSERT INTO retrieval_hits(id, retrieval_run_id, result_type, result_id, rank, score, verified, preview, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [hitId, runId, hit.resultType, hit.resultId, index + 1, Math.max(0, Math.min(1, hit.score)), hit.verified ? 1 : 0, hit.preview.slice(0, 1_000), JSON.stringify(hit.metadata ?? {})]);
      return { ...hit, id: hitId, rank: index + 1 };
    });
    this.database.flush();
    return { id: runId, ...(input.interviewId ? { interviewId: input.interviewId } : {}), ...(input.questionId ? { questionId: input.questionId } : {}), ...(input.profileId ? { profileId: input.profileId } : {}), query: input.query, route: input.route, ...(input.metadata ? { metadata: input.metadata } : {}), createdAt: now, hits };
  }

  get(runId: string): RetrievalRunRecord | undefined {
    const row = this.database.first<{ id: string; interviewId: string | null; questionId: string | null; profileId: string | null; query: string; route: string; metadataJson: string; createdAt: number }>("SELECT id, interview_id AS interviewId, question_id AS questionId, profile_id AS profileId, query, route, metadata_json AS metadataJson, created_at AS createdAt FROM retrieval_runs WHERE id = ?", [runId]);
    if (!row) return undefined;
    const hits = this.database.all<Record<string, unknown>>("SELECT id, result_type AS resultType, result_id AS resultId, rank, score, verified, preview, metadata_json AS metadataJson FROM retrieval_hits WHERE retrieval_run_id = ? ORDER BY rank", [runId]).map((hit) => ({ id: String(hit.id), resultType: String(hit.resultType) as RetrievalHitInput["resultType"], resultId: String(hit.resultId), rank: Number(hit.rank), score: Number(hit.score), verified: Number(hit.verified) === 1, preview: String(hit.preview), metadata: JSON.parse(String(hit.metadataJson)) as Record<string, unknown> }));
    return { id: row.id, ...(row.interviewId ? { interviewId: row.interviewId } : {}), ...(row.questionId ? { questionId: row.questionId } : {}), ...(row.profileId ? { profileId: row.profileId } : {}), query: row.query, route: row.route, metadata: JSON.parse(row.metadataJson || "{}") as Record<string, unknown>, createdAt: row.createdAt, hits };
  }

  list(profileId: string, limit = 20): RetrievalRunRecord[] {
    return this.database.all<{ id: string }>("SELECT id FROM retrieval_runs WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?", [profileId, Math.max(1, Math.min(100, limit))]).map((row) => this.get(row.id)).filter((run): run is RetrievalRunRecord => Boolean(run));
  }
}
