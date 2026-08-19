export const AGENT_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "search_files",
  "parse_document",
  "get_profile",
  "update_profile",
  "create_skill",
  "update_skill",
  "retrieve_knowledge",
  "web_search"
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];
export type ToolApprovalMode = "ASK_EVERY_TIME" | "FULL_ACCESS";
export type ToolRisk = "read" | "write" | "external";

const READ_TOOLS = new Set<AgentToolName>(["read_file", "list_files", "search_files", "parse_document", "get_profile", "retrieve_knowledge"]);
const EXTERNAL_TOOLS = new Set<AgentToolName>(["web_search"]);

export function toolRisk(name: AgentToolName): ToolRisk {
  if (EXTERNAL_TOOLS.has(name)) return "external";
  if (READ_TOOLS.has(name)) return "read";
  return "write";
}

export function isSafeWorkspacePath(root: string, requestedPath: string): boolean {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedPath || normalizedPath.split("/").some((part) => part === "..")) return false;
  return `${normalizedRoot}/${normalizedPath}`.startsWith(`${normalizedRoot}/`);
}

export function workspacePath(root: string, requestedPath: string): string {
  if (!isSafeWorkspacePath(root, requestedPath)) throw new Error("Workspace path escapes the profile workspace");
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = requestedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${normalizedRoot}/${normalizedPath}`;
}

export interface AgentToolContext {
  workspaceRoot: string;
  profileId?: string;
}

export interface AgentTool {
  name: AgentToolName;
  risk: ToolRisk;
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<unknown>;
}

export type ToolInvocationResult =
  | { status: "approval_required"; requestId: string; tool: AgentToolName; risk: ToolRisk }
  | { status: "completed"; value: unknown };

export class ToolApprovalPolicy {
  private readonly approved = new Set<string>();

  constructor(private readonly mode: ToolApprovalMode = "ASK_EVERY_TIME") {}

  requiresApproval(requestId: string, risk: ToolRisk): boolean {
    if (this.mode === "FULL_ACCESS" || risk === "read") return false;
    return !this.approved.has(requestId);
  }

  approve(requestId: string): void { this.approved.add(requestId); }
  revoke(requestId: string): void { this.approved.delete(requestId); }
}

export class AgentToolRegistry {
  private readonly tools = new Map<AgentToolName, AgentTool>();

  constructor(private readonly approvalPolicy = new ToolApprovalPolicy()) {}

  register(tool: AgentTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  approve(requestId: string): void { this.approvalPolicy.approve(requestId); }

  registeredTools(): AgentToolName[] { return [...this.tools.keys()]; }

  has(name: AgentToolName): boolean { return this.tools.has(name); }

  async invoke(requestId: string, name: AgentToolName, args: Record<string, unknown>, context: AgentToolContext): Promise<ToolInvocationResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool is not registered: ${name}`);
    if (this.approvalPolicy.requiresApproval(requestId, tool.risk)) return { status: "approval_required", requestId, tool: name, risk: tool.risk };
    return { status: "completed", value: await tool.execute(args, context) };
  }
}

export interface PreparationAction {
  requestId: string;
  tool: AgentToolName;
  args: Record<string, unknown>;
}

export class PreparationAgent {
  constructor(private readonly registry: AgentToolRegistry, private readonly context: AgentToolContext) {}

  run(action: PreparationAction): Promise<ToolInvocationResult> {
    return this.registry.invoke(action.requestId, action.tool, action.args, this.context);
  }
}

export type PreparationModelStep =
  | { type: "tool_call"; tool: AgentToolName; args: Record<string, unknown>; rationale?: string }
  | { type: "final"; summary: string };

export interface PreparationModel {
  next(input: { goal: string; history: Array<{ role: "model" | "tool"; content: string }> }, signal?: AbortSignal): Promise<PreparationModelStep>;
}

export type PreparationRuntimeEvent =
  | { type: "step"; index: number; goal: string }
  | { type: "tool_call"; index: number; requestId: string; tool: AgentToolName; args: Record<string, unknown>; rationale?: string }
  | { type: "approval_required"; requestId: string; tool: AgentToolName; risk: ToolRisk }
  | { type: "tool_result"; requestId: string; tool: AgentToolName; value: unknown }
  | { type: "rejected"; requestId: string; tool: AgentToolName }
  | { type: "completed"; summary: string };

/**
 * Runs a bounded model/tool loop for preparation tasks. Write and external
 * actions pause on an approval gate instead of silently mutating a profile.
 */
export class PreparationAgentRuntime {
  private readonly approvals = new Map<string, "approved" | "rejected">();
  private readonly waiters = new Map<string, Array<(decision: "approved" | "rejected") => void>>();

  constructor(private readonly model: PreparationModel, private readonly registry: AgentToolRegistry, private readonly context: AgentToolContext, private readonly maxSteps = 40) {}

  approve(requestId: string): void { this.resolveApproval(requestId, "approved"); }
  reject(requestId: string): void { this.resolveApproval(requestId, "rejected"); }

  async *run(goal: string, signal?: AbortSignal): AsyncGenerator<PreparationRuntimeEvent> {
    const history: Array<{ role: "model" | "tool"; content: string }> = [];
    for (let index = 0; index < Math.max(1, Math.min(48, this.maxSteps)); index += 1) {
      if (signal?.aborted) throw new Error("Preparation run aborted");
      yield { type: "step", index, goal };
      const step = await this.model.next({ goal, history }, signal);
      if (step.type === "final") {
        yield { type: "completed", summary: step.summary };
        return;
      }
      const requestId = `prep-${Date.now()}-${index}`;
      yield { type: "tool_call", index, requestId, tool: step.tool, args: step.args, ...(step.rationale ? { rationale: step.rationale } : {}) };
      if (!this.registry.has(step.tool)) {
        yield { type: "rejected", requestId, tool: step.tool };
        history.push({ role: "tool", content: `Tool ${step.tool} is not available in this run.` });
        continue;
      }
      const invocation = await this.registry.invoke(requestId, step.tool, step.args, this.context);
      if (invocation.status === "approval_required") {
        yield { type: "approval_required", requestId: invocation.requestId, tool: invocation.tool, risk: invocation.risk };
        const decision = await this.waitForApproval(requestId, signal);
        if (decision === "rejected") {
          yield { type: "rejected", requestId, tool: step.tool };
          history.push({ role: "tool", content: `Tool ${step.tool} was rejected by the user.` });
          continue;
        }
        this.registry.approve(requestId);
        const approved = await this.registry.invoke(requestId, step.tool, step.args, this.context);
        if (approved.status !== "completed") throw new Error(`Tool approval did not execute: ${step.tool}`);
        yield { type: "tool_result", requestId, tool: step.tool, value: approved.value };
        history.push({ role: "tool", content: JSON.stringify(approved.value) });
      } else {
        yield { type: "tool_result", requestId, tool: step.tool, value: invocation.value };
        history.push({ role: "tool", content: JSON.stringify(invocation.value) });
      }
    }
    throw new Error(`Preparation agent exceeded ${Math.min(48, this.maxSteps)} steps`);
  }

  private waitForApproval(requestId: string, signal?: AbortSignal): Promise<"approved" | "rejected"> {
    const known = this.approvals.get(requestId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(requestId) ?? [];
      waiters.push(resolve);
      this.waiters.set(requestId, waiters);
      signal?.addEventListener("abort", () => reject(new Error("Preparation approval aborted")), { once: true });
    });
  }

  private resolveApproval(requestId: string, decision: "approved" | "rejected"): void {
    this.approvals.set(requestId, decision);
    this.waiters.get(requestId)?.forEach((resolve) => resolve(decision));
    this.waiters.delete(requestId);
  }
}
