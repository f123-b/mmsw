import { describe, expect, it } from "vitest";
import { ContextLock, createEvidenceSnapshot } from "./evidence-context";

describe("EvidenceSnapshot and ContextLock", () => {
  it("deduplicates evidence and records trusted source boundaries", () => {
    const snapshot = createEvidenceSnapshot({
      questionId: "q1",
      profileId: "p1",
      projectId: "project-1",
      personalMemoryEvidence: ["我负责通信模块", "我负责通信模块"],
      projectEvidence: ["项目使用 CAN"],
      retrievedKnowledge: ["[GLOBAL_REFERENCE] CAN 使用仲裁机制"]
    });
    expect(snapshot.personalMemoryEvidence).toEqual(["我负责通信模块"]);
    expect(snapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "personal", trust: "personal", verified: true }),
      expect.objectContaining({ source: "project", trust: "project", verified: true }),
      expect.objectContaining({ source: "retrieval", trust: "reference", verified: false })
    ]));
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns the first locked view even when later context changes", () => {
    const lock = new ContextLock(2);
    const first = lock.lock({ questionId: "q1", projectId: "p1", currentProject: "原项目", currentModule: "通信", currentTopic: "CAN", projectEvidence: ["原始事实"] });
    const second = lock.lock({ questionId: "q1", projectId: "p1", currentProject: "新项目", currentModule: "新模块", currentTopic: "新主题", projectEvidence: ["后来被修改的事实"] });
    second.projectEvidence.push("调用方本地修改");

    expect(second.projectEvidence).toEqual(["原始事实", "调用方本地修改"]);
    expect(lock.get("q1")?.projectEvidence).toEqual(["原始事实"]);
    expect(lock.get("q1")).toMatchObject({ currentProject: "原项目", currentModule: "通信", currentTopic: "CAN" });
    expect(lock.get("q1")?.fingerprint).toBe(first.fingerprint);
  });

  it("bounds retained snapshots for a long interview", () => {
    const lock = new ContextLock(2);
    lock.lock({ questionId: "q1", projectEvidence: ["one"] });
    lock.lock({ questionId: "q2", projectEvidence: ["two"] });
    lock.lock({ questionId: "q3", projectEvidence: ["three"] });
    expect(lock.size).toBe(2);
    expect(lock.has("q1")).toBe(false);
    expect(lock.has("q3")).toBe(true);
  });

  it("keeps verified personal sources and candidate statements in the locked snapshot", () => {
    const snapshot = createEvidenceSnapshot({
      questionId: "q-personal",
      verifiedResumeEvidence: ["简历：负责语音识别模块"],
      verifiedPersonalProjectFacts: ["我负责模型部署"],
      sessionEvidence: [{
        id: "candidate-1",
        text: "我的准确率是98%",
        source: "candidate_statement",
        trust: "personal",
        verified: true,
        sessionId: "s1",
        extractedClaims: [{ claim: "我的准确率是98%", provenance: "personal_metric", risk: "high" }],
        createdAt: 1,
        confidence: 0.9,
        verification: "candidate_asserted"
      }]
    });
    expect(snapshot.verifiedResumeEvidence).toEqual(["简历：负责语音识别模块"]);
    expect(snapshot.verifiedPersonalProjectFacts).toEqual(["我负责模型部署"]);
    expect(snapshot.items.find((item) => item.source === "candidate_statement")).toMatchObject({ trust: "personal", verified: true, sourceId: "s1" });
  });
});
