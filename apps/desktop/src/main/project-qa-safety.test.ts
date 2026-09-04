import { describe, expect, it } from "vitest";
import { StrictProjectQaRouter } from "@interview-copilot/shared";
import { SqliteDatabase, SqliteProfileRepository, SqliteProjectMemoryRepository, SqliteQuestionBankRepository } from "./database";

async function fixture() {
  const database = await SqliteDatabase.open(":memory:");
  const profile = new SqliteProfileRepository(database).save({ name: "QA safety", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
  const memory = new SqliteProjectMemoryRepository(database);
  const project = memory.createProject(profile.id, "FOC");
  const bank = new SqliteQuestionBankRepository(database);
  const makeFact = (id: string, content = "PWM频率20kHz。", projectId = project.id) => {
    const fact = memory.addCandidateFact({ id, projectId, profileId: profile.id, type: "parameter", title: "PWM频率", content, confidence: 1, verified: false, status: "active", conflictStatus: "confirmed", evidenceLevel: "confirmed-code", ownership: "project", sourceIds: ["source"], evidence: [{ sourceId: "source", quote: content }] });
    return memory.confirmFactAsUser(fact.id)!;
  };
  return { database, profile, memory, project, bank, makeFact };
}

describe("project QA trust lifecycle", () => {
  it("keeps confirmed answers intact when an import adds duplicate questions and unreviewed alternatives", async () => {
    const { database, profile, project, bank } = await fixture();
    try {
      const question = bank.saveQuestion({ canonicalText: "PWM频率是多少？", type: "project", scope: "project", projectId: project.id, profileId: profile.id, verified: true, source: "manual" });
      const original = bank.saveAnswerCard({ questionId: question.id, content: "PWM频率20kHz。", sourceType: "manual", verified: true });
      const text = "问题：PWM频率是多少？\n答案：PWM频率30kHz。";
      expect(bank.importProjectText(profile.id, project.id, text)).toMatchObject({ importedAnswers: 1, duplicatesMerged: 1, verified: false });
      expect(bank.importProjectText(profile.id, project.id, text)).toMatchObject({ importedAnswers: 0, duplicatesMerged: 1 });
      const saved = bank.getQuestion(question.id)!;
      expect(saved).toMatchObject({ verified: true, stale: false, source: "manual" });
      expect(saved.answerCards).toHaveLength(2);
      expect(saved.answerCards.find((card) => card.id === original.id)).toMatchObject({ content: original.content, verified: true, stale: false });
      expect(saved.answerCards.find((card) => card.id !== original.id)).toMatchObject({ verified: false, sourceType: "imported" });
    } finally { database.close(); }
  });

  it("does not revive a stale question on reimport", async () => {
    const { database, profile, project, bank } = await fixture();
    try {
      const question = bank.saveQuestion({ canonicalText: "PWM频率是多少？", type: "project", scope: "project", projectId: project.id, profileId: profile.id, verified: true, stale: true, source: "manual" });
      bank.importProjectText(profile.id, project.id, "问题：PWM频率是多少？\n答案：PWM频率20kHz。");
      expect(bank.getQuestion(question.id)).toMatchObject({ verified: true, stale: true, source: "manual" });
    } finally { database.close(); }
  });

  it("requires separate question and answer confirmation before a new import is directly routable", async () => {
    const { database, profile, project, bank } = await fixture();
    try {
      const report = bank.importProjectText(profile.id, project.id, "问题：PWM频率是多少？\n答案：PWM频率20kHz。");
      const router = new StrictProjectQaRouter();
      const route = () => router.match("PWM频率是多少？", [bank.getQuestion(report.ids[0])!], project.id);
      expect(route().level).toBe("NO_MATCH");
      bank.bulkUpdate(report.ids, { verified: true });
      expect(route().level).toBe("NO_MATCH");
      const card = bank.getQuestion(report.ids[0])!.answerCards[0];
      bank.saveAnswerCard({ ...card, verified: true }); // Explicit human attestation, without automatic evidence certification.
      expect(route().level).toBe("EXACT");
    } finally { database.close(); }
  });

  it("blocks unsafe confirmation at the database boundary without overwriting the old card", async () => {
    const { database, profile, project, bank, makeFact } = await fixture();
    try {
      const fact = makeFact("pwm");
      const question = bank.saveQuestion({ canonicalText: "PWM频率是多少？", type: "project", scope: "project", projectId: project.id, profileId: profile.id, factIds: [fact.id] });
      const card = bank.saveAnswerCard({ questionId: question.id, content: "PWM频率30kHz。", sourceType: "ai-generated", factIds: [fact.id], verified: false });
      expect(() => bank.saveAnswerCard({ ...card, verified: true })).toThrow("PROJECT_QA_EVIDENCE_REVIEW_REQUIRED");
      expect(bank.getQuestion(question.id)!.answerCards[0]).toMatchObject({ content: "PWM频率30kHz。", verified: false });
      expect(bank.saveAnswerCard({ ...card, content: "PWM频率20000Hz。", verified: true })).toMatchObject({ verified: true });
    } finally { database.close(); }
  });

  it("blocks cross-project facts and facts made stale before confirmation", async () => {
    const { database, profile, project, bank, memory, makeFact } = await fixture();
    try {
      const otherProject = memory.createProject(profile.id, "ESP32");
      const other = makeFact("other-pwm", "PWM频率20kHz。", otherProject.id);
      const question = bank.saveQuestion({ canonicalText: "PWM频率是多少？", type: "project", scope: "project", projectId: project.id, profileId: profile.id });
      expect(() => bank.saveAnswerCard({ questionId: question.id, content: "PWM频率20kHz。", factIds: [other.id], verified: true })).toThrow("PROJECT_QA_EVIDENCE_REVIEW_REQUIRED");
      const local = makeFact("pwm");
      database.run("UPDATE project_facts SET stale = 1 WHERE id = ?", [local.id]);
      expect(() => bank.saveAnswerCard({ questionId: question.id, content: "PWM频率20kHz。", factIds: [local.id], verified: true })).toThrow("PROJECT_QA_EVIDENCE_REVIEW_REQUIRED");
      expect(bank.getQuestion(question.id)!.answerCards).toEqual([]);
    } finally { database.close(); }
  });

  it("requires sibling answers to be reviewed after shared fact links change", async () => {
    const { database, profile, project, bank, makeFact } = await fixture();
    try {
      const a = makeFact("pwm-a");
      const b = makeFact("pwm-b");
      const question = bank.saveQuestion({ canonicalText: "PWM频率是多少？", type: "project", scope: "project", projectId: project.id, profileId: profile.id, verified: true, factIds: [a.id] });
      const first = bank.saveAnswerCard({ questionId: question.id, content: "PWM频率20kHz。", verified: true });
      const second = bank.saveAnswerCard({ questionId: question.id, content: "PWM频率20000Hz。", verified: true });
      bank.saveAnswerCard({ ...first, verified: true, stale: false, factIds: [b.id] });
      const saved = bank.getQuestion(question.id)!;
      expect(saved.answerCards.find((card) => card.id === first.id)).toMatchObject({ stale: false, verified: true });
      expect(saved.answerCards.find((card) => card.id === second.id)).toMatchObject({ stale: true });
      expect(saved.factIds).toEqual([b.id]);
    } finally { database.close(); }
  });

  it("does not change global question-bank confirmation or import semantics", async () => {
    const { database, bank } = await fixture();
    try {
      const report = bank.importText("问题：DMA的作用是什么？\n答案：DMA可以搬运数据。", "global.txt");
      const question = bank.getQuestion(report.ids[0])!;
      expect(question).toMatchObject({ scope: "global", verified: false });
      expect(bank.saveAnswerCard({ questionId: question.id, content: "示例中假设提升30%。", verified: true })).toMatchObject({ verified: true });
    } finally { database.close(); }
  });
});
