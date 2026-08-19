import { describe, expect, it } from "vitest";
import { AgentToolRegistry, isSafeWorkspacePath, PreparationAgent, PreparationAgentRuntime, ToolApprovalPolicy, toolRisk, workspacePath } from "./agent";

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

  it("runs a bounded model/tool loop and pauses writes for approval", async () => {
    let calls = 0;
    const registry = new AgentToolRegistry(new ToolApprovalPolicy("ASK_EVERY_TIME"))
      .register({ name: "write_file", risk: "write", execute: async () => "updated" });
    const runtime = new PreparationAgentRuntime({
      next: async () => calls++ === 0 ? { type: "tool_call", tool: "write_file", args: { path: "resume.md" } } : { type: "final", summary: "完成" }
    }, registry, { workspaceRoot: "C:/workspace" }, 40);
    const events: Array<{ type: string; requestId?: string }> = [];
    const run = (async () => { for await (const event of runtime.run("整理简历")) events.push(event); })();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const approval = events.find((event) => event.type === "approval_required");
    expect(approval?.requestId).toBeTruthy();
    runtime.approve(approval?.requestId ?? "");
    await run;
    expect(events.map((event) => event.type)).toEqual(["step", "tool_call", "approval_required", "tool_result", "step", "completed"]);
  });

  it("rejects a model tool call that is not registered instead of throwing the run", async () => {
    const registry = new AgentToolRegistry(new ToolApprovalPolicy("FULL_ACCESS"));
    const runtime = new PreparationAgentRuntime({
      next: async ({ history }) => history.length === 0 ? { type: "tool_call", tool: "web_search", args: {} } : { type: "final", summary: "继续" }
    }, registry, { workspaceRoot: "C:/workspace" }, 4);
    const events: string[] = [];
    for await (const event of runtime.run("查资料")) events.push(event.type);
    expect(events).toEqual(["step", "tool_call", "rejected", "step", "completed"]);
  });
});
