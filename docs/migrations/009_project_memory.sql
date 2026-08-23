-- Interview Copilot schema migration 009: Personal Engineering Memory
-- The Electron sql.js migrator applies the equivalent statements transactionally.
-- Run this script only against a database already migrated through version 008.

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
