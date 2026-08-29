import { describe, expect, it } from "vitest";
import type { ProfileBuilderOutput } from "@interview-copilot/shared";
import { createProfile } from "@interview-copilot/shared";
import { SqliteDatabase, SqliteProfileRepository, SqliteSkillSuggestionRepository } from "./database";

describe("SqliteSkillSuggestionRepository", () => {
  it("stores evidence and does not resurrect a rejected suggestion during re-analysis", async () => {
    const database = await SqliteDatabase.open(":memory:");
    try {
      const profile = new SqliteProfileRepository(database).save(createProfile({ name: "Candidate" }), 100);
      const repository = new SqliteSkillSuggestionRepository(database);
      const nodes: ProfileBuilderOutput["skillGraph"]["nodes"] = [{ id: "skill-1", label: "C++", description: "能解释 RAII", evidenceIds: ["resume-1"] }];
      const snapshot = { generatedAt: 100, sources: [{ id: "resume-1", kind: "resume", title: "resume.pdf", fingerprint: "a" }] };

      repository.upsertFromArtifact(profile.id, nodes, snapshot, 200);
      const first = repository.list(profile.id)[0];
      expect(first).toMatchObject({ name: "C++", status: "pending", evidenceIds: ["resume-1"], evidenceQuotes: ["resume.pdf"], sourceKinds: ["resume"] });
      expect(first.confidence).toBeGreaterThan(0);

      const rejected = repository.review(first.id, "rejected", 300);
      expect(rejected?.status).toBe("rejected");
      repository.upsertFromArtifact(profile.id, [{ ...nodes[0], description: "更新后的证据" }], snapshot, 400);

      expect(repository.list(profile.id)[0]).toMatchObject({ id: first.id, status: "rejected", description: "更新后的证据", rejectedAt: 300 });
    } finally {
      database.close();
    }
  });
});
