import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectAliasResolver, StrictProjectQaRouter } from "@interview-copilot/shared";
import { SqliteDatabase, SqliteProjectMemoryRepository, SqliteQuestionBankRepository } from "./database";

// Opt-in integration check against a disposable copy; the real database is
// never opened by the migrating repository or written by this test.
const source = process.env.INTERVIEW_COPILOT_REPLAY_DATABASE;
describe.skipIf(!source)("local project routing audit", () => {
  it("finds the already verified FOC ownership and architecture answers", async () => {
    const target = resolve("../../output/interview-20260903/routing-replay.sqlite");
    if (!source || resolve(source) === target || existsSync(target)) throw new Error("Replay requires a new disposable database path");
    copyFileSync(source, target);
    const db = await SqliteDatabase.open(target);
    try {
      const record = db.first<{ profileId: string }>("SELECT profile_id AS profileId FROM interviews ORDER BY started_at DESC LIMIT 1")!;
      const snapshot = new SqliteProjectMemoryRepository(db).getSnapshot(record.profileId);
      const candidates = snapshot.projects.map((project) => ({ id: project.id, name: project.name, entities: [...project.hardware, ...project.software, ...project.technologyStack] }));
      const project = new ProjectAliasResolver().resolve("你来讲一讲，你这个FOC项目，你主要负责了什么？", candidates);
      expect(project.ambiguous).toBe(false);
      expect(project.projectName).toContain("FOC");
      const bank = new SqliteQuestionBankRepository(db);
      const questions = bank.listQuestions({ profileId: record.profileId, projectId: project.projectId, exactProject: true, scope: "project", status: "active", limit: 5000 });
      const router = new StrictProjectQaRouter();
      for (const question of ["你来讲一讲，你这个FOC项目，你主要负责了什么？", "那系统的架构是什么？"]) {
        const route = router.match(question, questions, project.projectId!);
        console.log("LOCAL_PROJECT_ROUTE", JSON.stringify({ question, level: route.level, top: route.route.top?.question.canonicalText, score: route.topScore, margin: route.margin, candidates: route.route.hits.map((hit) => ({ question: hit.question.canonicalText, score: hit.score, level: hit.matchLevel, base: hit.baseScore })) }));
        expect(route.level).not.toBe("NO_MATCH");
      }
    } finally { db.close(); unlinkSync(target); }
  });
});
