import { describe, expect, it } from "vitest";
import { planChatContext } from "./chat-intent";

describe("Chat context planner", () => {
  it("routes project questions to project memory without treating every prompt as a resume request", () => {
    expect(planChatContext("请解释 FOC 项目的电流环架构")).toMatchObject({ intent: "project_analysis", includeProjectMemory: true, includeResume: false });
  });

  it("routes job fit requests to both resume and JD context", () => {
    expect(planChatContext("这份简历和岗位 JD 匹配吗？")).toMatchObject({ intent: "job_fit_analysis", includeResume: true, includeJobDescription: true });
  });
});
