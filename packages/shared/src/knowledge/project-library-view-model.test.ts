import { describe, expect, it } from "vitest";
import { deriveProjectLibraryViewModel } from "./project-library-view-model";
import type { ProjectFact, ProjectMemoryProject } from "./types";
import type { ProjectUnderstanding } from "../project-comprehension/types";

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

  it("uses the grounded project understanding for summary and architecture", () => {
    const understanding = { projectId: project.id, schemaVersion: 1, status: "completed", identity: { name: "项目" }, summary: "这是经过 Grounding 的项目级理解摘要，描述组件、流程与工程边界。", architecture: { components: [{ id: "core", name: "Motor Control", kind: "control", description: "控制环", confidence: 0.9 }], relationships: [] }, runtimeFlows: [{ id: "flow", name: "Runtime Flow", kind: "runtime", description: "运行流程", steps: [], evidenceRefs: [] }], dataFlows: [], controlFlows: [], technologies: [], parameters: [], decisions: [], problems: [], interfaces: [], protections: [], tests: [], results: [], limitations: [], unknowns: [], evidenceRefs: [], quality: { architectureCoverage: 80, flowCoverage: 80, parameterCoverage: 0, decisionCoverage: 0, problemCoverage: 0, groundingCoverage: 100, sufficient: true }, trace: { toolCalls: 4, filesRead: 2, modelTurns: 0, elapsedMs: 4, stages: ["completed"] } } as ProjectUnderstanding;
    const model = deriveProjectLibraryViewModel({ project, facts: [], sourceCount: 1, understanding });
    expect(model.summary).toContain("Grounding");
    expect(model.components[0]?.name).toBe("Motor Control");
    expect(model.flows[0]?.name).toBe("Runtime Flow");
  });
});
