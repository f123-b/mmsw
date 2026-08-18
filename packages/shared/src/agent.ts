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
