import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDeterministicProjectMemory } from "./project-memory";
import { calculateProjectCompleteness } from "./project-completeness";
import type { ProjectMemoryAnalysisInput } from "./types";

function benchmarkFixture(name: string, id: string, projectName: string): ProjectMemoryAnalysisInput {
  const text = readFileSync(fileURLToPath(new URL(`../../../../tests/fixtures/project-analysis/${name}`, import.meta.url)), "utf8");
  return { projectId: id, projectName, sources: [{ id: `${id}-doc`, kind: "project-document", title: name, projectId: id, projectName, text }] };
}

describe("Project analysis benchmark", () => {
  it("reports extraction coverage for representative FOC and RK3506 documents", () => {
    const cases = [
      benchmarkFixture("foc-project.md", "bench-foc", "FOC"),
      benchmarkFixture("rk3506-project.md", "bench-rk3506", "RK3506")
    ];
    const started = performance.now();
    const results = cases.map((item) => {
      const snapshot = buildDeterministicProjectMemory(item);
      const project = snapshot.projects[0];
      const completeness = project ? calculateProjectCompleteness({ project, facts: snapshot.facts ?? [], modules: snapshot.modules, problems: snapshot.problems, questions: snapshot.interviewQuestions }) : undefined;
      return { id: item.projectId, facts: snapshot.facts?.length ?? 0, modules: snapshot.modules.length, problems: snapshot.problems.length, sourceCoverage: completeness?.sourceCoverageScore ?? 0, readiness: completeness?.interviewReadinessScore ?? 0 };
    });
    const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
    console.info("PROJECT_ANALYSIS_BENCHMARK", JSON.stringify({ documents: results.length, elapsedMs, results }));
    expect(results.every((result) => result.facts >= 12 && result.modules >= 3 && result.problems >= 1 && result.sourceCoverage >= 70)).toBe(true);
  });
});
