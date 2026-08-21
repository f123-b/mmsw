import { describe, expect, it } from "vitest";
import { buildDeterministicProfile, ProfileBuilderAgent, retrieveProfileExperience } from "./index";

describe("Profile Builder", () => {
  it("extracts grounded skills, projects, answer materials and FAQs", async () => {
    const artifact = await new ProfileBuilderAgent().build({
      profileId: "profile-1",
      profileName: "嵌入式工程师",
      sources: [
        { id: "resume-1", kind: "resume", title: "Resume", text: "项目经历：FOC 电机控制平台，使用 C/C++、DMA、PWM 和 CAN。" },
        { id: "interview-1", kind: "interview", title: "面试记录", text: "问题：为什么电流环需要放在中断？\n回答：因为电流环对实时性要求最高，我会放在 PWM 同步采样中断里。" }
      ]
    });
    expect(artifact.skillGraph.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(["C/C++", "FOC", "DMA", "PWM", "CAN"]));
    expect(artifact.projectGraph.nodes[0]?.name).toContain("FOC");
    expect(artifact.answerMaterials.some((item) => item.question.includes("电流环"))).toBe(true);
    expect(artifact.faqs.length).toBeGreaterThan(0);
    expect(artifact.skillGraph.nodes.every((node) => node.evidenceIds.length > 0)).toBe(true);
  });

  it("retrieves only evidence-backed material", () => {
    const artifact = buildDeterministicProfile({ profileId: "p", profileName: "p", sources: [{ id: "doc", kind: "project", title: "CAN 项目", text: "项目使用 CAN 和 DMA。" }] });
    const hits = retrieveProfileExperience("CAN", artifact);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.evidenceIds.length > 0)).toBe(true);
  });
});
