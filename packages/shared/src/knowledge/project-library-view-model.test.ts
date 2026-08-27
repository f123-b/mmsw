import { describe, expect, it } from "vitest";
import { deriveProjectLibraryViewModel } from "./project-library-view-model";
import type { ProjectFact, ProjectMemoryProject } from "./types";

const project: ProjectMemoryProject = { id: "project-a", profileId: "profile-a", name: "项目", description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: ["source-a"], confidence: 1 };
const fact: ProjectFact = { id: "parameter-a", projectId: project.id, type: "parameter", title: "电流环频率", content: "20 kHz", confidence: 1, verified: false, sourceIds: ["source-a"], evidence: [{ sourceId: "source-a", quote: "20 kHz" }], evidenceLevel: "confirmed-document", status: "active" };

describe("Project Library analysis state", () => {
  it("separates ready-to-analyze sources from analyzed facts", () => {
    const model = deriveProjectLibraryViewModel({ project, facts: [], sourceCount: 1 });
    expect(model.analysisStatus).toBe("sources_ready");
    expect(model.nextActions[0]).toMatchObject({ type: "analyze_sources", priority: "high" });
    expect(model.summary).toContain("等待项目分析");
  });

  it("marks a completed snapshot stale when a source changed later", () => {
    const model = deriveProjectLibraryViewModel({ project, facts: [fact], sourceCount: 1, analysisRuns: [{ projectId: project.id, status: "completed", updatedAt: 100 }], latestSourceUpdatedAt: 200 });
    expect(model.analysisStatus).toBe("stale");
    expect(model.nextActions[0]?.type).toBe("analyze_sources");
  });

  it("reports ready only after a completed analysis has current facts", () => {
    const model = deriveProjectLibraryViewModel({ project, facts: [fact], sourceCount: 1, analysisRuns: [{ projectId: project.id, status: "completed", updatedAt: 200 }], latestSourceUpdatedAt: 100 });
    expect(model.analysisStatus).toBe("ready");
  });
});
