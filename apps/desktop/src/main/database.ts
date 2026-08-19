import initSqlJs, { type SqlJsStatic } from "sql.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createProfile,
  type InterviewRecord,
  type InterviewSnapshot,
  type InterviewStatus,
  type Profile,
  type ProfileInput,
  type QuestionRecord,
  type AnswerRecord,
  type TranscriptRecord,
  type KnowledgeChunk
} from "@interview-copilot/shared";

export const APP_DATA_DIRECTORY = "InterviewCopilot";

function id(prefix: string, now: number): string { return `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`; }

function wasmCandidates(): string[] {
  const resourcesPath = process.resourcesPath ?? process.cwd();
  return [
    join(resourcesPath, "sql.js", "sql-wasm.wasm"),
    join(__dirname, "../../../node_modules/sql.js/dist/sql-wasm.wasm"),
    join(process.cwd(), "node_modules/sql.js/dist/sql-wasm.wasm")
  ];
}

function value<T>(input: unknown): T | undefined {
  return input === null || input === undefined ? undefined : input as T;
}

export class SqliteDatabase {
  private dirty = false;
  private flushTimer: NodeJS.Timeout | undefined;

  private constructor(private readonly filePath: string, private readonly database: InstanceType<SqlJsStatic["Database"]>) {}

  static async open(filePath: string, wasmPath = wasmCandidates().find((candidate) => existsSync(candidate))): Promise<SqliteDatabase> {
    if (filePath !== ":memory:") await mkdir(dirname(filePath), { recursive: true });
    const SQL: SqlJsStatic = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : undefined);
    const bytes = filePath !== ":memory:" && existsSync(filePath) ? readFileSync(filePath) : undefined;
    const database = new SQL.Database(bytes);
    const store = new SqliteDatabase(filePath, database);
    store.migrate();
    store.flushNow();
    return store;
  }

  run(sql: string, params: Array<string | number | Uint8Array | null> = []): void {
    this.database.run(sql, params);
    this.markDirty();
  }

  all<T extends object>(sql: string, params: Array<string | number | Uint8Array | null> = []): T[] {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  first<T extends object>(sql: string, params: Array<string | number | Uint8Array | null> = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  markDirty(): void { this.dirty = true; }

  flush(): void {
    if (this.filePath === ":memory:" || !this.dirty || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushNow();
    }, 500);
    this.flushTimer.unref?.();
  }

  flushNow(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.filePath === ":memory:" || !this.dirty) return;
    writeFileSync(this.filePath, this.database.export());
    this.dirty = false;
  }

  close(): void {
    this.flushNow();
    this.database.close();
  }

  private migrate(): void {
    this.database.run("PRAGMA foreign_keys = ON");
    this.database.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const current = Number(this.database.exec("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")[0]?.values[0]?.[0] ?? 0);
    const migrations: Array<[number, string]> = [
      [1, `
        CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL, resume_json TEXT, job_description_json TEXT, instructions TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS profile_knowledge (profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, knowledge_base_id TEXT NOT NULL, PRIMARY KEY(profile_id, knowledge_base_id));
        CREATE TABLE IF NOT EXISTS interviews (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL, language TEXT NOT NULL, automation_mode TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS transcripts (id TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE, source TEXT NOT NULL, text TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, final INTEGER NOT NULL, confidence REAL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE, text TEXT NOT NULL, confidence TEXT NOT NULL, source TEXT NOT NULL, detected_at INTEGER NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE, text TEXT NOT NULL, model TEXT NOT NULL, mode TEXT, latency_first_token INTEGER, latency_total INTEGER, cancel_reason TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `],
      [2, `
        CREATE TABLE IF NOT EXISTS knowledge_bases (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE, filename TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL, text TEXT NOT NULL, sections_json TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, text TEXT NOT NULL, metadata_json TEXT NOT NULL, embedding_json TEXT, created_at INTEGER NOT NULL);
      `],
      [3, `
        ALTER TABLE answers ADD COLUMN started_at INTEGER;
        ALTER TABLE answers ADD COLUMN first_token_at INTEGER;
        ALTER TABLE answers ADD COLUMN finished_at INTEGER;
      `],
      [4, `
        CREATE TABLE IF NOT EXISTS interview_analysis (interview_id TEXT PRIMARY KEY REFERENCES interviews(id) ON DELETE CASCADE, analysis_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      `]
    ];
    for (const [version, sql] of migrations) {
      if (version <= current) continue;
      this.database.run("BEGIN");
      try {
        this.database.run(sql);
        this.database.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", [version, Date.now()]);
        this.database.run("COMMIT");
      } catch (error) {
        this.database.run("ROLLBACK");
        throw error;
      }
    }
  }
}

export async function openAppDatabase(appDataPath: string): Promise<SqliteDatabase> {
  const directory = join(appDataPath, APP_DATA_DIRECTORY);
  await mkdir(directory, { recursive: true });
  return SqliteDatabase.open(join(directory, "interview-copilot.sqlite"));
}

export class SqliteProfileRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(): Profile[] {
    return this.database.all<{ id: string; name: string; language: string; resume_json: string | null; job_description_json: string | null; instructions: string | null; created_at: number; updated_at: number }>("SELECT * FROM profiles ORDER BY updated_at DESC").map((row) => this.hydrate(row));
  }

  get(profileId: string): Profile | undefined {
    const row = this.database.first<{ id: string; name: string; language: string; resume_json: string | null; job_description_json: string | null; instructions: string | null; created_at: number; updated_at: number }>("SELECT * FROM profiles WHERE id = ?", [profileId]);
    return row ? this.hydrate(row) : undefined;
  }

  save(input: Profile | ProfileInput, now = Date.now()): Profile {
    const existing = "id" in input ? input : undefined;
    const profile = existing ? { ...existing, updatedAt: now } : createProfile(input, now);
    this.database.run("INSERT INTO profiles(id, name, language, resume_json, job_description_json, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, language=excluded.language, resume_json=excluded.resume_json, job_description_json=excluded.job_description_json, instructions=excluded.instructions, updated_at=excluded.updated_at", [profile.id, profile.name, profile.language, profile.resume ? JSON.stringify(profile.resume) : null, profile.jobDescription ? JSON.stringify(profile.jobDescription) : null, profile.instructions ?? null, profile.createdAt, profile.updatedAt]);
    this.database.run("DELETE FROM skills WHERE profile_id = ?", [profile.id]);
    profile.skills.forEach((skill) => this.database.run("INSERT INTO skills(id, profile_id, name, description, content, tags_json) VALUES (?, ?, ?, ?, ?, ?)", [skill.id, profile.id, skill.name, skill.description, skill.content, JSON.stringify(skill.tags)]));
    this.database.run("DELETE FROM profile_knowledge WHERE profile_id = ?", [profile.id]);
    profile.knowledgeBaseIds.forEach((knowledgeBaseId) => this.database.run("INSERT INTO profile_knowledge(profile_id, knowledge_base_id) VALUES (?, ?)", [profile.id, knowledgeBaseId]));
    this.database.flush();
    return this.get(profile.id) as Profile;
  }

  delete(profileId: string): void {
    this.database.run("DELETE FROM profiles WHERE id = ?", [profileId]);
    this.database.run("DELETE FROM app_state WHERE key = 'active_profile_id' AND value = ?", [profileId]);
    this.database.flushNow();
  }

  clone(profileId: string, name: string, now = Date.now()): Profile {
    const source = this.get(profileId);
    if (!source) throw new Error(`Profile not found: ${profileId}`);
    return this.save({ ...source, id: id("profile", now), name: name.trim() || `${source.name} copy`, createdAt: now, updatedAt: now }, now);
  }

  setActive(profileId: string): Profile {
    const profile = this.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    this.database.run("INSERT INTO app_state(key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [profileId]);
    this.database.flushNow();
    return profile;
  }

  active(): Profile | undefined {
    const idRow = this.database.first<{ value: string }>("SELECT value FROM app_state WHERE key = 'active_profile_id'");
    return idRow ? this.get(idRow.value) : this.list()[0];
  }

  private hydrate(row: { id: string; name: string; language: string; resume_json: string | null; job_description_json: string | null; instructions: string | null; created_at: number; updated_at: number }): Profile {
    const skills = this.database.all<{ id: string; name: string; description: string; content: string; tags_json: string }>("SELECT id, name, description, content, tags_json FROM skills WHERE profile_id = ? ORDER BY name", [row.id]).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, content: skill.content, tags: JSON.parse(skill.tags_json) as string[] }));
    const knowledgeBaseIds = this.database.all<{ knowledge_base_id: string }>("SELECT knowledge_base_id FROM profile_knowledge WHERE profile_id = ?", [row.id]).map((item) => item.knowledge_base_id);
    return { id: row.id, name: row.name, language: row.language, resume: row.resume_json ? JSON.parse(row.resume_json) : undefined, jobDescription: row.job_description_json ? JSON.parse(row.job_description_json) : undefined, instructions: value<string>(row.instructions), skills, knowledgeBaseIds, createdAt: row.created_at, updatedAt: row.updated_at };
  }
}

export class SqliteInterviewHistoryRepository {
  constructor(private readonly database: SqliteDatabase) {}

  createInterview(input: Omit<InterviewRecord, "id" | "createdAt">, now = Date.now()): InterviewRecord {
    const record = { ...input, id: id("interview", now), createdAt: now };
    this.database.run("INSERT INTO interviews(id, profile_id, started_at, ended_at, status, language, automation_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.profileId, record.startedAt, record.endedAt ?? null, record.status, record.language, record.automationMode, record.createdAt]);
    this.database.flushNow();
    return record;
  }

  endInterview(interviewId: string, status: "ended" | "error" = "ended", endedAt = Date.now()): InterviewRecord {
    this.database.run("UPDATE interviews SET status = ?, ended_at = ? WHERE id = ?", [status, endedAt, interviewId]);
    this.database.flushNow();
    const record = this.database.first<InterviewRecord>("SELECT id, profile_id AS profileId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews WHERE id = ?", [interviewId]);
    if (!record) throw new Error(`Interview not found: ${interviewId}`);
    return record;
  }

  addTranscript(input: Omit<TranscriptRecord, "id" | "createdAt">, now = Date.now()): TranscriptRecord | undefined {
    if (!input.final) return undefined;
    const record = { ...input, id: id("transcript", now), createdAt: now };
    this.database.run("INSERT INTO transcripts(id, interview_id, source, text, start_ms, end_ms, final, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.interviewId, record.source, record.text, record.startMs, record.endMs, 1, record.confidence ?? null, record.createdAt]);
    this.database.flush();
    return record;
  }

  addQuestion(input: Omit<QuestionRecord, "id">): QuestionRecord {
    const record = { ...input, id: id("question", input.detectedAt) };
    this.database.run("INSERT INTO questions(id, interview_id, text, confidence, source, detected_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)", [record.id, record.interviewId, record.text, record.confidence, record.source, record.detectedAt, record.status]);
    this.database.flush();
    return record;
  }

  updateQuestionStatus(questionId: string, status: QuestionRecord["status"]): QuestionRecord | undefined {
    this.database.run("UPDATE questions SET status = ? WHERE id = ?", [status, questionId]);
    this.database.flushNow();
    return this.database.first<QuestionRecord>("SELECT id, interview_id AS interviewId, text, confidence, source, detected_at AS detectedAt, status FROM questions WHERE id = ?", [questionId]);
  }

  addAnswer(input: Omit<AnswerRecord, "id">): AnswerRecord {
    const record = { ...input, id: id("answer", input.createdAt) };
    this.database.run("INSERT INTO answers(id, question_id, text, model, mode, latency_first_token, latency_total, cancel_reason, started_at, first_token_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.questionId, record.text, record.model, record.mode ?? null, record.latencyFirstToken ?? null, record.latencyTotal ?? null, record.cancelReason ?? null, record.startedAt ?? null, record.firstTokenAt ?? null, record.finishedAt ?? null, record.createdAt]);
    this.database.flushNow();
    return record;
  }

  listInterviews(): InterviewRecord[] {
    return this.database.all<InterviewRecord>("SELECT id, profile_id AS profileId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews ORDER BY created_at DESC");
  }

  deleteInterview(interviewId: string): void {
    this.database.run("DELETE FROM interviews WHERE id = ?", [interviewId]);
    this.database.flushNow();
  }

  saveAnalysis(interviewId: string, analysis: unknown, now = Date.now()): void {
    this.database.run("INSERT INTO interview_analysis(interview_id, analysis_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(interview_id) DO UPDATE SET analysis_json=excluded.analysis_json, updated_at=excluded.updated_at", [interviewId, JSON.stringify(analysis), now]);
    this.database.flushNow();
  }

  getAnalysis<T = unknown>(interviewId: string): T | undefined {
    const row = this.database.first<{ analysisJson: string }>("SELECT analysis_json AS analysisJson FROM interview_analysis WHERE interview_id = ?", [interviewId]);
    return row ? JSON.parse(row.analysisJson) as T : undefined;
  }

  snapshot(interviewId: string): InterviewSnapshot {
    const interview = this.database.first<InterviewRecord>("SELECT id, profile_id AS profileId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews WHERE id = ?", [interviewId]);
    if (!interview) throw new Error(`Interview not found: ${interviewId}`);
    const transcripts = this.database.all<TranscriptRecord>("SELECT id, interview_id AS interviewId, source, text, start_ms AS startMs, end_ms AS endMs, final, confidence, created_at AS createdAt FROM transcripts WHERE interview_id = ? ORDER BY start_ms", [interviewId]);
    const questions = this.database.all<QuestionRecord>("SELECT id, interview_id AS interviewId, text, confidence, source, detected_at AS detectedAt, status FROM questions WHERE interview_id = ? ORDER BY detected_at", [interviewId]);
    const answers = this.database.all<AnswerRecord>("SELECT a.id, a.question_id AS questionId, a.text, a.model, a.mode, a.latency_first_token AS latencyFirstToken, a.latency_total AS latencyTotal, a.cancel_reason AS cancelReason, a.started_at AS startedAt, a.first_token_at AS firstTokenAt, a.finished_at AS finishedAt, a.created_at AS createdAt FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.interview_id = ? ORDER BY a.created_at", [interviewId]);
    return { interview, transcripts, questions, answers };
  }
}

export interface KnowledgeBaseRecord { id: string; name: string; createdAt: number; updatedAt: number; }
export interface KnowledgeDocumentRecord { id: string; knowledgeBaseId: string; filename: string; mimeType: string; sha256: string; text: string; sections: string[]; status: "processing" | "ready" | "error"; error?: string; createdAt: number; updatedAt: number; }

export class SqliteKnowledgeRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listKnowledgeBases(): KnowledgeBaseRecord[] {
    return this.database.all<KnowledgeBaseRecord>("SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM knowledge_bases ORDER BY updated_at DESC");
  }

  createKnowledgeBase(name: string, now = Date.now()): KnowledgeBaseRecord {
    const record = { id: id("knowledge-base", now), name: name.trim() || "默认知识库", createdAt: now, updatedAt: now };
    this.database.run("INSERT INTO knowledge_bases(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [record.id, record.name, record.createdAt, record.updatedAt]);
    this.database.flushNow();
    return record;
  }

  renameKnowledgeBase(knowledgeBaseId: string, name: string, now = Date.now()): KnowledgeBaseRecord | undefined {
    this.database.run("UPDATE knowledge_bases SET name = ?, updated_at = ? WHERE id = ?", [name.trim() || "默认知识库", now, knowledgeBaseId]);
    this.database.flushNow();
    return this.listKnowledgeBases().find((base) => base.id === knowledgeBaseId);
  }

  deleteKnowledgeBase(knowledgeBaseId: string): void {
    this.database.run("DELETE FROM knowledge_bases WHERE id = ?", [knowledgeBaseId]);
    this.database.flushNow();
  }

  ensureKnowledgeBase(name = "默认知识库"): KnowledgeBaseRecord {
    return this.listKnowledgeBases()[0] ?? this.createKnowledgeBase(name);
  }

  listDocuments(knowledgeBaseId?: string): KnowledgeDocumentRecord[] {
    const sql = "SELECT id, knowledge_base_id AS knowledgeBaseId, filename, mime_type AS mimeType, sha256, text, sections_json AS sectionsJson, status, error, created_at AS createdAt, updated_at AS updatedAt FROM documents";
    const rows = knowledgeBaseId ? this.database.all<Record<string, unknown>>(`${sql} WHERE knowledge_base_id = ? ORDER BY updated_at DESC`, [knowledgeBaseId]) : this.database.all<Record<string, unknown>>(`${sql} ORDER BY updated_at DESC`);
    return rows.map((row) => this.hydrateDocument(row));
  }

  getDocument(documentId: string): KnowledgeDocumentRecord | undefined {
    return this.listDocuments().find((document) => document.id === documentId);
  }

  deleteDocument(documentId: string): void {
    this.database.run("DELETE FROM documents WHERE id = ?", [documentId]);
    this.database.flushNow();
  }

  saveDocument(document: { id: string; knowledgeBaseId: string; filename: string; mimeType: string; sha256: string; text: string; sections: string[]; status: "processing" | "ready" | "error"; error?: string }, now = Date.now()): KnowledgeDocumentRecord {
    this.database.run("INSERT INTO documents(id, knowledge_base_id, filename, mime_type, sha256, text, sections_json, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, sha256=excluded.sha256, text=excluded.text, sections_json=excluded.sections_json, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at", [document.id, document.knowledgeBaseId, document.filename, document.mimeType, document.sha256, document.text, JSON.stringify(document.sections), document.status, document.error ?? null, now, now]);
    this.database.flushNow();
    return this.listDocuments(document.knowledgeBaseId).find((item) => item.id === document.id) as KnowledgeDocumentRecord;
  }

  replaceChunks(documentId: string, chunks: KnowledgeChunk[], now = Date.now()): void {
    this.database.run("DELETE FROM knowledge_chunks WHERE document_id = ?", [documentId]);
    chunks.forEach((chunk) => this.database.run("INSERT INTO knowledge_chunks(id, document_id, text, metadata_json, embedding_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [chunk.id, documentId, chunk.text, JSON.stringify(chunk.metadata), chunk.embedding ? JSON.stringify(chunk.embedding) : null, now]));
    this.database.flushNow();
  }

  listChunks(knowledgeBaseIds: string[] = []): KnowledgeChunk[] {
    if (knowledgeBaseIds.length === 0) return [];
    const placeholders = knowledgeBaseIds.map(() => "?").join(",");
    return this.database.all<{ id: string; text: string; metadataJson: string; embeddingJson: string | null }>(`SELECT c.id, c.text, c.metadata_json AS metadataJson, c.embedding_json AS embeddingJson FROM knowledge_chunks c JOIN documents d ON d.id = c.document_id WHERE d.knowledge_base_id IN (${placeholders}) AND d.status = 'ready'`, knowledgeBaseIds).map((row) => ({ id: row.id, text: row.text, metadata: JSON.parse(row.metadataJson), ...(row.embeddingJson ? { embedding: JSON.parse(row.embeddingJson) as number[] } : {}) }));
  }

  private hydrateDocument(row: Record<string, unknown>): KnowledgeDocumentRecord {
    return { id: String(row.id), knowledgeBaseId: String(row.knowledgeBaseId), filename: String(row.filename), mimeType: String(row.mimeType), sha256: String(row.sha256), text: String(row.text), sections: JSON.parse(String(row.sectionsJson)) as string[], status: row.status as KnowledgeDocumentRecord["status"], ...(row.error ? { error: String(row.error) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }
}
