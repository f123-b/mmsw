import { describe, expect, it } from "vitest";
import { createProfile, createSkill, ProfileStore, SkillRouter } from "./profile";

describe("Profile and Skill domain", () => {
  it("keeps resume/JD summaries separate from raw material", () => {
    const profile = createProfile({
      name: "嵌入式候选人",
      resume: { rawContent: "完整简历", summary: "STM32 与 FOC" },
      jobDescription: { rawContent: "完整 JD", summary: "电机控制岗位" }
    }, 1);
    expect(profile.resume?.summary).toBe("STM32 与 FOC");
    expect(profile.resume?.rawContent).toBe("完整简历");
    expect(profile.skills).toEqual([]);
    expect(profile).toMatchObject({ expressionLevel: "plain", explainAdvancedTerms: true });
  });

  it("routes only relevant top skills", () => {
    const profile = createProfile({ name: "candidate", skills: [
      createSkill({ name: "FOC 电机控制", description: "PMSM 电流采样", content: "Clarke Park SVPWM", tags: ["motor", "PWM"] }),
      createSkill({ name: "Linux Gateway", description: "进程和网络", content: "TCP/IP", tags: ["linux"] }),
      createSkill({ name: "RTOS", description: "任务调度", content: "优先级", tags: ["rtos"] }),
      createSkill({ name: "LVGL", description: "图形界面", content: "控件", tags: ["ui"] })
    ] });
    const routed = new SkillRouter().route("为什么 FOC 电流采样需要跟 PWM 同步？", profile);
    expect(routed[0]?.name).toBe("FOC 电机控制");
    expect(routed).toHaveLength(1);
  });

  it("updates skills through the profile store without mutating callers", () => {
    const profile = createProfile({ name: "candidate" }, 1);
    const store = new ProfileStore([profile]);
    const skill = createSkill({ name: "C", description: "", content: "", tags: [] });
    store.addSkill(profile.id, skill, 2);
    expect(store.get(profile.id)?.skills).toHaveLength(1);
    expect(profile.skills).toHaveLength(0);
  });
});
