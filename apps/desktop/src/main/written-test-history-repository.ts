import { SqliteDatabase } from "./database";
import type { WrittenAnswerDocument, WrittenQuestionType, WrittenSessionStatus, WrittenTestQuestion, WrittenTestScreenshot, WrittenTestSession, WrittenTestSessionDetail } from "@interview-copilot/shared";

function recordId(prefix: string, now: number): string { return `${prefix}-${now}-${Math.random().toString(36).slice(2, 8)}`; }
function parseArray(value: unknown): string[] { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; } }

export interface WrittenTestSessionInput { profileId: string; answerMode: "FAST" | "NORMAL" | "DEEP"; title?: string; }
export interface WrittenTestQuestionInput { sessionId: string; sequence: number; screenshotIds: string[]; rawQuestionText: string; normalizedQuestion: string; questionType: WrittenQuestionType; requirements: string[]; confidence: number; }

export class SqliteWrittenTestHistoryRepository {
  constructor(private readonly database: SqliteDatabase) {}

  recoverRunningSessions(now = Date.now()): number {
    const running = this.database.all<{ id: string }>("SELECT id FROM written_test_sessions WHERE status = 'RUNNING'");
    if (running.length === 0) return 0;
    this.database.run("UPDATE written_test_sessions SET status = 'ABORTED', ended_at = ?, updated_at = ? WHERE status = 'RUNNING'", [now, now]);
    this.database.flushNow();
    return running.length;
  }

  createSession(input: WrittenTestSessionInput, now = Date.now()): WrittenTestSession {
    const session: WrittenTestSession = { id: recordId("written-session", now), profileId: input.profileId, title: input.title?.trim() || "笔试练习", startedAt: now, status: "RUNNING", answerMode: input.answerMode, questionCount: 0, screenshotCount: 0, createdAt: now, updatedAt: now };
    this.database.run("INSERT INTO written_test_sessions(id, profile_id, title, started_at, status, answer_mode, question_count, screenshot_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [session.id, session.profileId, session.title, session.startedAt, session.status, session.answerMode, 0, 0, now, now]);
    this.database.flushNow();
    return session;
  }

  updateSession(sessionId: string, patch: { status?: WrittenSessionStatus; endedAt?: number; answerMode?: "FAST" | "NORMAL" | "DEEP"; questionCount?: number; screenshotCount?: number }, now = Date.now()): WrittenTestSession | undefined {
    const current = this.getSession(sessionId);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: now };
    this.database.run("UPDATE written_test_sessions SET ended_at = ?, status = ?, answer_mode = ?, question_count = ?, screenshot_count = ?, updated_at = ? WHERE id = ?", [next.endedAt ?? null, next.status, next.answerMode, next.questionCount, next.screenshotCount, now, sessionId]);
    this.database.flushNow();
    return next;
  }

  addScreenshot(input: Omit<WrittenTestScreenshot, "questionId"> & { questionId?: string }): WrittenTestScreenshot {
    this.database.run("INSERT INTO written_test_screenshots(id, session_id, question_id, file_path, thumbnail_path, mime_type, sha256, width, height, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [input.id, input.sessionId, input.questionId ?? null, input.filePath, input.thumbnailPath ?? null, input.mimeType, input.sha256, input.width ?? null, input.height ?? null, input.capturedAt]);
    this.database.run("UPDATE written_test_sessions SET screenshot_count = screenshot_count + 1, updated_at = ? WHERE id = ?", [input.capturedAt, input.sessionId]);
    this.database.flush();
    return input;
  }

  createQuestion(input: WrittenTestQuestionInput, now = Date.now()): WrittenTestQuestion {
    const question: WrittenTestQuestion = { id: recordId("written-question", now), ...input, createdAt: now };
    this.database.run("INSERT INTO written_test_questions(id, session_id, sequence, raw_question, normalized_question, question_type, requirements_json, screenshot_ids_json, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [question.id, question.sessionId, question.sequence, question.rawQuestionText, question.normalizedQuestion, question.questionType, JSON.stringify(question.requirements), JSON.stringify(question.screenshotIds), question.confidence, now]);
    for (const screenshotId of question.screenshotIds) this.database.run("UPDATE written_test_screenshots SET question_id = ? WHERE id = ?", [question.id, screenshotId]);
    this.database.run("UPDATE written_test_sessions SET question_count = question_count + 1, updated_at = ? WHERE id = ?", [now, question.sessionId]);
    this.database.flush();
    return question;
  }

  completeQuestion(questionId: string, answer: WrittenAnswerDocument, answerText: string, model: string, latencyMs: number, confidence: number, finishedAt = Date.now()): WrittenTestQuestion | undefined {
    this.database.run("UPDATE written_test_questions SET answer_json = ?, answer_text = ?, model = ?, latency_ms = ?, confidence = ?, finished_at = ? WHERE id = ?", [JSON.stringify(answer), answerText, model, latencyMs, confidence, finishedAt, questionId]);
    this.database.flushNow();
    return this.getQuestion(questionId);
  }

  attachScreenshotToQuestion(questionId: string, screenshotId: string): void {
    const question = this.getQuestion(questionId);
    if (!question || question.screenshotIds.includes(screenshotId)) return;
    const screenshotIds = [...question.screenshotIds, screenshotId];
    this.database.run("UPDATE written_test_questions SET screenshot_ids_json = ? WHERE id = ?", [JSON.stringify(screenshotIds), questionId]);
    this.database.run("UPDATE written_test_screenshots SET question_id = ? WHERE id = ?", [questionId, screenshotId]);
    this.database.flush();
  }

  updateQuestionFrame(questionId: string, input: { rawQuestionText: string; normalizedQuestion: string; questionType: WrittenQuestionType; requirements: string[]; confidence: number }): WrittenTestQuestion | undefined {
    this.database.run("UPDATE written_test_questions SET raw_question = ?, normalized_question = ?, question_type = ?, requirements_json = ?, confidence = ? WHERE id = ?", [input.rawQuestionText, input.normalizedQuestion, input.questionType, JSON.stringify(input.requirements), input.confidence, questionId]);
    this.database.flush();
    return this.getQuestion(questionId);
  }

  getSession(sessionId: string): WrittenTestSession | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, profile_id AS profileId, title, started_at AS startedAt, ended_at AS endedAt, status, answer_mode AS answerMode, question_count AS questionCount, screenshot_count AS screenshotCount, created_at AS createdAt, updated_at AS updatedAt FROM written_test_sessions WHERE id = ?", [sessionId]);
    return row ? this.hydrateSession(row) : undefined;
  }

  listSessions(): WrittenTestSession[] {
    return this.database.all<Record<string, unknown>>("SELECT id, profile_id AS profileId, title, started_at AS startedAt, ended_at AS endedAt, status, answer_mode AS answerMode, question_count AS questionCount, screenshot_count AS screenshotCount, created_at AS createdAt, updated_at AS updatedAt FROM written_test_sessions ORDER BY started_at DESC").map((row) => this.hydrateSession(row));
  }

  getQuestion(questionId: string): WrittenTestQuestion | undefined {
    const row = this.database.first<Record<string, unknown>>("SELECT id, session_id AS sessionId, sequence, raw_question AS rawQuestionText, normalized_question AS normalizedQuestion, question_type AS questionType, requirements_json AS requirementsJson, screenshot_ids_json AS screenshotIdsJson, answer_json AS answerJson, answer_text AS answerText, confidence, model, latency_ms AS latencyMs, created_at AS createdAt, finished_at AS finishedAt FROM written_test_questions WHERE id = ?", [questionId]);
    return row ? this.hydrateQuestion(row) : undefined;
  }

  getSessionDetail(sessionId: string): WrittenTestSessionDetail | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const questions = this.database.all<Record<string, unknown>>("SELECT id, session_id AS sessionId, sequence, raw_question AS rawQuestionText, normalized_question AS normalizedQuestion, question_type AS questionType, requirements_json AS requirementsJson, screenshot_ids_json AS screenshotIdsJson, answer_json AS answerJson, answer_text AS answerText, confidence, model, latency_ms AS latencyMs, created_at AS createdAt, finished_at AS finishedAt FROM written_test_questions WHERE session_id = ? ORDER BY sequence", [sessionId]).map((row) => this.hydrateQuestion(row));
    const screenshots = this.database.all<Record<string, unknown>>("SELECT id, session_id AS sessionId, question_id AS questionId, file_path AS filePath, thumbnail_path AS thumbnailPath, mime_type AS mimeType, sha256, width, height, captured_at AS capturedAt FROM written_test_screenshots WHERE session_id = ? ORDER BY captured_at", [sessionId]).map((row) => this.hydrateScreenshot(row));
    return { session, questions, screenshots };
  }

  deleteSession(sessionId: string): void {
    this.database.run("DELETE FROM written_test_sessions WHERE id = ?", [sessionId]);
    this.database.flushNow();
  }

  private hydrateSession(row: Record<string, unknown>): WrittenTestSession { return { id: String(row.id), profileId: String(row.profileId), title: String(row.title), startedAt: Number(row.startedAt), ...(row.endedAt != null ? { endedAt: Number(row.endedAt) } : {}), status: String(row.status) as WrittenTestSession["status"], answerMode: String(row.answerMode) as WrittenTestSession["answerMode"], questionCount: Number(row.questionCount), screenshotCount: Number(row.screenshotCount), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) }; }
  private hydrateQuestion(row: Record<string, unknown>): WrittenTestQuestion { let answer: WrittenAnswerDocument | undefined; try { answer = row.answerJson ? JSON.parse(String(row.answerJson)) as WrittenAnswerDocument : undefined; } catch { answer = undefined; } return { id: String(row.id), sessionId: String(row.sessionId), sequence: Number(row.sequence), screenshotIds: parseArray(row.screenshotIdsJson), rawQuestionText: String(row.rawQuestionText ?? ""), normalizedQuestion: String(row.normalizedQuestion ?? ""), questionType: String(row.questionType) as WrittenQuestionType, requirements: parseArray(row.requirementsJson), ...(answer ? { answer } : {}), ...(row.answerText ? { answerText: String(row.answerText) } : {}), confidence: Number(row.confidence), ...(row.model ? { model: String(row.model) } : {}), ...(row.latencyMs != null ? { latencyMs: Number(row.latencyMs) } : {}), createdAt: Number(row.createdAt), ...(row.finishedAt != null ? { finishedAt: Number(row.finishedAt) } : {}) }; }
  private hydrateScreenshot(row: Record<string, unknown>): WrittenTestScreenshot { return { id: String(row.id), sessionId: String(row.sessionId), ...(row.questionId ? { questionId: String(row.questionId) } : {}), filePath: String(row.filePath), ...(row.thumbnailPath ? { thumbnailPath: String(row.thumbnailPath) } : {}), mimeType: String(row.mimeType) as WrittenTestScreenshot["mimeType"], sha256: String(row.sha256), ...(row.width != null ? { width: Number(row.width) } : {}), ...(row.height != null ? { height: Number(row.height) } : {}), capturedAt: Number(row.capturedAt) }; }
}
