-- Preserve the relationship between a follow-up question and its root question.
ALTER TABLE questions ADD COLUMN parent_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL;
ALTER TABLE questions ADD COLUMN root_question_id TEXT REFERENCES questions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS questions_thread_idx ON questions(interview_id, root_question_id, detected_at);
