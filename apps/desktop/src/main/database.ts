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
  type QuestionBankScope,
  type QuestionBankSkillPointRecord,
  type QuestionBankSkillRecord,
  type QuestionBankSourceType,
  type QuestionBankType,
  type ProjectMemorySnapshot,
  ProjectFactMemoryRetriever,
  type ProjectRetrievalHit,
  type ProjectTechnicalPoint,
  type ProjectFact,
  type ProjectFactType
} from "@interview-copilot/shared";

export const APP_DATA_DIRECTORY = "InterviewCopilot";

export interface DatabaseFlushDiagnostics {
  databaseFlushDurationMs: number;
  databaseSize: number;
  pendingFlush: boolean;
  lastFlushAt?: number;
  lastDiagnostic?: "DATABASE_FLUSH_SLOW";
}

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
  private diagnostics: DatabaseFlushDiagnostics = { databaseFlushDurationMs: 0, databaseSize: 0, pendingFlush: false };

  private constructor(private readonly filePath: string, private readonly database: InstanceType<SqlJsStatic["Database"]>, private readonly onDiagnostic?: (code: string) => void) {}

  static async open(filePath: string, wasmPath = wasmCandidates().find((candidate) => existsSync(candidate)), options: { onDiagnostic?: (code: string) => void } = {}): Promise<SqliteDatabase> {
    if (filePath !== ":memory:") await mkdir(dirname(filePath), { recursive: true });
    const SQL: SqlJsStatic = await initSqlJs(wasmPath ? { locateFile: () => wasmPath } : undefined);
    const bytes = filePath !== ":memory:" && existsSync(filePath) ? readFileSync(filePath) : undefined;
    const database = new SQL.Database(bytes);
    const store = new SqliteDatabase(filePath, database, options.onDiagnostic);
    store.migrate();
    store.flushNow();
    return store;
  }

  run(sql: string, params: Array<string | number | Uint8Array | null> = []): void {
    if (params.some((param) => param === undefined)) throw new Error(`DATABASE_UNDEFINED_PARAM: ${sql}`);
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

  markDirty(): void {
    this.dirty = true;
    this.diagnostics = { ...this.diagnostics, pendingFlush: true };
  }

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
    if (this.filePath === ":memory:" || !this.dirty) {
      this.diagnostics = { ...this.diagnostics, pendingFlush: false };
      return;
    }
    const startedAt = performance.now();
    const bytes = this.database.export();
    writeFileSync(this.filePath, bytes);
    const duration = Math.max(0, performance.now() - startedAt);
    this.dirty = false;
    const slow = duration > 50;
    this.diagnostics = {
      databaseFlushDurationMs: duration,
      databaseSize: bytes.byteLength,
      pendingFlush: false,
      lastFlushAt: Date.now(),
      ...(slow ? { lastDiagnostic: "DATABASE_FLUSH_SLOW" as const } : {})
    };
    if (slow) this.onDiagnostic?.("DATABASE_FLUSH_SLOW");
  }

  getFlushDiagnostics(): DatabaseFlushDiagnostics { return { ...this.diagnostics, pendingFlush: this.dirty || Boolean(this.flushTimer) }; }

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
      `],
      [9, `
        ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE projects ADD COLUMN role TEXT NOT NULL DEFAULT '';
        ALTER TABLE projects ADD COLUMN hardware_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE projects ADD COLUMN software_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE projects ADD COLUMN technology_stack_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE projects ADD COLUMN time TEXT;
        ALTER TABLE projects ADD COLUMN source_ids_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE projects ADD COLUMN confidence REAL NOT NULL DEFAULT 1;
        CREATE TABLE IF NOT EXISTS project_modules (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          module_name TEXT NOT NULL,
          description TEXT NOT NULL,
          file_path TEXT,
          source_ids_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS technical_points (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          topic TEXT NOT NULL,
          content TEXT NOT NULL,
          importance TEXT NOT NULL DEFAULT 'medium',
          source_ids_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS project_problems (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          problem TEXT NOT NULL,
          cause TEXT NOT NULL,
          solution TEXT NOT NULL,
          result TEXT NOT NULL,
          source_ids_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS interview_questions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          answer_points_json TEXT NOT NULL DEFAULT '[]',
          keywords_json TEXT NOT NULL DEFAULT '[]',
          source_ids_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS project_modules_project_idx ON project_modules(project_id);
        CREATE INDEX IF NOT EXISTS technical_points_project_idx ON technical_points(project_id);
        CREATE INDEX IF NOT EXISTS project_problems_project_idx ON project_problems(project_id);
        CREATE INDEX IF NOT EXISTS interview_questions_project_idx ON interview_questions(project_id);
      `],
      [10, `
        ALTER TABLE question_bank_questions ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
        ALTER TABLE question_bank_questions ADD COLUMN profile_id TEXT;
        ALTER TABLE question_bank_questions ADD COLUMN project_id TEXT;
        ALTER TABLE question_bank_questions ADD COLUMN job_profile_id TEXT;
        ALTER TABLE question_bank_questions ADD COLUMN confidence REAL NOT NULL DEFAULT 1;
        ALTER TABLE question_bank_questions ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE question_bank_questions ADD COLUMN embedding_json TEXT;
        ALTER TABLE question_bank_questions ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
        CREATE INDEX IF NOT EXISTS question_bank_questions_scope_idx ON question_bank_questions(scope, profile_id, project_id, job_profile_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS question_bank_questions_project_idx ON question_bank_questions(project_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS project_facts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          fact_type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1,
          verified INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          embedding_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_fact_sources (
          fact_id TEXT NOT NULL REFERENCES project_facts(id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          quote TEXT,
          locator TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(fact_id, source_id, quote)
        );
        CREATE INDEX IF NOT EXISTS project_facts_project_idx ON project_facts(project_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS project_facts_type_idx ON project_facts(fact_type, updated_at DESC);
        CREATE INDEX IF NOT EXISTS project_fact_sources_source_idx ON project_fact_sources(source_id);

        CREATE TABLE IF NOT EXISTS job_targets (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          source_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          company TEXT,
          role TEXT,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS job_requirements (
          id TEXT PRIMARY KEY,
          job_target_id TEXT NOT NULL REFERENCES job_targets(id) ON DELETE CASCADE,
          category TEXT NOT NULL,
          requirement TEXT NOT NULL,
          importance TEXT NOT NULL DEFAULT 'medium',
          source_quote TEXT,
          verified INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS job_targets_profile_idx ON job_targets(profile_id, status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS job_requirements_target_idx ON job_requirements(job_target_id, importance, updated_at DESC);

        CREATE TABLE IF NOT EXISTS knowledge_analysis_runs (
          id TEXT PRIMARY KEY,
          profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
          run_type TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          model TEXT,
          prompt_version TEXT,
          status TEXT NOT NULL,
          input_snapshot_json TEXT NOT NULL,
          output_json TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS retrieval_runs (
          id TEXT PRIMARY KEY,
          interview_id TEXT REFERENCES interviews(id) ON DELETE SET NULL,
          question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
          profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          query TEXT NOT NULL,
          route TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS retrieval_hits (
          id TEXT PRIMARY KEY,
          retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(id) ON DELETE CASCADE,
          result_type TEXT NOT NULL,
          result_id TEXT NOT NULL,
          rank INTEGER NOT NULL,
          score REAL NOT NULL,
          verified INTEGER NOT NULL DEFAULT 0,
          preview TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS knowledge_analysis_runs_profile_idx ON knowledge_analysis_runs(profile_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS retrieval_runs_profile_idx ON retrieval_runs(profile_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS retrieval_hits_run_idx ON retrieval_hits(retrieval_run_id, rank);

        INSERT OR IGNORE INTO question_bank_questions(
          id, canonical_text, normalized_text, type, difficulty, job_role, source, status,
          created_at, updated_at, scope, profile_id, project_id, confidence, verified, search_text
        )
        SELECT iq.id, iq.question, lower(iq.question), 'project', 'medium', NULL, 'generated', 'active',
          p.created_at, p.updated_at, 'project', p.profile_id, iq.project_id, 0.65, 0,
          iq.question || ' ' || iq.keywords_json || ' ' || iq.answer_points_json
        FROM interview_questions iq
        JOIN projects p ON p.id = iq.project_id
        WHERE p.profile_id IS NOT NULL;

        INSERT OR IGNORE INTO question_bank_answer_cards(
          id, question_id, mode, content, code_content, key_points_json, complexity,
          limitations, source_type, verified, version, created_at, updated_at
        )
        SELECT iq.id || '-generated-answer', iq.id, 'standard', iq.answer_points_json, NULL,
          iq.answer_points_json, NULL, NULL, 'generated', 0, 1, p.created_at, p.updated_at
        FROM interview_questions iq
        JOIN projects p ON p.id = iq.project_id
        WHERE p.profile_id IS NOT NULL;
      `],
      [11, `
        ALTER TABLE interviews ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
        ALTER TABLE interviews ADD COLUMN job_target_id TEXT REFERENCES job_targets(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS interviews_context_idx ON interviews(profile_id, project_id, job_target_id, created_at DESC);
      `],
      [12, `
        ALTER TABLE questions ADD COLUMN parent_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL;
        ALTER TABLE questions ADD COLUMN root_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS questions_thread_idx ON questions(interview_id, root_question_id, detected_at);
      `],
      [13, `
        ALTER TABLE retrieval_runs ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
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
    new SqliteJobTargetRepository(this.database).syncProfile(profile, now);
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
    return this.database.all<ProjectRecord>("SELECT id, name, profile_id AS profileId, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id NOT LIKE 'memory-project-%' ORDER BY updated_at DESC");
  }

  get(projectId: string): ProjectRecord | undefined {
    return this.database.first<ProjectRecord>("SELECT id, name, profile_id AS profileId, created_at AS createdAt, updated_at AS updatedAt FROM projects WHERE id = ? AND id NOT LIKE 'memory-project-%'", [projectId]);
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

export interface ProjectMemoryStats {
  projects: number;
  modules: number;
  technicalPoints: number;
  problems: number;
  interviewQuestions: number;
}

function jsonArray<T = string>(value: unknown): T[] {
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
}

export interface ProjectFactMatch {
  fact: ProjectFact;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  typeScore: number;
  projectScore: number;
  verifiedBoost: number;
  finalScore: number;
  reason: string;
}

/** Structured Project Memory persistence. Legacy projects/conversations remain compatible. */
export class SqliteProjectMemoryRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getSnapshot(profileId: string): ProjectMemorySnapshot {
    const projects = this.database.all<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, description, role, hardware_json AS hardwareJson, software_json AS softwareJson, technology_stack_json AS technologyStackJson, time, source_ids_json AS sourceIdsJson, confidence FROM projects WHERE profile_id = ? AND id LIKE 'memory-project-%' ORDER BY updated_at DESC", [profileId]).map((row) => ({
      id: String(row.id), profileId: String(row.profileId), name: String(row.name), description: String(row.description ?? ""), role: String(row.role ?? ""), hardware: jsonArray(row.hardwareJson), software: jsonArray(row.softwareJson), technologyStack: jsonArray(row.technologyStackJson), ...(row.time ? { time: String(row.time) } : {}), sourceIds: jsonArray(row.sourceIdsJson), confidence: Number(row.confidence ?? 1)
    }));
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length === 0) return { projects, modules: [], technicalPoints: [], problems: [], interviewQuestions: [] };
    const placeholders = projectIds.map(() => "?").join(",");
    const modules = this.database.all<Record<string, unknown>>(`SELECT id, project_id AS projectId, module_name AS moduleName, description, file_path AS filePath, source_ids_json AS sourceIdsJson FROM project_modules WHERE project_id IN (${placeholders})`, projectIds).map((row) => ({ id: String(row.id), projectId: String(row.projectId), moduleName: String(row.moduleName), description: String(row.description), ...(row.filePath ? { filePath: String(row.filePath) } : {}), sourceIds: jsonArray(row.sourceIdsJson) }));
    const technicalPoints = this.database.all<Record<string, unknown>>(`SELECT id, project_id AS projectId, topic, content, importance, source_ids_json AS sourceIdsJson FROM technical_points WHERE project_id IN (${placeholders})`, projectIds).map((row) => ({ id: String(row.id), projectId: String(row.projectId), topic: String(row.topic), content: String(row.content), importance: String(row.importance) as ProjectTechnicalPoint["importance"], sourceIds: jsonArray(row.sourceIdsJson) }));
    const problems = this.database.all<Record<string, unknown>>(`SELECT id, project_id AS projectId, problem, cause, solution, result, source_ids_json AS sourceIdsJson FROM project_problems WHERE project_id IN (${placeholders})`, projectIds).map((row) => ({ id: String(row.id), projectId: String(row.projectId), problem: String(row.problem), cause: String(row.cause), solution: String(row.solution), result: String(row.result), sourceIds: jsonArray(row.sourceIdsJson) }));
    const interviewQuestions = this.database.all<Record<string, unknown>>(`SELECT id, project_id AS projectId, question, answer_points_json AS answerPointsJson, keywords_json AS keywordsJson, source_ids_json AS sourceIdsJson FROM interview_questions WHERE project_id IN (${placeholders})`, projectIds).map((row) => ({ id: String(row.id), projectId: String(row.projectId), question: String(row.question), answerPoints: jsonArray(row.answerPointsJson), keywords: jsonArray(row.keywordsJson), sourceIds: jsonArray(row.sourceIdsJson) }));
    return { projects, modules, technicalPoints, problems, interviewQuestions };
  }

  replaceSnapshot(profileId: string, snapshot: ProjectMemorySnapshot, now = Date.now()): ProjectMemorySnapshot {
    const previousFactVerification = new Map(this.database.all<{ id: string; verified: number }>("SELECT id, verified FROM project_facts WHERE project_id IN (SELECT id FROM projects WHERE profile_id = ? AND id LIKE 'memory-project-%')", [profileId]).map((row) => [row.id, Number(row.verified) === 1] as const));
    this.database.run("DELETE FROM question_bank_questions WHERE scope = 'project' AND profile_id = ? AND source = 'generated'", [profileId]);
    this.database.run("DELETE FROM projects WHERE profile_id = ? AND id LIKE 'memory-project-%'", [profileId]);
    for (const project of snapshot.projects) {
      this.database.run("INSERT INTO projects(id, name, profile_id, description, role, hardware_json, software_json, technology_stack_json, time, source_ids_json, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, profile_id=excluded.profile_id, description=excluded.description, role=excluded.role, hardware_json=excluded.hardware_json, software_json=excluded.software_json, technology_stack_json=excluded.technology_stack_json, time=excluded.time, source_ids_json=excluded.source_ids_json, confidence=excluded.confidence, updated_at=excluded.updated_at", [project.id, project.name, profileId, project.description, project.role, JSON.stringify(project.hardware), JSON.stringify(project.software), JSON.stringify(project.technologyStack), project.time ?? null, JSON.stringify(project.sourceIds), project.confidence, now, now]);
    }
    for (const module of snapshot.modules) this.database.run("INSERT INTO project_modules(id, project_id, module_name, description, file_path, source_ids_json) VALUES (?, ?, ?, ?, ?, ?)", [module.id, module.projectId, module.moduleName, module.description, module.filePath ?? null, JSON.stringify(module.sourceIds)]);
    for (const point of snapshot.technicalPoints) this.database.run("INSERT INTO technical_points(id, project_id, topic, content, importance, source_ids_json) VALUES (?, ?, ?, ?, ?, ?)", [point.id, point.projectId, point.topic, point.content, point.importance, JSON.stringify(point.sourceIds)]);
    for (const problem of snapshot.problems) this.database.run("INSERT INTO project_problems(id, project_id, problem, cause, solution, result, source_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [problem.id, problem.projectId, problem.problem, problem.cause, problem.solution, problem.result, JSON.stringify(problem.sourceIds)]);
    for (const question of snapshot.interviewQuestions) this.database.run("INSERT INTO interview_questions(id, project_id, question, answer_points_json, keywords_json, source_ids_json) VALUES (?, ?, ?, ?, ?, ?)", [question.id, question.projectId, question.question, JSON.stringify(question.answerPoints), JSON.stringify(question.keywords), JSON.stringify(question.sourceIds)]);
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
    const saveFact = (fact: ProjectFact): void => {
      const verified = previousFactVerification.get(fact.id) ?? fact.verified;
      this.database.run("INSERT INTO project_facts(id, project_id, fact_type, title, content, confidence, verified, status, embedding_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, fact_type=excluded.fact_type, title=excluded.title, content=excluded.content, confidence=excluded.confidence, verified=excluded.verified, status=excluded.status, updated_at=excluded.updated_at", [fact.id, fact.projectId, fact.type, fact.title, fact.content, Math.max(0, Math.min(1, fact.confidence)), verified ? 1 : 0, fact.createdAt ?? now, fact.updatedAt ?? now]);
      this.database.run("DELETE FROM project_fact_sources WHERE fact_id = ?", [fact.id]);
      for (const sourceId of fact.sourceIds) this.database.run("INSERT OR IGNORE INTO project_fact_sources(fact_id, source_id, quote, locator, created_at) VALUES (?, ?, NULL, NULL, ?)", [fact.id, sourceId, now]);
    };
    for (const project of snapshot.projects) {
      saveFact({ id: `${project.id}-fact-background`, projectId: project.id, profileId, type: "background", title: "项目背景", content: project.description, confidence: project.confidence, verified: false, sourceIds: project.sourceIds, createdAt: now, updatedAt: now });
      saveFact({ id: `${project.id}-fact-responsibility`, projectId: project.id, profileId, type: "responsibility", title: "个人职责", content: project.role, confidence: project.confidence, verified: false, sourceIds: project.sourceIds, createdAt: now, updatedAt: now });
      if (project.technologyStack.length || project.hardware.length || project.software.length) saveFact({ id: `${project.id}-fact-technology`, projectId: project.id, profileId, type: "technology", title: "技术栈与平台", content: [`技术栈：${project.technologyStack.join("、")}`, `硬件：${project.hardware.join("、")}`, `软件：${project.software.join("、")}`].filter((item) => !item.endsWith("：")).join("\n"), confidence: project.confidence, verified: false, sourceIds: project.sourceIds, createdAt: now, updatedAt: now });
    }
    for (const module of snapshot.modules) saveFact({ id: `${module.id}-fact`, projectId: module.projectId, profileId: projectById.get(module.projectId)?.profileId ?? profileId, type: "module", title: module.moduleName, content: module.description, confidence: projectById.get(module.projectId)?.confidence ?? 0.65, verified: false, sourceIds: module.sourceIds, createdAt: now, updatedAt: now });
    for (const point of snapshot.technicalPoints) saveFact({ id: `${point.id}-fact`, projectId: point.projectId, profileId: projectById.get(point.projectId)?.profileId ?? profileId, type: "technology", title: point.topic, content: point.content, confidence: projectById.get(point.projectId)?.confidence ?? 0.65, verified: false, sourceIds: point.sourceIds, createdAt: now, updatedAt: now });
    for (const problem of snapshot.problems) saveFact({ id: `${problem.id}-fact`, projectId: problem.projectId, profileId: projectById.get(problem.projectId)?.profileId ?? profileId, type: "challenge", title: problem.problem, content: [`原因：${problem.cause}`, `解决：${problem.solution}`, `结果：${problem.result}`].join("\n"), confidence: projectById.get(problem.projectId)?.confidence ?? 0.65, verified: false, sourceIds: problem.sourceIds, createdAt: now, updatedAt: now });
    const questionBank = new SqliteQuestionBankRepository(this.database);
    for (const question of snapshot.interviewQuestions) {
      const project = projectById.get(question.projectId);
      questionBank.saveQuestion({ id: question.id, canonicalText: question.question, type: "project", scope: "project", profileId, projectId: question.projectId, source: "generated", confidence: project?.confidence ?? 0.65, verified: false, variants: question.keywords });
      questionBank.saveAnswerCard({ id: `${question.id}-generated-answer`, questionId: question.id, content: question.answerPoints.join("\n"), keyPoints: question.answerPoints, sourceType: "generated", verified: false });
    }
    this.database.flushNow();
    return this.getSnapshot(profileId);
  }

  listFacts(profileId: string, projectId?: string): ProjectFact[] {
      const rows = projectId
      ? this.database.all<Record<string, unknown>>("SELECT f.id, f.project_id AS projectId, p.profile_id AS profileId, f.fact_type AS type, f.title, f.content, f.confidence, f.verified, f.embedding_json AS embeddingJson, f.created_at AS createdAt, f.updated_at AS updatedAt FROM project_facts f JOIN projects p ON p.id = f.project_id WHERE p.profile_id = ? AND f.project_id = ? AND f.status = 'active' ORDER BY f.verified DESC, f.confidence DESC, f.updated_at DESC", [profileId, projectId])
      : this.database.all<Record<string, unknown>>("SELECT f.id, f.project_id AS projectId, p.profile_id AS profileId, f.fact_type AS type, f.title, f.content, f.confidence, f.verified, f.embedding_json AS embeddingJson, f.created_at AS createdAt, f.updated_at AS updatedAt FROM project_facts f JOIN projects p ON p.id = f.project_id WHERE p.profile_id = ? AND f.status = 'active' ORDER BY f.verified DESC, f.confidence DESC, f.updated_at DESC", [profileId]);
    return rows.map((row) => this.hydrateFact(row));
  }

  getFact(factId: string): ProjectFact | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT f.id, f.project_id AS projectId, p.profile_id AS profileId, f.fact_type AS type, f.title, f.content, f.confidence, f.verified, f.created_at AS createdAt, f.updated_at AS updatedAt FROM project_facts f JOIN projects p ON p.id = f.project_id WHERE f.id = ?", [factId]);
    return row ? this.hydrateFact(row) : undefined;
  }

  setFactVerification(factId: string, verified: boolean, now = Date.now()): ProjectFact | undefined {
    if (!this.getFact(factId)) return undefined;
    this.database.run("UPDATE project_facts SET verified = ?, updated_at = ? WHERE id = ?", [verified ? 1 : 0, now, factId]);
    this.database.flushNow();
    return this.getFact(factId);
  }

  searchFacts(profileId: string, query: string, options: { projectId?: string; detectedProjectId?: string; queryEmbedding?: number[]; questionType?: string; limit?: number; minScore?: number } = {}): ProjectFactMatch[] {
    const hits = new ProjectFactMemoryRetriever().search(query, this.listFacts(profileId), {
      selectedProjectId: options.projectId,
      detectedProjectId: options.detectedProjectId,
      queryEmbedding: options.queryEmbedding,
      questionType: options.questionType,
      topK: options.limit,
      minScore: options.minScore
    });
    return hits.map((hit: ProjectRetrievalHit) => ({ ...hit, score: hit.finalScore }));
  }

  private hydrateFact(row: Record<string, unknown>): ProjectFact {
    const sourceIds = this.database.all<{ sourceId: string }>("SELECT source_id AS sourceId FROM project_fact_sources WHERE fact_id = ? ORDER BY created_at", [String(row.id)]).map((item) => item.sourceId);
    const embedding = jsonArray<number>(row.embeddingJson);
    return { id: String(row.id), projectId: String(row.projectId), profileId: String(row.profileId), type: String(row.type) as ProjectFactType, title: String(row.title), content: String(row.content), confidence: Number(row.confidence ?? 1), verified: Number(row.verified) === 1, sourceIds, ...(embedding.length ? { embedding } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  stats(profileId: string): ProjectMemoryStats {
    const snapshot = this.getSnapshot(profileId);
    return { projects: snapshot.projects.length, modules: snapshot.modules.length, technicalPoints: snapshot.technicalPoints.length, problems: snapshot.problems.length, interviewQuestions: snapshot.interviewQuestions.length };
  }
}

export { SqliteRetrievalRepository } from "./database/retrieval-repository";
export type { RetrievalHitInput, RetrievalRunRecord } from "./database/retrieval-repository";

export interface KnowledgeAnalysisRunRecord {
  id: string;
  profileId?: string;
  runType: string;
  inputHash: string;
  model?: string;
  promptVersion?: string;
  status: "running" | "completed" | "failed";
  inputSnapshot: unknown;
  output?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export class SqliteKnowledgeAnalysisRepository {
  constructor(private readonly database: SqliteDatabase) {}

  record(input: Omit<KnowledgeAnalysisRunRecord, "id" | "createdAt" | "updatedAt"> & { id?: string; now?: number }): KnowledgeAnalysisRunRecord {
    const now = input.now ?? Date.now();
    const runId = input.id ?? id("analysis", now);
    this.database.run("INSERT INTO knowledge_analysis_runs(id, profile_id, run_type, input_hash, model, prompt_version, status, input_snapshot_json, output_json, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, run_type=excluded.run_type, input_hash=excluded.input_hash, model=excluded.model, prompt_version=excluded.prompt_version, status=excluded.status, input_snapshot_json=excluded.input_snapshot_json, output_json=excluded.output_json, error=excluded.error, updated_at=excluded.updated_at", [runId, input.profileId ?? null, input.runType, input.inputHash, input.model ?? null, input.promptVersion ?? null, input.status, JSON.stringify(input.inputSnapshot), input.output === undefined ? null : JSON.stringify(input.output), input.error ?? null, now, now]);
    this.database.flush();
    return { id: runId, ...(input.profileId ? { profileId: input.profileId } : {}), runType: input.runType, inputHash: input.inputHash, ...(input.model ? { model: input.model } : {}), ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}), status: input.status, inputSnapshot: input.inputSnapshot, ...(input.output === undefined ? {} : { output: input.output }), ...(input.error ? { error: input.error } : {}), createdAt: now, updatedAt: now };
  }

  list(profileId: string): KnowledgeAnalysisRunRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, profile_id AS profileId, run_type AS runType, input_hash AS inputHash, model, prompt_version AS promptVersion, status, input_snapshot_json AS inputSnapshotJson, output_json AS outputJson, error, created_at AS createdAt, updated_at AS updatedAt FROM knowledge_analysis_runs WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]).map((row) => ({ id: String(row.id), profileId: String(row.profileId), runType: String(row.runType), inputHash: String(row.inputHash), ...(row.model ? { model: String(row.model) } : {}), ...(row.promptVersion ? { promptVersion: String(row.promptVersion) } : {}), status: String(row.status) as KnowledgeAnalysisRunRecord["status"], inputSnapshot: JSON.parse(String(row.inputSnapshotJson)), ...(row.outputJson ? { output: JSON.parse(String(row.outputJson)) } : {}), ...(row.error ? { error: String(row.error) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }));
  }
}

export interface JobRequirementRecord {
  id: string;
  jobTargetId: string;
  category: string;
  requirement: string;
  importance: "high" | "medium" | "low";
  sourceQuote?: string;
  verified: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface JobTargetRecord {
  id: string;
  profileId: string;
  name: string;
  company?: string;
  role?: string;
  description: string;
  status: "active" | "inactive";
  requirements: JobRequirementRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface JobRequirementMatch {
  requirement: JobRequirementRecord;
  score: number;
}

function parseJobRequirements(text: string): Array<{ category: string; requirement: string; importance: "high" | "medium" | "low" }> {
  return text.split(/\r?\n+/).map((line) => line.replace(/^\s*[-*•\d.、)]+\s*/, "").trim()).filter((line) => line.length >= 6 && /任职要求|岗位职责|负责|熟悉|掌握|精通|经验|技能|能力|开发|维护|设计|测试|优化/.test(line)).slice(0, 80).map((requirement) => ({ category: /负责|开发|维护|设计|测试|优化/.test(requirement) ? "responsibility" : "requirement", requirement, importance: /必须|熟练|精通|核心|至少|优先/.test(requirement) ? "high" : /了解|加分|优先考虑/.test(requirement) ? "low" : "medium" }));
}

export class SqliteJobTargetRepository {
  constructor(private readonly database: SqliteDatabase) {}

  syncProfile(profile: Profile, now = Date.now()): JobTargetRecord | undefined {
    const job = profile.jobDescription;
    const targetId = `job-target-${profile.id}`;
    if (!job?.rawContent?.trim()) {
      this.database.run("UPDATE job_targets SET status = 'inactive', updated_at = ? WHERE id = ?", [now, targetId]);
      this.database.flush();
      return this.get(targetId);
    }
    const existing = this.get(targetId);
    this.database.run("INSERT INTO job_targets(id, profile_id, source_document_id, name, company, role, description, status, created_at, updated_at) VALUES (?, ?, NULL, ?, NULL, NULL, ?, 'active', ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, name=excluded.name, description=excluded.description, status='active', updated_at=excluded.updated_at", [targetId, profile.id, job.summary.trim() || "目标岗位", job.rawContent, existing?.createdAt ?? now, now]);
    this.database.run("DELETE FROM job_requirements WHERE job_target_id = ?", [targetId]);
    for (const [index, requirement] of parseJobRequirements(job.rawContent).entries()) this.database.run("INSERT INTO job_requirements(id, job_target_id, category, requirement, importance, source_quote, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)", [`${targetId}-requirement-${index + 1}`, targetId, requirement.category, requirement.requirement, requirement.importance, requirement.requirement, now, now]);
    this.database.flushNow();
    return this.get(targetId);
  }

  get(targetId: string): JobTargetRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, profile_id AS profileId, name, company, role, description, status, created_at AS createdAt, updated_at AS updatedAt FROM job_targets WHERE id = ?", [targetId]);
    if (!row) return undefined;
    return this.hydrate(row);
  }

  list(profileId?: string): JobTargetRecord[] {
    const rows = profileId
      ? this.database.all<Record<string, unknown>>("SELECT id, profile_id AS profileId, name, company, role, description, status, created_at AS createdAt, updated_at AS updatedAt FROM job_targets WHERE profile_id = ? ORDER BY updated_at DESC", [profileId])
      : this.database.all<Record<string, unknown>>("SELECT id, profile_id AS profileId, name, company, role, description, status, created_at AS createdAt, updated_at AS updatedAt FROM job_targets ORDER BY updated_at DESC");
    return rows.map((row) => this.hydrate(row));
  }

  searchRequirements(profileId: string, query: string, limit = 5, targetId?: string): JobRequirementMatch[] {
    const targetIds = targetId
      ? this.database.all<{ id: string }>("SELECT id FROM job_targets WHERE profile_id = ? AND status = 'active' AND id = ?", [profileId, targetId]).map((row) => row.id)
      : this.database.all<{ id: string }>("SELECT id FROM job_targets WHERE profile_id = ? AND status = 'active'", [profileId]).map((row) => row.id);
    if (targetIds.length === 0) return [];
    const placeholders = targetIds.map(() => "?").join(",");
    return this.database.all<Record<string, unknown>>(`SELECT id, job_target_id AS jobTargetId, category, requirement, importance, source_quote AS sourceQuote, verified, created_at AS createdAt, updated_at AS updatedAt FROM job_requirements WHERE job_target_id IN (${placeholders})`, targetIds).map((row) => {
      const requirement = this.hydrateRequirement(row);
      return { requirement, score: questionBankSimilarity(query, requirement.requirement) };
    }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score).slice(0, Math.max(1, Math.min(20, limit)));
  }

  private hydrate(row: Record<string, unknown>): JobTargetRecord {
    const requirements = this.database.all<Record<string, unknown>>("SELECT id, job_target_id AS jobTargetId, category, requirement, importance, source_quote AS sourceQuote, verified, created_at AS createdAt, updated_at AS updatedAt FROM job_requirements WHERE job_target_id = ? ORDER BY importance DESC, updated_at DESC", [String(row.id)]).map((item) => this.hydrateRequirement(item));
    return { id: String(row.id), profileId: String(row.profileId), name: String(row.name), ...(row.company ? { company: String(row.company) } : {}), ...(row.role ? { role: String(row.role) } : {}), description: String(row.description), status: String(row.status) as JobTargetRecord["status"], requirements, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  private hydrateRequirement(row: Record<string, unknown>): JobRequirementRecord {
    return { id: String(row.id), jobTargetId: String(row.jobTargetId), category: String(row.category), requirement: String(row.requirement), importance: String(row.importance) as JobRequirementRecord["importance"], ...(row.sourceQuote ? { sourceQuote: String(row.sourceQuote) } : {}), verified: Number(row.verified) === 1, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
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
    // Streaming updates arrive once per token. A synchronous full-database
    // export here blocks Electron's main process and makes the window appear
    // unresponsive while an answer is being generated. Batch intermediate
    // writes, but persist terminal states immediately.
    if (status === "streaming") this.database.flush();
    else this.database.flushNow();
  }

  recoverInterruptedMessages(now = Date.now()): number {
    const interrupted = this.database.all<{ id: string }>("SELECT id FROM conversation_messages WHERE status = 'streaming'");
    if (interrupted.length === 0) return 0;
    this.database.run("UPDATE conversation_messages SET status = 'error' WHERE status = 'streaming'");
    this.database.run("UPDATE conversations SET updated_at = ? WHERE id IN (SELECT conversation_id FROM conversation_messages WHERE status = 'error')", [now]);
    this.database.flushNow();
    return interrupted.length;
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
    this.database.run("INSERT INTO interviews(id, profile_id, project_id, job_target_id, started_at, ended_at, status, language, automation_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.profileId, record.projectId ?? null, record.jobTargetId ?? null, record.startedAt, record.endedAt ?? null, record.status, record.language, record.automationMode, record.createdAt]);
    this.database.flushNow();
    return record;
  }

  endInterview(interviewId: string, status: "ended" | "error" = "ended", endedAt = Date.now()): InterviewRecord {
    this.database.run("UPDATE interviews SET status = ?, ended_at = ? WHERE id = ?", [status, endedAt, interviewId]);
    this.database.flushNow();
    const record = this.database.first<InterviewRecord>("SELECT id, profile_id AS profileId, project_id AS projectId, job_target_id AS jobTargetId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews WHERE id = ?", [interviewId]);
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
    this.database.run("INSERT INTO questions(id, interview_id, text, confidence, source, detected_at, status, parent_question_id, root_question_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.interviewId, record.text, record.confidence, record.source, record.detectedAt, record.status, record.parentQuestionId ?? null, record.rootQuestionId ?? null]);
    this.database.flush();
    return record;
  }

  updateQuestionStatus(questionId: string, status: QuestionRecord["status"]): QuestionRecord | undefined {
    this.database.run("UPDATE questions SET status = ? WHERE id = ?", [status, questionId]);
    this.database.flushNow();
    return this.database.first<QuestionRecord>("SELECT id, interview_id AS interviewId, text, confidence, source, detected_at AS detectedAt, status, parent_question_id AS parentQuestionId, root_question_id AS rootQuestionId FROM questions WHERE id = ?", [questionId]);
  }

  addAnswer(input: Omit<AnswerRecord, "id">): AnswerRecord {
    const record = { ...input, id: id("answer", input.createdAt) };
    this.database.run("INSERT INTO answers(id, question_id, text, model, mode, latency_first_token, latency_total, cancel_reason, started_at, first_token_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.questionId, record.text, record.model, record.mode ?? null, record.latencyFirstToken ?? null, record.latencyTotal ?? null, record.cancelReason ?? null, record.startedAt ?? null, record.firstTokenAt ?? null, record.finishedAt ?? null, record.createdAt]);
    this.database.flushNow();
    return record;
  }

  listInterviews(): InterviewRecord[] {
    return this.database.all<InterviewRecord>("SELECT id, profile_id AS profileId, project_id AS projectId, job_target_id AS jobTargetId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews ORDER BY created_at DESC");
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
    const interview = this.database.first<InterviewRecord>("SELECT id, profile_id AS profileId, project_id AS projectId, job_target_id AS jobTargetId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews WHERE id = ?", [interviewId]);
    if (!interview) throw new Error(`Interview not found: ${interviewId}`);
    const transcripts = this.database.all<TranscriptRecord>("SELECT id, interview_id AS interviewId, source, text, start_ms AS startMs, end_ms AS endMs, final, confidence, created_at AS createdAt FROM transcripts WHERE interview_id = ? ORDER BY start_ms", [interviewId]);
    const questions = this.database.all<QuestionRecord>("SELECT id, interview_id AS interviewId, text, confidence, source, detected_at AS detectedAt, status, parent_question_id AS parentQuestionId, root_question_id AS rootQuestionId FROM questions WHERE interview_id = ? ORDER BY detected_at", [interviewId]);
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

  /** Mark imports interrupted by an app restart so they are visible and can be retried. */
  recoverProcessingDocuments(now = Date.now()): void {
    this.database.run("UPDATE documents SET status = 'error', error = ?, updated_at = ? WHERE status = 'processing'", ["上次导入未完成，请重新导入或重建索引", now]);
    this.database.flushNow();
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
    this.database.run("BEGIN");
    try {
      this.database.run("DELETE FROM knowledge_chunks WHERE document_id = ?", [documentId]);
      chunks.forEach((chunk) => this.database.run("INSERT INTO knowledge_chunks(id, document_id, text, metadata_json, embedding_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [chunk.id, documentId, chunk.text, JSON.stringify(chunk.metadata), chunk.embedding ? JSON.stringify(chunk.embedding) : null, now]));
      this.database.run("COMMIT");
      this.database.flushNow();
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
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
  scope?: QuestionBankScope;
  profileId?: string;
  projectId?: string;
  jobProfileId?: string;
  difficulty?: string;
  jobRole?: string;
  source?: QuestionBankSourceType;
  status?: "active" | "archived";
  confidence?: number;
  verified?: boolean;
  embedding?: number[];
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

interface QuestionBankQuestionRow {
  id: string;
  canonicalText: string;
  normalizedText: string;
  type: QuestionBankType;
  scope: QuestionBankScope;
  profileId: string | null;
  projectId: string | null;
  jobProfileId: string | null;
  difficulty: string;
  jobRole: string | null;
  source: QuestionBankSourceType;
  status: "active" | "archived";
  confidence: number;
  verified: number;
  embeddingJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface QuestionBankAnswerGenerationResult {
  requested: number;
  generated: number;
  skipped: number;
  failed: number;
}

export class SqliteQuestionBankRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listQuestions(options: { search?: string; type?: QuestionBankType; scope?: QuestionBankScope; profileId?: string; projectId?: string; jobProfileId?: string; limit?: number } = {}): QuestionBankQuestionRecord[] {
    const clauses: string[] = ["status = 'active'"];
    const params: Array<string | number> = [];
    if (options.type) { clauses.push("type = ?"); params.push(options.type); }
    if (options.scope) { clauses.push("scope = ?"); params.push(options.scope); }
    if (options.profileId) { clauses.push("(profile_id = ? OR profile_id IS NULL)"); params.push(options.profileId); }
    if (options.projectId) { clauses.push("(project_id = ? OR project_id IS NULL)"); params.push(options.projectId); }
    if (options.jobProfileId) { clauses.push("(job_profile_id = ? OR job_profile_id IS NULL)"); params.push(options.jobProfileId); }
    if (options.search?.trim()) {
      const search = normalizeQuestionBankText(options.search);
      clauses.push("(normalized_text LIKE ? OR search_text LIKE ? OR id IN (SELECT question_id FROM question_bank_variants WHERE normalized_text LIKE ?))");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const limit = Math.max(1, Math.min(5000, options.limit ?? 200));
    params.push(limit);
    const rows = this.database.all<QuestionBankQuestionRow>(`SELECT id, canonical_text AS canonicalText, normalized_text AS normalizedText, type, scope, profile_id AS profileId, project_id AS projectId, job_profile_id AS jobProfileId, difficulty, job_role AS jobRole, source, status, confidence, verified, embedding_json AS embeddingJson, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_questions WHERE ${clauses.join(" AND ")} ORDER BY verified DESC, confidence DESC, updated_at DESC LIMIT ?`, params);
    return rows.map((row) => this.hydrateQuestion(row));
  }

  getQuestion(questionId: string): QuestionBankQuestionRecord | undefined {
    const row = this.database.first<QuestionBankQuestionRow>("SELECT id, canonical_text AS canonicalText, normalized_text AS normalizedText, type, scope, profile_id AS profileId, project_id AS projectId, job_profile_id AS jobProfileId, difficulty, job_role AS jobRole, source, status, confidence, verified, embedding_json AS embeddingJson, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_questions WHERE id = ?", [questionId]);
    return row ? this.hydrateQuestion(row) : undefined;
  }

  saveQuestion(input: QuestionBankQuestionInput, now = Date.now()): QuestionBankQuestionRecord {
    const canonicalText = input.canonicalText.trim();
    if (!canonicalText) throw new Error("QUESTION_BANK_EMPTY: 问题不能为空");
    const questionId = input.id ?? id("bank-question", now);
    const normalizedText = normalizeQuestionBankText(canonicalText);
    const existing = input.id ? this.getQuestion(input.id) : undefined;
    const variants = input.variants ?? existing?.variants ?? [];
    const searchText = normalizeQuestionBankText([canonicalText, ...variants].join(" "));
    this.database.run("INSERT INTO question_bank_questions(id, canonical_text, normalized_text, type, scope, profile_id, project_id, job_profile_id, difficulty, job_role, source, status, confidence, verified, embedding_json, search_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET canonical_text=excluded.canonical_text, normalized_text=excluded.normalized_text, type=excluded.type, scope=excluded.scope, profile_id=excluded.profile_id, project_id=excluded.project_id, job_profile_id=excluded.job_profile_id, difficulty=excluded.difficulty, job_role=excluded.job_role, source=excluded.source, status=excluded.status, confidence=excluded.confidence, verified=excluded.verified, embedding_json=excluded.embedding_json, search_text=excluded.search_text, updated_at=excluded.updated_at", [questionId, canonicalText, normalizedText, input.type ?? existing?.type ?? inferQuestionBankType(canonicalText), input.scope ?? existing?.scope ?? "global", input.profileId ?? existing?.profileId ?? null, input.projectId ?? existing?.projectId ?? null, input.jobProfileId ?? existing?.jobProfileId ?? null, input.difficulty ?? existing?.difficulty ?? "medium", input.jobRole?.trim() || existing?.jobRole || null, input.source ?? existing?.source ?? "manual", input.status ?? existing?.status ?? "active", Math.max(0, Math.min(1, input.confidence ?? existing?.confidence ?? 1)), input.verified ?? existing?.verified ?? false ? 1 : 0, input.embedding ? JSON.stringify(input.embedding) : existing?.embedding ? JSON.stringify(existing.embedding) : null, searchText, existing?.createdAt ?? now, now]);
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

  matchQuestion(text: string, options: { threshold?: number; scope?: QuestionBankScope; profileId?: string; projectId?: string; jobProfileId?: string } = {}): QuestionBankMatch | undefined {
    const threshold = options.threshold ?? 0.72;
    const matches = this.listQuestions({ limit: 5000, scope: options.scope, profileId: options.profileId, projectId: options.projectId, jobProfileId: options.jobProfileId }).map((question) => {
      const variantScore = question.variants.reduce((best, variant) => Math.max(best, questionBankSimilarity(text, variant)), 0);
      const baseScore = Math.max(questionBankSimilarity(text, question.canonicalText), variantScore);
      const trustBoost = question.verified ? 0.02 : question.confidence * 0.01;
      return { question, score: Math.min(1, baseScore + trustBoost), exact: normalizeQuestionBankText(text) === question.normalizedText };
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

  private hydrateQuestion(row: QuestionBankQuestionRow): QuestionBankQuestionRecord {
    const variants = this.database.all<{ text: string }>("SELECT text FROM question_bank_variants WHERE question_id = ? ORDER BY created_at", [row.id]).map((item) => item.text);
    const skillIds = this.database.all<{ skillId: string }>("SELECT skill_id AS skillId FROM question_bank_question_skills WHERE question_id = ?", [row.id]).map((item) => item.skillId);
    const answerCards = this.database.all<Record<string, unknown>>("SELECT id, question_id AS questionId, mode, content, code_content AS codeContent, key_points_json AS keyPointsJson, complexity, limitations, source_type AS sourceType, verified, version, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_answer_cards WHERE question_id = ? ORDER BY verified DESC, updated_at DESC", [row.id]).map((item) => this.hydrateAnswerCard(item));
    return { id: row.id, canonicalText: row.canonicalText, normalizedText: row.normalizedText, type: row.type, scope: row.scope || "global", ...(row.profileId ? { profileId: row.profileId } : {}), ...(row.projectId ? { projectId: row.projectId } : {}), ...(row.jobProfileId ? { jobProfileId: row.jobProfileId } : {}), difficulty: row.difficulty, ...(row.jobRole ? { jobRole: row.jobRole } : {}), source: row.source, status: row.status, confidence: Number(row.confidence ?? 1), verified: Number(row.verified) === 1, ...(row.embeddingJson ? { embedding: JSON.parse(row.embeddingJson) as number[] } : {}), variants, answerCards, skillIds, createdAt: row.createdAt, updatedAt: row.updatedAt };
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
