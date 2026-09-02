import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAppDatabase } from "./database";
import { WrittenTestArchiveService } from "./written-test-archive";
import { SqliteWrittenTestHistoryRepository } from "./written-test-history-repository";

describe("written test persistence", () => {
  it("autosaves screenshots and structured answers without image bytes in sqlite", async () => {
    const root = await mkdtemp(join(tmpdir(), "mmsw-written-test-"));
    const database = await openAppDatabase(root);
    try {
      const archive = new WrittenTestArchiveService(root, () => 1_725_000_000_000);
      const repository = new SqliteWrittenTestHistoryRepository(database);
      const session = repository.createSession({ profileId: "p-1", answerMode: "NORMAL" }, 1_725_000_000_000);
      const archived = await archive.archiveScreenshot(session.id, { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", width: 3, height: 1 }, 1, 1_725_000_000_000);
      repository.addScreenshot(archived);
      const question = repository.createQuestion({ sessionId: session.id, sequence: 1, screenshotIds: [archived.id], rawQuestionText: "1+1=?", normalizedQuestion: "1+1=?", questionType: "CALCULATION", requirements: ["给结果"], confidence: 0.9 }, 1_725_000_000_100);
      repository.completeQuestion(question.id, { questionType: "CALCULATION", finalAnswer: "2", steps: [], equations: ["1+1=2"], explanation: "", warnings: [], confidence: 0.9 }, "2", "fixture", 12, 0.9, 1_725_000_000_200);
      const detail = repository.getSessionDetail(session.id);
      expect(detail?.session.screenshotCount).toBe(1);
      expect(detail?.questions[0]?.answer?.finalAnswer).toBe("2");
      expect(database.all<{ file_path: string }>("SELECT file_path FROM written_test_screenshots")[0]?.file_path).toContain("written-tests");
      expect(database.all<{ answer_json: string }>("SELECT answer_json FROM written_test_questions")[0]?.answer_json).not.toContain("data:image");
      repository.deleteSession(session.id);
      expect(repository.listSessions()).toHaveLength(0);
      await archive.deleteSession(session.id);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

