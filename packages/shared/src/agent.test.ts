import { describe, expect, it } from "vitest";
import { AgentToolRegistry, isSafeWorkspacePath, PreparationAgent, ToolApprovalPolicy, toolRisk, workspacePath } from "./agent";

describe("workspace safety and tool approvals", () => {
  it("rejects traversal and resolves only inside the profile workspace", () => {
    expect(isSafeWorkspacePath("C:/workspace/profile-1", "resume/cv.md")).toBe(true);
    expect(isSafeWorkspacePath("C:/workspace/profile-1", "../secrets.txt")).toBe(false);
    expect(() => workspacePath("C:/workspace/profile-1", "..\\secrets.txt")).toThrow();
  });

  it("requires approval for writes in ASK_EVERY_TIME and allows reads", async () => {
    const policy = new ToolApprovalPolicy("ASK_EVERY_TIME");
    const registry = new AgentToolRegistry(policy)
      .register({ name: "read_file", risk: "read", execute: async () => "content" })
      .register({ name: "write_file", risk: "write", execute: async () => "written" });
    const context = { workspaceRoot: "C:/workspace/profile-1" };
    expect(await registry.invoke("read-1", "read_file", {}, context)).toMatchObject({ status: "completed", value: "content" });
    expect(await registry.invoke("write-1", "write_file", {}, context)).toMatchObject({ status: "approval_required", risk: "write" });
    policy.approve("write-1");
    expect(await registry.invoke("write-1", "write_file", {}, context)).toMatchObject({ status: "completed", value: "written" });
  });

  it("exposes the documented external tool risk and agent dispatch", async () => {
    expect(toolRisk("web_search")).toBe("external");
    const registry = new AgentToolRegistry(new ToolApprovalPolicy("FULL_ACCESS"))
      .register({ name: "get_profile", risk: "read", execute: async (args) => args.id });
    const agent = new PreparationAgent(registry, { workspaceRoot: "C:/workspace/profile-1", profileId: "profile-1" });
    expect(await agent.run({ requestId: "profile-1", tool: "get_profile", args: { id: "profile-1" } })).toMatchObject({ status: "completed", value: "profile-1" });
  });
});
