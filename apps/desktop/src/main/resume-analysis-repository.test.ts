import { describe, expect, it } from "vitest";
import { analyzeResume } from "@interview-copilot/shared";
import { SqliteDatabase, SqliteProfileRepository, SqliteResumeAnalysisRepository } from "./database";
import { resumeAnalysisHash } from "./profile-builder";

describe("SqliteResumeAnalysisRepository", () => {
  it("persists by profile, current Resume hash and analyzer version", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save({ name: "Resume persistence", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
      const rawText = "项目经历\n项目名称：FOC 平台\n- 使用 C++";
      const analysis = analyzeResume({ sourceId: `resume-${profile.id}`, filename: "resume.txt", rawText });
      const repository = new SqliteResumeAnalysisRepository(database);
      const saved = repository.save({ profileId: profile.id, resumeHash: resumeAnalysisHash(rawText), artifact: analysis, now: 10 });
      expect(saved).toMatchObject({ profileId: profile.id, resumeHash: resumeAnalysisHash(rawText), analyzerVersion: 2, status: "current" });
      expect(repository.get(profile.id, "different-hash")?.status).toBeUndefined();
      expect(repository.get(profile.id)?.artifact?.version).toBe(2);
    } finally { database.close(); }
  });
});
