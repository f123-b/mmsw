import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createProfile } from "@interview-copilot/shared";
import { boundProfileBuilderSources, MAX_SOURCE_CHARS, MAX_TOTAL_CHARS, ProfileBuilderService } from "./profile-builder";
import { SqliteDatabase, SqliteProfileBuilderRepository, SqliteProfileRepository } from "./database";
import type { SqliteInterviewHistoryRepository, SqliteKnowledgeRepository, SqliteProjectRepository } from "./database";

describe("ProfileBuilderService freshness", () => {
  it("bounds source count payloads per source and in aggregate", () => {
    const bounded = boundProfileBuilderSources([
      { id: "a", kind: "resume", title: "A", text: "a".repeat(MAX_SOURCE_CHARS + 100), updatedAt: 1 },
      { id: "b", kind: "knowledge", title: "B", text: "b".repeat(MAX_SOURCE_CHARS + 100), updatedAt: 2 },
      { id: "c", kind: "knowledge", title: "C", text: "c".repeat(MAX_TOTAL_CHARS), updatedAt: 3 },
      { id: "d", kind: "knowledge", title: "D", text: "d".repeat(MAX_SOURCE_CHARS), updatedAt: 4 }
    ]);

    expect(bounded).toHaveLength(4);
    expect(Math.max(...bounded.map((source) => source.text.length))).toBe(MAX_SOURCE_CHARS);
    expect(bounded.reduce((total, source) => total + source.text.length, 0)).toBe(MAX_TOTAL_CHARS);
  });

  it("marks an artifact stale when its source fingerprint no longer matches", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profiles = new SqliteProfileRepository(database);
      const profile = profiles.save(createProfile({ name: "Candidate", resume: { rawContent: "candidate evidence", summary: "candidate evidence", uploadedAt: 100 } }), 100);
      const artifacts = new SqliteProfileBuilderRepository(database);
      const sourceText = "标题：Resume\n摘要：candidate evidence\ncandidate evidence";
      const fingerprint = createHash("sha256").update(`resume-${profile.id}\nresume\n${sourceText}`).digest("hex").slice(0, 16);
      artifacts.save({ profileId: profile.id, status: "ready", sourceSnapshot: { generatedAt: 100, sources: [{ id: `resume-${profile.id}`, kind: "resume", title: "Resume", fingerprint }] }, now: 200 });
      const service = new ProfileBuilderService(
        profiles,
        { list: () => [] } as unknown as SqliteProjectRepository,
        { listDocuments: () => [] } as unknown as SqliteKnowledgeRepository,
        { listInterviews: () => [] } as unknown as SqliteInterviewHistoryRepository,
        artifacts
      );

      expect(service.get(profile.id)?.status).toBe("ready");
      profiles.save({ ...profile, instructions: "same source, different interview preference" }, 300);
      expect(service.get(profile.id)?.status).toBe("ready");
      profiles.save({ ...profile, resume: { ...profile.resume!, rawContent: "new candidate evidence" } }, 400);
      expect(service.get(profile.id)?.status).toBe("stale");
    } finally {
      database.close();
    }
  });
});
