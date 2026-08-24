-- Interview context: persist the selected project and job target for history and replay.
ALTER TABLE interviews ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE interviews ADD COLUMN job_target_id TEXT REFERENCES job_targets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS interviews_context_idx ON interviews(profile_id, project_id, job_target_id, created_at DESC);
