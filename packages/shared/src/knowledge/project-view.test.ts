import { describe, expect, it } from "vitest";
import { deriveProjectView } from "./project-view";
import { buildDeterministicProjectMemory, ProjectMemoryAgent } from "./project-memory";

describe("Project View trust boundary", () => {
  it("does not fall back to legacy project columns", () => {
    const project = { id: "p", name: "项目", description: "legacy description", role: "legacy role", hardware: ["Legacy MCU"], software: ["Legacy OS"], technologyStack: ["Legacy Tech"], sourceIds: ["legacy"], confidence: 0.9 };
    const view = deriveProjectView(project, []);
    expect(view.description).toBe("");
    expect(view.role).toBe("");
    expect(view.hardware).toEqual([]);
    expect(view.software).toEqual([]);
    expect(view.technologyStack).toEqual([]);
    expect(view.sourceIds).toEqual([]);
  });

  it("uses only eligible facts and preserves source-derived fields", () => {
    const view = deriveProjectView({ id: "p", name: "项目", description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: [], confidence: 0 }, [
      { id: "doc", projectId: "p", type: "technology", title: "CAN", content: "CAN", confidence: 0.8, verified: false, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: "CAN" }], evidenceLevel: "confirmed-document", status: "active" },
      { id: "pending", projectId: "p", type: "technology", title: "未确认", content: "未确认", confidence: 1, verified: false, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: "未确认" }], evidenceLevel: "pending", status: "pending_review" }
    ]);
    expect(view.technologyStack).toEqual(["CAN"]);
    expect(view.sourceIds).toEqual(["s"]);
  });

  it("does not create project questions from legacy fields without eligible facts", () => {
    const snapshot = buildDeterministicProjectMemory({ projectId: "p", projectName: "项目", sources: [{ id: "s", kind: "project-document", title: "空资料", text: "没有项目事实" }] });
    expect(snapshot.interviewQuestions).toEqual([]);
  });

  it("clamps an LLM evidence upgrade to the system source level", async () => {
    const agent = new ProjectMemoryAgent({ generate: async () => JSON.stringify({ facts: [{ factType: "technology", title: "CAN", content: "CAN", confidence: 1, evidenceLevel: "confirmed-user", sources: [{ sourceId: "architecture", quote: "CAN" }] }] }) });
    const snapshot = await agent.build({ projectId: "p", projectName: "项目", sources: [{ id: "architecture", kind: "project-document", sourceRole: "architecture", title: "架构", text: "CAN" }] });
    expect(snapshot.facts?.[0]?.evidenceLevel).toBe("confirmed-document");
  });
});
