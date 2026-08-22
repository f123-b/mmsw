import initSqlJs, { type SqlJsStatic } from "sql.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createProfile,
  QUESTION_BANK_TYPES,
  type InterviewRecord,
  type InterviewSnapshot,
  type InterviewStatus,
  type Profile,
  type ProfileInput,
  type QuestionRecord,
  type AnswerRecord,
  type TranscriptRecord,
  type KnowledgeChunk,
  inferKnowledgeDocumentType,
  type KnowledgeDocumentType,
  type ProfileBuilderOutput,
  inferQuestionBankType,
  normalizeQuestionBankText,
  parseQuestionBankText,
  questionBankSimilarity,
  type QuestionBankAnswerCardRecord,
  type QuestionBankAnswerMode,
  type QuestionBankJobProfileRecord,
  type QuestionBankMatch,
  type QuestionBankQuestionRecord,
  type QuestionBankSkillPointRecord,
  type QuestionBankSkillRecord,
  type QuestionBankSourceType,
  type QuestionBankType
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
      `],
      [5, `
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS conversation_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations(updated_at DESC);
        CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx ON conversation_messages(conversation_id, created_at);
      `],
      [6, `
        CREATE TABLE IF NOT EXISTS profile_builder_artifacts (profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, version INTEGER NOT NULL, status TEXT NOT NULL, source_snapshot_json TEXT NOT NULL, artifact_json TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS profile_builder_artifacts_updated_at_idx ON profile_builder_artifacts(updated_at DESC);
      `],
      [7, `
        ALTER TABLE documents ADD COLUMN document_type TEXT NOT NULL DEFAULT 'other';
        CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(knowledge_base_id, document_type, updated_at DESC);
      `],
      [8, `
        CREATE TABLE IF NOT EXISTS question_bank_questions (
          id TEXT PRIMARY KEY,
          canonical_text TEXT NOT NULL,
          normalized_text TEXT NOT NULL,
          type TEXT NOT NULL,
          difficulty TEXT NOT NULL DEFAULT 'medium',
          job_role TEXT,
          source TEXT NOT NULL DEFAULT 'manual',
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS question_bank_variants (
          id TEXT PRIMARY KEY,
          question_id TEXT NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          normalized_text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS question_bank_answer_cards (
          id TEXT PRIMARY KEY,
          question_id TEXT NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,
          content TEXT NOT NULL,
          code_content TEXT,
          key_points_json TEXT NOT NULL,
          complexity TEXT,
          limitations TEXT,
          source_type TEXT NOT NULL DEFAULT 'manual',
          verified INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS question_bank_skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL DEFAULT 'technical',
          aliases_json TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS question_bank_skill_points (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL REFERENCES question_bank_skills(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'manual',
          verified INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS question_bank_question_skills (
          question_id TEXT NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES question_bank_skills(id) ON DELETE CASCADE,
          PRIMARY KEY(question_id, skill_id)
        );
        CREATE TABLE IF NOT EXISTS question_bank_job_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS question_bank_job_skills (
          job_profile_id TEXT NOT NULL REFERENCES question_bank_job_profiles(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES question_bank_skills(id) ON DELETE CASCADE,
          PRIMARY KEY(job_profile_id, skill_id)
        );
        CREATE INDEX IF NOT EXISTS question_bank_questions_normalized_idx ON question_bank_questions(normalized_text);
        CREATE INDEX IF NOT EXISTS question_bank_questions_type_idx ON question_bank_questions(type, updated_at DESC);
        CREATE INDEX IF NOT EXISTS question_bank_variants_normalized_idx ON question_bank_variants(normalized_text);
        CREATE INDEX IF NOT EXISTS question_bank_answer_cards_question_idx ON question_bank_answer_cards(question_id, mode, verified DESC);
        CREATE INDEX IF NOT EXISTS question_bank_skills_normalized_idx ON question_bank_skills(normalized_name);
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

export interface ProfileBuilderArtifactRecord {
  profileId: string;
  version: number;
  status: "ready" | "partial" | "error";
  sourceSnapshot: unknown;
  artifact?: ProfileBuilderOutput;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export class SqliteProfileBuilderRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(profileId: string): ProfileBuilderArtifactRecord | undefined {
    const row = this.database.first<{ profileId: string; version: number; status: string; sourceSnapshotJson: string; artifactJson: string; error: string | null; createdAt: number; updatedAt: number }>("SELECT profile_id AS profileId, version, status, source_snapshot_json AS sourceSnapshotJson, artifact_json AS artifactJson, error, created_at AS createdAt, updated_at AS updatedAt FROM profile_builder_artifacts WHERE profile_id = ?", [profileId]);
    if (!row) return undefined;
    return {
      profileId: row.profileId,
      version: row.version,
      status: row.status as ProfileBuilderArtifactRecord["status"],
      sourceSnapshot: JSON.parse(row.sourceSnapshotJson),
      artifact: row.artifactJson ? JSON.parse(row.artifactJson) as ProfileBuilderOutput : undefined,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  save(input: { profileId: string; status: ProfileBuilderArtifactRecord["status"]; sourceSnapshot: unknown; artifact?: ProfileBuilderOutput; error?: string; now?: number }): ProfileBuilderArtifactRecord {
    const now = input.now ?? Date.now();
    const existing = this.get(input.profileId);
    this.database.run("INSERT INTO profile_builder_artifacts(profile_id, version, status, source_snapshot_json, artifact_json, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET version=excluded.version, status=excluded.status, source_snapshot_json=excluded.source_snapshot_json, artifact_json=excluded.artifact_json, error=excluded.error, updated_at=excluded.updated_at", [input.profileId, input.artifact?.version ?? existing?.version ?? 1, input.status, JSON.stringify(input.sourceSnapshot), input.artifact ? JSON.stringify(input.artifact) : existing?.artifact ? JSON.stringify(existing.artifact) : "{}", input.error ?? null, existing?.createdAt ?? now, now]);
    this.database.flushNow();
    return this.get(input.profileId) as ProfileBuilderArtifactRecord;
  }

  invalidate(profileId: string, now = Date.now()): void {
    const current = this.get(profileId);
    if (!current) return;
    this.database.run("UPDATE profile_builder_artifacts SET status = 'partial', error = ?, updated_at = ? WHERE profile_id = ?", ["资料已更新，等待 Profile Builder 重建", now, profileId]);
    this.database.flush();
  }

  delete(profileId: string): void {
    this.database.run("DELETE FROM profile_builder_artifacts WHERE profile_id = ?", [profileId]);
    this.database.flushNow();
  }
}

export interface ProjectRecord {
  id: string;
  name: string;
  profileId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord {
  id: string;
  projectId?: string;
  profileId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "streaming" | "completed" | "error" | "cancelled";
  model?: string;
  createdAt: number;
}

export class SqliteProjectRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(): ProjectRecord[] {
    return this.database.all<ProjectRecord>("SELECT id, name, profile_id AS profileId, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC");
  }

  get(projectId: string): ProjectRecord | undefined {
    return this.database.first<ProjectRecord>("SELECT id, name, profile_id AS profileId, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ?", [projectId]);
  }

  create(name: string, profileId?: string, now = Date.now()): ProjectRecord {
    const project = { id: id("project", now), name: name.trim() || "新面试项目", ...(profileId ? { profileId } : {}), createdAt: now, updatedAt: now };
    this.database.run("INSERT INTO projects(id, name, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [project.id, project.name, project.profileId ?? null, now, now]);
    this.database.flushNow();
    return project;
  }

  rename(projectId: string, name: string, now = Date.now()): ProjectRecord | undefined {
    this.database.run("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?", [name.trim() || "新面试项目", now, projectId]);
    this.database.flushNow();
    return this.get(projectId);
  }

  delete(projectId: string): void {
    this.database.run("DELETE FROM projects WHERE id = ?", [projectId]);
    this.database.flushNow();
  }
}

export class SqliteConversationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(profileId?: string): ConversationRecord[] {
    const sql = "SELECT id, project_id AS projectId, profile_id AS profileId, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations";
    return profileId
      ? this.database.all<ConversationRecord>(`${sql} WHERE profile_id = ? ORDER BY updated_at DESC`, [profileId])
      : this.database.all<ConversationRecord>(`${sql} ORDER BY updated_at DESC`);
  }

  get(conversationId: string): { conversation: ConversationRecord; messages: ConversationMessageRecord[] } | undefined {
    const conversation = this.database.first<ConversationRecord>("SELECT id, project_id AS projectId, profile_id AS profileId, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations WHERE id = ?", [conversationId]);
    if (!conversation) return undefined;
    const messages = this.database.all<ConversationMessageRecord>("SELECT id, conversation_id AS conversationId, role, content, status, model, created_at AS createdAt FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id", [conversationId]);
    return { conversation, messages: messages.map((message) => ({ ...message, role: message.role as ConversationMessageRecord["role"], status: message.status as ConversationMessageRecord["status"], ...(message.model ? { model: message.model } : {}) })) };
  }

  create(profileId?: string, projectId?: string, title = "新对话", now = Date.now()): ConversationRecord {
    const conversation = { id: id("conversation", now), ...(projectId ? { projectId } : {}), ...(profileId ? { profileId } : {}), title: title.trim() || "新对话", createdAt: now, updatedAt: now };
    this.database.run("INSERT INTO conversations(id, project_id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [conversation.id, conversation.projectId ?? null, conversation.profileId ?? null, conversation.title, now, now]);
    this.database.flushNow();
    return conversation;
  }

  rename(conversationId: string, title: string, now = Date.now()): void {
    this.database.run("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?", [title.trim() || "新对话", now, conversationId]);
    this.database.flushNow();
  }

  addMessage(input: { conversationId: string; role: ConversationMessageRecord["role"]; content: string; status: ConversationMessageRecord["status"]; model?: string }, now = Date.now()): ConversationMessageRecord {
    const message = { id: id("message", now), ...input, createdAt: now };
    this.database.run("INSERT INTO conversation_messages(id, conversation_id, role, content, status, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [message.id, message.conversationId, message.role, message.content, message.status, message.model ?? null, now]);
    this.database.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, input.conversationId]);
    this.database.flushNow();
    return message;
  }

  updateMessage(messageId: string, content: string, status: ConversationMessageRecord["status"], now = Date.now()): void {
    this.database.run("UPDATE conversation_messages SET content = ?, status = ? WHERE id = ?", [content, status, messageId]);
    const message = this.database.first<{ conversationId: string }>("SELECT conversation_id AS conversationId FROM conversation_messages WHERE id = ?", [messageId]);
    if (message) this.database.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, message.conversationId]);
    this.database.flushNow();
  }

  delete(conversationId: string): void {
    this.database.run("DELETE FROM conversations WHERE id = ?", [conversationId]);
    this.database.flushNow();
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
export interface KnowledgeDocumentRecord { id: string; knowledgeBaseId: string; filename: string; mimeType: string; sha256: string; text: string; sections: string[]; documentType: KnowledgeDocumentType; status: "processing" | "ready" | "error"; error?: string; createdAt: number; updatedAt: number; }

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
    const sql = "SELECT id, knowledge_base_id AS knowledgeBaseId, filename, mime_type AS mimeType, sha256, text, sections_json AS sectionsJson, document_type AS documentType, status, error, created_at AS createdAt, updated_at AS updatedAt FROM documents";
    const rows = knowledgeBaseId ? this.database.all<Record<string, unknown>>(`${sql} WHERE knowledge_base_id = ? ORDER BY updated_at DESC`, [knowledgeBaseId]) : this.database.all<Record<string, unknown>>(`${sql} ORDER BY updated_at DESC`);
    return rows.map((row) => this.hydrateDocument(row));
  }

  /** Backfill categories for documents created before document classification existed. */
  backfillDocumentTypes(): void {
    for (const document of this.listDocuments().filter((item) => item.documentType === "other")) {
      const inferred = inferKnowledgeDocumentType(document.filename, document.text);
      if (inferred !== "other") this.updateDocumentType(document.id, inferred);
    }
  }

  getDocument(documentId: string): KnowledgeDocumentRecord | undefined {
    return this.listDocuments().find((document) => document.id === documentId);
  }

  deleteDocument(documentId: string): void {
    this.database.run("DELETE FROM documents WHERE id = ?", [documentId]);
    this.database.flushNow();
  }

  saveDocument(document: { id: string; knowledgeBaseId: string; filename: string; mimeType: string; sha256: string; text: string; sections: string[]; documentType?: KnowledgeDocumentType; status: "processing" | "ready" | "error"; error?: string }, now = Date.now()): KnowledgeDocumentRecord {
    const documentType = document.documentType ?? "other";
    this.database.run("INSERT INTO documents(id, knowledge_base_id, filename, mime_type, sha256, text, sections_json, document_type, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, sha256=excluded.sha256, text=excluded.text, sections_json=excluded.sections_json, document_type=excluded.document_type, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at", [document.id, document.knowledgeBaseId, document.filename, document.mimeType, document.sha256, document.text, JSON.stringify(document.sections), documentType, document.status, document.error ?? null, now, now]);
    this.database.flushNow();
    return this.listDocuments(document.knowledgeBaseId).find((item) => item.id === document.id) as KnowledgeDocumentRecord;
  }

  updateDocumentType(documentId: string, documentType: KnowledgeDocumentType, now = Date.now()): KnowledgeDocumentRecord | undefined {
    this.database.run("UPDATE documents SET document_type = ?, updated_at = ? WHERE id = ?", [documentType, now, documentId]);
    const chunks = this.database.all<{ id: string; metadataJson: string }>("SELECT id, metadata_json AS metadataJson FROM knowledge_chunks WHERE document_id = ?", [documentId]);
    for (const chunk of chunks) {
      const metadata = JSON.parse(chunk.metadataJson) as Record<string, unknown>;
      metadata.documentType = documentType;
      this.database.run("UPDATE knowledge_chunks SET metadata_json = ? WHERE id = ?", [JSON.stringify(metadata), chunk.id]);
    }
    this.database.flushNow();
    return this.getDocument(documentId);
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
    return { id: String(row.id), knowledgeBaseId: String(row.knowledgeBaseId), filename: String(row.filename), mimeType: String(row.mimeType), sha256: String(row.sha256), text: String(row.text), sections: JSON.parse(String(row.sectionsJson)) as string[], documentType: String(row.documentType || "other") as KnowledgeDocumentType, status: row.status as KnowledgeDocumentRecord["status"], ...(row.error ? { error: String(row.error) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }
}

export interface QuestionBankQuestionInput {
  id?: string;
  canonicalText: string;
  type?: QuestionBankType;
  difficulty?: string;
  jobRole?: string;
  source?: QuestionBankSourceType;
  status?: "active" | "archived";
  variants?: string[];
}

export interface QuestionBankAnswerCardInput {
  id?: string;
  questionId: string;
  mode?: QuestionBankAnswerMode;
  content: string;
  codeContent?: string;
  keyPoints?: string[];
  complexity?: string;
  limitations?: string;
  sourceType?: QuestionBankSourceType;
  verified?: boolean;
  version?: number;
}

export interface QuestionBankSkillInput {
  id?: string;
  name: string;
  category?: string;
  aliases?: string[];
  description?: string;
}

export interface QuestionBankSkillPointInput {
  id?: string;
  skillId: string;
  title: string;
  content: string;
  sourceType?: QuestionBankSourceType;
  verified?: boolean;
}

export interface QuestionBankJobProfileInput {
  id?: string;
  name: string;
  description?: string;
  skillIds?: string[];
}

export interface QuestionBankImportResult {
  recognizedQuestions: number;
  importedQuestions: number;
  importedAnswers: number;
  filteredProjectQuestions: number;
  filteredBehavioralQuestions: number;
  duplicatesMerged: number;
  failedQuestions: number;
  ids: string[];
}

export interface QuestionBankImportOptions {
  includeProject?: boolean;
  includeBehavioral?: boolean;
}

export interface QuestionBankAnswerGenerationResult {
  requested: number;
  generated: number;
  skipped: number;
  failed: number;
}

export class SqliteQuestionBankRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listQuestions(options: { search?: string; type?: QuestionBankType; limit?: number } = {}): QuestionBankQuestionRecord[] {
    const clauses: string[] = ["status = 'active'"];
    const params: Array<string | number> = [];
    if (options.type) { clauses.push("type = ?"); params.push(options.type); }
    if (options.search?.trim()) {
      const search = normalizeQuestionBankText(options.search);
      clauses.push("(normalized_text LIKE ? OR id IN (SELECT question_id FROM question_bank_variants WHERE normalized_text LIKE ?))");
      params.push(`%${search}%`, `%${search}%`);
    }
    const limit = Math.max(1, Math.min(5000, options.limit ?? 200));
    params.push(limit);
    const rows = this.database.all<{ id: string; canonicalText: string; normalizedText: string; type: QuestionBankType; difficulty: string; jobRole: string | null; source: QuestionBankSourceType; status: "active" | "archived"; createdAt: number; updatedAt: number }>(`SELECT id, canonical_text AS canonicalText, normalized_text AS normalizedText, type, difficulty, job_role AS jobRole, source, status, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_questions WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`, params);
    return rows.map((row) => this.hydrateQuestion(row));
  }

  getQuestion(questionId: string): QuestionBankQuestionRecord | undefined {
    const row = this.database.first<{ id: string; canonicalText: string; normalizedText: string; type: QuestionBankType; difficulty: string; jobRole: string | null; source: QuestionBankSourceType; status: "active" | "archived"; createdAt: number; updatedAt: number }>("SELECT id, canonical_text AS canonicalText, normalized_text AS normalizedText, type, difficulty, job_role AS jobRole, source, status, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_questions WHERE id = ?", [questionId]);
    return row ? this.hydrateQuestion(row) : undefined;
  }

  saveQuestion(input: QuestionBankQuestionInput, now = Date.now()): QuestionBankQuestionRecord {
    const canonicalText = input.canonicalText.trim();
    if (!canonicalText) throw new Error("QUESTION_BANK_EMPTY: 问题不能为空");
    const questionId = input.id ?? id("bank-question", now);
    const normalizedText = normalizeQuestionBankText(canonicalText);
    const existing = input.id ? this.getQuestion(input.id) : undefined;
    this.database.run("INSERT INTO question_bank_questions(id, canonical_text, normalized_text, type, difficulty, job_role, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET canonical_text=excluded.canonical_text, normalized_text=excluded.normalized_text, type=excluded.type, difficulty=excluded.difficulty, job_role=excluded.job_role, source=excluded.source, status=excluded.status, updated_at=excluded.updated_at", [questionId, canonicalText, normalizedText, input.type ?? inferQuestionBankType(canonicalText), input.difficulty ?? "medium", input.jobRole?.trim() || null, input.source ?? existing?.source ?? "manual", input.status ?? "active", existing?.createdAt ?? now, now]);
    if (input.variants) {
      this.database.run("DELETE FROM question_bank_variants WHERE question_id = ?", [questionId]);
      for (const variant of input.variants.map((item) => item.trim()).filter(Boolean)) this.database.run("INSERT INTO question_bank_variants(id, question_id, text, normalized_text, created_at) VALUES (?, ?, ?, ?, ?)", [id("bank-variant", now), questionId, variant, normalizeQuestionBankText(variant), now]);
    }
    this.database.flushNow();
    return this.getQuestion(questionId) as QuestionBankQuestionRecord;
  }

  deleteQuestion(questionId: string): void {
    this.database.run("DELETE FROM question_bank_questions WHERE id = ?", [questionId]);
    this.database.flushNow();
  }

  saveAnswerCard(input: QuestionBankAnswerCardInput, now = Date.now()): QuestionBankAnswerCardRecord {
    if (!this.getQuestion(input.questionId)) throw new Error("QUESTION_BANK_QUESTION_NOT_FOUND: 题目不存在");
    const cardId = input.id ?? id("bank-answer", now);
    const current = input.id ? this.getAnswerCard(input.id) : undefined;
    this.database.run("INSERT INTO question_bank_answer_cards(id, question_id, mode, content, code_content, key_points_json, complexity, limitations, source_type, verified, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET question_id=excluded.question_id, mode=excluded.mode, content=excluded.content, code_content=excluded.code_content, key_points_json=excluded.key_points_json, complexity=excluded.complexity, limitations=excluded.limitations, source_type=excluded.source_type, verified=excluded.verified, version=excluded.version, updated_at=excluded.updated_at", [cardId, input.questionId, input.mode ?? "standard", input.content.trim(), input.codeContent?.trim() || null, JSON.stringify(input.keyPoints ?? []), input.complexity?.trim() || null, input.limitations?.trim() || null, input.sourceType ?? current?.sourceType ?? "manual", input.verified ? 1 : 0, input.version ?? (current?.version ?? 0) + 1, current?.createdAt ?? now, now]);
    this.database.flushNow();
    return this.getAnswerCard(cardId) as QuestionBankAnswerCardRecord;
  }

  deleteAnswerCard(answerCardId: string): void {
    this.database.run("DELETE FROM question_bank_answer_cards WHERE id = ?", [answerCardId]);
    this.database.flushNow();
  }

  saveSkill(input: QuestionBankSkillInput, now = Date.now()): QuestionBankSkillRecord {
    const name = input.name.trim();
    if (!name) throw new Error("QUESTION_BANK_EMPTY_SKILL: 技能名称不能为空");
    const skillId = input.id ?? id("bank-skill", now);
    const existing = input.id ? this.getSkill(input.id) : undefined;
    this.database.run("INSERT INTO question_bank_skills(id, name, normalized_name, category, aliases_json, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, normalized_name=excluded.normalized_name, category=excluded.category, aliases_json=excluded.aliases_json, description=excluded.description, updated_at=excluded.updated_at", [skillId, name, normalizeQuestionBankText(name), input.category?.trim() || "technical", JSON.stringify(input.aliases ?? []), input.description?.trim() ?? "", existing?.createdAt ?? now, now]);
    this.database.flushNow();
    return this.getSkill(skillId) as QuestionBankSkillRecord;
  }

  listSkills(search = ""): QuestionBankSkillRecord[] {
    const normalized = normalizeQuestionBankText(search);
    const rows = normalized ? this.database.all<Record<string, unknown>>("SELECT id, name, normalized_name AS normalizedName, category, aliases_json AS aliasesJson, description, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_skills WHERE normalized_name LIKE ? ORDER BY updated_at DESC", [`%${normalized}%`]) : this.database.all<Record<string, unknown>>("SELECT id, name, normalized_name AS normalizedName, category, aliases_json AS aliasesJson, description, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_skills ORDER BY updated_at DESC");
    return rows.map((row) => this.hydrateSkill(row));
  }

  getSkill(skillId: string): QuestionBankSkillRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, name, normalized_name AS normalizedName, category, aliases_json AS aliasesJson, description, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_skills WHERE id = ?", [skillId]);
    return row ? this.hydrateSkill(row) : undefined;
  }

  saveSkillPoint(input: QuestionBankSkillPointInput, now = Date.now()): QuestionBankSkillPointRecord {
    if (!this.getSkill(input.skillId)) throw new Error("QUESTION_BANK_SKILL_NOT_FOUND: 技能不存在");
    const pointId = input.id ?? id("bank-skill-point", now);
    const current = input.id ? this.getSkillPoint(input.id) : undefined;
    this.database.run("INSERT INTO question_bank_skill_points(id, skill_id, title, content, source_type, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET skill_id=excluded.skill_id, title=excluded.title, content=excluded.content, source_type=excluded.source_type, verified=excluded.verified, updated_at=excluded.updated_at", [pointId, input.skillId, input.title.trim(), input.content.trim(), input.sourceType ?? current?.sourceType ?? "manual", input.verified ? 1 : 0, current?.createdAt ?? now, now]);
    this.database.flushNow();
    return this.getSkillPoint(pointId) as QuestionBankSkillPointRecord;
  }

  linkQuestionSkill(questionId: string, skillId: string): void {
    this.database.run("INSERT OR IGNORE INTO question_bank_question_skills(question_id, skill_id) VALUES (?, ?)", [questionId, skillId]);
    this.database.flushNow();
  }

  saveJobProfile(input: QuestionBankJobProfileInput, now = Date.now()): QuestionBankJobProfileRecord {
    const name = input.name.trim();
    if (!name) throw new Error("QUESTION_BANK_EMPTY_JOB: 岗位名称不能为空");
    const jobId = input.id ?? id("bank-job", now);
    const existing = this.getJobProfile(jobId);
    this.database.run("INSERT INTO question_bank_job_profiles(id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, updated_at=excluded.updated_at", [jobId, name, input.description?.trim() ?? "", existing?.createdAt ?? now, now]);
    if (input.skillIds) {
      this.database.run("DELETE FROM question_bank_job_skills WHERE job_profile_id = ?", [jobId]);
      for (const skillId of input.skillIds) if (this.getSkill(skillId)) this.database.run("INSERT OR IGNORE INTO question_bank_job_skills(job_profile_id, skill_id) VALUES (?, ?)", [jobId, skillId]);
    }
    this.database.flushNow();
    return this.getJobProfile(jobId) as QuestionBankJobProfileRecord;
  }

  listJobProfiles(): QuestionBankJobProfileRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_job_profiles ORDER BY updated_at DESC").map((row) => this.hydrateJobProfile(row));
  }

  getJobProfile(jobProfileId: string): QuestionBankJobProfileRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_job_profiles WHERE id = ?", [jobProfileId]);
    return row ? this.hydrateJobProfile(row) : undefined;
  }

  matchQuestion(text: string, options: { threshold?: number } = {}): QuestionBankMatch | undefined {
    const threshold = options.threshold ?? 0.72;
    const matches = this.listQuestions({ limit: 500 }).map((question) => {
      const variantScore = question.variants.reduce((best, variant) => Math.max(best, questionBankSimilarity(text, variant)), 0);
      return { question, score: Math.max(questionBankSimilarity(text, question.canonicalText), variantScore), exact: normalizeQuestionBankText(text) === question.normalizedText };
    }).sort((left, right) => right.score - left.score);
    const match = matches[0];
    return match && match.score >= threshold ? match : undefined;
  }

  importText(text: string, filename = "题库导入", options: QuestionBankImportOptions = {}): QuestionBankImportResult {
    const includeProject = options.includeProject ?? false;
    const includeBehavioral = options.includeBehavioral ?? true;
    let recognizedQuestions = 0;
    let importedQuestions = 0;
    let importedAnswers = 0;
    let filteredProjectQuestions = 0;
    let filteredBehavioralQuestions = 0;
    let duplicatesMerged = 0;
    let failedQuestions = 0;
    const ids: string[] = [];
    const existingByNormalized = new Map(this.listQuestions({ limit: 5000 }).map((question) => [question.normalizedText, question]));

    const saveEntry = (question: string, type: QuestionBankType, answer = "", variants: string[] = []): void => {
      const canonicalText = question.trim();
      if (!canonicalText || canonicalText.length < 4) return;
      recognizedQuestions += 1;
      if (type === "project" && !includeProject) { filteredProjectQuestions += 1; return; }
      if (type === "behavioral" && !includeBehavioral) { filteredBehavioralQuestions += 1; return; }
      try {
        const normalizedText = normalizeQuestionBankText(canonicalText);
        const existing = existingByNormalized.get(normalizedText);
        if (existing) {
          const mergedVariants = [...new Set([...existing.variants, ...variants, canonicalText].filter((item) => normalizeQuestionBankText(item) !== existing.normalizedText))];
          if (mergedVariants.length !== existing.variants.length) {
            const updated = this.saveQuestion({ id: existing.id, canonicalText: existing.canonicalText, type: existing.type, difficulty: existing.difficulty, jobRole: existing.jobRole, variants: mergedVariants, source: existing.source });
            existingByNormalized.set(normalizedText, updated);
          }
          if (answer && !existing.answerCards.some((card) => card.content.trim())) this.saveAnswerCard({ questionId: existing.id, content: answer, sourceType: "imported", verified: false });
          ids.push(existing.id);
          duplicatesMerged += 1;
          return;
        }
        const record = this.saveQuestion({ canonicalText, type, variants, source: "imported" });
        existingByNormalized.set(record.normalizedText, record);
        ids.push(record.id);
        importedQuestions += 1;
        if (answer) { this.saveAnswerCard({ questionId: record.id, content: answer, sourceType: "imported", verified: false }); importedAnswers += 1; }
      } catch {
        failedQuestions += 1;
      }
    };

    if (/\.json$/i.test(filename)) {
      try {
        const parsed = JSON.parse(text) as unknown;
        const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { questions?: unknown[] }).questions) ? (parsed as { questions: unknown[] }).questions : [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const item = entry as { question?: unknown; text?: unknown; type?: unknown; answer?: unknown; content?: unknown; code?: unknown; variants?: unknown };
          const question = String(item.question ?? item.text ?? "").trim();
          if (question.length < 4) continue;
          const type = typeof item.type === "string" && (QUESTION_BANK_TYPES as readonly string[]).includes(item.type) ? item.type as QuestionBankType : inferQuestionBankType(question);
          const content = String(item.answer ?? item.content ?? item.code ?? "").trim();
          saveEntry(question, type, content, Array.isArray(item.variants) ? item.variants.map(String) : []);
        }
        return { recognizedQuestions, importedQuestions, importedAnswers, filteredProjectQuestions, filteredBehavioralQuestions, duplicatesMerged, failedQuestions, ids: [...new Set(ids)] };
      } catch {
        throw new Error("QUESTION_BANK_JSON_INVALID: 题库 JSON 格式无效");
      }
    }
    for (const entry of parseQuestionBankText(text)) saveEntry(entry.question, entry.type, entry.answer);
    return { recognizedQuestions, importedQuestions, importedAnswers, filteredProjectQuestions, filteredBehavioralQuestions, duplicatesMerged, failedQuestions, ids: [...new Set(ids)] };
  }

  private hydrateQuestion(row: { id: string; canonicalText: string; normalizedText: string; type: QuestionBankType; difficulty: string; jobRole: string | null; source: QuestionBankSourceType; status: "active" | "archived"; createdAt: number; updatedAt: number }): QuestionBankQuestionRecord {
    const variants = this.database.all<{ text: string }>("SELECT text FROM question_bank_variants WHERE question_id = ? ORDER BY created_at", [row.id]).map((item) => item.text);
    const skillIds = this.database.all<{ skillId: string }>("SELECT skill_id AS skillId FROM question_bank_question_skills WHERE question_id = ?", [row.id]).map((item) => item.skillId);
    const answerCards = this.database.all<Record<string, unknown>>("SELECT id, question_id AS questionId, mode, content, code_content AS codeContent, key_points_json AS keyPointsJson, complexity, limitations, source_type AS sourceType, verified, version, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_answer_cards WHERE question_id = ? ORDER BY verified DESC, updated_at DESC", [row.id]).map((item) => this.hydrateAnswerCard(item));
    return { ...row, jobRole: row.jobRole || undefined, variants, answerCards, skillIds };
  }

  private getAnswerCard(answerCardId: string): QuestionBankAnswerCardRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, question_id AS questionId, mode, content, code_content AS codeContent, key_points_json AS keyPointsJson, complexity, limitations, source_type AS sourceType, verified, version, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_answer_cards WHERE id = ?", [answerCardId]);
    return row ? this.hydrateAnswerCard(row) : undefined;
  }

  private hydrateAnswerCard(row: Record<string, unknown>): QuestionBankAnswerCardRecord {
    return { id: String(row.id), questionId: String(row.questionId), mode: String(row.mode) as QuestionBankAnswerMode, content: String(row.content), ...(row.codeContent ? { codeContent: String(row.codeContent) } : {}), keyPoints: JSON.parse(String(row.keyPointsJson)) as string[], ...(row.complexity ? { complexity: String(row.complexity) } : {}), ...(row.limitations ? { limitations: String(row.limitations) } : {}), sourceType: String(row.sourceType) as QuestionBankSourceType, verified: Number(row.verified) === 1, version: Number(row.version), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  private hydrateSkill(row: Record<string, unknown>): QuestionBankSkillRecord {
    const points = this.database.all<Record<string, unknown>>("SELECT id, skill_id AS skillId, title, content, source_type AS sourceType, verified, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_skill_points WHERE skill_id = ? ORDER BY updated_at DESC", [String(row.id)]).map((item) => ({ id: String(item.id), skillId: String(item.skillId), title: String(item.title), content: String(item.content), sourceType: String(item.sourceType) as QuestionBankSourceType, verified: Number(item.verified) === 1, createdAt: Number(item.createdAt), updatedAt: Number(item.updatedAt) }));
    return { id: String(row.id), name: String(row.name), normalizedName: String(row.normalizedName), category: String(row.category), aliases: JSON.parse(String(row.aliasesJson)) as string[], description: String(row.description), points, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  private getSkillPoint(pointId: string): QuestionBankSkillPointRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, skill_id AS skillId, title, content, source_type AS sourceType, verified, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_skill_points WHERE id = ?", [pointId]);
    return row ? { id: String(row.id), skillId: String(row.skillId), title: String(row.title), content: String(row.content), sourceType: String(row.sourceType) as QuestionBankSourceType, verified: Number(row.verified) === 1, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) } : undefined;
  }

  private hydrateJobProfile(row: Record<string, unknown>): QuestionBankJobProfileRecord {
    const skillIds = this.database.all<{ skillId: string }>("SELECT skill_id AS skillId FROM question_bank_job_skills WHERE job_profile_id = ?", [String(row.id)]).map((item) => item.skillId);
    return { id: String(row.id), name: String(row.name), description: String(row.description), skillIds, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }
}
