import { describe, expect, it } from "vitest";
import { buildSessionTerminologyContext } from "./terminology/dynamic-lexicon-builder";
import { INTERVIEW_DIRECTION_PRESETS, INTERVIEW_DIRECTION_WEIGHT, resolveInterviewDomainContext } from "./interview-directions";
import { TECHNICAL_DOMAIN_LABELS, TECHNICAL_DOMAINS } from "./terminology/terminology-types";

describe("interview direction compatibility layer", () => {
  it("keeps the legacy route untouched when no selection is supplied", () => {
    expect(resolveInterviewDomainContext({ jd: "C++ Linux", resume: "嵌入式" })).toBeUndefined();
    const context = buildSessionTerminologyContext({ jd: "C++ Linux", resume: "嵌入式" });
    expect(context.domainContext).toBeUndefined();
    expect(context.primaryDomains.length).toBeGreaterThan(0);
  });

  it("normalizes one primary and ordered secondary directions", () => {
    const context = resolveInterviewDomainContext({
      selection: { mode: "hybrid", primaryDirectionId: "motor_control", secondaryDirectionIds: ["robotics_ros2", "linux_systems"], allowAutoSecondary: true },
      jd: "Linux ROS2 机器人控制",
      resume: "FOC 电机控制"
    });
    expect(context?.primaryDirectionId).toBe("motor_control");
    expect(context?.secondaryDirectionIds).toEqual(["robotics_ros2", "linux_systems"]);
    expect(context?.primaryDomains).toEqual(expect.arrayContaining(["motor_control", "control_algorithm", "embedded"]));
    expect(context?.secondaryDomains).toEqual(expect.arrayContaining(["robotics", "ros", "linux"]));
    expect(context?.effectiveDomains[0]).toMatchObject({ source: "primary", weight: INTERVIEW_DIRECTION_WEIGHT.primary });
    expect(context?.effectiveDomains.some((item) => item.source === "secondary" && item.weight === INTERVIEW_DIRECTION_WEIGHT.secondary)).toBe(true);
    const topical = resolveInterviewDomainContext({ selection: { mode: "hybrid", primaryDirectionId: "ai_application" }, currentTopic: "ROS2 机器人", project: "Linux 驱动" });
    expect(topical?.effectiveDomains.find((item) => item.source === "current_topic")?.weight).toBeGreaterThan(INTERVIEW_DIRECTION_WEIGHT.current_project);
    expect(topical?.effectiveDomains.find((item) => item.source === "current_project")?.weight).toBeGreaterThan(INTERVIEW_DIRECTION_WEIGHT.primary);
  });

  it("supports custom multi-select domains and auto secondary fallback", () => {
    const context = resolveInterviewDomainContext({ selection: { mode: "manual", primaryDirectionId: "custom", customDomains: ["llm", "robotics", "ros"] }, jd: "Java backend" });
    expect(context?.primaryDomains).toEqual(["llm", "robotics", "ros"]);
    expect(context?.secondaryDomains).toEqual([]);
    const hybrid = resolveInterviewDomainContext({ selection: { mode: "hybrid", primaryDirectionId: "ai_application" }, jd: "Java 后端 Linux 驱动" });
    expect(hybrid?.autoSecondaryDomains.length).toBeGreaterThan(0);
    expect(hybrid?.secondaryDomains.some((domain) => hybrid.autoSecondaryDomains.includes(domain))).toBe(true);
  });

  it("loads additive AI application, motor control, and ROS2 packs", () => {
    const direction = resolveInterviewDomainContext({ selection: { mode: "hybrid", primaryDirectionId: "ai_application", secondaryDirectionIds: ["motor_control", "robotics_ros2"] } });
    const context = buildSessionTerminologyContext({ domainContext: direction, customTerms: [] });
    expect(context.terms.map((term) => term.canonical)).toEqual(expect.arrayContaining(["LLM", "Embedding", "PMSM", "ROS2", "ROS Node"]));
    expect(context.sourceCounts.builtin).toBeGreaterThan(0);
  });

  it("keeps the preset catalog additive and exposes all requested directions", () => {
    const ids = new Set(INTERVIEW_DIRECTION_PRESETS.map((preset) => preset.id));
    expect([...ids]).toEqual(expect.arrayContaining(["auto", "embedded_software", "motor_control", "c_cpp_systems", "linux_systems", "ai_application", "ai_cv", "robotics_ros2", "java_backend", "frontend", "algorithms", "network", "database", "fpga", "digital_ic_verification", "devops", "custom"]));
  });

  it("provides a stable user-facing label for every internal domain id", () => {
    for (const domain of TECHNICAL_DOMAINS) {
      expect(TECHNICAL_DOMAIN_LABELS[domain]).toBeTruthy();
      expect(TECHNICAL_DOMAIN_LABELS[domain]).not.toBe(domain);
    }
  });
});
