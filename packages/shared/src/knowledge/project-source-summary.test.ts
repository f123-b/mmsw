import { describe, expect, it } from "vitest";
import { deriveSourceExtractionSummary } from "./project-source-summary";
import type { ProjectFact } from "./types";

const fact = (id: string, type: ProjectFact["type"], sourceId = "source-a", extra: Partial<ProjectFact> = {}): ProjectFact => ({
  id,
  projectId: "project-a",
  type,
  title: id,
  content: id,
  confidence: 0.9,
  verified: false,
  sourceIds: [sourceId],
  evidence: [{ sourceId, quote: id }],
  evidenceLevel: "confirmed-document",
  status: "active",
  ...extra
});

describe("source-scoped extraction summaries", () => {
  it("counts eligible facts without leaking other sources or rejected facts", () => {
    const summary = deriveSourceExtractionSummary("source-a", [
      fact("parameter", "parameter"),
      fact("technology", "technology"),
      fact("decision", "technical_decision"),
      fact("challenge", "challenge"),
      fact("cause", "cause"),
      fact("solution", "solution"),
      fact("result", "result"),
      fact("other-source", "parameter", "source-b"),
      fact("rejected", "technology", "source-a", { status: "rejected" })
    ]);
    expect(summary).toMatchObject({ totalFacts: 7, parameters: 1, technologies: 1, decisions: 1, challenges: 1, causes: 1, solutions: 1, results: 1 });
  });

  it("marks unmeasured results as limitations", () => {
    const summary = deriveSourceExtractionSummary("source-a", [fact("not-measured", "metric", "source-a", { content: "尚未完成正式 benchmark" })]);
    expect(summary).toMatchObject({ metrics: 1, limitations: 1 });
  });
});
