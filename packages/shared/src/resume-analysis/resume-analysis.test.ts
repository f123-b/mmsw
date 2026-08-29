import { describe, expect, it } from "vitest";
import { ResumeAnalyzer } from "./analyzer";

describe("ResumeAnalyzer", () => {
  it("extracts only explicit project blocks inside the project section", () => {
    const analysis = new ResumeAnalyzer().analyze({ sourceId: "resume-1", filename: "resume.txt", rawText: [
      "张三\n邮箱：candidate@example.com",
      "工作经历",
      "某公司 · 负责项目经验平台",
      "项目经历",
      "FOC 电机控制器 | 2022.01-2023.06 | 负责人",
      "- 负责电流采样和 PWM 控制，技术栈 C/C++、DMA、CAN",
      "RK3506 多协议网关 | 2023.07-2024.02 | 开发工程师",
      "- 实现 UART、SPI、WebSocket 协议适配",
      "ROS2 导航系统 | 2024.03-2025.01",
      "- 使用 ROS2、C++ 完成路径规划",
      "技能特长",
      "项目管理、沟通"
    ].join("\n") });
    expect(analysis.projects.map((project) => project.name)).toEqual(["FOC 电机控制器", "RK3506 多协议网关", "ROS2 导航系统"]);
    expect(analysis.projects).toHaveLength(3);
    expect(analysis.projects.every((project) => project.evidence.sourceId === "resume-1" && project.evidence.rawExcerpt.length > 0)).toBe(true);
  });
});
