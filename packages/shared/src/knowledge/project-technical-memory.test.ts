import { describe, expect, it } from "vitest";
import { calculateProjectCompleteness } from "./project-completeness";
import { isFactUserActionRequired } from "./project-fact-eligibility";
import { extractProjectFacts, ProjectFactConflictResolver, ProjectFactValidator } from "./project-facts";
import { areCanonicalFactValuesEquivalent, canonicalProjectFactKey } from "./project-semantics";
import { canonicalProjectParameterKey, deriveProjectProblemChains, formatProjectFactValue, inferExperienceRelation, normalizeProjectFactValue, resolveProjectAnswerPerspective } from "./project-technical-memory";
import type { ProjectFact } from "./types";

const fact = (id: string, type: ProjectFact["type"], title: string, content: string, extra: Partial<ProjectFact> = {}): ProjectFact => ({ id, projectId: "p", type, factType: type, title, content, confidence: 0.9, verified: false, sourceIds: ["s"], evidence: [{ sourceId: "s", quote: content }], evidenceLevel: "confirmed-document", status: "active", ...extra });

describe("Project Technical Memory V4", () => {
  it("normalizes parameter values and keeps measured performance as metric", () => {
    expect(normalizeProjectFactValue(undefined, "电流环频率 20 kHz")).toMatchObject({ kind: "scalar", value: 20_000, unit: "Hz", display: "20 kHz" });
    expect(normalizeProjectFactValue(undefined, "限流 2-5 A")).toMatchObject({ kind: "range", min: 2, max: 5, unit: "A" });
    expect(formatProjectFactValue({ kind: "boolean", value: true })).toBe("是");
    expect(canonicalProjectParameterKey({ type: "parameter", title: "电流环频率", content: "20 kHz" })).toBe("control.current_loop.frequency");
    expect(canonicalProjectParameterKey({ type: "metric", title: "电流环频率", content: "实测 20 kHz" })).toBeUndefined();
    expect(canonicalProjectParameterKey({ type: "cause", title: "问题原因", content: "采样窗口和参数问题" })).toBeUndefined();
    expect(areCanonicalFactValuesEquivalent(
      fact("display-a", "parameter", "电流环频率", "20 kHz", { canonicalKey: "control.current_loop.frequency", value: { kind: "scalar", value: 20_000, unit: "Hz", display: "20 kHz" } }),
      fact("display-b", "parameter", "电流环频率", "20000 Hz", { canonicalKey: "control.current_loop.frequency", value: { kind: "scalar", value: 20_000, unit: "Hz", display: "20000 Hz" } })
    )).toBe(true);
    const repaired = ProjectFactValidator.sanitize(fact("metric-param", "metric", "电流环频率", "电流环频率 20 kHz"));
    expect(repaired?.type).toBe("parameter");
    const extracted = extractProjectFacts({ projectId: "p", sources: [{ id: "doc", kind: "project-document", sourceRole: "overview", title: "参数", text: "电流环 20kHz\n速度环 1kHz\n平均延迟 8ms" }] });
    expect(extracted.find((item) => item.content.includes("电流环"))).toMatchObject({ type: "parameter", canonicalKey: "control.current_loop.frequency", value: { kind: "scalar", value: 20_000, unit: "Hz" }, experienceRelation: "configured" });
    expect(extracted.some((item) => item.type === "metric" && item.content.includes("平均延迟"))).toBe(false);
  });

  it("uses structured values for deterministic parameter conflicts", () => {
    const result = new ProjectFactConflictResolver().resolve([
      fact("ten", "parameter", "电流环频率", "电流环频率 10 kHz", { value: { kind: "scalar", value: 10, unit: "kHz" } }),
      fact("twenty", "parameter", "电流环频率", "电流环频率 20 kHz", { value: { kind: "scalar", value: 20, unit: "kHz" } })
    ]);
    expect(canonicalProjectFactKey(result[0] as ProjectFact)).toBe("control.current_loop.frequency");
    expect(new Set(result.map((item) => item.conflictGroupId))).toEqual(new Set(["conflict:p:control.current_loop.frequency"]));
  });

  it("protects third-party libraries from implementation claims", () => {
    expect(inferExperienceRelation(fact("rtos", "technology", "FreeRTOS", "项目使用 FreeRTOS"))).toBe("used");
    expect(inferExperienceRelation(fact("opencv", "technology", "OpenCV", "集成 OpenCV"))).toBe("integrated");
    expect(inferExperienceRelation(fact("algorithm", "technology", "滤波算法", "我实现了滤波算法"))).toBe("implemented");
    expect(inferExperienceRelation(fact("foc", "technology", "FOC", "FOC"))).toBe("implemented");
    expect(inferExperienceRelation(fact("can", "technology", "CAN", "CAN"))).toBe("integrated");
    expect(inferExperienceRelation(fact("cause", "cause", "原因", "采样窗口不稳定"))).toBe("debugged");
    expect(inferExperienceRelation(fact("solution", "solution", "解决", "调整 PI"))).toBe("debugged");
    expect(inferExperienceRelation(fact("parameter", "parameter", "周期", "10 ms"))).toBe("configured");
    expect(inferExperienceRelation(fact("metric", "metric", "延迟", "实测 8 ms"))).toBe("measured");
  });

  it("applies ownership-aware actions and answer perspective", () => {
    const responsibility = fact("role", "responsibility", "职责", "负责电流环", { ownership: "unknown", evidenceLevel: "pending", status: "pending_review" });
    expect(isFactUserActionRequired(responsibility, "personal")).toBe(false);
    expect(isFactUserActionRequired(responsibility, "partial")).toBe(true);
    const technical = fact("design", "technical_decision", "技术方案", "我设计了电流采样链路", { experienceRelation: "designed" });
    expect(resolveProjectAnswerPerspective({ ownershipMode: "personal" }, technical).voice).toBe("first-person");
    expect(resolveProjectAnswerPerspective({ ownershipMode: "team" }, technical).voice).toBe("project");
    expect(resolveProjectAnswerPerspective({ ownershipMode: "reference" }, technical).voice).toBe("project");
  });

  it("computes familiarity dimensions and derives problem chains", () => {
    const facts = [
      fact("bg", "background", "背景", "实现电机控制"),
      fact("param", "parameter", "CAN 波特率", "CAN 波特率 500 kbps", { canonicalKey: "communication.can.bitrate", value: { kind: "scalar", value: 500, unit: "kbps" } }),
      fact("challenge", "challenge", "问题", "低速抖动", { sectionPath: ["问题"] }),
      fact("cause", "cause", "原因", "采样时序不稳", { sectionPath: ["问题"] }),
      fact("solution", "solution", "解决", "校准触发点", { sectionPath: ["问题"] })
    ];
    const result = calculateProjectCompleteness({ project: { id: "p", name: "项目", description: "", role: "", hardware: [], software: [], technologyStack: [], sourceIds: [], confidence: 1, ownershipMode: "personal" }, facts });
    expect(result.projectFamiliarityScore).toBeGreaterThan(0);
    expect(result.familiarityDimensions.map((item) => item.key)).toEqual(expect.arrayContaining(["background", "parameters", "decisions", "problems"]));
    expect(deriveProjectProblemChains(facts)).toHaveLength(1);
    expect(result.interviewReadinessScore).toBe(Math.round(result.projectFamiliarityScore * 0.75 + result.questionCoverage * 0.15 + result.criticalReviewScore * 0.10));
  });
});
