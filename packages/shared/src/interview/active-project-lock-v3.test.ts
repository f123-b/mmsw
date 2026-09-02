import { describe, expect, it } from "vitest";
import { ActiveProjectResolver } from "./active-project-resolver";

const projects = [
  { id: "foc", name: "FOC 电机控制", aliases: ["FOC"], entities: ["DMA"] },
  { id: "robot", name: "机器人控制平台", aliases: ["robot"], entities: ["CAN"] }
];

describe("V3 active project lock", () => {
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
});
