import { describe, expect, it } from "vitest";
import { ActiveProjectResolver } from "./active-project-resolver";

const projects = [
  { id: "foc", name: "FOC 电机控制", aliases: ["FOC"], entities: ["DMA"] },
  { id: "robot", name: "机器人控制平台", aliases: ["robot"], entities: ["CAN"] }
];

describe("V3 active project lock", () => {
  it("does not switch from FOC to another project on a basic protocol question", () => {
    const resolver = new ActiveProjectResolver();
    resolver.setManual({ projectId: "foc", projectName: "FOC 电机控制" }, 1);
    for (const text of ["什么是CAN？", "什么是SPI？", "DMA的原理是什么？"]) resolver.observe({ text, speaker: "interviewer", projects, now: 2 });
    expect(resolver.state.activeProject?.projectId).toBe("foc");
  });
  it("keeps a weak switch pending and only locks an explicit switch", () => {
    const resolver = new ActiveProjectResolver();
    resolver.setManual({ projectId: "foc", projectName: "FOC 电机控制" }, 1);
    resolver.observe({ text: "机器人调试", speaker: "interviewer", projects, now: 2 });
    expect(resolver.state).toMatchObject({ status: "ACTIVE", lockState: "SWITCH_PENDING", activeProject: { projectId: "foc" } });
    resolver.observe({ text: "下面看机器人项目", speaker: "interviewer", projects, now: 3 });
    expect(resolver.state).toMatchObject({ status: "ACTIVE", lockState: "LOCKED", activeProject: { projectId: "robot" } });
  });

  it("marks ambiguous project evidence as conflict", () => {
    const resolver = new ActiveProjectResolver();
    resolver.reset(1);
    resolver.observe({ text: "这个项目", speaker: "interviewer", projects: [{ ...projects[0], aliases: ["这个项目"] }, { ...projects[1], aliases: ["这个项目"] }], now: 2 });
    expect(resolver.state.lockState).toBe("CONFLICT");
  });

  it("accumulates two medium current-turn signals before switching", () => {
    const evidenceProjects = [
      { id: "foc", name: "FOC 电机控制", entities: ["FOC", "电机"] },
      { id: "robot", name: "机器人控制平台", entities: [] }
    ];
    const resolver = new ActiveProjectResolver();
    resolver.setManual({ projectId: "foc", projectName: "FOC 电机控制" }, 1);
    const first = resolver.observe({ text: "机器 平台", speaker: "interviewer", projects: evidenceProjects, now: 2 });
    expect(first).toMatchObject({ changed: false, reason: "project-switch-candidate", evidenceLevel: "medium", activeProject: { projectId: "foc" } });
    const second = resolver.observe({ text: "机器 平台", speaker: "interviewer", projects: evidenceProjects, now: 3 });
    expect(second).toMatchObject({ changed: true, activeProject: { projectId: "robot" }, evidenceLevel: "medium" });
  });
});
