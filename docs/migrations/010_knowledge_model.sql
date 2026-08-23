-- Interview Copilot schema migration 010: unified knowledge scopes and provenance.
-- The Electron sql.js migrator applies the equivalent statements transactionally.
-- Run this script only against a database already migrated through version 009.

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
