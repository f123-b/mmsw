import initSqlJs, { type SqlJsStatic } from "sql.js";
import { createHash } from "node:crypto";
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
  type HistoryChangedEvent,
  type TerminologyCorrection,
  type KnowledgeChunk,
  inferKnowledgeDocumentType,
  type KnowledgeDocumentType,
  type ProfileBuilderOutput,
  type ResumeAnalysis,
  RESUME_ANALYSIS_VERSION,
  PROFILE_BUILDER_VERSION,
  type ProfileBuilderSourceKind,
  type SkillSuggestion,
  type SkillSuggestionStatus,
  inferQuestionBankType,
  inferQuestionBankBankType,
  normalizeQuestionBankText,
  parseQuestionBankText,
  questionBankSimilarity,
  QuestionBankRouter,
  type QuestionBankAnswerCardRecord,
  type QuestionBankAnswerMode,
  type QuestionBankBankType,
  type QuestionBankJobProfileRecord,
  type QuestionBankMatch,
  type QuestionBankQuestionRecord,
  type QuestionBankRelationRecord,
  type QuestionBankRelationType,
  type QuestionBankRouteOptions,
  type QuestionBankRouteResult,
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
  type ProjectFactType,
  type ProjectSourceAssignment,
  type ProjectSourceRelationship,
  type ProjectSourceType,
  type ProjectSourceRole,
  type ProjectSourceAssignmentMethod,
  type ProjectFactEvidence,
  type ProjectConflictGroup,
  type ProjectUserAction,
  ProjectFactConflictResolver,
  listConflictGroups,
  listUserActions,
  withFactSemantics,
  normalizeProfileBuilderArtifact,
  calculateProjectCompleteness,
  calculateQuestionBankCoverage,
  type ProjectCompletenessResult,
  type QuestionBankCoverageResult,
  deriveProjectView,
  isFactEligible,
  isFactReviewRequired,
  isFactUserActionRequired,
  normalizeSkillKey,
  canonicalProjectParameterKey,
  inferExperienceRelation,
  normalizeProjectFactValue,
  normalizeProjectOwnershipMode,
  type ProjectOwnershipMode,
  type ProjectUnderstanding,
  type ProjectUnderstandingSnapshotRecord,
  type ProjectAnalysisJob,
  type ProjectQuestionBankImportReport,
  type RepositoryManifest,
  type RepositorySourceFile,
  type RepositorySkippedFile
  , type TechnicalDomain
  , type TechnicalTerm
} from "@interview-copilot/shared";
import type { ChatCancelReason, ChatMessageStatus, ChatResponse, ChatStreamTelemetry } from "@interview-copilot/shared";

export const APP_DATA_DIRECTORY = "InterviewCopilot";

function safeJson<T>(raw: unknown): T | undefined {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" ? value as T : undefined;
  } catch {
    return undefined;
  }
}

export interface DatabaseFlushDiagnostics {
  databaseFlushDurationMs: number;
  databaseSize: number;
  pendingFlush: boolean;
  lastFlushAt?: number;
  lastDiagnostic?: "DATABASE_FLUSH_SLOW";
}

function id(prefix: string, now: number): string { return `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`; }

function projectFactEmbeddingHash(title: string, content: string): string {
  return createHash("sha256").update(`${title}\n${content}`).digest("hex");
}

function slugDatabase(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 64) || `project-${Date.now()}`;
}

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

  flush(delayMs = 500): void {
    if (this.filePath === ":memory:" || !this.dirty || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushNow();
    }, delayMs);
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
        -- Deprecated compatibility projection. Runtime question writes use
        -- question_bank_*; migration 10 copied existing rows forward.
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
      `],
      [14, `
        ALTER TABLE project_facts ADD COLUMN embedding_hash TEXT;
        ALTER TABLE project_facts ADD COLUMN embedding_model TEXT;
        ALTER TABLE project_facts ADD COLUMN embedding_version TEXT;
        ALTER TABLE project_facts ADD COLUMN embedding_updated_at INTEGER;
        CREATE INDEX IF NOT EXISTS project_facts_embedding_idx ON project_facts(embedding_hash, embedding_model, embedding_version);
      `],
      [15, `
        ALTER TABLE projects ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE knowledge_analysis_runs ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
        ALTER TABLE knowledge_analysis_runs ADD COLUMN started_at INTEGER;
        ALTER TABLE knowledge_analysis_runs ADD COLUMN finished_at INTEGER;
        ALTER TABLE knowledge_analysis_runs ADD COLUMN snapshot_version INTEGER;
        ALTER TABLE question_bank_questions ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE question_bank_answer_cards ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS project_sources (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          relationship TEXT NOT NULL DEFAULT 'primary',
          confidence REAL NOT NULL DEFAULT 1,
          verified INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, source_type, source_id)
        );
        CREATE INDEX IF NOT EXISTS project_sources_project_idx ON project_sources(project_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS project_sources_source_idx ON project_sources(source_type, source_id);
        CREATE TABLE IF NOT EXISTS project_analysis_state (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          latest_analysis_id TEXT,
          last_successful_analysis_id TEXT,
          status TEXT NOT NULL,
          snapshot_version INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS question_bank_question_facts (
          question_id TEXT NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
          fact_id TEXT NOT NULL REFERENCES project_facts(id) ON DELETE CASCADE,
          PRIMARY KEY(question_id, fact_id)
        );
        CREATE INDEX IF NOT EXISTS question_bank_question_facts_fact_idx ON question_bank_question_facts(fact_id);
      `],
      [16, `
        ALTER TABLE conversation_messages ADD COLUMN provider TEXT;
        ALTER TABLE conversation_messages ADD COLUMN error_code TEXT;
        ALTER TABLE conversation_messages ADD COLUMN cancel_reason TEXT;
        ALTER TABLE conversation_messages ADD COLUMN started_at INTEGER;
        ALTER TABLE conversation_messages ADD COLUMN first_token_at INTEGER;
        ALTER TABLE conversation_messages ADD COLUMN finished_at INTEGER;
        ALTER TABLE conversation_messages ADD COLUMN duration_ms INTEGER;
        ALTER TABLE conversation_messages ADD COLUMN finish_reason TEXT;
        ALTER TABLE conversation_messages ADD COLUMN characters_generated INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS conversation_messages_status_idx ON conversation_messages(status, created_at);
      `],
      [17, `
        ALTER TABLE conversation_messages ADD COLUMN response_json TEXT;
      `],
      [18, `
        ALTER TABLE profiles ADD COLUMN expression_level TEXT NOT NULL DEFAULT 'plain';
        ALTER TABLE profiles ADD COLUMN explain_advanced_terms INTEGER NOT NULL DEFAULT 1;
      `],
      [19, `
        ALTER TABLE project_sources ADD COLUMN source_role TEXT NOT NULL DEFAULT 'overview';
        ALTER TABLE project_sources ADD COLUMN assignment_method TEXT NOT NULL DEFAULT 'explicit';
        ALTER TABLE project_facts ADD COLUMN evidence_level TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE project_facts ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';
        ALTER TABLE project_facts ADD COLUMN section_path_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE project_facts ADD COLUMN subtype TEXT;
        ALTER TABLE project_facts ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'pending_review';
        ALTER TABLE project_facts ADD COLUMN conflict_group_id TEXT;
        ALTER TABLE project_facts ADD COLUMN ownership TEXT NOT NULL DEFAULT 'project';
        ALTER TABLE project_facts ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE project_fact_sources ADD COLUMN relation TEXT NOT NULL DEFAULT 'support';
        CREATE INDEX IF NOT EXISTS project_facts_conflict_idx ON project_facts(project_id, conflict_group_id, conflict_status);
        CREATE INDEX IF NOT EXISTS project_sources_role_idx ON project_sources(project_id, source_role, updated_at DESC);
      `],
      [20, `
        CREATE TABLE IF NOT EXISTS project_skills (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
          source_fact_id TEXT REFERENCES project_facts(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, skill_id)
        );
        CREATE INDEX IF NOT EXISTS project_skills_skill_idx ON project_skills(skill_id, project_id);
      `],
      [21, `
        -- Repair rows created before the trust pipeline had explicit defaults.
        UPDATE project_facts
        SET conflict_status = CASE WHEN status = 'conflicting' THEN 'conflicting' ELSE 'confirmed' END
        WHERE status <> 'rejected' AND conflict_group_id IS NULL;
        UPDATE project_facts
        SET conflict_status = 'conflicting'
        WHERE status = 'conflicting' AND status <> 'rejected';
        UPDATE project_facts
        SET ownership = 'self', evidence_level = 'confirmed-user'
        WHERE status <> 'rejected' AND verified = 1 AND fact_type = 'responsibility';
        UPDATE project_facts
        SET evidence_level = 'confirmed-user'
        WHERE status <> 'rejected' AND verified = 1 AND evidence_level = 'pending' AND fact_type <> 'responsibility';
        UPDATE project_facts
        SET evidence_level = CASE
          WHEN EXISTS (
            SELECT 1 FROM project_fact_sources pfs
            JOIN project_sources ps ON ps.project_id = project_facts.project_id AND ps.source_id = pfs.source_id
            WHERE pfs.fact_id = project_facts.id AND COALESCE(pfs.quote, '') <> ''
              AND (ps.source_role = 'code' OR ps.source_type = 'repository')
          ) THEN 'confirmed-code'
          WHEN EXISTS (
            SELECT 1 FROM project_fact_sources pfs
            JOIN project_sources ps ON ps.project_id = project_facts.project_id AND ps.source_id = pfs.source_id
            WHERE pfs.fact_id = project_facts.id AND COALESCE(pfs.quote, '') <> ''
              AND (ps.source_role IN ('responsibility', 'resume') OR ps.source_type = 'user_fact')
          ) THEN 'confirmed-user'
          WHEN EXISTS (
            SELECT 1 FROM project_fact_sources pfs
            JOIN project_sources ps ON ps.project_id = project_facts.project_id AND ps.source_id = pfs.source_id
            WHERE pfs.fact_id = project_facts.id AND COALESCE(pfs.quote, '') <> ''
              AND (ps.source_role IN ('overview', 'architecture', 'test') OR ps.source_type = 'document')
          ) THEN 'confirmed-document'
          ELSE evidence_level
        END
        WHERE status <> 'rejected' AND verified = 0 AND evidence_level = 'pending'
          AND EXISTS (SELECT 1 FROM project_fact_sources pfs WHERE pfs.fact_id = project_facts.id AND COALESCE(pfs.quote, '') <> '');
      `],
      [22, `
        CREATE INDEX IF NOT EXISTS project_facts_semantics_idx ON project_facts(project_id, canonical_key, cardinality, conflict_status);
      `],
      [23, `
        ALTER TABLE projects ADD COLUMN ownership_mode TEXT NOT NULL DEFAULT 'personal';
        ALTER TABLE projects ADD COLUMN ownership_note TEXT;
        ALTER TABLE project_facts ADD COLUMN experience_relation TEXT NOT NULL DEFAULT 'project';
        ALTER TABLE project_facts ADD COLUMN value_json TEXT;
        UPDATE project_facts SET experience_relation = CASE
          WHEN fact_type = 'metric' THEN 'measured'
          WHEN fact_type IN ('architecture', 'technical_decision', 'decision') THEN 'designed'
          WHEN fact_type IN ('challenge', 'cause') THEN 'observed'
          WHEN fact_type IN ('technology', 'software', 'hardware') THEN 'used'
          ELSE 'project'
        END
        WHERE experience_relation = 'project';
        CREATE INDEX IF NOT EXISTS project_facts_runtime_v4_idx ON project_facts(project_id, status, stale, fact_type, canonical_key);
      `],
      [24, `
        CREATE TABLE IF NOT EXISTS project_understanding_snapshots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          input_hash TEXT NOT NULL,
          model TEXT,
          status TEXT NOT NULL,
          understanding_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS project_understanding_project_idx ON project_understanding_snapshots(project_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS project_understanding_input_idx ON project_understanding_snapshots(project_id, input_hash, updated_at DESC);
      `],
      [25, `
        CREATE TABLE IF NOT EXISTS repository_source_files (
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          language TEXT,
          size INTEGER NOT NULL,
          sha256 TEXT,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(document_id, path)
        );
        CREATE INDEX IF NOT EXISTS repository_source_files_document_idx ON repository_source_files(document_id, path);
        CREATE TABLE IF NOT EXISTS repository_manifests (
          document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
          manifest_json TEXT NOT NULL,
          skipped_files_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_analysis_jobs (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER,
          progress REAL NOT NULL DEFAULT 0,
          files_total INTEGER NOT NULL DEFAULT 0,
          files_explored INTEGER NOT NULL DEFAULT 0,
          tool_calls INTEGER NOT NULL DEFAULT 0,
          model_turns INTEGER NOT NULL DEFAULT 0,
          error_code TEXT,
          error_message TEXT,
          cancel_requested INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS project_analysis_jobs_project_idx ON project_analysis_jobs(project_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS project_analysis_jobs_profile_idx ON project_analysis_jobs(profile_id, updated_at DESC);
      `],
      [26, `
        ALTER TABLE question_bank_questions ADD COLUMN bank_type TEXT NOT NULL DEFAULT 'general';
        ALTER TABLE question_bank_questions ADD COLUMN category TEXT NOT NULL DEFAULT 'technical';
        ALTER TABLE question_bank_questions ADD COLUMN module_id TEXT;
        ALTER TABLE question_bank_questions ADD COLUMN frequency INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE question_bank_questions ADD COLUMN last_asked_at INTEGER;
        ALTER TABLE question_bank_questions ADD COLUMN mastery REAL NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS question_bank_questions_bank_idx ON question_bank_questions(bank_type, category, updated_at DESC);
        CREATE INDEX IF NOT EXISTS question_bank_questions_module_idx ON question_bank_questions(module_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS question_bank_questions_mastery_idx ON question_bank_questions(mastery, frequency, updated_at DESC);
        CREATE TABLE IF NOT EXISTS question_bank_relations (
          id TEXT PRIMARY KEY,
          source_question_id TEXT NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
          target_question_id TEXT NOT NULL REFERENCES question_bank_questions(id) ON DELETE CASCADE,
          relation_type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(source_question_id, target_question_id, relation_type)
        );
        CREATE INDEX IF NOT EXISTS question_bank_relations_source_idx ON question_bank_relations(source_question_id, relation_type, updated_at DESC);
        CREATE INDEX IF NOT EXISTS question_bank_relations_target_idx ON question_bank_relations(target_question_id, relation_type, updated_at DESC);
        UPDATE question_bank_questions
        SET bank_type = CASE
          WHEN scope = 'project' OR project_id IS NOT NULL OR type = 'project' THEN 'project'
          WHEN scope = 'job' OR job_profile_id IS NOT NULL OR source = 'jd' THEN 'job'
          WHEN type = 'behavioral' THEN 'behavioral'
          WHEN type = 'general' THEN 'general'
          ELSE 'skill'
        END,
        category = type;
      `],
      [27, `
        ALTER TABLE transcripts ADD COLUMN raw_text TEXT;
        ALTER TABLE transcripts ADD COLUMN normalized_text TEXT;
        ALTER TABLE transcripts ADD COLUMN canonical_text TEXT;
        ALTER TABLE transcripts ADD COLUMN terminology_corrections_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE questions ADD COLUMN raw_transcript TEXT;
        ALTER TABLE questions ADD COLUMN normalized_question TEXT;
        ALTER TABLE questions ADD COLUMN canonical_question TEXT;
        ALTER TABLE questions ADD COLUMN context_relation TEXT;
        ALTER TABLE questions ADD COLUMN inherited_topic TEXT;
        ALTER TABLE questions ADD COLUMN topic TEXT;
        ALTER TABLE questions ADD COLUMN terminology_corrections_json TEXT NOT NULL DEFAULT '[]';
      `],
      [28, `
        ALTER TABLE questions ADD COLUMN semantic_frame TEXT;
      `],
      [29, `
        ALTER TABLE profiles ADD COLUMN company_context TEXT;
        ALTER TABLE profiles ADD COLUMN salary_expectation_json TEXT;
      `],
      [30, `
        ALTER TABLE answers ADD COLUMN telemetry_json TEXT;
      `],
      [31, `
        ALTER TABLE questions ADD COLUMN group_id TEXT;
        ALTER TABLE questions ADD COLUMN relation_type TEXT;
        ALTER TABLE questions ADD COLUMN thread_item_type TEXT;
        ALTER TABLE answers ADD COLUMN group_id TEXT;
        ALTER TABLE answers ADD COLUMN relation TEXT;
        ALTER TABLE answers ADD COLUMN answer_run_id TEXT;
        CREATE INDEX IF NOT EXISTS questions_group_idx ON questions(interview_id, group_id, detected_at);
        CREATE INDEX IF NOT EXISTS answers_group_idx ON answers(group_id, created_at);
      `],
      [32, `
        CREATE TABLE IF NOT EXISTS profile_skill_suggestions (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          normalized_name TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          confidence REAL NOT NULL DEFAULT 0,
          evidence_ids_json TEXT NOT NULL DEFAULT '[]',
          evidence_quotes_json TEXT NOT NULL DEFAULT '[]',
          source_kinds_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending',
          confirmed_at INTEGER,
          rejected_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(profile_id, normalized_name)
        );
        CREATE INDEX IF NOT EXISTS profile_skill_suggestions_profile_idx ON profile_skill_suggestions(profile_id, status, updated_at DESC);
      `],
      [33, `
        ALTER TABLE skills ADD COLUMN source TEXT;
        ALTER TABLE skills ADD COLUMN evidence_refs_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE skills ADD COLUMN confirmed_at INTEGER;
      `],
      [34, `
        ALTER TABLE profile_skill_suggestions ADD COLUMN analysis_version INTEGER NOT NULL DEFAULT 1;
        CREATE INDEX IF NOT EXISTS profile_skill_suggestions_version_idx ON profile_skill_suggestions(profile_id, analysis_version, status, updated_at DESC);
      `],
      [35, `
        CREATE TABLE IF NOT EXISTS resume_analyses (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          resume_hash TEXT NOT NULL,
          analyzer_version INTEGER NOT NULL,
          analysis_quality TEXT NOT NULL,
          artifact_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(profile_id, resume_hash, analyzer_version)
        );
        CREATE INDEX IF NOT EXISTS resume_analyses_profile_idx ON resume_analyses(profile_id, updated_at DESC);
      `],
      [36, `
        CREATE TABLE IF NOT EXISTS terminology_custom_terms (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          canonical TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          phonetic_aliases_json TEXT NOT NULL DEFAULT '[]',
          domains_json TEXT NOT NULL DEFAULT '[]',
          tags_json TEXT NOT NULL DEFAULT '[]',
          priority INTEGER NOT NULL DEFAULT 120,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(profile_id, canonical)
        );
        CREATE INDEX IF NOT EXISTS terminology_custom_terms_profile_idx ON terminology_custom_terms(profile_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS terminology_user_corrections (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          raw TEXT NOT NULL,
          canonical TEXT NOT NULL,
          confidence REAL NOT NULL,
          source TEXT NOT NULL DEFAULT 'user',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS terminology_user_corrections_profile_idx ON terminology_user_corrections(profile_id, created_at DESC);
      `],
    ];
    for (const [version, sql] of migrations) {
      if (version <= current) continue;
      this.database.run("BEGIN");
      try {
        if (version === 22) {
          const columns = new Set(this.all<{ name: string }>("PRAGMA table_info(project_facts)").map((row) => row.name));
          for (const column of ["canonical_key", "cardinality", "variant_context"]) {
            if (!columns.has(column)) this.database.run(`ALTER TABLE project_facts ADD COLUMN ${column} TEXT`);
          }
        }
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

export interface TerminologyCustomTermInput {
  profileId: string;
  canonical: string;
  aliases?: string[];
  phoneticAliases?: string[];
  domains?: TechnicalDomain[];
  tags?: string[];
  priority?: number;
}

export interface TerminologyUserCorrectionRecord {
  id: string;
  profileId: string;
  raw: string;
  canonical: string;
  confidence: number;
  source: "user";
  createdAt: number;
}

export class SqliteTerminologyRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listTerms(profileId: string): TechnicalTerm[] {
    return this.database.all<{ id: string; canonical: string; aliases_json: string; phonetic_aliases_json: string; domains_json: string; tags_json: string; priority: number }>("SELECT id, canonical, aliases_json, phonetic_aliases_json, domains_json, tags_json, priority FROM terminology_custom_terms WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]).map((row) => ({ id: row.id, canonical: row.canonical, aliases: safeJson<string[]>(row.aliases_json) ?? [], phoneticAliases: safeJson<string[]>(row.phonetic_aliases_json) ?? [], domains: safeJson<TechnicalDomain[]>(row.domains_json) ?? ["common_cs"], tags: safeJson<string[]>(row.tags_json) ?? [], source: "user", priority: row.priority }));
  }

  addTerm(input: TerminologyCustomTermInput, now = Date.now()): TechnicalTerm {
    const canonical = input.canonical.trim();
    if (!canonical) throw new Error("TERMINOLOGY_CANONICAL_REQUIRED");
    const term: TechnicalTerm = { id: id("terminology", now), canonical, aliases: [...new Set([canonical, ...(input.aliases ?? [])].map((value) => value.trim()).filter(Boolean))], phoneticAliases: [...new Set((input.phoneticAliases ?? []).map((value) => value.trim()).filter(Boolean))], domains: input.domains?.length ? input.domains : ["common_cs"], tags: input.tags ?? [], source: "user", priority: input.priority ?? 120 };
    this.database.run("INSERT INTO terminology_custom_terms(id, profile_id, canonical, aliases_json, phonetic_aliases_json, domains_json, tags_json, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, canonical) DO UPDATE SET aliases_json=excluded.aliases_json, phonetic_aliases_json=excluded.phonetic_aliases_json, domains_json=excluded.domains_json, tags_json=excluded.tags_json, priority=excluded.priority, updated_at=excluded.updated_at", [term.id, input.profileId, term.canonical, JSON.stringify(term.aliases), JSON.stringify(term.phoneticAliases), JSON.stringify(term.domains), JSON.stringify(term.tags), term.priority, now, now]);
    return this.listTerms(input.profileId).find((item) => item.canonical === term.canonical) ?? term;
  }

  deleteTerm(profileId: string, canonical: string): boolean {
    this.database.run("DELETE FROM terminology_custom_terms WHERE profile_id = ? AND canonical = ?", [profileId, canonical]);
    return true;
  }

  learnCorrection(profileId: string, raw: string, canonical: string, confidence = 1, now = Date.now()): TerminologyUserCorrectionRecord {
    const record = { id: id("terminology-correction", now), profileId, raw: raw.trim(), canonical: canonical.trim(), confidence: Math.max(0, Math.min(1, confidence)), source: "user" as const, createdAt: now };
    if (!record.raw || !record.canonical) throw new Error("TERMINOLOGY_CORRECTION_REQUIRED");
    this.database.run("INSERT INTO terminology_user_corrections(id, profile_id, raw, canonical, confidence, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [record.id, record.profileId, record.raw, record.canonical, record.confidence, record.source, record.createdAt]);
    this.addTerm({ profileId, canonical: record.canonical, aliases: [record.raw], priority: 130 }, now);
    return record;
  }

  listCorrections(profileId: string): TerminologyUserCorrectionRecord[] {
    return this.database.all<{ id: string; profile_id: string; raw: string; canonical: string; confidence: number; source: "user"; created_at: number }>("SELECT id, profile_id, raw, canonical, confidence, source, created_at FROM terminology_user_corrections WHERE profile_id = ? ORDER BY created_at DESC", [profileId]).map((row) => ({ id: row.id, profileId: row.profile_id, raw: row.raw, canonical: row.canonical, confidence: row.confidence, source: "user", createdAt: row.created_at }));
  }
}

export class SqliteProfileRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(): Profile[] {
    return this.database.all<{ id: string; name: string; language: string; resume_json: string | null; job_description_json: string | null; instructions: string | null; expression_level: string; explain_advanced_terms: number; created_at: number; updated_at: number }>("SELECT * FROM profiles ORDER BY updated_at DESC").map((row) => this.hydrate(row));
  }

  get(profileId: string): Profile | undefined {
    const row = this.database.first<{ id: string; name: string; language: string; resume_json: string | null; job_description_json: string | null; instructions: string | null; expression_level: string; explain_advanced_terms: number; created_at: number; updated_at: number }>("SELECT * FROM profiles WHERE id = ?", [profileId]);
    return row ? this.hydrate(row) : undefined;
  }

  save(input: Profile | ProfileInput, now = Date.now()): Profile {
    const existing = "id" in input ? input : undefined;
    const profile = existing ? { ...existing, updatedAt: now } : createProfile(input, now);
    this.database.run("INSERT INTO profiles(id, name, language, resume_json, job_description_json, instructions, expression_level, explain_advanced_terms, company_context, salary_expectation_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, language=excluded.language, resume_json=excluded.resume_json, job_description_json=excluded.job_description_json, instructions=excluded.instructions, expression_level=excluded.expression_level, explain_advanced_terms=excluded.explain_advanced_terms, company_context=excluded.company_context, salary_expectation_json=excluded.salary_expectation_json, updated_at=excluded.updated_at", [profile.id, profile.name, profile.language, profile.resume ? JSON.stringify(profile.resume) : null, profile.jobDescription ? JSON.stringify(profile.jobDescription) : null, profile.instructions ?? null, profile.expressionLevel ?? "plain", profile.explainAdvancedTerms === false ? 0 : 1, profile.companyContext ?? null, profile.salaryExpectation ? JSON.stringify(profile.salaryExpectation) : null, profile.createdAt, profile.updatedAt]);
    // Reconcile skills by stable id. Deleting and re-inserting the whole
    // profile used to cascade-delete project_skills on every profile save.
    const incomingSkillIds = new Set(profile.skills.map((skill) => skill.id));
    const existingSkillIds = this.database.all<{ id: string }>("SELECT id FROM skills WHERE profile_id = ?", [profile.id]).map((skill) => skill.id);
    for (const skillId of existingSkillIds) if (!incomingSkillIds.has(skillId)) this.database.run("DELETE FROM skills WHERE id = ? AND profile_id = ?", [skillId, profile.id]);
    profile.skills.forEach((skill) => this.database.run("INSERT INTO skills(id, profile_id, name, description, content, tags_json, source, evidence_refs_json, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, name=excluded.name, description=excluded.description, content=excluded.content, tags_json=excluded.tags_json, source=excluded.source, evidence_refs_json=excluded.evidence_refs_json, confirmed_at=excluded.confirmed_at", [skill.id, profile.id, skill.name, skill.description, skill.content, JSON.stringify(skill.tags), skill.source ?? null, JSON.stringify(skill.evidenceRefs ?? []), skill.confirmedAt ?? null]));
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

  private hydrate(row: { id: string; name: string; language: string; resume_json: string | null; job_description_json: string | null; instructions: string | null; expression_level: string; explain_advanced_terms: number; company_context?: string | null; salary_expectation_json?: string | null; created_at: number; updated_at: number }): Profile {
    const skills = this.database.all<{ id: string; name: string; description: string; content: string; tags_json: string; source?: string | null; evidence_refs_json?: string | null; confirmed_at?: number | null }>("SELECT id, name, description, content, tags_json, source, evidence_refs_json, confirmed_at FROM skills WHERE profile_id = ? ORDER BY name", [row.id]).map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, content: skill.content, tags: JSON.parse(skill.tags_json) as string[], ...(skill.source ? { source: skill.source as Profile["skills"][number]["source"] } : {}), ...(skill.evidence_refs_json ? { evidenceRefs: jsonArray<string>(skill.evidence_refs_json) } : {}), ...(skill.confirmed_at ? { confirmedAt: Number(skill.confirmed_at) } : {}) }));
    const knowledgeBaseIds = this.database.all<{ knowledge_base_id: string }>("SELECT knowledge_base_id FROM profile_knowledge WHERE profile_id = ?", [row.id]).map((item) => item.knowledge_base_id);
    return { id: row.id, name: row.name, language: row.language, resume: row.resume_json ? JSON.parse(row.resume_json) : undefined, jobDescription: row.job_description_json ? JSON.parse(row.job_description_json) : undefined, instructions: value<string>(row.instructions), expressionLevel: ["plain", "standard", "expert"].includes(row.expression_level) ? row.expression_level as Profile["expressionLevel"] : "plain", explainAdvancedTerms: Number(row.explain_advanced_terms) !== 0, ...(row.company_context ? { companyContext: row.company_context } : {}), ...(row.salary_expectation_json ? { salaryExpectation: JSON.parse(row.salary_expectation_json) } : {}), skills, knowledgeBaseIds, createdAt: row.created_at, updatedAt: row.updated_at };
  }
}

export interface ProfileBuilderArtifactRecord {
  profileId: string;
  version: number;
  status: "ready" | "partial" | "error" | "stale";
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
    let sourceSnapshot: unknown;
    try { sourceSnapshot = JSON.parse(row.sourceSnapshotJson); } catch { sourceSnapshot = { sources: [], error: "Invalid source snapshot JSON" }; }
    const artifact = normalizeProfileBuilderArtifact(row.artifactJson, { profileId: row.profileId, status: row.status as ProfileBuilderOutput["status"], error: row.error ?? undefined });
    return {
      profileId: row.profileId,
      version: row.version,
      status: row.status as ProfileBuilderArtifactRecord["status"],
      sourceSnapshot,
      artifact,
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
    this.database.run("UPDATE profile_builder_artifacts SET status = 'stale', error = ?, updated_at = ? WHERE profile_id = ?", ["资料已更新，等待 Profile Builder 重建", now, profileId]);
    this.database.flush();
  }

  delete(profileId: string): void {
    this.database.run("DELETE FROM profile_builder_artifacts WHERE profile_id = ?", [profileId]);
    this.database.flushNow();
  }
}

export interface ResumeAnalysisRecord {
  profileId: string;
  resumeHash: string;
  analyzerVersion: number;
  analysisQuality: ResumeAnalysis["analysisQuality"];
  artifact?: ResumeAnalysis;
  status: "current" | "stale";
  createdAt: number;
  updatedAt: number;
}

export class SqliteResumeAnalysisRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(profileId: string, resumeHash?: string, analyzerVersion = RESUME_ANALYSIS_VERSION): ResumeAnalysisRecord | undefined {
    const row = resumeHash
      ? this.database.first<Record<string, unknown>>("SELECT profile_id AS profileId, resume_hash AS resumeHash, analyzer_version AS analyzerVersion, analysis_quality AS analysisQuality, artifact_json AS artifactJson, created_at AS createdAt, updated_at AS updatedAt FROM resume_analyses WHERE profile_id = ? AND resume_hash = ? AND analyzer_version = ?", [profileId, resumeHash, analyzerVersion])
      : this.database.first<Record<string, unknown>>("SELECT profile_id AS profileId, resume_hash AS resumeHash, analyzer_version AS analyzerVersion, analysis_quality AS analysisQuality, artifact_json AS artifactJson, created_at AS createdAt, updated_at AS updatedAt FROM resume_analyses WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 1", [profileId]);
    if (!row) return undefined;
    return this.hydrate(row, Boolean(resumeHash && String(row.resumeHash) === resumeHash && Number(row.analyzerVersion) === analyzerVersion));
  }

  save(input: { profileId: string; resumeHash: string; artifact: ResumeAnalysis; now?: number }): ResumeAnalysisRecord {
    const now = input.now ?? Date.now();
    this.database.run("INSERT INTO resume_analyses(profile_id, resume_hash, analyzer_version, analysis_quality, artifact_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, resume_hash, analyzer_version) DO UPDATE SET analysis_quality=excluded.analysis_quality, artifact_json=excluded.artifact_json, updated_at=excluded.updated_at", [input.profileId, input.resumeHash, input.artifact.version, input.artifact.analysisQuality, JSON.stringify(input.artifact), now, now]);
    this.database.flushNow();
    return this.get(input.profileId, input.resumeHash, input.artifact.version) as ResumeAnalysisRecord;
  }

  private hydrate(row: Record<string, unknown>, current: boolean): ResumeAnalysisRecord {
    let artifact: ResumeAnalysis | undefined;
    try {
      const parsed = JSON.parse(String(row.artifactJson)) as ResumeAnalysis;
      if (parsed && parsed.version === RESUME_ANALYSIS_VERSION) artifact = parsed;
    } catch { artifact = undefined; }
    return { profileId: String(row.profileId), resumeHash: String(row.resumeHash), analyzerVersion: Number(row.analyzerVersion), analysisQuality: String(row.analysisQuality) === "structured" ? "structured" : "fallback", ...(artifact ? { artifact } : {}), status: current && Boolean(artifact) ? "current" : "stale", createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }
}

export class SqliteSkillSuggestionRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(profileId: string, status?: SkillSuggestionStatus): SkillSuggestion[] {
    const where = status ? " AND status = ?" : "";
    const params = status ? [profileId, status] : [profileId];
    return this.database.all<Record<string, unknown>>(`SELECT id, profile_id AS profileId, name, description, confidence, evidence_ids_json AS evidenceIdsJson, evidence_quotes_json AS evidenceQuotesJson, source_kinds_json AS sourceKindsJson, analysis_version AS analysisVersion, status, confirmed_at AS confirmedAt, rejected_at AS rejectedAt, created_at AS createdAt, updated_at AS updatedAt FROM profile_skill_suggestions WHERE profile_id = ? AND analysis_version = ${PROFILE_BUILDER_VERSION}${where} ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, updated_at DESC, name`, params).map((row) => this.hydrate(row));
  }

  upsertFromArtifact(profileId: string, nodes: ProfileBuilderOutput["skillGraph"]["nodes"], sourceSnapshot: unknown, now = Date.now()): SkillSuggestion[] {
    const sources = Array.isArray((sourceSnapshot as { sources?: unknown } | undefined)?.sources) ? (sourceSnapshot as { sources: Array<Record<string, unknown>> }).sources : [];
    const sourceById = new Map(sources.map((source) => [String(source.id), source]));
    for (const node of nodes) {
      const name = node.label.trim();
      const normalizedName = normalizeSkillKey(name);
      if (!normalizedName) continue;
      const evidenceIds = [...new Set(node.evidenceIds.filter(Boolean))];
      const evidenceQuotes = evidenceIds.map((evidenceId) => {
        const source = sourceById.get(evidenceId);
        const sourceText = source?.text ? String(source.text) : "";
        const normalizedText = sourceText.toLocaleLowerCase();
        const index = normalizedText.indexOf(name.toLocaleLowerCase());
        return index >= 0 ? sourceText.slice(Math.max(0, index - 80), index + Math.min(160, name.length + 80)).trim() : source?.title ? String(source.title) : evidenceId;
      });
      const sourceKinds = [...new Set(evidenceIds.map((evidenceId) => sourceById.get(evidenceId)?.kind).filter((kind): kind is ProfileBuilderSourceKind => typeof kind === "string"))];
      const confidence = Math.min(0.95, 0.55 + Math.min(0.35, evidenceIds.length * 0.1));
      const suggestionId = `skill-suggestion-${profileId}-${normalizedName.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").slice(0, 64)}`;
       this.database.run("INSERT INTO profile_skill_suggestions(id, profile_id, normalized_name, name, description, confidence, evidence_ids_json, evidence_quotes_json, source_kinds_json, analysis_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(profile_id, normalized_name) DO UPDATE SET name=excluded.name, description=excluded.description, confidence=excluded.confidence, evidence_ids_json=excluded.evidence_ids_json, evidence_quotes_json=excluded.evidence_quotes_json, source_kinds_json=excluded.source_kinds_json, analysis_version=excluded.analysis_version, updated_at=excluded.updated_at", [suggestionId, profileId, normalizedName, name, node.description || "", confidence, JSON.stringify(evidenceIds), JSON.stringify(evidenceQuotes), JSON.stringify(sourceKinds), PROFILE_BUILDER_VERSION, now, now]);
    }
    if (nodes.length > 0) this.database.flushNow();
    return this.list(profileId);
  }

  review(id: string, status: SkillSuggestionStatus, now = Date.now()): SkillSuggestion | undefined {
    if (!["pending", "confirmed", "rejected"].includes(status)) throw new Error("Invalid skill suggestion status");
    this.database.run("UPDATE profile_skill_suggestions SET status = ?, confirmed_at = ?, rejected_at = ?, updated_at = ? WHERE id = ?", [status, status === "confirmed" ? now : null, status === "rejected" ? now : null, now, id]);
    this.database.flushNow();
    const row = this.database.first<Record<string, unknown>>("SELECT id, profile_id AS profileId, name, description, confidence, evidence_ids_json AS evidenceIdsJson, evidence_quotes_json AS evidenceQuotesJson, source_kinds_json AS sourceKindsJson, analysis_version AS analysisVersion, status, confirmed_at AS confirmedAt, rejected_at AS rejectedAt, created_at AS createdAt, updated_at AS updatedAt FROM profile_skill_suggestions WHERE id = ? AND analysis_version = ?", [id, PROFILE_BUILDER_VERSION]);
    return row ? this.hydrate(row) : undefined;
  }

  private hydrate(row: Record<string, unknown>): SkillSuggestion {
    const status = ["pending", "confirmed", "rejected"].includes(String(row.status)) ? String(row.status) as SkillSuggestionStatus : "pending";
    return {
      id: String(row.id),
      profileId: String(row.profileId),
      name: String(row.name),
      description: String(row.description ?? ""),
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0))),
      evidenceIds: jsonArray<string>(row.evidenceIdsJson),
      evidenceQuotes: jsonArray<string>(row.evidenceQuotesJson),
      sourceKinds: jsonArray<ProfileBuilderSourceKind>(row.sourceKindsJson),
      analysisVersion: Number(row.analysisVersion ?? PROFILE_BUILDER_VERSION),
      status,
      ...(row.confirmedAt ? { confirmedAt: Number(row.confirmedAt) } : {}),
      ...(row.rejectedAt ? { rejectedAt: Number(row.rejectedAt) } : {}),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt)
    };
  }
}

export interface ProjectRecord {
  id: string;
  name: string;
  profileId?: string;
  createdAt: number;
  updatedAt: number;
  ownershipMode?: ProjectOwnershipMode;
  ownershipNote?: string;
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
  status: ChatMessageStatus;
  model?: string;
  provider?: string;
  errorCode?: string;
  cancelReason?: ChatCancelReason;
  startedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
  durationMs?: number;
  finishReason?: string;
  charactersGenerated: number;
  structuredResponse?: ChatResponse;
  createdAt: number;
}

export class SqliteProjectRepository {
  constructor(private readonly database: SqliteDatabase) {}

  list(): ProjectRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, created_at AS createdAt, updated_at AS updatedAt, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects ORDER BY updated_at DESC").map((row) => this.hydrate(row));
  }

  get(projectId: string): ProjectRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, created_at AS createdAt, updated_at AS updatedAt, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects WHERE id = ?", [projectId]);
    return row ? this.hydrate(row) : undefined;
  }

  create(name: string, profileId?: string, now = Date.now(), ownershipMode: ProjectOwnershipMode = "personal", ownershipNote?: string): ProjectRecord {
    const existing = profileId ? this.database.first<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, created_at AS createdAt, updated_at AS updatedAt, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects WHERE profile_id = ? AND lower(trim(name)) = lower(trim(?)) ORDER BY updated_at DESC LIMIT 1", [profileId, name.trim() || "新面试项目"]) : undefined;
    if (existing) return this.hydrate(existing);
    const project = { id: id("project", now), name: name.trim() || "新面试项目", ...(profileId ? { profileId } : {}), createdAt: now, updatedAt: now };
    this.database.run("INSERT INTO projects(id, name, profile_id, ownership_mode, ownership_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [project.id, project.name, project.profileId ?? null, normalizeProjectOwnershipMode(ownershipMode), ownershipNote?.trim() || null, now, now]);
    this.database.flushNow();
    return this.get(project.id) as ProjectRecord;
  }

  update(projectId: string, input: { name?: string; ownershipMode?: ProjectOwnershipMode; ownershipNote?: string }, now = Date.now()): ProjectRecord | undefined {
    const current = this.get(projectId);
    if (!current) return undefined;
    this.database.run("UPDATE projects SET name = ?, ownership_mode = ?, ownership_note = ?, updated_at = ? WHERE id = ?", [input.name?.trim() || current.name, normalizeProjectOwnershipMode(input.ownershipMode ?? current.ownershipMode), input.ownershipNote === undefined ? current.ownershipNote ?? null : input.ownershipNote.trim() || null, now, projectId]);
    this.database.flushNow();
    return this.get(projectId);
  }

  private hydrate(row: Record<string, unknown>): ProjectRecord {
    return { id: String(row.id), name: String(row.name), ...(row.profileId ? { profileId: String(row.profileId) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), ownershipMode: normalizeProjectOwnershipMode(row.ownershipMode), ...(row.ownershipNote ? { ownershipNote: String(row.ownershipNote) } : {}) };
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
  facts: number;
  eligibleFacts: number;
  reviewRequiredFacts: number;
  userActionRequiredFacts: number;
  conflictingFacts: number;
  /** Number of unresolved decision groups, not candidate facts. */
  conflictGroups: number;
  /** Number of user decisions, with one action per conflict group. */
  userActions: number;
  staleFacts: number;
  /** Current-project alias used by detail views. */
  questions: number;
  projectFamiliarityScore?: number;
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

export interface ProjectSourceRecord extends ProjectSourceAssignment {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSourceDetail extends ProjectSourceRecord {
  title: string;
  documentType?: string;
  status?: string;
  text?: string;
  updatedAt: number;
}

export class SqliteProjectSourceRepository {
  constructor(private readonly database: SqliteDatabase) {}

  listProjectSources(projectId: string): ProjectSourceRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, project_id AS projectId, source_type AS sourceType, source_id AS sourceId, relationship, source_role AS sourceRole, assignment_method AS assignmentMethod, confidence, verified, created_at AS createdAt, updated_at AS updatedAt FROM project_sources WHERE project_id = ? ORDER BY relationship = 'primary' DESC, updated_at DESC", [projectId]).map((row) => this.hydrate(row));
  }

  getBySource(sourceType: ProjectSourceType, sourceId: string): ProjectSourceRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, project_id AS projectId, source_type AS sourceType, source_id AS sourceId, relationship, source_role AS sourceRole, assignment_method AS assignmentMethod, confidence, verified, created_at AS createdAt, updated_at AS updatedAt FROM project_sources WHERE source_type = ? AND source_id = ? ORDER BY updated_at DESC", [sourceType, sourceId]).map((row) => this.hydrate(row));
  }

  assign(input: Omit<ProjectSourceAssignment, "id" | "createdAt" | "updatedAt"> & { id?: string }, now = Date.now()): ProjectSourceRecord {
    const assignmentId = input.id ?? `project-source-${input.projectId}-${input.sourceType}-${input.sourceId}`;
    this.database.run("INSERT INTO project_sources(id, project_id, source_type, source_id, relationship, source_role, assignment_method, confidence, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, source_type, source_id) DO UPDATE SET relationship=excluded.relationship, source_role=excluded.source_role, assignment_method=excluded.assignment_method, confidence=excluded.confidence, verified=excluded.verified, updated_at=excluded.updated_at", [assignmentId, input.projectId, input.sourceType, input.sourceId, input.relationship, input.sourceRole ?? "other", input.assignmentMethod ?? "explicit", Math.max(0, Math.min(1, input.confidence)), input.verified ? 1 : 0, now, now]);
    this.database.flushNow();
    return this.listProjectSources(input.projectId).find((item) => item.sourceType === input.sourceType && item.sourceId === input.sourceId) as ProjectSourceRecord;
  }

  unassign(projectId: string, sourceType: ProjectSourceType, sourceId: string): void {
    this.database.run("DELETE FROM project_sources WHERE project_id = ? AND source_type = ? AND source_id = ?", [projectId, sourceType, sourceId]);
    this.database.flushNow();
  }

  private hydrate(row: Record<string, unknown>): ProjectSourceRecord {
    return { id: String(row.id), projectId: String(row.projectId), sourceType: String(row.sourceType) as ProjectSourceType, sourceId: String(row.sourceId), relationship: String(row.relationship) as ProjectSourceRelationship, sourceRole: String(row.sourceRole ?? "other") as ProjectSourceRole, assignmentMethod: String(row.assignmentMethod ?? "explicit") as ProjectSourceAssignmentMethod, confidence: Number(row.confidence ?? 1), verified: Number(row.verified) === 1, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }
}

/** Structured Project Memory persistence. Legacy projects/conversations remain compatible. */
export class SqliteProjectMemoryRepository {
  private readonly sources: SqliteProjectSourceRepository;
  private readonly projects: SqliteProjectRepository;

  constructor(private readonly database: SqliteDatabase) { this.sources = new SqliteProjectSourceRepository(database); this.projects = new SqliteProjectRepository(database); }

  listProjects(profileId: string): Array<{ id: string; name: string; profileId: string; aliases: string[]; sourceIds: string[]; ownershipMode: ProjectOwnershipMode; ownershipNote?: string }> {
    return this.database.all<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, aliases_json AS aliasesJson, source_ids_json AS sourceIdsJson, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]).map((row) => ({ id: String(row.id), name: String(row.name), profileId: String(row.profileId), aliases: jsonArray(row.aliasesJson), sourceIds: jsonArray(row.sourceIdsJson), ownershipMode: normalizeProjectOwnershipMode(row.ownershipMode), ...(row.ownershipNote ? { ownershipNote: String(row.ownershipNote) } : {}) }));
  }

  getProject(projectId: string): { id: string; name: string; profileId: string; aliases: string[]; sourceIds: string[]; ownershipMode: ProjectOwnershipMode; ownershipNote?: string } | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, aliases_json AS aliasesJson, source_ids_json AS sourceIdsJson, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects WHERE id = ?", [projectId]);
    return row ? { id: String(row.id), name: String(row.name), profileId: String(row.profileId), aliases: jsonArray(row.aliasesJson), sourceIds: jsonArray(row.sourceIdsJson), ownershipMode: normalizeProjectOwnershipMode(row.ownershipMode), ...(row.ownershipNote ? { ownershipNote: String(row.ownershipNote) } : {}) } : undefined;
  }

  listProjectSources(projectId: string): ProjectSourceRecord[] { return this.sources.listProjectSources(projectId); }
  listProjectDocumentIds(projectId: string): string[] {
    return [...new Set(this.listProjectSources(projectId).filter((item) => item.sourceRole !== "reference" && item.relationship !== "reference" && ["document", "repository"].includes(item.sourceType)).map((item) => item.sourceId))];
  }
  /** Explicit global/reference assignments for a profile. */
  listReferenceSources(profileId: string): ProjectSourceRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT ps.id, ps.project_id AS projectId, ps.source_type AS sourceType, ps.source_id AS sourceId, ps.relationship, ps.source_role AS sourceRole, ps.assignment_method AS assignmentMethod, ps.confidence, ps.verified, ps.created_at AS createdAt, ps.updated_at AS updatedAt FROM project_sources ps JOIN projects p ON p.id = ps.project_id WHERE p.profile_id = ? AND (ps.source_role = 'reference' OR ps.relationship = 'reference') ORDER BY ps.updated_at DESC", [profileId]).map((row) => ({ id: String(row.id), projectId: String(row.projectId), sourceType: String(row.sourceType) as ProjectSourceType, sourceId: String(row.sourceId), relationship: String(row.relationship) as ProjectSourceRelationship, sourceRole: String(row.sourceRole ?? "reference") as ProjectSourceRole, assignmentMethod: String(row.assignmentMethod ?? "explicit") as ProjectSourceAssignmentMethod, confidence: Number(row.confidence ?? 1), verified: Number(row.verified) === 1, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }));
  }
  listReferenceDocumentIds(profileId: string): string[] {
    return [...new Set(this.listReferenceSources(profileId).filter((item) => ["document", "repository"].includes(item.sourceType)).map((item) => item.sourceId))];
  }
  listSourceDetails(projectId: string): ProjectSourceDetail[] {
    return this.listProjectSources(projectId).map((assignment) => {
      const document = assignment.sourceType === "document" || assignment.sourceType === "repository"
        ? this.database.first<Record<string, unknown>>("SELECT filename, document_type AS documentType, status, text, updated_at AS updatedAt FROM documents WHERE id = ?", [assignment.sourceId])
        : undefined;
      const repositoryFileCount = assignment.sourceType === "repository" ? Number(this.database.first<{ count: number }>("SELECT COUNT(*) AS count FROM repository_source_files WHERE document_id = ?", [assignment.sourceId])?.count ?? 0) : 0;
      return { ...assignment, title: String(document?.filename ?? assignment.sourceId), ...(document?.documentType ? { documentType: String(document.documentType) } : {}), ...(document?.status ? { status: String(document.status) } : {}), ...(document?.text ? { text: String(document.text).slice(0, 20_000) } : {}), ...(assignment.sourceType === "repository" ? { repositoryFileCount } : {}), updatedAt: Number(document?.updatedAt ?? assignment.updatedAt) };
    });
  }
  createProject(profileId: string, name: string, now = Date.now(), ownershipMode: ProjectOwnershipMode = "personal", ownershipNote?: string): { id: string; name: string; profileId: string; aliases: string[]; sourceIds: string[]; ownershipMode: ProjectOwnershipMode; ownershipNote?: string } {
    return this.ensureProject({ profileId, name, ownershipMode, ownershipNote }, now);
  }
  renameProject(projectId: string, name: string, now = Date.now()): { id: string; name: string; profileId: string; aliases: string[]; sourceIds: string[] } | undefined {
    this.projects.rename(projectId, name, now);
    return this.getProject(projectId);
  }
  deleteProject(projectId: string): void { this.projects.delete(projectId); }
  deriveProjectView(projectId: string): ProjectMemorySnapshot["projects"][number] | undefined {
    const profileId = this.database.first<{ profileId: string }>("SELECT profile_id AS profileId FROM projects WHERE id = ?", [projectId])?.profileId;
    return profileId ? this.getSnapshot(profileId).projects.find((project) => project.id === projectId) : undefined;
  }
  assignSource(input: Omit<ProjectSourceAssignment, "id" | "createdAt" | "updatedAt"> & { id?: string }): ProjectSourceRecord { return this.sources.assign(input); }
  unassignSource(projectId: string, sourceType: ProjectSourceType, sourceId: string): void {
    const now = Date.now();
    const profileId = this.database.first<{ profileId: string }>("SELECT profile_id AS profileId FROM projects WHERE id = ?", [projectId])?.profileId;
    if (!profileId) return;
    const affected = this.listFacts(profileId, projectId, { includeStale: true, includeRejected: true }).filter((fact) => fact.evidence?.some((item) => item.sourceId === sourceId));
    const beforeEligibility = new Map(affected.map((fact) => [fact.id, isFactEligible(fact)]));
    this.database.run("BEGIN");
    try {
      // Remove the binding and its evidence rows together. Facts are then
      // evaluated against the remaining active support evidence.
      this.database.run("DELETE FROM project_sources WHERE project_id = ? AND source_type = ? AND source_id = ?", [projectId, sourceType, sourceId]);
      for (const fact of affected) {
        const refreshed = this.getFact(fact.id);
        if (!refreshed) continue;
        this.database.run("DELETE FROM project_fact_sources WHERE fact_id = ? AND source_id = ?", [fact.id, sourceId]);
        const assignments = this.listProjectSources(projectId);
        const validSupport = refreshed.evidence?.some((item) => item.sourceId !== sourceId && item.relation !== "refute" && item.quote.trim() && assignments.some((assignment) => assignment.sourceId === item.sourceId && assignment.relationship !== "reference")) ?? false;
        const userConfirmed = refreshed.evidenceLevel === "confirmed-user" || refreshed.verified;
        if (validSupport) {
          const level = this.evidenceLevelForAssignments(refreshed, assignments);
          this.database.run("UPDATE project_facts SET stale = 0, evidence_level = CASE WHEN evidence_level = 'confirmed-user' OR verified = 1 THEN evidence_level ELSE ? END, updated_at = ? WHERE id = ?", [level, now, fact.id]);
        } else if (userConfirmed) {
          // A confirmed-user claim remains a valid personal statement even if
          // its auxiliary document is later unbound; provenance is degraded,
          // but the user confirmation is not silently revoked.
          this.database.run("UPDATE project_facts SET stale = 0, updated_at = ? WHERE id = ?", [now, fact.id]);
        } else {
          this.database.run("UPDATE project_facts SET stale = 1, updated_at = ? WHERE id = ?", [now, fact.id]);
        }
        const after = this.getFact(fact.id);
        if (after && beforeEligibility.get(fact.id) !== isFactEligible(after)) {
          this.database.run("UPDATE question_bank_questions SET stale = 1, updated_at = ? WHERE id IN (SELECT question_id FROM question_bank_question_facts WHERE fact_id = ?)", [now, fact.id]);
          this.database.run("UPDATE question_bank_answer_cards SET stale = 1, updated_at = ? WHERE question_id IN (SELECT question_id FROM question_bank_question_facts WHERE fact_id = ?)", [now, fact.id]);
        }
      }
      this.database.run("COMMIT");
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
    this.syncProjectSkillsForProject(projectId, now);
    this.database.flushNow();
  }
  sourcesFor(sourceType: ProjectSourceType, sourceId: string): ProjectSourceRecord[] { return this.sources.getBySource(sourceType, sourceId); }

  ensureProject(input: { id?: string; profileId: string; name: string; aliases?: string[]; sourceIds?: string[]; ownershipMode?: ProjectOwnershipMode; ownershipNote?: string }, now = Date.now()): { id: string; name: string; profileId: string; aliases: string[]; sourceIds: string[]; ownershipMode: ProjectOwnershipMode; ownershipNote?: string } {
    const existing = this.database.first<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, aliases_json AS aliasesJson, source_ids_json AS sourceIdsJson, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects WHERE profile_id = ? AND lower(trim(name)) = lower(trim(?)) ORDER BY updated_at DESC LIMIT 1", [input.profileId, input.name.trim() || "待确认项目"]);
    const projectId = input.id ?? (existing ? String(existing.id) : this.projects.create(input.name, input.profileId, now).id);
    const preservedOwnershipMode = input.ownershipMode ?? existing?.ownershipMode;
    const preservedOwnershipNote = input.ownershipNote === undefined ? existing?.ownershipNote : input.ownershipNote;
    this.database.run("INSERT INTO projects(id, name, profile_id, aliases_json, source_ids_json, ownership_mode, ownership_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, profile_id=excluded.profile_id, aliases_json=excluded.aliases_json, source_ids_json=excluded.source_ids_json, ownership_mode=excluded.ownership_mode, ownership_note=excluded.ownership_note, updated_at=excluded.updated_at", [projectId, input.name.trim() || "待确认项目", input.profileId, JSON.stringify(input.aliases ?? []), JSON.stringify(input.sourceIds ?? []), normalizeProjectOwnershipMode(preservedOwnershipMode), typeof preservedOwnershipNote === "string" ? preservedOwnershipNote.trim() || null : null, now, now]);
    this.database.flushNow();
    return this.getProject(projectId) as { id: string; name: string; profileId: string; aliases: string[]; sourceIds: string[]; ownershipMode: ProjectOwnershipMode; ownershipNote?: string };
  }

  getUnderstandingSnapshot(projectId: string, inputHash?: string, completedOnly = true): ProjectUnderstandingSnapshotRecord | undefined {
    const conditions = ["project_id = ?"];
    const params: Array<string | number> = [projectId];
    if (inputHash) { conditions.push("input_hash = ?"); params.push(inputHash); }
    if (completedOnly) conditions.push("status = 'completed'");
    const row = this.database.first<Record<string, unknown>>(`SELECT id, project_id AS projectId, version, input_hash AS inputHash, model, status, understanding_json AS understandingJson, created_at AS createdAt, updated_at AS updatedAt FROM project_understanding_snapshots WHERE ${conditions.join(" AND ")} ORDER BY version DESC, updated_at DESC LIMIT 1`, params);
    const understanding = row ? safeJson<ProjectUnderstanding>(row.understandingJson) : undefined;
    return row && understanding ? { id: String(row.id), projectId: String(row.projectId), version: Number(row.version), inputHash: String(row.inputHash), ...(row.model ? { model: String(row.model) } : {}), status: String(row.status) as ProjectUnderstandingSnapshotRecord["status"], understanding, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) } : undefined;
  }

  listUnderstandingSnapshots(projectId: string, limit = 20): ProjectUnderstandingSnapshotRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, project_id AS projectId, version, input_hash AS inputHash, model, status, understanding_json AS understandingJson, created_at AS createdAt, updated_at AS updatedAt FROM project_understanding_snapshots WHERE project_id = ? ORDER BY version DESC, updated_at DESC LIMIT ?", [projectId, Math.max(1, Math.min(100, limit))]).flatMap((row) => {
      const understanding = safeJson<ProjectUnderstanding>(row.understandingJson);
      return understanding ? [{ id: String(row.id), projectId: String(row.projectId), version: Number(row.version), inputHash: String(row.inputHash), ...(row.model ? { model: String(row.model) } : {}), status: String(row.status) as ProjectUnderstandingSnapshotRecord["status"], understanding, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }] : [];
    });
  }

  saveUnderstandingSnapshot(input: { projectId: string; inputHash: string; understanding: ProjectUnderstanding; model?: string; status?: ProjectUnderstandingSnapshotRecord["status"]; version?: number; id?: string; now?: number }): ProjectUnderstandingSnapshotRecord {
    const now = input.now ?? Date.now();
    const snapshotId = input.id ?? `project-understanding-${input.projectId}-${input.inputHash.slice(0, 24)}`;
    const existing = this.getUnderstandingSnapshot(input.projectId, input.inputHash, false);
    const version = input.version ?? existing?.version ?? Number(this.database.first<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM project_understanding_snapshots WHERE project_id = ?", [input.projectId])?.version ?? 0) + 1;
    this.database.run("INSERT INTO project_understanding_snapshots(id, project_id, version, input_hash, model, status, understanding_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, input_hash=excluded.input_hash, model=excluded.model, status=excluded.status, understanding_json=excluded.understanding_json, updated_at=excluded.updated_at", [snapshotId, input.projectId, version, input.inputHash, input.model ?? null, input.status ?? input.understanding.status, JSON.stringify({ ...input.understanding, version }), existing?.createdAt ?? now, now]);
    this.database.flushNow();
    return this.getUnderstandingSnapshot(input.projectId, input.inputHash, false) as ProjectUnderstandingSnapshotRecord;
  }

  getSnapshot(profileId: string): ProjectMemorySnapshot {
    const projects = this.database.all<Record<string, unknown>>("SELECT id, name, profile_id AS profileId, description, role, hardware_json AS hardwareJson, software_json AS softwareJson, technology_stack_json AS technologyStackJson, time, source_ids_json AS sourceIdsJson, confidence, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]).filter((row) => {
      const state = this.database.first<{ status: string; lastSuccessfulAnalysisId: string | null }>("SELECT status, last_successful_analysis_id AS lastSuccessfulAnalysisId FROM project_analysis_state WHERE project_id = ?", [String(row.id)]);
      return !(state?.status === "failed" && !state.lastSuccessfulAnalysisId);
    }).map((row) => ({
      id: String(row.id), profileId: String(row.profileId), name: String(row.name), description: String(row.description ?? ""), role: String(row.role ?? ""), hardware: jsonArray(row.hardwareJson), software: jsonArray(row.softwareJson), technologyStack: jsonArray(row.technologyStackJson), ...(row.time ? { time: String(row.time) } : {}), sourceIds: jsonArray(row.sourceIdsJson), confidence: Number(row.confidence ?? 1), ownershipMode: normalizeProjectOwnershipMode(row.ownershipMode), ...(row.ownershipNote ? { ownershipNote: String(row.ownershipNote) } : {})
    }));
    const projectIds = projects.map((project) => project.id);
    if (projectIds.length === 0) return { projects, modules: [], technicalPoints: [], problems: [], interviewQuestions: [], facts: [], understandings: [] };
    const placeholders = projectIds.map(() => "?").join(",");
    const modules = this.database.all<Record<string, unknown>>(`SELECT id, project_id AS projectId, module_name AS moduleName, description, file_path AS filePath, source_ids_json AS sourceIdsJson FROM project_modules WHERE project_id IN (${placeholders})`, projectIds).map((row) => ({ id: String(row.id), projectId: String(row.projectId), moduleName: String(row.moduleName), description: String(row.description), ...(row.filePath ? { filePath: String(row.filePath) } : {}), sourceIds: jsonArray(row.sourceIdsJson) }));
    const technicalPoints = this.database.all<Record<string, unknown>>(`SELECT id, project_id AS projectId, topic, content, importance, source_ids_json AS sourceIdsJson FROM technical_points WHERE project_id IN (${placeholders})`, projectIds).map((row) => ({ id: String(row.id), projectId: String(row.projectId), topic: String(row.topic), content: String(row.content), importance: String(row.importance) as ProjectTechnicalPoint["importance"], sourceIds: jsonArray(row.sourceIdsJson) }));
    const problems = this.database.all<Record<string, unknown>>(`SELECT id, project_id AS projectId, problem, cause, solution, result, source_ids_json AS sourceIdsJson FROM project_problems WHERE project_id IN (${placeholders})`, projectIds).map((row) => ({ id: String(row.id), projectId: String(row.projectId), problem: String(row.problem), cause: String(row.cause), solution: String(row.solution), result: String(row.result), sourceIds: jsonArray(row.sourceIdsJson) }));
    const questionBank = new SqliteQuestionBankRepository(this.database);
    // The old interview_questions table is intentionally read only through
    // migration compatibility. The unified Question Bank is authoritative.
    const interviewQuestions = this.database.all<{ id: string; projectId: string }>(`SELECT id, project_id AS projectId FROM question_bank_questions WHERE scope = 'project' AND status = 'active' AND project_id IN (${placeholders}) ORDER BY updated_at DESC`, projectIds).flatMap((row) => {
      const question = questionBank.getQuestion(String(row.id));
      if (!question) return [];
      const answerPoints = question.answerCards.flatMap((card) => card.keyPoints.length > 0 ? card.keyPoints : card.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)).slice(0, 20);
      return [{ id: question.id, projectId: String(row.projectId), question: question.canonicalText, answerPoints, keywords: question.variants, sourceIds: question.factIds ?? [], factIds: question.factIds, stale: Boolean(question.stale) }];
    });
    const facts = this.listFacts(profileId);
    const understandings = projectIds.flatMap((projectId) => {
      const record = this.getUnderstandingSnapshot(projectId);
      return record ? [record.understanding] : [];
    });
    return { projects: projects.map((project) => deriveProjectView(project, facts)), modules, technicalPoints, problems, interviewQuestions, facts, understandings, ...(understandings.length === 1 ? { understanding: understandings[0] } : {}) };
  }

  replaceSnapshot(profileId: string, snapshot: ProjectMemorySnapshot, now = Date.now(), onlyProjectId?: string): ProjectMemorySnapshot {
    const factScope = onlyProjectId ? "project_id = ?" : "project_id IN (SELECT id FROM projects WHERE profile_id = ?)";
    const projectFilterParams: Array<string | number> = onlyProjectId ? [onlyProjectId] : [profileId];
    const previousAssignments = onlyProjectId ? this.sources.listProjectSources(onlyProjectId) : [];
    const persistedOwnership = new Map(this.database.all<{ id: string; ownershipMode: string | null; ownershipNote: string | null }>("SELECT id, ownership_mode AS ownershipMode, ownership_note AS ownershipNote FROM projects WHERE profile_id = ?", [profileId]).map((row) => [row.id, row] as const));
    snapshot = { ...snapshot, projects: snapshot.projects.map((project) => { const existing = persistedOwnership.get(project.id); return { ...project, ownershipMode: normalizeProjectOwnershipMode(existing?.ownershipMode ?? project.ownershipMode), ...(existing?.ownershipNote ? { ownershipNote: existing.ownershipNote } : project.ownershipNote ? { ownershipNote: project.ownershipNote } : {}) }; }) };
    const previousFacts = new Map(this.listFacts(profileId, onlyProjectId, { includeStale: true, includeRejected: true }).map((fact) => [fact.id, fact] as const));
    const previousFactVerification = new Map(this.database.all<{ id: string; verified: number }>(`SELECT id, verified FROM project_facts WHERE ${factScope}`, projectFilterParams).map((row) => [row.id, Number(row.verified) === 1] as const));
    const previousFactEmbeddings = new Map(this.database.all<{ id: string; embeddingJson: string | null; embeddingHash: string | null; embeddingModel: string | null; embeddingVersion: string | null; embeddingUpdatedAt: number | null }>(`SELECT id, embedding_json AS embeddingJson, embedding_hash AS embeddingHash, embedding_model AS embeddingModel, embedding_version AS embeddingVersion, embedding_updated_at AS embeddingUpdatedAt FROM project_facts WHERE ${factScope}`, projectFilterParams).map((row) => [row.id, row] as const));
    const questionDelete = onlyProjectId ? "DELETE FROM question_bank_questions WHERE scope = 'project' AND profile_id = ? AND source = 'generated' AND project_id = ?" : "DELETE FROM question_bank_questions WHERE scope = 'project' AND profile_id = ? AND source = 'generated'";
    this.database.run(questionDelete, onlyProjectId ? [profileId, onlyProjectId] : [profileId]);
    if (onlyProjectId) {
      this.database.run("DELETE FROM project_modules WHERE project_id = ?", [onlyProjectId]);
      this.database.run("DELETE FROM technical_points WHERE project_id = ?", [onlyProjectId]);
      this.database.run("DELETE FROM project_problems WHERE project_id = ?", [onlyProjectId]);
    } else {
      // Keep all project rows and user-authored facts; reanalysis only refreshes derived records.
      this.database.run("DELETE FROM project_modules WHERE project_id IN (SELECT id FROM projects WHERE profile_id = ?)", [profileId]);
      this.database.run("DELETE FROM technical_points WHERE project_id IN (SELECT id FROM projects WHERE profile_id = ?)", [profileId]);
      this.database.run("DELETE FROM project_problems WHERE project_id IN (SELECT id FROM projects WHERE profile_id = ?)", [profileId]);
    }
    for (const project of snapshot.projects) {
      this.database.run("INSERT INTO projects(id, name, profile_id, description, role, hardware_json, software_json, technology_stack_json, time, source_ids_json, confidence, ownership_mode, ownership_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, profile_id=excluded.profile_id, description=excluded.description, role=excluded.role, hardware_json=excluded.hardware_json, software_json=excluded.software_json, technology_stack_json=excluded.technology_stack_json, time=excluded.time, source_ids_json=excluded.source_ids_json, confidence=excluded.confidence, ownership_mode=excluded.ownership_mode, ownership_note=excluded.ownership_note, updated_at=excluded.updated_at", [project.id, project.name, profileId, project.description, project.role, JSON.stringify(project.hardware), JSON.stringify(project.software), JSON.stringify(project.technologyStack), project.time ?? null, JSON.stringify(project.sourceIds), project.confidence, normalizeProjectOwnershipMode(project.ownershipMode), project.ownershipNote ?? null, now, now]);
    }
    for (const module of snapshot.modules) this.database.run("INSERT INTO project_modules(id, project_id, module_name, description, file_path, source_ids_json) VALUES (?, ?, ?, ?, ?, ?)", [module.id, module.projectId, module.moduleName, module.description, module.filePath ?? null, JSON.stringify(module.sourceIds)]);
    for (const point of snapshot.technicalPoints) this.database.run("INSERT INTO technical_points(id, project_id, topic, content, importance, source_ids_json) VALUES (?, ?, ?, ?, ?, ?)", [point.id, point.projectId, point.topic, point.content, point.importance, JSON.stringify(point.sourceIds)]);
    for (const problem of snapshot.problems) this.database.run("INSERT INTO project_problems(id, project_id, problem, cause, solution, result, source_ids_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [problem.id, problem.projectId, problem.problem, problem.cause, problem.solution, problem.result, JSON.stringify(problem.sourceIds)]);
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
    const saveFact = (fact: ProjectFact): void => {
      fact = withFactSemantics(fact);
      const verified = previousFactVerification.get(fact.id) ?? fact.verified;
      const contentHash = projectFactEmbeddingHash(fact.title, fact.content);
      const previous = previousFactEmbeddings.get(fact.id);
      const keepEmbedding = previous?.embeddingHash === contentHash && Boolean(previous.embeddingJson);
      const persistedStatus = fact.evidence?.some((item) => item.quote.trim()) ? fact.status ?? "active" : "pending_review";
      this.database.run("INSERT INTO project_facts(id, project_id, fact_type, title, content, confidence, verified, status, evidence_level, scope, section_path_json, subtype, canonical_key, cardinality, variant_context, conflict_status, conflict_group_id, ownership, stale, embedding_json, embedding_hash, embedding_model, embedding_version, embedding_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, fact_type=excluded.fact_type, title=excluded.title, content=excluded.content, confidence=excluded.confidence, verified=CASE WHEN project_facts.verified=1 THEN 1 ELSE excluded.verified END, status=CASE WHEN project_facts.verified=1 AND project_facts.evidence_level='confirmed-user' THEN project_facts.status ELSE excluded.status END, evidence_level=CASE WHEN project_facts.verified=1 AND project_facts.evidence_level='confirmed-user' THEN project_facts.evidence_level ELSE excluded.evidence_level END, scope=excluded.scope, section_path_json=excluded.section_path_json, subtype=excluded.subtype, canonical_key=excluded.canonical_key, cardinality=excluded.cardinality, variant_context=excluded.variant_context, conflict_status=excluded.conflict_status, conflict_group_id=excluded.conflict_group_id, ownership=CASE WHEN project_facts.ownership='self' THEN project_facts.ownership ELSE excluded.ownership END, stale=0, embedding_json=excluded.embedding_json, embedding_hash=excluded.embedding_hash, embedding_model=excluded.embedding_model, embedding_version=excluded.embedding_version, embedding_updated_at=excluded.embedding_updated_at, updated_at=excluded.updated_at", [fact.id, fact.projectId, fact.type, fact.title, fact.content, Math.max(0, Math.min(1, fact.confidence)), verified ? 1 : 0, persistedStatus, fact.evidenceLevel ?? "confirmed-document", fact.scope ?? "project", JSON.stringify(fact.sectionPath ?? []), fact.subtype ?? null, fact.canonicalKey ?? null, fact.cardinality ?? null, fact.variantContext ?? null, fact.conflictStatus ?? "confirmed", fact.conflictGroupId ?? null, fact.ownership ?? "project", fact.stale ? 1 : 0, keepEmbedding ? previous?.embeddingJson : null, keepEmbedding ? contentHash : null, keepEmbedding ? previous?.embeddingModel ?? null : null, keepEmbedding ? previous?.embeddingVersion ?? null : null, keepEmbedding ? previous?.embeddingUpdatedAt ?? null : null, fact.createdAt ?? now, fact.updatedAt ?? now]);
      this.database.run("DELETE FROM project_fact_sources WHERE fact_id = ?", [fact.id]);
      const evidence: ProjectFactEvidence[] = fact.evidence?.length ? fact.evidence : fact.sourceIds.map((sourceId) => ({ sourceId, quote: "" }));
      for (const item of evidence) this.database.run("INSERT OR IGNORE INTO project_fact_sources(fact_id, source_id, quote, locator, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)", [fact.id, item.sourceId, item.quote || null, item.locator ?? null, item.relation ?? "support", now]);
      this.database.run("UPDATE project_facts SET experience_relation = ?, value_json = ? WHERE id = ?", [fact.experienceRelation ?? inferExperienceRelation(fact), fact.value ? JSON.stringify(fact.value) : null, fact.id]);
    };
    const factsToSave: ProjectFact[] = [];
    if (snapshot.facts?.length) {
      for (const item of snapshot.facts) factsToSave.push({ ...item, profileId, status: item.status ?? "active", createdAt: item.createdAt ?? now, updatedAt: now });
    } else {
      for (const project of snapshot.projects) {
        factsToSave.push({ id: `${project.id}-fact-background`, projectId: project.id, profileId, type: "background", title: "项目背景", content: project.description, confidence: project.confidence, verified: false, sourceIds: project.sourceIds, createdAt: now, updatedAt: now });
        factsToSave.push({ id: `${project.id}-fact-responsibility`, projectId: project.id, profileId, type: "responsibility", title: "个人职责", content: project.role, confidence: project.confidence, verified: false, sourceIds: project.sourceIds, createdAt: now, updatedAt: now });
        if (project.technologyStack.length || project.hardware.length || project.software.length) factsToSave.push({ id: `${project.id}-fact-technology`, projectId: project.id, profileId, type: "technology", title: "技术栈与平台", content: [`技术栈：${project.technologyStack.join("、")}`, `硬件：${project.hardware.join("、")}`, `软件：${project.software.join("、")}`].filter((item) => !item.endsWith("：")).join("\n"), confidence: project.confidence, verified: false, sourceIds: project.sourceIds, createdAt: now, updatedAt: now });
      }
      for (const module of snapshot.modules) factsToSave.push({ id: `${module.id}-fact`, projectId: module.projectId, profileId: projectById.get(module.projectId)?.profileId ?? profileId, type: "module", title: module.moduleName, content: module.description, confidence: projectById.get(module.projectId)?.confidence ?? 0.65, verified: false, sourceIds: module.sourceIds, createdAt: now, updatedAt: now });
      for (const point of snapshot.technicalPoints) factsToSave.push({ id: `${point.id}-fact`, projectId: point.projectId, profileId: projectById.get(point.projectId)?.profileId ?? profileId, type: "technology", title: point.topic, content: point.content, confidence: projectById.get(point.projectId)?.confidence ?? 0.65, verified: false, sourceIds: point.sourceIds, createdAt: now, updatedAt: now });
      for (const problem of snapshot.problems) factsToSave.push({ id: `${problem.id}-fact`, projectId: problem.projectId, profileId: projectById.get(problem.projectId)?.profileId ?? profileId, type: "challenge", title: problem.problem, content: [`原因：${problem.cause}`, `解决：${problem.solution}`, `结果：${problem.result}`].join("\n"), confidence: projectById.get(problem.projectId)?.confidence ?? 0.65, verified: false, sourceIds: problem.sourceIds, createdAt: now, updatedAt: now });
    }
    for (const fact of factsToSave) saveFact(fact);
    const incomingFactIds = new Set(factsToSave.map((fact) => fact.id));
    const changedFactIdsByProject = new Map<string, Set<string>>();
    const markChanged = (fact: ProjectFact): void => {
      const previous = previousFacts.get(fact.id);
      if (fact.evidenceLevel === "confirmed-user" || fact.verified || previous?.evidenceLevel === "confirmed-user" || previous?.verified) return;
      const ids = changedFactIdsByProject.get(fact.projectId) ?? new Set<string>();
      ids.add(fact.id);
      changedFactIdsByProject.set(fact.projectId, ids);
    };
    for (const fact of factsToSave) {
      const before = previousFacts.get(fact.id);
      const beforeValue = JSON.stringify({ key: before?.canonicalKey ?? null, type: before?.type ?? null, title: before?.title ?? null, content: before?.content ?? null, value: before?.value ?? null });
      const afterValue = JSON.stringify({ key: fact.canonicalKey ?? null, type: fact.type, title: fact.title, content: fact.content, value: fact.value ?? null });
      if (!before || beforeValue !== afterValue || Boolean(before.stale) !== Boolean(fact.stale)) markChanged(fact);
    }
    for (const [factId, before] of previousFacts) {
      if (!incomingFactIds.has(factId) && !before.verified && before.evidenceLevel !== "confirmed-user") {
        this.database.run("UPDATE project_facts SET stale = 1, updated_at = ? WHERE id = ?", [now, factId]);
        markChanged(before);
      }
    }
    for (const project of snapshot.projects) this.syncProjectSkillsForProject(project.id, now);
    const questionBank = new SqliteQuestionBankRepository(this.database);
    for (const [projectId, factIds] of changedFactIdsByProject) questionBank.invalidateProjectQaDependencies(projectId, [...factIds], now);
    for (const question of snapshot.interviewQuestions) {
      const project = projectById.get(question.projectId);
      questionBank.saveQuestion({ id: question.id, canonicalText: question.question, type: "project", bankType: "project", category: "project", scope: "project", profileId, projectId: question.projectId, source: "generated", confidence: project?.confidence ?? 0.65, verified: false, variants: question.keywords, factIds: question.factIds });
      questionBank.saveAnswerCard({ id: `${question.id}-generated-answer`, questionId: question.id, content: question.answerPoints.join("\n"), keyPoints: question.answerPoints, sourceType: "generated", verified: false, factIds: question.factIds });
    }
    for (const assignment of previousAssignments) this.sources.assign(assignment);
    this.database.flushNow();
    return this.getSnapshot(profileId);
  }

  listFacts(profileId: string, projectId?: string, options: { includeStale?: boolean; includeRejected?: boolean } = {}): ProjectFact[] {
    const conditions = ["p.profile_id = ?"];
    const params: Array<string | number> = [profileId];
    if (projectId) { conditions.push("f.project_id = ?"); params.push(projectId); }
    if (!options.includeStale) conditions.push("COALESCE(f.stale, 0) = 0");
    if (!options.includeRejected) conditions.push("f.status <> 'rejected'");
    else conditions.push("f.status IN ('active', 'pending_review', 'conflicting', 'rejected')");
    const rows = this.database.all<Record<string, unknown>>(`SELECT f.id, f.project_id AS projectId, p.profile_id AS profileId, f.fact_type AS type, f.title, f.content, f.confidence, f.verified, f.status, f.evidence_level AS evidenceLevel, f.scope, f.section_path_json AS sectionPathJson, f.subtype, f.canonical_key AS canonicalKey, f.cardinality, f.variant_context AS variantContext, f.conflict_status AS conflictStatus, f.conflict_group_id AS conflictGroupId, f.ownership, f.stale, f.embedding_json AS embeddingJson, f.embedding_hash AS embeddingHash, f.embedding_model AS embeddingModel, f.embedding_version AS embeddingVersion, f.embedding_updated_at AS embeddingUpdatedAt, f.created_at AS createdAt, f.updated_at AS updatedAt FROM project_facts f JOIN projects p ON p.id = f.project_id WHERE ${conditions.join(" AND ")} ORDER BY CASE WHEN f.conflict_status IN ('conflicting','pending_review') THEN 0 ELSE 1 END, f.verified DESC, f.confidence DESC, f.updated_at DESC`, params);
    return rows.map((row) => this.hydrateFact(row));
  }

  getFact(factId: string): ProjectFact | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT f.id, f.project_id AS projectId, p.profile_id AS profileId, f.fact_type AS type, f.title, f.content, f.confidence, f.verified, f.status, f.evidence_level AS evidenceLevel, f.scope, f.section_path_json AS sectionPathJson, f.subtype, f.canonical_key AS canonicalKey, f.cardinality, f.variant_context AS variantContext, f.conflict_status AS conflictStatus, f.conflict_group_id AS conflictGroupId, f.ownership, f.stale, f.embedding_json AS embeddingJson, f.embedding_hash AS embeddingHash, f.embedding_model AS embeddingModel, f.embedding_version AS embeddingVersion, f.embedding_updated_at AS embeddingUpdatedAt, f.created_at AS createdAt, f.updated_at AS updatedAt FROM project_facts f JOIN projects p ON p.id = f.project_id WHERE f.id = ?", [factId]);
    return row ? this.hydrateFact(row) : undefined;
  }

  addCandidateFact(fact: ProjectFact, now = Date.now()): ProjectFact {
    if (!fact.projectId || !fact.sourceIds.length || !fact.evidence?.length) throw new Error("PROJECT_FACT_EVIDENCE_REQUIRED");
    fact = withFactSemantics(fact);
    this.database.run("INSERT INTO project_facts(id, project_id, fact_type, title, content, confidence, verified, status, evidence_level, scope, section_path_json, subtype, canonical_key, cardinality, variant_context, conflict_status, conflict_group_id, ownership, stale, embedding_json, embedding_hash, embedding_model, embedding_version, embedding_updated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, confidence=excluded.confidence, status='pending_review', evidence_level=excluded.evidence_level, scope=excluded.scope, section_path_json=excluded.section_path_json, subtype=excluded.subtype, canonical_key=excluded.canonical_key, cardinality=excluded.cardinality, variant_context=excluded.variant_context, ownership=excluded.ownership, stale=0, updated_at=excluded.updated_at", [fact.id, fact.projectId, fact.type, fact.title, fact.content, Math.max(0, Math.min(1, fact.confidence)), fact.evidenceLevel ?? "pending", fact.scope ?? "project", JSON.stringify(fact.sectionPath ?? []), fact.subtype ?? null, fact.canonicalKey ?? null, fact.cardinality ?? null, fact.variantContext ?? null, fact.conflictStatus ?? "pending_review", fact.conflictGroupId ?? null, fact.ownership ?? "project", fact.createdAt ?? now, now]);
    this.database.run("DELETE FROM project_fact_sources WHERE fact_id = ?", [fact.id]);
    for (const item of fact.evidence ?? []) this.database.run("INSERT OR IGNORE INTO project_fact_sources(fact_id, source_id, quote, locator, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)", [fact.id, item.sourceId, item.quote, item.locator ?? null, item.relation ?? "support", now]);
    this.database.run("UPDATE project_facts SET experience_relation = ?, value_json = ? WHERE id = ?", [fact.experienceRelation ?? inferExperienceRelation(fact), fact.value ? JSON.stringify(fact.value) : null, fact.id]);
    this.database.flushNow();
    return this.getFact(fact.id) as ProjectFact;
  }

  /** Add an explicitly user-authored responsibility fact. */
  addUserResponsibility(profileId: string, projectId: string, content: string, now = Date.now()): ProjectFact {
    const value = content.trim();
    if (!value) throw new Error("PROJECT_RESPONSIBILITY_REQUIRED");
    const project = this.getProject(projectId);
    if (!project || project.profileId !== profileId) throw new Error("PROJECT_NOT_FOUND");
    const sourceId = id("user-fact", now);
    this.sources.assign({ projectId, sourceType: "user_fact", sourceId, relationship: "supporting", sourceRole: "responsibility", assignmentMethod: "manual", confidence: 1, verified: true }, now);
    const factId = `${projectId}-responsibility-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const fact = this.addCandidateFact({ id: factId, projectId, profileId, type: "responsibility", factType: "responsibility", title: "个人职责", content: value.slice(0, 1_000), confidence: 1, verified: false, sourceIds: [sourceId], evidence: [{ sourceId, quote: value.slice(0, 800), relation: "support" }], scope: "project", evidenceLevel: "confirmed-user", ownership: "self", status: "pending_review" }, now);
    return this.setFactReviewStatus(fact.id, "active", now) as ProjectFact;
  }

  /** Single source of truth for an explicit human confirmation. */
  confirmFactAsUser(factId: string, options: { now?: number; allowConflict?: boolean } = {}): ProjectFact | undefined {
    const before = this.getFact(factId);
    if (!before) return undefined;
    if (before.stale || before.status === "rejected") throw new Error("PROJECT_FACT_NOT_CONFIRMABLE");
    if ((before.status === "conflicting" || before.conflictStatus === "conflicting") && !options.allowConflict) throw new Error("PROJECT_CONFLICT_REQUIRES_WINNER");
    if (!before.evidence?.some((item) => item.quote.trim() && item.relation !== "refute")) throw new Error("PROJECT_FACT_EVIDENCE_REQUIRED");
    const now = options.now ?? Date.now();
    const promoteToUser = before.type === "responsibility" || before.type === "result" || before.type === "metric" || ["pending", "inferred", "risk"].includes(before.evidenceLevel ?? "pending");
    this.database.run("UPDATE project_facts SET verified = 1, status = 'active', conflict_status = 'confirmed', ownership = CASE WHEN fact_type = 'responsibility' THEN 'self' ELSE ownership END, evidence_level = CASE WHEN ? = 1 THEN 'confirmed-user' ELSE evidence_level END, updated_at = ? WHERE id = ?", [promoteToUser ? 1 : 0, now, factId]);
    const after = this.getFact(factId);
    this.markDependentQuestionsStaleIfNeeded(before, after, now);
    this.syncProjectSkillsForProject(before.projectId, now);
    this.database.flushNow();
    return this.getFact(factId);
  }

  private markDependentQuestionsStaleIfNeeded(before: ProjectFact | undefined, after: ProjectFact | undefined, now: number): void {
    if (!before || !after || isFactEligible(before) === isFactEligible(after)) return;
    this.database.run("UPDATE question_bank_questions SET stale = 1, updated_at = ? WHERE id IN (SELECT question_id FROM question_bank_question_facts WHERE fact_id = ?)", [now, before.id]);
    this.database.run("UPDATE question_bank_answer_cards SET stale = 1, updated_at = ? WHERE question_id IN (SELECT question_id FROM question_bank_question_facts WHERE fact_id = ?)", [now, before.id]);
  }

  setFactVerification(factId: string, verified: boolean, now = Date.now()): ProjectFact | undefined {
    if (verified) return this.confirmFactAsUser(factId, { now });
    const before = this.getFact(factId);
    if (!before) return undefined;
    this.database.run("UPDATE project_facts SET verified = ?, ownership = CASE WHEN ? = 1 AND fact_type = 'responsibility' THEN 'self' ELSE ownership END, status = CASE WHEN ? = 1 AND status = 'pending_review' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?", [verified ? 1 : 0, verified ? 1 : 0, verified ? 1 : 0, now, factId]);
    const after = this.getFact(factId);
    this.markDependentQuestionsStaleIfNeeded(before, after, now);
    this.syncProjectSkillsForProject(before.projectId, now);
    this.database.flushNow();
    return this.getFact(factId);
  }

  searchFacts(profileId: string, query: string, options: { projectId?: string; detectedProjectId?: string; queryEmbedding?: number[]; questionType?: string; limit?: number; minScore?: number; mode?: "answer" | "review"; includeReferenceProject?: boolean } = {}): ProjectFactMatch[] {
    const mode = options.mode ?? "answer";
    const referenceProjectIds = new Set(this.projects.list().filter((project) => project.profileId === profileId && normalizeProjectOwnershipMode(project.ownershipMode) === "reference").map((project) => project.id));
    const candidates = this.listFacts(profileId, undefined, { includeStale: mode === "review", includeRejected: false }).filter((fact) => !referenceProjectIds.has(fact.projectId) || options.includeReferenceProject).filter((fact) => mode === "answer" ? isFactEligible(fact) : isFactReviewRequired(fact));
    const hits = new ProjectFactMemoryRetriever().search(query, candidates, {
      selectedProjectId: options.projectId,
      detectedProjectId: options.detectedProjectId,
      queryEmbedding: options.queryEmbedding,
      questionType: options.questionType,
      topK: options.limit,
      minScore: options.minScore
    });
    return hits.map((hit: ProjectRetrievalHit) => ({ ...hit, score: hit.finalScore }));
  }

  setFactReviewStatus(factId: string, status: ProjectFact["status"], now = Date.now()): ProjectFact | undefined {
    if (!this.getFact(factId) || !status) return undefined;
    if (status === "active") return this.confirmFactAsUser(factId, { now });
    const before = this.getFact(factId);
    this.database.run("UPDATE project_facts SET status = ?, ownership = CASE WHEN ? = 'active' AND fact_type = 'responsibility' THEN 'self' ELSE ownership END, evidence_level = CASE WHEN ? = 'active' AND fact_type = 'responsibility' THEN 'confirmed-user' ELSE evidence_level END, conflict_status = CASE WHEN ? = 'active' AND conflict_status = 'pending_review' THEN 'confirmed' ELSE conflict_status END, updated_at = ? WHERE id = ?", [status, status, status, status, now, factId]);
    const after = this.getFact(factId);
    this.markDependentQuestionsStaleIfNeeded(before, after, now);
    this.syncProjectSkillsForProject(before?.projectId ?? "", now);
    this.database.flushNow();
    return this.getFact(factId);
  }

  resolveConflict(conflictGroupId: string, selectedFactId: string, keepBoth = false, variantContexts?: Record<string, string>, now = Date.now()): ProjectFact[] {
    const selected = this.getFact(selectedFactId);
    if (!selected || selected.conflictGroupId !== conflictGroupId) throw new Error("PROJECT_CONFLICT_SELECTION_INVALID");
    const siblings = this.listFacts(String(selected.profileId ?? ""), selected.projectId, { includeStale: true, includeRejected: true }).filter((fact) => fact.conflictGroupId === conflictGroupId);
    if (keepBoth) {
      if (!variantContexts || siblings.some((fact) => !variantContexts[fact.id]?.trim())) throw new Error("PROJECT_CONFLICT_VARIANT_CONTEXT_REQUIRED");
      for (const fact of siblings) {
        this.database.run("UPDATE project_facts SET status='active', conflict_status='confirmed', variant_context=?, updated_at=? WHERE id=?", [variantContexts[fact.id].trim().slice(0, 120), now, fact.id]);
      }
    } else {
      this.database.run("UPDATE project_facts SET status='rejected', conflict_status='confirmed', updated_at=? WHERE conflict_group_id=? AND id <> ?", [now, conflictGroupId, selectedFactId]);
      this.confirmFactAsUser(selectedFactId, { now, allowConflict: true });
    }
    for (const fact of siblings) this.markDependentQuestionsStaleIfNeeded(fact, this.getFact(fact.id), now);
    this.syncProjectSkillsForProject(selected.projectId, now);
    this.database.flushNow();
    return this.listFacts(String(selected.profileId ?? ""), selected.projectId);
  }

  listProjectSkills(projectId: string): Array<{ projectId: string; skillId: string; sourceFactId?: string }> {
    return this.database.all<Record<string, unknown>>("SELECT project_id AS projectId, skill_id AS skillId, source_fact_id AS sourceFactId FROM project_skills WHERE project_id = ?", [projectId]).map((row) => ({ projectId: String(row.projectId), skillId: String(row.skillId), ...(row.sourceFactId ? { sourceFactId: String(row.sourceFactId) } : {}) }));
  }

  private evidenceLevelForAssignments(fact: ProjectFact, assignments: ProjectSourceRecord[]): NonNullable<ProjectFact["evidenceLevel"]> {
    const levels = assignments.filter((assignment) => assignment.relationship !== "reference" && fact.evidence?.some((item) => item.sourceId === assignment.sourceId && item.relation !== "refute" && item.quote.trim())).map((assignment) => {
      if (assignment.sourceType === "user_fact" || assignment.sourceRole === "responsibility" || assignment.sourceRole === "resume") return "confirmed-user" as const;
      if (assignment.sourceRole === "code" || assignment.sourceType === "repository") return "confirmed-code" as const;
      if (["overview", "architecture", "test", "debug"].includes(assignment.sourceRole ?? "")) return "confirmed-document" as const;
      return "pending" as const;
    });
    const rank: Record<NonNullable<ProjectFact["evidenceLevel"]>, number> = { pending: 0, inferred: 0, risk: 0, "not-measured": 0, "confirmed-document": 1, "confirmed-code": 2, "confirmed-user": 3 };
    return levels.sort((left, right) => rank[right] - rank[left])[0] ?? "pending";
  }

  private syncProjectSkillsForProject(projectId: string, now = Date.now()): void {
    const profileId = this.database.first<{ profileId: string }>("SELECT profile_id AS profileId FROM projects WHERE id = ?", [projectId])?.profileId;
    if (!profileId) return;
    this.syncProjectSkills(profileId, projectId, this.listFacts(profileId, projectId, { includeStale: true, includeRejected: true }), now);
  }

  private syncProjectSkills(profileId: string, projectId: string, facts: ProjectFact[], now: number): void {
    const skills = this.database.all<{ id: string; name: string }>("SELECT id, name FROM skills WHERE profile_id = ?", [profileId]);
    const expected = new Map<string, string>();
    for (const fact of facts.filter((item) => item.projectId === projectId && ["technology", "hardware", "software"].includes(item.type) && isFactEligible(item))) {
      const skill = skills.find((item) => normalizeSkillKey(item.name) === normalizeSkillKey(fact.title));
      if (skill && !expected.has(skill.id)) expected.set(skill.id, fact.id);
    }
    const actual = this.database.all<{ skillId: string }>("SELECT skill_id AS skillId FROM project_skills WHERE project_id = ?", [projectId]);
    for (const row of actual) if (!expected.has(row.skillId)) this.database.run("DELETE FROM project_skills WHERE project_id = ? AND skill_id = ?", [projectId, row.skillId]);
    for (const [skillId, factId] of expected) this.database.run("INSERT INTO project_skills(project_id, skill_id, source_fact_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, skill_id) DO UPDATE SET source_fact_id=excluded.source_fact_id, updated_at=excluded.updated_at", [projectId, skillId, factId, now, now]);
  }

  getProjectCompleteness(profileId: string, projectId: string): ProjectCompletenessResult | undefined {
    const snapshot = this.getSnapshot(profileId);
    const project = snapshot.projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    return calculateProjectCompleteness({ project, facts: this.listFacts(profileId, projectId), modules: snapshot.modules, problems: snapshot.problems, questions: snapshot.interviewQuestions });
  }

  listConflictGroups(projectId: string, includeResolved = false): ProjectConflictGroup[] {
    const profileId = this.database.first<{ profileId: string }>("SELECT profile_id AS profileId FROM projects WHERE id = ?", [projectId])?.profileId;
    if (!profileId) return [];
    return listConflictGroups(this.listFacts(profileId, projectId, { includeStale: includeResolved, includeRejected: includeResolved }), { projectId, includeResolved });
  }

  listUserActions(projectId: string): ProjectUserAction[] {
    const project = this.getProject(projectId);
    const profileId = project?.profileId;
    if (!profileId) return [];
    return listUserActions(this.listFacts(profileId, projectId), projectId, project);
  }

  /** Reclassifies legacy technical rows in place without deleting facts or evidence. */
  repairProjectTechnicalSemantics(projectId: string, now = Date.now()): ProjectFact[] {
    const project = this.getProject(projectId);
    if (!project) return [];
    const existing = this.listFacts(project.profileId, projectId, { includeStale: true, includeRejected: true });
    const assignments = this.sources.listProjectSources(projectId);
    const normalizedExisting = existing.map((fact) => {
      // Migration 21 established these trust defaults. Re-run the same
      // deterministic derivation for legacy databases whose migration marker
      // was already past 23; never lower an existing user confirmation.
      const trustBackfill = fact.status !== "rejected"
        ? fact.type === "responsibility" && fact.verified
          ? { ownership: "self" as const, evidenceLevel: "confirmed-user" as const }
          : fact.verified && fact.evidenceLevel === "pending"
            ? { evidenceLevel: "confirmed-user" as const }
            : !fact.verified && fact.evidenceLevel === "pending" && fact.evidence?.some((item) => item.quote.trim())
              ? { evidenceLevel: this.evidenceLevelForAssignments(fact, assignments) }
              : {}
        : {};
      const enriched = { ...fact, ...trustBackfill };
      return enriched.type !== "parameter" && ["metric", "technology"].includes(enriched.type) && canonicalProjectParameterKey(enriched)
        ? { ...enriched, type: "parameter" as const, factType: "parameter" as const, value: normalizeProjectFactValue(enriched.value, enriched.content) }
        : withFactSemantics(enriched);
    });
    const repaired = new ProjectFactConflictResolver().resolve(normalizedExisting);
    const repairedIds = new Set(repaired.map((fact) => fact.id));
    this.database.run("BEGIN");
    try {
      for (const fact of existing) {
        const next = repaired.find((candidate) => candidate.id === fact.id);
        if (!next) {
          this.database.run("UPDATE project_facts SET status='rejected', conflict_status='confirmed', conflict_group_id=NULL, updated_at=? WHERE id=?", [now, fact.id]);
          continue;
        }
        const persistence = next.conflictGroupId ? next : {
          ...next,
          status: next.status === "rejected" ? "rejected" as const : ["pending", "inferred", "risk"].includes(next.evidenceLevel ?? "pending") ? "pending_review" as const : "active" as const,
          conflictStatus: next.status === "conflicting" ? "conflicting" as const : "confirmed" as const,
          conflictGroupId: undefined
        };
        this.database.run("UPDATE project_facts SET canonical_key=?, cardinality=?, variant_context=?, status=?, conflict_status=?, conflict_group_id=?, evidence_level=?, ownership=?, updated_at=? WHERE id=?", [persistence.canonicalKey ?? null, persistence.cardinality ?? null, persistence.variantContext ?? null, persistence.status ?? "active", persistence.conflictStatus ?? "confirmed", persistence.conflictGroupId ?? null, persistence.evidenceLevel ?? fact.evidenceLevel ?? "pending", persistence.ownership ?? fact.ownership ?? "project", now, fact.id]);
        this.database.run("UPDATE project_facts SET fact_type=?, experience_relation=?, value_json=? WHERE id=?", [persistence.type, persistence.experienceRelation ?? inferExperienceRelation(persistence), persistence.value ? JSON.stringify(persistence.value) : null, fact.id]);
        if (persistence.evidence) {
          this.database.run("DELETE FROM project_fact_sources WHERE fact_id=?", [fact.id]);
          for (const item of persistence.evidence) this.database.run("INSERT OR IGNORE INTO project_fact_sources(fact_id, source_id, quote, locator, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)", [fact.id, item.sourceId, item.quote || null, item.locator ?? null, item.relation ?? "support", now]);
        }
      }
      this.database.run("COMMIT");
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
    this.syncProjectSkillsForProject(projectId, now);
    this.database.flushNow();
    return this.listFacts(project.profileId, projectId, { includeStale: true, includeRejected: true }).filter((fact) => repairedIds.has(fact.id));
  }

  /** Compatibility alias retained for the existing IPC and callers. */
  repairProjectFactSemantics(projectId: string, now = Date.now()): ProjectFact[] {
    return this.repairProjectTechnicalSemantics(projectId, now);
  }

  setFactEmbedding(factId: string, embedding: number[], options: { model?: string; version?: string; now?: number } = {}): ProjectFact | undefined {
    const fact = this.getFact(factId);
    const vector = embedding.filter((value) => Number.isFinite(value));
    if (!fact || vector.length === 0) return fact;
    const now = options.now ?? Date.now();
    this.database.run("UPDATE project_facts SET embedding_json = ?, embedding_hash = ?, embedding_model = ?, embedding_version = ?, embedding_updated_at = ?, updated_at = ? WHERE id = ?", [JSON.stringify(vector), projectFactEmbeddingHash(fact.title, fact.content), options.model ?? null, options.version ?? "project-facts-v1", now, now, factId]);
    this.database.flushNow();
    return this.getFact(factId);
  }

  async embedFacts(profileId: string, embed: (text: string, signal?: AbortSignal) => Promise<number[]>, options: { projectId?: string; model?: string; version?: string; concurrency?: number; signal?: AbortSignal } = {}): Promise<{ embedded: number; reused: number; failed: number }> {
    const facts = this.listFacts(profileId, options.projectId).filter((fact) => fact.status === "active");
    const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)));
    let embedded = 0;
    let reused = 0;
    let failed = 0;
    const pending = facts.filter((fact) => {
      const sameContent = Boolean(fact.embedding?.length && fact.embeddingHash === projectFactEmbeddingHash(fact.title, fact.content));
      const sameModel = !options.model || fact.embeddingModel === options.model;
      const sameVersion = !options.version || fact.embeddingVersion === options.version;
      if (sameContent && sameModel && sameVersion) { reused += 1; return false; }
      return true;
    });
    for (let index = 0; index < pending.length; index += concurrency) {
      options.signal?.throwIfAborted?.();
      await Promise.all(pending.slice(index, index + concurrency).map(async (fact) => {
        try {
          options.signal?.throwIfAborted?.();
          const vector = await embed(`${fact.title}\n${fact.content}`, options.signal);
          if (this.setFactEmbedding(fact.id, vector, options)) embedded += 1;
          else failed += 1;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          failed += 1;
        }
      }));
    }
    return { embedded, reused, failed };
  }

  private hydrateFact(row: Record<string, unknown>): ProjectFact {
    const evidence = this.database.all<{ sourceId: string; quote: string | null; locator: string | null; relation: string | null }>("SELECT source_id AS sourceId, quote, locator, relation FROM project_fact_sources WHERE fact_id = ? ORDER BY created_at", [String(row.id)]).map((item) => ({ sourceId: item.sourceId, quote: item.quote ?? "", ...(item.locator ? { locator: item.locator } : {}), relation: item.relation === "refute" ? "refute" : "support" } satisfies ProjectFactEvidence));
    const technical = this.database.first<{ experienceRelation: string | null; valueJson: string | null }>("SELECT experience_relation AS experienceRelation, value_json AS valueJson FROM project_facts WHERE id = ?", [String(row.id)]);
    const sourceIds = evidence.map((item) => item.sourceId);
    const embedding = jsonArray<number>(row.embeddingJson);
    return { id: String(row.id), projectId: String(row.projectId), profileId: String(row.profileId), type: String(row.type) as ProjectFactType, factType: String(row.type) as ProjectFactType, title: String(row.title), content: String(row.content), confidence: Number(row.confidence ?? 1), verified: Number(row.verified) === 1, sourceIds, evidence, scope: String(row.scope ?? "project") as ProjectFact["scope"], sectionPath: jsonArray<string>(row.sectionPathJson), evidenceLevel: String(row.evidenceLevel ?? "pending") as ProjectFact["evidenceLevel"], ...(row.subtype ? { subtype: String(row.subtype) } : {}), ...(row.canonicalKey ? { canonicalKey: String(row.canonicalKey) } : {}), ...(row.cardinality ? { cardinality: String(row.cardinality) as ProjectFact["cardinality"] } : {}), ...(row.variantContext ? { variantContext: String(row.variantContext) } : {}), status: String(row.status ?? "active") as ProjectFact["status"], conflictStatus: String(row.conflictStatus ?? "pending_review") as ProjectFact["conflictStatus"], ...(row.conflictGroupId ? { conflictGroupId: String(row.conflictGroupId) } : {}), ownership: String(row.ownership ?? "project") as ProjectFact["ownership"], experienceRelation: technical?.experienceRelation ? technical.experienceRelation as ProjectFact["experienceRelation"] : inferExperienceRelation({ type: String(row.type) as ProjectFactType, title: String(row.title), content: String(row.content) }), ...(technical?.valueJson ? { value: safeJson<ProjectFact["value"]>(technical.valueJson) } : {}), stale: Number(row.stale) === 1, ...(embedding.length ? { embedding } : {}), ...(row.embeddingHash ? { embeddingHash: String(row.embeddingHash) } : {}), ...(row.embeddingModel ? { embeddingModel: String(row.embeddingModel) } : {}), ...(row.embeddingVersion ? { embeddingVersion: String(row.embeddingVersion) } : {}), ...(row.embeddingUpdatedAt ? { embeddingUpdatedAt: Number(row.embeddingUpdatedAt) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  stats(profileId: string, projectId?: string): ProjectMemoryStats {
    const snapshot = this.getSnapshot(profileId);
    const scopedProjects = projectId ? snapshot.projects.filter((project) => project.id === projectId) : snapshot.projects;
    const allFacts = this.listFacts(profileId, projectId, { includeStale: true, includeRejected: true });
    const currentFacts = allFacts.filter((fact) => !fact.stale && fact.status !== "rejected");
    const questions = snapshot.interviewQuestions.filter((question) => !projectId || question.projectId === projectId).length;
    const conflictGroups = listConflictGroups(currentFacts, { projectId }).filter((group) => !group.resolved);
    const userActions = projectId
      ? listUserActions(currentFacts, projectId, scopedProjects[0])
      : scopedProjects.flatMap((project) => listUserActions(currentFacts, project.id, project));
    const familiarity = projectId && scopedProjects[0] ? calculateProjectCompleteness({ project: scopedProjects[0], facts: currentFacts, modules: snapshot.modules, problems: snapshot.problems, questions: snapshot.interviewQuestions }).projectFamiliarityScore : undefined;
    return { projects: scopedProjects.length, modules: snapshot.modules.filter((item) => !projectId || item.projectId === projectId).length, technicalPoints: snapshot.technicalPoints.filter((item) => !projectId || item.projectId === projectId).length, problems: snapshot.problems.filter((item) => !projectId || item.projectId === projectId).length, interviewQuestions: questions, questions, facts: currentFacts.length, eligibleFacts: currentFacts.filter(isFactEligible).length, reviewRequiredFacts: currentFacts.filter(isFactReviewRequired).length, userActionRequiredFacts: userActions.length, conflictingFacts: currentFacts.filter((fact) => fact.conflictStatus === "conflicting" || fact.status === "conflicting").length, conflictGroups: conflictGroups.length, userActions: userActions.length, staleFacts: allFacts.filter((fact) => fact.stale).length, ...(familiarity === undefined ? {} : { projectFamiliarityScore: familiarity }) };
  }
}

export { SqliteRetrievalRepository } from "./database/retrieval-repository";
export type { RetrievalHitInput, RetrievalRunRecord } from "./database/retrieval-repository";

export interface KnowledgeAnalysisRunRecord {
  id: string;
  profileId?: string;
  projectId?: string;
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
  startedAt?: number;
  finishedAt?: number;
  snapshotVersion?: number;
}

export interface ProjectAnalysisState {
  projectId: string;
  latestAnalysisId?: string;
  lastSuccessfulAnalysisId?: string;
  status: "running" | "completed" | "failed" | "stale";
  snapshotVersion: number;
  updatedAt: number;
}

export class SqliteKnowledgeAnalysisRepository {
  constructor(private readonly database: SqliteDatabase) {}

  record(input: Omit<KnowledgeAnalysisRunRecord, "id" | "createdAt" | "updatedAt"> & { id?: string; now?: number }): KnowledgeAnalysisRunRecord {
    const now = input.now ?? Date.now();
    const runId = input.id ?? id("analysis", now);
    this.database.run("INSERT INTO knowledge_analysis_runs(id, profile_id, project_id, run_type, input_hash, model, prompt_version, status, input_snapshot_json, output_json, error, started_at, finished_at, snapshot_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id, project_id=excluded.project_id, run_type=excluded.run_type, input_hash=excluded.input_hash, model=excluded.model, prompt_version=excluded.prompt_version, status=excluded.status, input_snapshot_json=excluded.input_snapshot_json, output_json=excluded.output_json, error=excluded.error, started_at=excluded.started_at, finished_at=excluded.finished_at, snapshot_version=excluded.snapshot_version, updated_at=excluded.updated_at", [runId, input.profileId ?? null, input.projectId ?? null, input.runType, input.inputHash, input.model ?? null, input.promptVersion ?? null, input.status, JSON.stringify(input.inputSnapshot), input.output === undefined ? null : JSON.stringify(input.output), input.error ?? null, input.startedAt ?? now, input.finishedAt ?? (input.status === "running" ? null : now), input.snapshotVersion ?? null, now, now]);
    this.database.flush();
    return { id: runId, ...(input.profileId ? { profileId: input.profileId } : {}), ...(input.projectId ? { projectId: input.projectId } : {}), runType: input.runType, inputHash: input.inputHash, ...(input.model ? { model: input.model } : {}), ...(input.promptVersion ? { promptVersion: input.promptVersion } : {}), status: input.status, inputSnapshot: input.inputSnapshot, ...(input.output === undefined ? {} : { output: input.output }), ...(input.error ? { error: input.error } : {}), createdAt: now, updatedAt: now, startedAt: input.startedAt ?? now, ...(input.status === "running" ? {} : { finishedAt: input.finishedAt ?? now }), ...(input.snapshotVersion === undefined ? {} : { snapshotVersion: input.snapshotVersion }) };
  }

  list(profileId: string): KnowledgeAnalysisRunRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, profile_id AS profileId, project_id AS projectId, run_type AS runType, input_hash AS inputHash, model, prompt_version AS promptVersion, status, input_snapshot_json AS inputSnapshotJson, output_json AS outputJson, error, started_at AS startedAt, finished_at AS finishedAt, snapshot_version AS snapshotVersion, created_at AS createdAt, updated_at AS updatedAt FROM knowledge_analysis_runs WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]).map((row) => ({ id: String(row.id), profileId: String(row.profileId), ...(row.projectId ? { projectId: String(row.projectId) } : {}), runType: String(row.runType), inputHash: String(row.inputHash), ...(row.model ? { model: String(row.model) } : {}), ...(row.promptVersion ? { promptVersion: String(row.promptVersion) } : {}), status: String(row.status) as KnowledgeAnalysisRunRecord["status"], inputSnapshot: JSON.parse(String(row.inputSnapshotJson)), ...(row.outputJson ? { output: JSON.parse(String(row.outputJson)) } : {}), ...(row.error ? { error: String(row.error) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), ...(row.startedAt ? { startedAt: Number(row.startedAt) } : {}), ...(row.finishedAt ? { finishedAt: Number(row.finishedAt) } : {}), ...(row.snapshotVersion ? { snapshotVersion: Number(row.snapshotVersion) } : {}) }));
  }

  setProjectState(input: Omit<ProjectAnalysisState, "updatedAt"> & { updatedAt?: number }): ProjectAnalysisState {
    const now = input.updatedAt ?? Date.now();
    this.database.run("INSERT INTO project_analysis_state(project_id, latest_analysis_id, last_successful_analysis_id, status, snapshot_version, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET latest_analysis_id=excluded.latest_analysis_id, last_successful_analysis_id=COALESCE(excluded.last_successful_analysis_id, project_analysis_state.last_successful_analysis_id), status=excluded.status, snapshot_version=excluded.snapshot_version, updated_at=excluded.updated_at", [input.projectId, input.latestAnalysisId ?? null, input.lastSuccessfulAnalysisId ?? null, input.status, input.snapshotVersion, now]);
    this.database.flush();
    return this.getProjectState(input.projectId) as ProjectAnalysisState;
  }

  getProjectState(projectId: string): ProjectAnalysisState | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT project_id AS projectId, latest_analysis_id AS latestAnalysisId, last_successful_analysis_id AS lastSuccessfulAnalysisId, status, snapshot_version AS snapshotVersion, updated_at AS updatedAt FROM project_analysis_state WHERE project_id = ?", [projectId]);
    return row ? { projectId: String(row.projectId), ...(row.latestAnalysisId ? { latestAnalysisId: String(row.latestAnalysisId) } : {}), ...(row.lastSuccessfulAnalysisId ? { lastSuccessfulAnalysisId: String(row.lastSuccessfulAnalysisId) } : {}), status: String(row.status) as ProjectAnalysisState["status"], snapshotVersion: Number(row.snapshotVersion), updatedAt: Number(row.updatedAt) } : undefined;
  }
}

export class SqliteProjectAnalysisJobRepository {
  constructor(private readonly database: SqliteDatabase) {}

  save(job: ProjectAnalysisJob): ProjectAnalysisJob {
    this.database.run("INSERT INTO project_analysis_jobs(id, profile_id, project_id, status, stage, created_at, started_at, updated_at, finished_at, progress, files_total, files_explored, tool_calls, model_turns, error_code, error_message, cancel_requested) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, stage=excluded.stage, started_at=excluded.started_at, updated_at=excluded.updated_at, finished_at=excluded.finished_at, progress=excluded.progress, files_total=excluded.files_total, files_explored=excluded.files_explored, tool_calls=excluded.tool_calls, model_turns=excluded.model_turns, error_code=excluded.error_code, error_message=excluded.error_message, cancel_requested=excluded.cancel_requested", [job.id, job.profileId, job.projectId, job.status, job.stage, job.createdAt, job.startedAt ?? null, job.updatedAt, job.finishedAt ?? null, job.progress, job.filesTotal, job.filesExplored, job.toolCalls, job.modelTurns, job.errorCode ?? null, job.errorMessage ?? null, job.cancelRequested ? 1 : 0]);
    this.database.flush();
    return this.get(job.id) as ProjectAnalysisJob;
  }

  get(jobId: string): ProjectAnalysisJob | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, profile_id AS profileId, project_id AS projectId, status, stage, created_at AS createdAt, started_at AS startedAt, updated_at AS updatedAt, finished_at AS finishedAt, progress, files_total AS filesTotal, files_explored AS filesExplored, tool_calls AS toolCalls, model_turns AS modelTurns, error_code AS errorCode, error_message AS errorMessage, cancel_requested AS cancelRequested FROM project_analysis_jobs WHERE id = ?", [jobId]);
    return row ? this.hydrate(row) : undefined;
  }

  latestForProject(projectId: string): ProjectAnalysisJob | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, profile_id AS profileId, project_id AS projectId, status, stage, created_at AS createdAt, started_at AS startedAt, updated_at AS updatedAt, finished_at AS finishedAt, progress, files_total AS filesTotal, files_explored AS filesExplored, tool_calls AS toolCalls, model_turns AS modelTurns, error_code AS errorCode, error_message AS errorMessage, cancel_requested AS cancelRequested FROM project_analysis_jobs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1", [projectId]);
    return row ? this.hydrate(row) : undefined;
  }

  list(profileId: string): ProjectAnalysisJob[] {
    return this.database.all<Record<string, unknown>>("SELECT id, profile_id AS profileId, project_id AS projectId, status, stage, created_at AS createdAt, started_at AS startedAt, updated_at AS updatedAt, finished_at AS finishedAt, progress, files_total AS filesTotal, files_explored AS filesExplored, tool_calls AS toolCalls, model_turns AS modelTurns, error_code AS errorCode, error_message AS errorMessage, cancel_requested AS cancelRequested FROM project_analysis_jobs WHERE profile_id = ? ORDER BY updated_at DESC", [profileId]).map((row) => this.hydrate(row));
  }

  recoverInterrupted(now = Date.now()): number {
    const result = this.database.all<Record<string, unknown>>("SELECT id FROM project_analysis_jobs WHERE status IN ('queued', 'mapping', 'exploring', 'synthesizing', 'grounding')");
    if (result.length === 0) return 0;
    this.database.run("UPDATE project_analysis_jobs SET status='failed', stage='failed', error_code='PROJECT_ANALYSIS_INTERRUPTED', error_message='应用重启时分析尚未完成，可重新分析', finished_at=?, updated_at=? WHERE status IN ('queued', 'mapping', 'exploring', 'synthesizing', 'grounding')", [now, now]);
    this.database.flushNow();
    return result.length;
  }

  private hydrate(row: Record<string, unknown>): ProjectAnalysisJob {
    return { id: String(row.id), profileId: String(row.profileId), projectId: String(row.projectId), status: String(row.status) as ProjectAnalysisJob["status"], stage: String(row.stage) as ProjectAnalysisJob["stage"], createdAt: Number(row.createdAt), ...(row.startedAt ? { startedAt: Number(row.startedAt) } : {}), updatedAt: Number(row.updatedAt), ...(row.finishedAt ? { finishedAt: Number(row.finishedAt) } : {}), progress: Number(row.progress ?? 0), filesTotal: Number(row.filesTotal ?? 0), filesExplored: Number(row.filesExplored ?? 0), toolCalls: Number(row.toolCalls ?? 0), modelTurns: Number(row.modelTurns ?? 0), ...(row.errorCode ? { errorCode: String(row.errorCode) } : {}), ...(row.errorMessage ? { errorMessage: String(row.errorMessage) } : {}), cancelRequested: Number(row.cancelRequested) === 1 };
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
    const messages = this.database.all<Record<string, unknown>>("SELECT id, conversation_id AS conversationId, role, content, status, model, provider, error_code AS errorCode, cancel_reason AS cancelReason, started_at AS startedAt, first_token_at AS firstTokenAt, finished_at AS finishedAt, duration_ms AS durationMs, finish_reason AS finishReason, characters_generated AS charactersGenerated, response_json AS responseJson, created_at AS createdAt FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id", [conversationId]);
    return { conversation, messages: messages.map((message) => ({
      id: String(message.id), conversationId: String(message.conversationId), role: String(message.role) as ConversationMessageRecord["role"], content: String(message.content),
      status: (message.status === "error" ? "failed" : String(message.status)) as ConversationMessageRecord["status"],
      ...(message.model ? { model: String(message.model) } : {}), ...(message.provider ? { provider: String(message.provider) } : {}),
      ...(message.errorCode ? { errorCode: String(message.errorCode) } : {}), ...(message.cancelReason ? { cancelReason: String(message.cancelReason) as ChatCancelReason } : {}),
      ...(message.startedAt ? { startedAt: Number(message.startedAt) } : {}), ...(message.firstTokenAt ? { firstTokenAt: Number(message.firstTokenAt) } : {}), ...(message.finishedAt ? { finishedAt: Number(message.finishedAt) } : {}),
      ...(message.durationMs ? { durationMs: Number(message.durationMs) } : {}), ...(message.finishReason ? { finishReason: String(message.finishReason) } : {}),
      charactersGenerated: Number(message.charactersGenerated ?? String(message.content).length), ...(message.responseJson ? { structuredResponse: safeJson<ChatResponse>(message.responseJson) } : {}), createdAt: Number(message.createdAt)
    })) };
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

  addMessage(input: { conversationId: string; role: ConversationMessageRecord["role"]; content: string; status: ConversationMessageRecord["status"]; model?: string; provider?: string; startedAt?: number; charactersGenerated?: number; structuredResponse?: ChatResponse }, now = Date.now()): ConversationMessageRecord {
    const message: ConversationMessageRecord = { id: id("message", now), ...input, charactersGenerated: input.charactersGenerated ?? input.content.length, createdAt: now };
    this.database.run("INSERT INTO conversation_messages(id, conversation_id, role, content, status, model, provider, started_at, characters_generated, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [message.id, message.conversationId, message.role, message.content, message.status, message.model ?? null, message.provider ?? null, message.startedAt ?? null, message.charactersGenerated, message.structuredResponse ? JSON.stringify(message.structuredResponse) : null, now]);
    this.database.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now, input.conversationId]);
    this.database.flushNow();
    return message;
  }

  updateMessage(messageId: string, content: string, status: ConversationMessageRecord["status"], now = Date.now(), telemetry: Partial<ChatStreamTelemetry> & { errorCode?: string; cancelReason?: ChatCancelReason; structuredResponse?: ChatResponse } = {}): void {
    const durationMs = telemetry.durationMs ?? (telemetry.startedAt && telemetry.finishedAt ? telemetry.finishedAt - telemetry.startedAt : undefined);
    this.database.run("UPDATE conversation_messages SET content = ?, status = ?, error_code = COALESCE(?, error_code), cancel_reason = COALESCE(?, cancel_reason), started_at = COALESCE(?, started_at), first_token_at = COALESCE(?, first_token_at), finished_at = COALESCE(?, finished_at), duration_ms = COALESCE(?, duration_ms), finish_reason = COALESCE(?, finish_reason), provider = COALESCE(?, provider), characters_generated = ?, response_json = COALESCE(?, response_json) WHERE id = ?", [content, status, telemetry.errorCode ?? null, telemetry.cancelReason ?? null, telemetry.startedAt ?? null, telemetry.firstTokenAt ?? null, telemetry.finishedAt ?? null, durationMs ?? null, telemetry.finishReason ?? null, telemetry.provider ?? null, telemetry.charactersGenerated ?? content.length, telemetry.structuredResponse ? JSON.stringify(telemetry.structuredResponse) : null, messageId]);
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
    const interrupted = this.database.all<{ id: string; content: string }>("SELECT id, content FROM conversation_messages WHERE status = 'streaming'");
    if (interrupted.length === 0) return 0;
    this.database.run("UPDATE conversation_messages SET status = CASE WHEN length(content) > 0 THEN 'partial_error' ELSE 'failed' END, error_code = 'CHAT_RELOADED_DURING_STREAM', finished_at = ?, duration_ms = CASE WHEN started_at IS NOT NULL THEN ? - started_at ELSE NULL END WHERE status = 'streaming'", [now, now]);
    this.database.run("UPDATE conversations SET updated_at = ? WHERE id IN (SELECT conversation_id FROM conversation_messages WHERE status IN ('partial_error', 'failed'))", [now]);
    this.database.flushNow();
    return interrupted.length;
  }

  delete(conversationId: string): void {
    this.database.run("DELETE FROM conversations WHERE id = ?", [conversationId]);
    this.database.flushNow();
  }
}

export class SqliteInterviewHistoryRepository {
  private readonly revisions = new Map<string, number>();

  constructor(private readonly database: SqliteDatabase, private readonly onChanged?: (event: HistoryChangedEvent) => void) {}

  getRevision(interviewId: string): number { return this.revisions.get(interviewId) ?? 0; }

  createInterview(input: Omit<InterviewRecord, "id" | "createdAt">, now = Date.now()): InterviewRecord {
    const record = { ...input, id: id("interview", now), createdAt: now };
    this.database.run("INSERT INTO interviews(id, profile_id, project_id, job_target_id, started_at, ended_at, status, language, automation_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.profileId, record.projectId ?? null, record.jobTargetId ?? null, record.startedAt, record.endedAt ?? null, record.status, record.language, record.automationMode, record.createdAt]);
    this.database.flushNow();
    this.emitChanged(record.id, "state");
    return record;
  }

  endInterview(interviewId: string, status: "ended" | "error" = "ended", endedAt = Date.now()): InterviewRecord {
    this.database.run("UPDATE interviews SET status = ?, ended_at = ? WHERE id = ?", [status, endedAt, interviewId]);
    this.database.flushNow();
    const row = this.database.first<Record<string, unknown>>("SELECT id, profile_id AS profileId, project_id AS projectId, job_target_id AS jobTargetId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews WHERE id = ?", [interviewId]);
    if (!row) throw new Error(`Interview not found: ${interviewId}`);
    const record = this.hydrateInterview(row);
    this.emitChanged(interviewId, "state");
    return record;
  }

  addTranscript(input: Omit<TranscriptRecord, "id" | "createdAt">, now = Date.now()): TranscriptRecord | undefined {
    if (!input.final) return undefined;
    const record = { ...input, id: id("transcript", now), createdAt: now };
    this.database.run("INSERT INTO transcripts(id, interview_id, source, text, raw_text, normalized_text, canonical_text, terminology_corrections_json, start_ms, end_ms, final, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.interviewId, record.source, record.text, record.rawText ?? null, record.normalizedText ?? null, record.canonicalText ?? null, JSON.stringify(record.terminologyCorrections ?? []), record.startMs, record.endMs, 1, record.confidence ?? null, record.createdAt]);
    this.database.flush();
    this.emitChanged(record.interviewId, "transcript");
    return record;
  }

  addQuestion(input: Omit<QuestionRecord, "id">): QuestionRecord {
    const record = { ...input, id: id("question", input.detectedAt) };
    this.database.run("INSERT INTO questions(id, interview_id, text, confidence, source, detected_at, status, parent_question_id, root_question_id, raw_transcript, normalized_question, canonical_question, context_relation, inherited_topic, topic, terminology_corrections_json, semantic_frame, group_id, relation_type, thread_item_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.interviewId, record.text, record.confidence, record.source, record.detectedAt, record.status, record.parentQuestionId ?? null, record.rootQuestionId ?? null, record.rawTranscript ?? null, record.normalizedQuestion ?? null, record.canonicalQuestion ?? null, record.contextRelation ?? null, record.inheritedTopic ?? null, record.topic ?? null, JSON.stringify(record.terminologyCorrections ?? []), record.semanticFrame ?? null, record.groupId ?? null, record.relationType ?? null, record.threadItemType ?? null]);
    this.database.flush();
    this.emitChanged(record.interviewId, "question");
    return record;
  }

  updateQuestionStatus(questionId: string, status: QuestionRecord["status"]): QuestionRecord | undefined {
    this.database.run("UPDATE questions SET status = ? WHERE id = ?", [status, questionId]);
    this.database.flushNow();
    const record = this.database.first<Record<string, unknown>>("SELECT id, interview_id AS interviewId, text, confidence, source, detected_at AS detectedAt, status, parent_question_id AS parentQuestionId, root_question_id AS rootQuestionId, raw_transcript AS rawTranscript, normalized_question AS normalizedQuestion, canonical_question AS canonicalQuestion, context_relation AS contextRelation, inherited_topic AS inheritedTopic, topic, terminology_corrections_json AS terminologyCorrectionsJson, semantic_frame AS semanticFrame, group_id AS groupId, relation_type AS relationType, thread_item_type AS threadItemType FROM questions WHERE id = ?", [questionId]);
    if (!record) return undefined;
    const hydrated = this.hydrateQuestion(record);
    this.emitChanged(hydrated.interviewId, "question");
    return hydrated;
  }

  addAnswer(input: Omit<AnswerRecord, "id">): AnswerRecord {
    const record = { ...input, id: id("answer", input.createdAt) };
    this.database.run("INSERT INTO answers(id, question_id, text, model, mode, latency_first_token, latency_total, cancel_reason, started_at, first_token_at, finished_at, telemetry_json, group_id, relation, answer_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [record.id, record.questionId, record.text, record.model, record.mode ?? null, record.latencyFirstToken ?? null, record.latencyTotal ?? null, record.cancelReason ?? null, record.startedAt ?? null, record.firstTokenAt ?? null, record.finishedAt ?? null, record.telemetry ? JSON.stringify(record.telemetry) : null, record.groupId ?? null, record.relation ?? null, record.answerRunId ?? null, record.createdAt]);
    this.database.flushNow();
    const interviewId = this.database.first<{ interviewId: string }>("SELECT q.interview_id AS interviewId FROM questions q WHERE q.id = ?", [record.questionId])?.interviewId;
    if (interviewId) this.emitChanged(interviewId, "answer");
    return record;
  }

  listInterviews(): InterviewRecord[] {
    return this.database.all<Record<string, unknown>>("SELECT id, profile_id AS profileId, project_id AS projectId, job_target_id AS jobTargetId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews ORDER BY created_at DESC").map((row) => this.hydrateInterview(row));
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
    const interviewRow = this.database.first<Record<string, unknown>>("SELECT id, profile_id AS profileId, project_id AS projectId, job_target_id AS jobTargetId, started_at AS startedAt, ended_at AS endedAt, status, language, automation_mode AS automationMode, created_at AS createdAt FROM interviews WHERE id = ?", [interviewId]);
    if (!interviewRow) throw new Error(`Interview not found: ${interviewId}`);
    const interview = this.hydrateInterview(interviewRow);
    const transcripts = this.database.all<Record<string, unknown>>("SELECT id, interview_id AS interviewId, source, text, raw_text AS rawText, normalized_text AS normalizedText, canonical_text AS canonicalText, terminology_corrections_json AS terminologyCorrectionsJson, start_ms AS startMs, end_ms AS endMs, final, confidence, created_at AS createdAt FROM transcripts WHERE interview_id = ? ORDER BY start_ms", [interviewId]).map((row) => this.hydrateTranscript(row));
    const questions = this.database.all<Record<string, unknown>>("SELECT id, interview_id AS interviewId, text, confidence, source, detected_at AS detectedAt, status, parent_question_id AS parentQuestionId, root_question_id AS rootQuestionId, raw_transcript AS rawTranscript, normalized_question AS normalizedQuestion, canonical_question AS canonicalQuestion, context_relation AS contextRelation, inherited_topic AS inheritedTopic, topic, terminology_corrections_json AS terminologyCorrectionsJson, semantic_frame AS semanticFrame, group_id AS groupId, relation_type AS relationType, thread_item_type AS threadItemType FROM questions WHERE interview_id = ? ORDER BY detected_at", [interviewId]).map((row) => this.hydrateQuestion(row));
    const answers = this.database.all<Record<string, unknown>>("SELECT a.id, a.question_id AS questionId, a.text, a.model, a.mode, a.latency_first_token AS latencyFirstToken, a.latency_total AS latencyTotal, a.cancel_reason AS cancelReason, a.started_at AS startedAt, a.first_token_at AS firstTokenAt, a.finished_at AS finishedAt, a.telemetry_json AS telemetryJson, a.group_id AS groupId, a.relation, a.answer_run_id AS answerRunId, a.created_at AS createdAt FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.interview_id = ? ORDER BY a.created_at", [interviewId]).map((row) => ({
      id: String(row.id), questionId: String(row.questionId), text: String(row.text), model: String(row.model), ...(row.mode ? { mode: String(row.mode) as AnswerRecord["mode"] } : {}), ...(row.latencyFirstToken !== null && row.latencyFirstToken !== undefined ? { latencyFirstToken: Number(row.latencyFirstToken) } : {}), ...(row.latencyTotal !== null && row.latencyTotal !== undefined ? { latencyTotal: Number(row.latencyTotal) } : {}), ...(row.cancelReason ? { cancelReason: String(row.cancelReason) as AnswerRecord["cancelReason"] } : {}), ...(row.startedAt !== null && row.startedAt !== undefined ? { startedAt: Number(row.startedAt) } : {}), ...(row.firstTokenAt !== null && row.firstTokenAt !== undefined ? { firstTokenAt: Number(row.firstTokenAt) } : {}), ...(row.finishedAt !== null && row.finishedAt !== undefined ? { finishedAt: Number(row.finishedAt) } : {}), ...(row.telemetryJson ? { telemetry: safeJson<AnswerRecord["telemetry"]>(row.telemetryJson) } : {}), ...(row.groupId ? { groupId: String(row.groupId) } : {}), ...(row.relation ? { relation: String(row.relation) as AnswerRecord["relation"] } : {}), ...(row.answerRunId ? { answerRunId: String(row.answerRunId) } : {}), createdAt: Number(row.createdAt)
    } satisfies AnswerRecord));
    return { interview, transcripts, questions, answers };
  }

  private emitChanged(interviewId: string, type: HistoryChangedEvent["type"]): void {
    const revision = (this.revisions.get(interviewId) ?? 0) + 1;
    this.revisions.set(interviewId, revision);
    this.onChanged?.({ interviewId, revision, type, createdAt: Date.now() });
  }

  private hydrateInterview(row: Record<string, unknown>): InterviewRecord {
    return {
      id: String(row.id),
      profileId: String(row.profileId),
      ...(row.projectId ? { projectId: String(row.projectId) } : {}),
      ...(row.jobTargetId ? { jobTargetId: String(row.jobTargetId) } : {}),
      startedAt: Number(row.startedAt),
      ...(row.endedAt !== null && row.endedAt !== undefined && Number.isFinite(Number(row.endedAt)) ? { endedAt: Number(row.endedAt) } : {}),
      status: String(row.status) as InterviewRecord["status"],
      language: String(row.language),
      automationMode: String(row.automationMode) as InterviewRecord["automationMode"],
      createdAt: Number(row.createdAt)
    };
  }

  private hydrateTranscript(row: Record<string, unknown>): TranscriptRecord {
    return {
      id: String(row.id), interviewId: String(row.interviewId), source: String(row.source) as TranscriptRecord["source"], text: String(row.text),
      ...(row.rawText ? { rawText: String(row.rawText) } : {}), ...(row.normalizedText ? { normalizedText: String(row.normalizedText) } : {}), ...(row.canonicalText ? { canonicalText: String(row.canonicalText) } : {}),
      terminologyCorrections: this.parseJson(row.terminologyCorrectionsJson), startMs: Number(row.startMs), endMs: Number(row.endMs), final: Boolean(row.final), ...(row.confidence !== null && row.confidence !== undefined ? { confidence: Number(row.confidence) } : {}), createdAt: Number(row.createdAt)
    };
  }

  private hydrateQuestion(row: Record<string, unknown>): QuestionRecord {
    return {
      id: String(row.id), interviewId: String(row.interviewId), text: String(row.text), confidence: String(row.confidence) as QuestionRecord["confidence"], source: String(row.source) as QuestionRecord["source"], detectedAt: Number(row.detectedAt), status: String(row.status) as QuestionRecord["status"],
      ...(row.parentQuestionId ? { parentQuestionId: String(row.parentQuestionId) } : {}), ...(row.rootQuestionId ? { rootQuestionId: String(row.rootQuestionId) } : {}), ...(row.rawTranscript ? { rawTranscript: String(row.rawTranscript) } : {}), ...(row.normalizedQuestion ? { normalizedQuestion: String(row.normalizedQuestion) } : {}), ...(row.canonicalQuestion ? { canonicalQuestion: String(row.canonicalQuestion) } : {}), ...(row.contextRelation ? { contextRelation: String(row.contextRelation) as QuestionRecord["contextRelation"] } : {}), ...(row.inheritedTopic ? { inheritedTopic: String(row.inheritedTopic) } : {}), ...(row.topic ? { topic: String(row.topic) } : {}), ...(row.semanticFrame ? { semanticFrame: String(row.semanticFrame) as QuestionRecord["semanticFrame"] } : {}), ...(row.groupId ? { groupId: String(row.groupId) } : {}), ...(row.relationType ? { relationType: String(row.relationType) as QuestionRecord["relationType"] } : {}), ...(row.threadItemType ? { threadItemType: String(row.threadItemType) } : {}), terminologyCorrections: this.parseJson(row.terminologyCorrectionsJson)
    };
  }

  private parseJson(value: unknown): TerminologyCorrection[] {
    if (typeof value !== "string" || !value) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is TerminologyCorrection => Boolean(item && typeof item === "object" && "raw" in item && "canonical" in item && "source" in item));
    } catch { return []; }
  }
}

export interface KnowledgeBaseRecord { id: string; name: string; createdAt: number; updatedAt: number; }
export interface KnowledgeDocumentRecord { id: string; knowledgeBaseId: string; filename: string; mimeType: string; sha256: string; text: string; sections: string[]; documentType: KnowledgeDocumentType; status: "processing" | "ready" | "error"; error?: string; createdAt: number; updatedAt: number; repositoryFiles?: RepositorySourceFile[]; repositoryManifest?: RepositoryManifest; repositorySkippedFiles?: RepositorySkippedFile[]; }

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
    return rows.map((row) => this.hydrateDocument(row, false));
  }

  findDocumentBySha256(sha256: string, knowledgeBaseId?: string): KnowledgeDocumentRecord | undefined {
    const sql = "SELECT id, knowledge_base_id AS knowledgeBaseId, filename, mime_type AS mimeType, sha256, text, sections_json AS sectionsJson, document_type AS documentType, status, error, created_at AS createdAt, updated_at AS updatedAt FROM documents WHERE sha256 = ?";
    const row = knowledgeBaseId
      ? this.database.first<Record<string, unknown>>(`${sql} AND knowledge_base_id = ? ORDER BY updated_at DESC LIMIT 1`, [sha256, knowledgeBaseId])
      : this.database.first<Record<string, unknown>>(`${sql} ORDER BY updated_at DESC LIMIT 1`, [sha256]);
    return row ? this.hydrateDocument(row) : undefined;
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

  getDocument(documentId: string, options: { includeRepositoryFiles?: boolean } = {}): KnowledgeDocumentRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, knowledge_base_id AS knowledgeBaseId, filename, mime_type AS mimeType, sha256, text, sections_json AS sectionsJson, document_type AS documentType, status, error, created_at AS createdAt, updated_at AS updatedAt FROM documents WHERE id = ?", [documentId]);
    return row ? this.hydrateDocument(row, options.includeRepositoryFiles !== false) : undefined;
  }

  deleteDocument(documentId: string): void {
    this.database.run("DELETE FROM documents WHERE id = ?", [documentId]);
    this.database.flushNow();
  }

  saveDocument(document: { id: string; knowledgeBaseId: string; filename: string; mimeType: string; sha256: string; text: string; sections: string[]; documentType?: KnowledgeDocumentType; status: "processing" | "ready" | "error"; error?: string; repositoryFiles?: RepositorySourceFile[]; repositoryManifest?: RepositoryManifest; repositorySkippedFiles?: RepositorySkippedFile[] }, now = Date.now(), options: { includeRepositoryFiles?: boolean } = {}): KnowledgeDocumentRecord {
    const documentType = document.documentType ?? "other";
    this.database.run("INSERT INTO documents(id, knowledge_base_id, filename, mime_type, sha256, text, sections_json, document_type, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, sha256=excluded.sha256, text=excluded.text, sections_json=excluded.sections_json, document_type=excluded.document_type, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at", [document.id, document.knowledgeBaseId, document.filename, document.mimeType, document.sha256, document.text, JSON.stringify(document.sections), documentType, document.status, document.error ?? null, now, now]);
    this.database.flushNow();
    if (document.repositoryFiles || document.repositoryManifest) this.replaceRepositoryFiles(document.id, document.repositoryFiles ?? [], document.repositoryManifest, document.repositorySkippedFiles ?? [], now);
    return this.getDocument(document.id, options) as KnowledgeDocumentRecord;
  }

  async saveDocumentAsync(document: { id: string; knowledgeBaseId: string; filename: string; mimeType: string; sha256: string; text: string; sections: string[]; documentType?: KnowledgeDocumentType; status: "processing" | "ready" | "error"; error?: string; repositoryFiles?: RepositorySourceFile[]; repositoryManifest?: RepositoryManifest; repositorySkippedFiles?: RepositorySkippedFile[] }, now = Date.now(), options: { includeRepositoryFiles?: boolean; flushDelayMs?: number } = {}): Promise<KnowledgeDocumentRecord> {
    const documentType = document.documentType ?? "other";
    this.database.run("INSERT INTO documents(id, knowledge_base_id, filename, mime_type, sha256, text, sections_json, document_type, status, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type, sha256=excluded.sha256, text=excluded.text, sections_json=excluded.sections_json, document_type=excluded.document_type, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at", [document.id, document.knowledgeBaseId, document.filename, document.mimeType, document.sha256, document.text, JSON.stringify(document.sections), documentType, document.status, document.error ?? null, now, now]);
    if (document.repositoryFiles || document.repositoryManifest) await this.replaceRepositoryFilesAsync(document.id, document.repositoryFiles ?? [], document.repositoryManifest, document.repositorySkippedFiles ?? [], now, options.flushDelayMs ?? 10_000);
    else this.database.flush(options.flushDelayMs ?? 500);
    return this.getDocument(document.id, options) as KnowledgeDocumentRecord;
  }

  replaceRepositoryFiles(documentId: string, files: RepositorySourceFile[], manifest?: RepositoryManifest, skippedFiles: RepositorySkippedFile[] = [], now = Date.now()): void {
    this.database.run("BEGIN");
    try {
      this.database.run("DELETE FROM repository_source_files WHERE document_id = ?", [documentId]);
      for (const file of files) this.database.run("INSERT INTO repository_source_files(document_id, path, kind, language, size, sha256, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [documentId, file.path, file.kind, file.language ?? null, file.size, file.sha256 ?? null, file.text, now, now]);
      if (manifest) this.database.run("INSERT INTO repository_manifests(document_id, manifest_json, skipped_files_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET manifest_json=excluded.manifest_json, skipped_files_json=excluded.skipped_files_json, updated_at=excluded.updated_at", [documentId, JSON.stringify(manifest), JSON.stringify(skippedFiles), now]);
      else this.database.run("DELETE FROM repository_manifests WHERE document_id = ?", [documentId]);
      this.database.run("COMMIT");
      this.database.flushNow();
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  async replaceRepositoryFilesAsync(documentId: string, files: RepositorySourceFile[], manifest?: RepositoryManifest, skippedFiles: RepositorySkippedFile[] = [], now = Date.now(), flushDelayMs = 10_000): Promise<void> {
    this.database.run("BEGIN");
    try {
      this.database.run("DELETE FROM repository_source_files WHERE document_id = ?", [documentId]);
      for (const [index, file] of files.entries()) {
        this.database.run("INSERT INTO repository_source_files(document_id, path, kind, language, size, sha256, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [documentId, file.path, file.kind, file.language ?? null, file.size, file.sha256 ?? null, file.text, now, now]);
        if (index > 0 && index % 4 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (manifest) this.database.run("INSERT INTO repository_manifests(document_id, manifest_json, skipped_files_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET manifest_json=excluded.manifest_json, skipped_files_json=excluded.skipped_files_json, updated_at=excluded.updated_at", [documentId, JSON.stringify(manifest), JSON.stringify(skippedFiles), now]);
      else this.database.run("DELETE FROM repository_manifests WHERE document_id = ?", [documentId]);
      this.database.run("COMMIT");
      this.database.flush(flushDelayMs);
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  listRepositoryFiles(documentId: string, options: { limit?: number; offset?: number } = {}): RepositorySourceFile[] {
    const limit = options.limit === undefined ? undefined : Math.max(1, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const sql = "SELECT document_id AS documentId, path, kind, language, size, sha256, text FROM repository_source_files WHERE document_id = ? ORDER BY path";
    const rows = limit === undefined ? this.database.all<Record<string, unknown>>(sql, [documentId]) : this.database.all<Record<string, unknown>>(`${sql} LIMIT ? OFFSET ?`, [documentId, limit, offset]);
    return rows.map((row) => ({ documentId: String(row.documentId), path: String(row.path), kind: String(row.kind) as RepositorySourceFile["kind"], ...(row.language ? { language: String(row.language) } : {}), size: Number(row.size), ...(row.sha256 ? { sha256: String(row.sha256) } : {}), text: String(row.text) }));
  }

  getRepositoryManifest(documentId: string): { manifest?: RepositoryManifest; skippedFiles: RepositorySkippedFile[] } {
    const row = this.database.first<Record<string, unknown>>("SELECT manifest_json AS manifestJson, skipped_files_json AS skippedFilesJson FROM repository_manifests WHERE document_id = ?", [documentId]);
    return { ...(row?.manifestJson ? { manifest: JSON.parse(String(row.manifestJson)) as RepositoryManifest } : {}), skippedFiles: row?.skippedFilesJson ? JSON.parse(String(row.skippedFilesJson)) as RepositorySkippedFile[] : [] };
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

  async replaceChunksAsync(documentId: string, chunks: KnowledgeChunk[], now = Date.now(), flushDelayMs = 10_000): Promise<void> {
    this.database.run("BEGIN");
    try {
      this.database.run("DELETE FROM knowledge_chunks WHERE document_id = ?", [documentId]);
      for (const [index, chunk] of chunks.entries()) {
        this.database.run("INSERT INTO knowledge_chunks(id, document_id, text, metadata_json, embedding_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [chunk.id, documentId, chunk.text, JSON.stringify(chunk.metadata), chunk.embedding ? JSON.stringify(chunk.embedding) : null, now]);
        if (index > 0 && index % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.database.run("COMMIT");
      this.database.flush(flushDelayMs);
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    }
  }

  /** Return ready chunks for an explicit document allow-list. */
  listChunksByDocumentIds(documentIds: string[] = []): KnowledgeChunk[] {
    const ids = [...new Set(documentIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.database.all<{ id: string; documentId: string; text: string; metadataJson: string; embeddingJson: string | null }>(`SELECT c.id, c.document_id AS documentId, c.text, c.metadata_json AS metadataJson, c.embedding_json AS embeddingJson FROM knowledge_chunks c JOIN documents d ON d.id = c.document_id WHERE c.document_id IN (${placeholders}) AND d.status = 'ready'`, ids).map((row) => {
      const metadata = JSON.parse(row.metadataJson) as KnowledgeChunk["metadata"];
      return { id: row.id, text: row.text, metadata: { ...metadata, documentId: metadata.documentId || row.documentId }, ...(row.embeddingJson ? { embedding: JSON.parse(row.embeddingJson) as number[] } : {}) };
    });
  }

  private hydrateDocument(row: Record<string, unknown>, includeRepositoryFiles = true): KnowledgeDocumentRecord {
    if (!includeRepositoryFiles) {
      const repository = this.getRepositoryManifest(String(row.id));
      return { id: String(row.id), knowledgeBaseId: String(row.knowledgeBaseId), filename: String(row.filename), mimeType: String(row.mimeType), sha256: String(row.sha256), text: String(row.text), sections: JSON.parse(String(row.sectionsJson)) as string[], documentType: String(row.documentType || "other") as KnowledgeDocumentType, status: row.status as KnowledgeDocumentRecord["status"], ...(row.error ? { error: String(row.error) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), ...(repository.manifest ? { repositoryManifest: repository.manifest } : {}), ...(repository.skippedFiles.length > 0 ? { repositorySkippedFiles: repository.skippedFiles } : {}) };
    }
    const repositoryFiles = this.listRepositoryFiles(String(row.id));
    const repository = this.getRepositoryManifest(String(row.id));
    return { id: String(row.id), knowledgeBaseId: String(row.knowledgeBaseId), filename: String(row.filename), mimeType: String(row.mimeType), sha256: String(row.sha256), text: String(row.text), sections: JSON.parse(String(row.sectionsJson)) as string[], documentType: String(row.documentType || "other") as KnowledgeDocumentType, status: row.status as KnowledgeDocumentRecord["status"], ...(row.error ? { error: String(row.error) } : {}), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt), ...(repositoryFiles.length > 0 ? { repositoryFiles } : {}), ...(repository.manifest ? { repositoryManifest: repository.manifest } : {}), ...(repository.skippedFiles.length > 0 ? { repositorySkippedFiles: repository.skippedFiles } : {}) };
  }
}

export interface QuestionBankQuestionInput {
  id?: string;
  canonicalText: string;
  type?: QuestionBankType;
  bankType?: QuestionBankBankType;
  category?: string;
  scope?: QuestionBankScope;
  profileId?: string;
  projectId?: string;
  moduleId?: string;
  jobProfileId?: string;
  difficulty?: string;
  jobRole?: string;
  source?: QuestionBankSourceType;
  status?: "active" | "archived";
  confidence?: number;
  verified?: boolean;
  stale?: boolean;
  embedding?: number[];
  variants?: string[];
  skillIds?: string[];
  factIds?: string[];
  frequency?: number;
  lastAskedAt?: number;
  mastery?: number;
}

export interface QuestionBankRelationInput {
  id?: string;
  sourceQuestionId: string;
  targetQuestionId: string;
  relationType: QuestionBankRelationType;
  confidence?: number;
  source?: QuestionBankSourceType;
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
  stale?: boolean;
  factIds?: string[];
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
  profileId?: string;
  projectId?: string;
  source?: QuestionBankSourceType;
  verifyImported?: boolean;
}

export interface QuestionBankListOptions {
  search?: string;
  type?: QuestionBankType;
  bankType?: QuestionBankBankType;
  category?: string;
  scope?: QuestionBankScope;
  profileId?: string;
  projectId?: string;
  moduleId?: string;
  jobProfileId?: string;
  skillId?: string;
  status?: "active" | "archived" | "all";
  /** When filtering project QA, do not include profile/global records. */
  exactProject?: boolean;
  sort?: "updated" | "name" | "difficulty" | "verified" | "mastery";
  limit?: number;
  offset?: number;
}

export interface QuestionBankRouteQuery extends QuestionBankRouteOptions {
  scope?: QuestionBankScope;
  profileId?: string;
}

export interface QuestionBankBulkPatch { status?: "active" | "archived"; stale?: boolean; verified?: boolean; type?: QuestionBankType; bankType?: QuestionBankBankType; projectId?: string | null; moduleId?: string | null; }

export interface QuestionBankDuplicateCluster { canonical: QuestionBankQuestionRecord; variants: QuestionBankQuestionRecord[]; score: number; }

interface QuestionBankQuestionRow {
  id: string;
  canonicalText: string;
  normalizedText: string;
  type: QuestionBankType;
  bankType: QuestionBankBankType;
  category: string;
  scope: QuestionBankScope;
  profileId: string | null;
  projectId: string | null;
  jobProfileId: string | null;
  difficulty: string;
  jobRole: string | null;
  moduleId: string | null;
  source: QuestionBankSourceType;
  status: "active" | "archived";
  confidence: number;
  verified: number;
  stale: number;
  embeddingJson: string | null;
  frequency: number;
  lastAskedAt: number | null;
  mastery: number;
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

  listQuestions(options: QuestionBankListOptions = {}): QuestionBankQuestionRecord[] {
    const clauses: string[] = [options.status === "all" ? "1 = 1" : "status = ?"];
    const params: Array<string | number> = [];
    if (options.status !== "all") params.push(options.status ?? "active");
    if (options.type) { clauses.push("type = ?"); params.push(options.type); }
    if (options.bankType) { clauses.push("bank_type = ?"); params.push(options.bankType); }
    if (options.category?.trim()) { clauses.push("category = ?"); params.push(options.category.trim()); }
    if (options.scope) { clauses.push("scope = ?"); params.push(options.scope); }
    if (options.profileId) { clauses.push("(profile_id = ? OR profile_id IS NULL)"); params.push(options.profileId); }
    if (options.projectId) { clauses.push(options.exactProject || options.scope === "project" ? "project_id = ?" : "(project_id = ? OR project_id IS NULL)"); params.push(options.projectId); }
    if (options.moduleId) { clauses.push("module_id = ?"); params.push(options.moduleId); }
    if (options.jobProfileId) { clauses.push("(job_profile_id = ? OR job_profile_id IS NULL)"); params.push(options.jobProfileId); }
    if (options.skillId) { clauses.push("EXISTS (SELECT 1 FROM question_bank_question_skills qs WHERE qs.question_id = question_bank_questions.id AND qs.skill_id = ?)"); params.push(options.skillId); }
    if (options.search?.trim()) {
      const search = normalizeQuestionBankText(options.search);
      clauses.push("(normalized_text LIKE ? OR search_text LIKE ? OR id IN (SELECT question_id FROM question_bank_variants WHERE normalized_text LIKE ?))");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const limit = Math.max(1, Math.min(5000, options.limit ?? 200));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const order = options.sort === "name" ? "canonical_text ASC" : options.sort === "difficulty" ? "difficulty ASC, updated_at DESC" : options.sort === "verified" ? "verified DESC, updated_at DESC" : options.sort === "mastery" ? "mastery ASC, frequency ASC, updated_at DESC" : "updated_at DESC";
    params.push(limit, offset);
    const rows = this.database.all<QuestionBankQuestionRow>(`SELECT id, canonical_text AS canonicalText, normalized_text AS normalizedText, type, bank_type AS bankType, category, scope, profile_id AS profileId, project_id AS projectId, module_id AS moduleId, job_profile_id AS jobProfileId, difficulty, job_role AS jobRole, source, status, confidence, verified, stale, embedding_json AS embeddingJson, frequency, last_asked_at AS lastAskedAt, mastery, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_questions WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, params);
    return rows.map((row) => this.hydrateQuestion(row));
  }

  countQuestions(options: Omit<QuestionBankListOptions, "limit" | "offset" | "sort"> = {}): number {
    const clauses: string[] = [options.status === "all" ? "1 = 1" : "status = ?"];
    const params: Array<string | number> = [];
    if (options.status !== "all") params.push(options.status ?? "active");
    if (options.type) { clauses.push("type = ?"); params.push(options.type); }
    if (options.bankType) { clauses.push("bank_type = ?"); params.push(options.bankType); }
    if (options.category?.trim()) { clauses.push("category = ?"); params.push(options.category.trim()); }
    if (options.scope) { clauses.push("scope = ?"); params.push(options.scope); }
    if (options.profileId) { clauses.push("(profile_id = ? OR profile_id IS NULL)"); params.push(options.profileId); }
    if (options.projectId) { clauses.push(options.exactProject || options.scope === "project" ? "project_id = ?" : "(project_id = ? OR project_id IS NULL)"); params.push(options.projectId); }
    if (options.moduleId) { clauses.push("module_id = ?"); params.push(options.moduleId); }
    if (options.jobProfileId) { clauses.push("(job_profile_id = ? OR job_profile_id IS NULL)"); params.push(options.jobProfileId); }
    if (options.skillId) { clauses.push("EXISTS (SELECT 1 FROM question_bank_question_skills qs WHERE qs.question_id = question_bank_questions.id AND qs.skill_id = ?)"); params.push(options.skillId); }
    if (options.search?.trim()) { const search = normalizeQuestionBankText(options.search); clauses.push("(normalized_text LIKE ? OR search_text LIKE ? OR id IN (SELECT question_id FROM question_bank_variants WHERE normalized_text LIKE ?))"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    return Number(this.database.first<{ count: number }>(`SELECT COUNT(*) AS count FROM question_bank_questions WHERE ${clauses.join(" AND ")}`, params)?.count ?? 0);
  }

  bulkUpdate(questionIds: string[], patch: QuestionBankBulkPatch, now = Date.now()): number {
    const ids = [...new Set(questionIds)].filter(Boolean);
    for (const questionId of ids) {
      const current = this.getQuestion(questionId);
      if (!current) continue;
      this.database.run("UPDATE question_bank_questions SET status = ?, stale = ?, verified = ?, type = ?, bank_type = ?, project_id = ?, module_id = ?, updated_at = ? WHERE id = ?", [patch.status ?? current.status, patch.stale === undefined ? current.stale ? 1 : 0 : patch.stale ? 1 : 0, patch.verified === undefined ? current.verified ? 1 : 0 : patch.verified ? 1 : 0, patch.type ?? current.type, patch.bankType ?? current.bankType, patch.projectId === undefined ? current.projectId ?? null : patch.projectId, patch.moduleId === undefined ? current.moduleId ?? null : patch.moduleId, now, questionId]);
    }
    this.database.flushNow();
    return ids.filter((questionId) => Boolean(this.getQuestion(questionId))).length;
  }

  duplicateClusters(limit = 120): QuestionBankDuplicateCluster[] {
    const questions = this.listQuestions({ limit: Math.min(800, Math.max(1, limit * 6)), status: "active" });
    const clusters: QuestionBankDuplicateCluster[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < questions.length; index += 1) {
      const canonical = questions[index];
      if (seen.has(canonical.id)) continue;
      const variants = questions.slice(index + 1).map((candidate) => ({ candidate, score: questionBankSimilarity(canonical.canonicalText, candidate.canonicalText) })).filter((item) => item.score >= 0.82).sort((left, right) => right.score - left.score).slice(0, 8);
      if (variants.length) { variants.forEach((item) => seen.add(item.candidate.id)); clusters.push({ canonical, variants: variants.map((item) => item.candidate), score: variants[0]?.score ?? 0 }); }
      if (clusters.length >= limit) break;
    }
    return clusters;
  }

  coverage(jobProfileId?: string, profileId?: string): QuestionBankCoverageResult {
    const skills = this.listSkills();
    const jobSkillIds = jobProfileId ? this.getJobProfile(jobProfileId)?.skillIds : undefined;
    const questions = this.listQuestions({ status: "active", profileId, limit: 5000 }).map((question) => {
      const searchable = [question.canonicalText, ...question.variants, ...question.answerCards.map((card) => `${card.content} ${card.codeContent ?? ""}`)].join(" ");
      const coveredPointIds = skills.flatMap((skill) => skill.points.filter((point) => question.skillIds.includes(skill.id) && (searchable.includes(point.title) || questionBankSimilarity(searchable, point.title) >= 0.62)).map((point) => point.id));
      return { skillIds: question.skillIds, coveredPointIds, verified: question.verified, stale: question.stale, answerCards: question.answerCards.map((card) => ({ content: card.content, verified: card.verified, stale: card.stale })) };
    });
    return calculateQuestionBankCoverage({ skills, questions, skillIds: jobSkillIds, jobProfileId });
  }

  mergeDuplicates(canonicalId: string, duplicateIds: string[], now = Date.now()): QuestionBankQuestionRecord | undefined {
    const canonical = this.getQuestion(canonicalId);
    if (!canonical) return undefined;
    const mergedVariants = [...canonical.variants];
    for (const duplicateId of [...new Set(duplicateIds)].filter((id) => id !== canonicalId)) {
      const duplicate = this.getQuestion(duplicateId);
      if (!duplicate) continue;
      mergedVariants.push(duplicate.canonicalText, ...duplicate.variants);
      for (const skillId of duplicate.skillIds) this.database.run("INSERT OR IGNORE INTO question_bank_question_skills(question_id, skill_id) VALUES (?, ?)", [canonicalId, skillId]);
      for (const factId of duplicate.factIds ?? []) this.database.run("INSERT OR IGNORE INTO question_bank_question_facts(question_id, fact_id) VALUES (?, ?)", [canonicalId, factId]);
      const verifiedCard = duplicate.answerCards.find((card) => card.verified);
      if (verifiedCard && !canonical.answerCards.some((card) => card.verified)) this.saveAnswerCard({ ...verifiedCard, id: undefined, questionId: canonicalId });
      this.database.run("UPDATE question_bank_questions SET status = 'archived', updated_at = ? WHERE id = ?", [now, duplicateId]);
    }
    const uniqueVariants = [...new Set(mergedVariants.map((item) => item.trim()).filter((item) => normalizeQuestionBankText(item) !== canonical.normalizedText))];
    return this.saveQuestion({ id: canonicalId, canonicalText: canonical.canonicalText, variants: uniqueVariants, stale: canonical.stale, verified: canonical.verified });
  }

  getQuestion(questionId: string): QuestionBankQuestionRecord | undefined {
    const row = this.database.first<QuestionBankQuestionRow>("SELECT id, canonical_text AS canonicalText, normalized_text AS normalizedText, type, bank_type AS bankType, category, scope, profile_id AS profileId, project_id AS projectId, module_id AS moduleId, job_profile_id AS jobProfileId, difficulty, job_role AS jobRole, source, status, confidence, verified, stale, embedding_json AS embeddingJson, frequency, last_asked_at AS lastAskedAt, mastery, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_questions WHERE id = ?", [questionId]);
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
    const type = input.type ?? existing?.type ?? inferQuestionBankType(canonicalText);
    const projectId = input.projectId ?? existing?.projectId;
    const jobProfileId = input.jobProfileId ?? existing?.jobProfileId;
    const source = input.source ?? existing?.source ?? "manual";
    const bankType = input.bankType ?? existing?.bankType ?? inferQuestionBankBankType({ scope: input.scope ?? existing?.scope, type, projectId, jobProfileId, source, skillIds: input.skillIds ?? existing?.skillIds });
    const scope = input.scope ?? existing?.scope ?? (bankType === "project" ? "project" : bankType === "job" ? "job" : "global");
    const category = input.category?.trim() || existing?.category || type;
    const moduleId = input.moduleId ?? existing?.moduleId;
    const frequency = Math.max(0, Math.floor(input.frequency ?? existing?.frequency ?? 0));
    const lastAskedAt = input.lastAskedAt ?? existing?.lastAskedAt ?? null;
    const mastery = Math.max(0, Math.min(1, input.mastery ?? existing?.mastery ?? 0));
    this.database.run("INSERT INTO question_bank_questions(id, canonical_text, normalized_text, type, bank_type, category, scope, profile_id, project_id, module_id, job_profile_id, difficulty, job_role, source, status, confidence, verified, stale, embedding_json, search_text, frequency, last_asked_at, mastery, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET canonical_text=excluded.canonical_text, normalized_text=excluded.normalized_text, type=excluded.type, bank_type=excluded.bank_type, category=excluded.category, scope=excluded.scope, profile_id=excluded.profile_id, project_id=excluded.project_id, module_id=excluded.module_id, job_profile_id=excluded.job_profile_id, difficulty=excluded.difficulty, job_role=excluded.job_role, source=excluded.source, status=excluded.status, confidence=excluded.confidence, verified=excluded.verified, stale=excluded.stale, embedding_json=excluded.embedding_json, search_text=excluded.search_text, frequency=excluded.frequency, last_asked_at=excluded.last_asked_at, mastery=excluded.mastery, updated_at=excluded.updated_at", [questionId, canonicalText, normalizedText, type, bankType, category, scope, input.profileId ?? existing?.profileId ?? null, projectId ?? null, moduleId ?? null, jobProfileId ?? null, input.difficulty ?? existing?.difficulty ?? "medium", input.jobRole?.trim() || existing?.jobRole || null, source, input.status ?? existing?.status ?? "active", Math.max(0, Math.min(1, input.confidence ?? existing?.confidence ?? 1)), input.verified ?? existing?.verified ?? false ? 1 : 0, input.stale ?? existing?.stale ?? false ? 1 : 0, input.embedding ? JSON.stringify(input.embedding) : existing?.embedding ? JSON.stringify(existing.embedding) : null, searchText, frequency, lastAskedAt, mastery, existing?.createdAt ?? now, now]);
    if (input.variants) {
      this.database.run("DELETE FROM question_bank_variants WHERE question_id = ?", [questionId]);
      for (const variant of input.variants.map((item) => item.trim()).filter(Boolean)) this.database.run("INSERT INTO question_bank_variants(id, question_id, text, normalized_text, created_at) VALUES (?, ?, ?, ?, ?)", [id("bank-variant", now), questionId, variant, normalizeQuestionBankText(variant), now]);
    }
    if (input.factIds) {
      this.database.run("DELETE FROM question_bank_question_facts WHERE question_id = ?", [questionId]);
      for (const factId of input.factIds) this.database.run("INSERT OR IGNORE INTO question_bank_question_facts(question_id, fact_id) VALUES (?, ?)", [questionId, factId]);
    }
    if (input.skillIds) {
      this.database.run("DELETE FROM question_bank_question_skills WHERE question_id = ?", [questionId]);
      for (const skillId of input.skillIds) if (this.getSkill(skillId)) this.database.run("INSERT OR IGNORE INTO question_bank_question_skills(question_id, skill_id) VALUES (?, ?)", [questionId, skillId]);
    }
    this.database.flushNow();
    return this.getQuestion(questionId) as QuestionBankQuestionRecord;
  }

  deleteQuestion(questionId: string): void {
    this.database.run("DELETE FROM question_bank_questions WHERE id = ?", [questionId]);
    this.database.flushNow();
  }

  saveAnswerCard(input: QuestionBankAnswerCardInput, now = Date.now()): QuestionBankAnswerCardRecord {
    const question = this.getQuestion(input.questionId);
    if (!question) throw new Error("QUESTION_BANK_QUESTION_NOT_FOUND: 题目不存在");
    if (question.scope === "project" && (input.sourceType === "generated" || input.sourceType === "ai-generated") && !(input.factIds?.length || question.factIds?.length)) throw new Error("PROJECT_ANSWER_FACTS_REQUIRED: 项目答案必须关联 Project Facts");
    const cardId = input.id ?? id("bank-answer", now);
    const current = input.id ? this.getAnswerCard(input.id) : undefined;
    this.database.run("INSERT INTO question_bank_answer_cards(id, question_id, mode, content, code_content, key_points_json, complexity, limitations, source_type, verified, stale, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET question_id=excluded.question_id, mode=excluded.mode, content=excluded.content, code_content=excluded.code_content, key_points_json=excluded.key_points_json, complexity=excluded.complexity, limitations=excluded.limitations, source_type=excluded.source_type, verified=excluded.verified, stale=excluded.stale, version=excluded.version, updated_at=excluded.updated_at", [cardId, input.questionId, input.mode ?? "standard", input.content.trim(), input.codeContent?.trim() || null, JSON.stringify(input.keyPoints ?? []), input.complexity?.trim() || null, input.limitations?.trim() || null, input.sourceType ?? current?.sourceType ?? "manual", input.verified ? 1 : 0, input.stale ?? current?.stale ?? false ? 1 : 0, input.version ?? (current?.version ?? 0) + 1, current?.createdAt ?? now, now]);
    if (input.factIds) {
      this.database.run("DELETE FROM question_bank_question_facts WHERE question_id = ?", [input.questionId]);
      for (const factId of input.factIds) this.database.run("INSERT OR IGNORE INTO question_bank_question_facts(question_id, fact_id) VALUES (?, ?)", [input.questionId, factId]);
    }
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

  saveRelation(input: QuestionBankRelationInput, now = Date.now()): QuestionBankRelationRecord {
    if (!this.getQuestion(input.sourceQuestionId) || !this.getQuestion(input.targetQuestionId)) throw new Error("QUESTION_BANK_QUESTION_NOT_FOUND: 关联题目不存在");
    const relationId = input.id ?? id("bank-relation", now);
    const current = input.id ? this.getRelation(input.id) : undefined;
    this.database.run("INSERT INTO question_bank_relations(id, source_question_id, target_question_id, relation_type, confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_question_id, target_question_id, relation_type) DO UPDATE SET confidence=excluded.confidence, source=excluded.source, updated_at=excluded.updated_at", [relationId, input.sourceQuestionId, input.targetQuestionId, input.relationType, Math.max(0, Math.min(1, input.confidence ?? current?.confidence ?? 1)), input.source ?? current?.source ?? "manual", current?.createdAt ?? now, now]);
    this.database.flushNow();
    return this.getRelationByPair(input.sourceQuestionId, input.targetQuestionId, input.relationType) as QuestionBankRelationRecord;
  }

  listRelations(questionId?: string): QuestionBankRelationRecord[] {
    const rows = questionId
      ? this.database.all<Record<string, unknown>>("SELECT id, source_question_id AS sourceQuestionId, target_question_id AS targetQuestionId, relation_type AS relationType, confidence, source, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_relations WHERE source_question_id = ? OR target_question_id = ? ORDER BY updated_at DESC", [questionId, questionId])
      : this.database.all<Record<string, unknown>>("SELECT id, source_question_id AS sourceQuestionId, target_question_id AS targetQuestionId, relation_type AS relationType, confidence, source, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_relations ORDER BY updated_at DESC");
    return rows.map((row) => this.hydrateRelation(row));
  }

  deleteRelation(relationId: string): void {
    this.database.run("DELETE FROM question_bank_relations WHERE id = ?", [relationId]);
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

  routeQuestion(text: string, options: QuestionBankRouteQuery = {}): QuestionBankRouteResult {
    const candidates = this.listQuestions({ status: options.includeArchived ? "all" : "active", scope: options.scope, profileId: options.profileId, projectId: options.projectId, jobProfileId: options.jobProfileId, limit: 5000 })
      // Project QA is opt-in at the caller boundary. Generic routing should
      // never accidentally select a project answer merely because it shares
      // a technical token with the current question.
      .filter((question) => Boolean(options.projectId) || question.scope !== "project");
    const router = new QuestionBankRouter();
    if (options.projectId && !options.includeArchived) return router.routeProjectQaFirst(text, candidates, { ...options, projectId: options.projectId });
    return router.route(text, candidates, options);
  }

  matchQuestion(text: string, options: { threshold?: number; scope?: QuestionBankScope; profileId?: string; projectId?: string; jobProfileId?: string } = {}): QuestionBankMatch | undefined {
    const threshold = options.threshold ?? 0.72;
    const top = this.routeQuestion(text, { ...options, threshold: Math.max(0, threshold - 0.02) }).top;
    return top && top.score >= threshold ? { question: top.question, score: top.score, exact: top.exact } : undefined;
  }

  importText(text: string, filename = "题库导入", options: QuestionBankImportOptions = {}): QuestionBankImportResult {
    const includeProject = options.includeProject ?? false;
    const includeBehavioral = options.includeBehavioral ?? true;
    const projectImport = Boolean(options.projectId);
    const importedSource = options.source ?? "imported";
    const verifyImported = options.verifyImported ?? projectImport;
    let recognizedQuestions = 0;
    let importedQuestions = 0;
    let importedAnswers = 0;
    let filteredProjectQuestions = 0;
    let filteredBehavioralQuestions = 0;
    let duplicatesMerged = 0;
    let failedQuestions = 0;
    const ids: string[] = [];
    const existingQuestions = projectImport
      ? this.listQuestions({ status: "all", scope: "project", projectId: options.projectId, exactProject: true, limit: 5000 })
      : this.listQuestions({ limit: 5000 });
    const existingByNormalized = new Map(existingQuestions.map((question) => [question.normalizedText, question]));

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
          if (mergedVariants.length !== existing.variants.length || projectImport) {
            const updated = this.saveQuestion({ id: existing.id, canonicalText: existing.canonicalText, type: projectImport ? type : existing.type, bankType: projectImport ? "project" : existing.bankType, category: projectImport ? "project" : existing.category, scope: projectImport ? "project" : existing.scope, profileId: projectImport ? options.profileId : existing.profileId, projectId: projectImport ? options.projectId : existing.projectId, difficulty: existing.difficulty, jobRole: existing.jobRole, variants: mergedVariants, source: projectImport ? importedSource : existing.source, verified: projectImport ? true : existing.verified, stale: projectImport ? false : existing.stale });
            existingByNormalized.set(normalizedText, updated);
          }
          if (answer && !existing.answerCards.some((card) => card.content.trim() === answer.trim() && !card.stale)) this.saveAnswerCard({ questionId: existing.id, content: answer, sourceType: importedSource, verified: verifyImported, stale: false });
          ids.push(existing.id);
          duplicatesMerged += 1;
          return;
        }
        const record = this.saveQuestion({ canonicalText, type, bankType: projectImport ? "project" : undefined, category: projectImport ? "project" : undefined, scope: projectImport ? "project" : undefined, profileId: options.profileId, projectId: options.projectId, variants, source: importedSource, verified: verifyImported, stale: false });
        existingByNormalized.set(record.normalizedText, record);
        ids.push(record.id);
        importedQuestions += 1;
        if (answer) { this.saveAnswerCard({ questionId: record.id, content: answer, sourceType: importedSource, verified: verifyImported, stale: false }); importedAnswers += 1; }
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

  importProjectText(profileId: string, projectId: string, text: string, filename = "项目题库导入"): ProjectQuestionBankImportReport {
    const project = this.database.first<{ profileId: string }>("SELECT profile_id AS profileId FROM projects WHERE id = ?", [projectId]);
    if (!project || project.profileId !== profileId) throw new Error("PROJECT_QA_SCOPE_INVALID: 项目不属于当前档案");
    const result = this.importText(text, filename, { includeProject: true, includeBehavioral: true, profileId, projectId, source: "imported", verifyImported: true });
    return { projectId, filename, sourceRole: "question_bank", verified: true, ...result };
  }

  invalidateProjectQaDependencies(projectId: string, factIds: string[], now = Date.now()): number {
    const ids = [...new Set(factIds.filter(Boolean))];
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const questionIds = this.database.all<{ id: string }>(`SELECT DISTINCT q.id FROM question_bank_questions q JOIN question_bank_question_facts qf ON qf.question_id = q.id WHERE q.scope = 'project' AND q.project_id = ? AND qf.fact_id IN (${placeholders})`, [projectId, ...ids]).map((row) => row.id);
    if (questionIds.length === 0) return 0;
    const questionPlaceholders = questionIds.map(() => "?").join(",");
    this.database.run(`UPDATE question_bank_questions SET stale = 1, updated_at = ? WHERE id IN (${questionPlaceholders})`, [now, ...questionIds]);
    this.database.run(`UPDATE question_bank_answer_cards SET stale = 1, updated_at = ? WHERE question_id IN (${questionPlaceholders})`, [now, ...questionIds]);
    this.database.flushNow();
    return questionIds.length;
  }

  /**
   * Kept for integrations compiled against the previous API. Material
   * imports no longer have enough information to invalidate a whole project;
   * callers must pass changed fact IDs to invalidateProjectQaDependencies.
   */
  markProjectQuestionBankStale(_projectId: string, _now = Date.now()): number {
    return 0;
  }

  private hydrateQuestion(row: QuestionBankQuestionRow): QuestionBankQuestionRecord {
    const variants = this.database.all<{ text: string }>("SELECT text FROM question_bank_variants WHERE question_id = ? ORDER BY created_at", [row.id]).map((item) => item.text);
    const skillIds = this.database.all<{ skillId: string }>("SELECT skill_id AS skillId FROM question_bank_question_skills WHERE question_id = ?", [row.id]).map((item) => item.skillId);
    const answerCards = this.database.all<Record<string, unknown>>("SELECT id, question_id AS questionId, mode, content, code_content AS codeContent, key_points_json AS keyPointsJson, complexity, limitations, source_type AS sourceType, verified, stale, version, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_answer_cards WHERE question_id = ? ORDER BY verified DESC, updated_at DESC", [row.id]).map((item) => this.hydrateAnswerCard(item));
    const factIds = this.database.all<{ factId: string }>("SELECT fact_id AS factId FROM question_bank_question_facts WHERE question_id = ?", [row.id]).map((item) => item.factId);
    const relations = this.listRelations(row.id);
    return { id: row.id, canonicalText: row.canonicalText, normalizedText: row.normalizedText, type: row.type, bankType: row.bankType || inferQuestionBankBankType({ scope: row.scope, type: row.type, projectId: row.projectId ?? undefined, jobProfileId: row.jobProfileId ?? undefined, source: row.source, skillIds }), category: row.category || row.type, scope: row.scope || "global", ...(row.profileId ? { profileId: row.profileId } : {}), ...(row.projectId ? { projectId: row.projectId } : {}), ...(row.moduleId ? { moduleId: row.moduleId } : {}), ...(row.jobProfileId ? { jobProfileId: row.jobProfileId } : {}), difficulty: row.difficulty, ...(row.jobRole ? { jobRole: row.jobRole } : {}), source: row.source, status: row.status, stale: Number(row.stale) === 1, confidence: Number(row.confidence ?? 1), verified: Number(row.verified) === 1, ...(row.embeddingJson ? { embedding: JSON.parse(row.embeddingJson) as number[] } : {}), variants, relations, followUps: relations.filter((relation) => relation.relationType === "FOLLOW_UP"), answerCards, skillIds, factIds, frequency: Number(row.frequency ?? 0), ...(row.lastAskedAt ? { lastAskedAt: Number(row.lastAskedAt) } : {}), mastery: Number(row.mastery ?? 0), createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  private getRelation(relationId: string): QuestionBankRelationRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, source_question_id AS sourceQuestionId, target_question_id AS targetQuestionId, relation_type AS relationType, confidence, source, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_relations WHERE id = ?", [relationId]);
    return row ? this.hydrateRelation(row) : undefined;
  }

  private getRelationByPair(sourceQuestionId: string, targetQuestionId: string, relationType: QuestionBankRelationType): QuestionBankRelationRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, source_question_id AS sourceQuestionId, target_question_id AS targetQuestionId, relation_type AS relationType, confidence, source, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_relations WHERE source_question_id = ? AND target_question_id = ? AND relation_type = ?", [sourceQuestionId, targetQuestionId, relationType]);
    return row ? this.hydrateRelation(row) : undefined;
  }

  private hydrateRelation(row: Record<string, unknown>): QuestionBankRelationRecord {
    return { id: String(row.id), sourceQuestionId: String(row.sourceQuestionId), targetQuestionId: String(row.targetQuestionId), relationType: String(row.relationType) as QuestionBankRelationType, confidence: Number(row.confidence ?? 1), source: String(row.source) as QuestionBankSourceType, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
  }

  private getAnswerCard(answerCardId: string): QuestionBankAnswerCardRecord | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, question_id AS questionId, mode, content, code_content AS codeContent, key_points_json AS keyPointsJson, complexity, limitations, source_type AS sourceType, verified, stale, version, created_at AS createdAt, updated_at AS updatedAt FROM question_bank_answer_cards WHERE id = ?", [answerCardId]);
    return row ? this.hydrateAnswerCard(row) : undefined;
  }

  private hydrateAnswerCard(row: Record<string, unknown>): QuestionBankAnswerCardRecord {
    const factIds = this.database.all<{ factId: string }>("SELECT fact_id AS factId FROM question_bank_question_facts WHERE question_id = ?", [String(row.questionId)]).map((item) => item.factId);
    return { id: String(row.id), questionId: String(row.questionId), mode: String(row.mode) as QuestionBankAnswerMode, content: String(row.content), ...(row.codeContent ? { codeContent: String(row.codeContent) } : {}), keyPoints: JSON.parse(String(row.keyPointsJson)) as string[], ...(row.complexity ? { complexity: String(row.complexity) } : {}), ...(row.limitations ? { limitations: String(row.limitations) } : {}), sourceType: String(row.sourceType) as QuestionBankSourceType, verified: Number(row.verified) === 1, stale: Number(row.stale) === 1, factIds, version: Number(row.version), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
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
