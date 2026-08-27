import type {
  ProjectAgentDecision,
  ProjectComprehensionModelInput,
  ProjectComprehensionPlannerInput,
  ProjectExplorationAction,
  ProjectExplorerObservation,
  ProjectRepoMap,
} from "./types";

function normalized(value: string): string { return value.toLowerCase().replace(/[_-]+/g, " "); }

export interface ProjectExplorationPlannerContext {
  repoMap: ProjectRepoMap;
  observations: ProjectExplorerObservation[];
  filesRead: Set<string>;
  toolCalls: number;
  modelTurns: number;
}

function hasAction(context: ProjectExplorationPlannerContext, type: ProjectExplorationAction["type"]): boolean {
  return context.observations.some((observation) => observation.action.type === type);
}

function nextCoreFile(context: ProjectExplorationPlannerContext): string | undefined {
  return context.repoMap.likelyCoreFiles.find((path) => !context.filesRead.has(path));
}

function explorationQuery(context: ProjectExplorationPlannerContext): string {
  const candidates = context.repoMap.likelyCoreFiles
    .map((path) => path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "")
    .filter((name) => name.length >= 3)
    .slice(0, 6);
  return candidates.length > 0 ? candidates.join("|") : "main|entry|init|run|process";
}

/** Deterministic safety net for offline, timeout, and malformed-model runs. */
export class FallbackPlanner {
  plan(context: ProjectExplorationPlannerContext): ProjectExplorationAction {
    if (!hasAction(context, "readFile")) {
      const entry = context.repoMap.entryPoints[0] ?? context.repoMap.likelyCoreFiles[0] ?? context.repoMap.documentFiles[0];
      return entry ? { type: "readFile", path: entry } : { type: "inspectProjectDocument" };
    }
    const recentMatches = context.observations.slice().reverse().flatMap((observation) => observation.matches ?? []);
    const matchedFile = recentMatches.map((match) => match.path).find((path) => !context.filesRead.has(path));
    if (matchedFile) return { type: "readFile", path: matchedFile };
    if (!hasAction(context, "searchText")) return { type: "searchText", query: explorationQuery(context) };
    const coreFile = nextCoreFile(context);
    if (coreFile && context.filesRead.size < 12) return { type: "readFile", path: coreFile };
    if (!hasAction(context, "inspectBuildConfig") && context.repoMap.configFiles.length > 0) return { type: "inspectBuildConfig" };
    if (!hasAction(context, "inspectTests") && context.repoMap.testFiles.length > 0) return { type: "inspectTests" };
    if (!hasAction(context, "inspectProjectDocument") && context.repoMap.documentFiles.length > 0) return { type: "inspectProjectDocument" };
    if (!hasAction(context, "findDefinitions")) {
      const symbol = context.repoMap.entryPoints[0]?.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "main";
      return { type: "findDefinitions", symbol: normalized(symbol).replace(/\s+/g, "_") };
    }
    return { type: "synthesize" };
  }
}

/** Backwards-compatible name retained for callers that explicitly inject it. */
export class ProjectExplorationPlanner extends FallbackPlanner {}

export interface ProjectLLMPlanner {
  plan(input: ProjectComprehensionPlannerInput): Promise<ProjectAgentDecision>;
}

export interface ProjectLLMExplorationPlannerOptions {
  model: { generate(input: ProjectComprehensionModelInput): Promise<string> };
  timeoutMs?: number;
}

function parseObject(output: string): Record<string, unknown> | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? output;
  const object = fenced.match(/\{[\s\S]*\}/)?.[0] ?? fenced;
  try {
    const parsed: unknown = JSON.parse(object.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

const actions = new Set<ProjectAgentDecision["action"]>([
  "readFile", "searchText", "findDefinitions", "findReferences", "inspectBuildConfig", "inspectTests",
  "inspectProjectDocument", "inspectGitHistory", "verifyClaim", "synthesize",
]);

function compactPlannerInput(input: ProjectComprehensionPlannerInput): ProjectComprehensionPlannerInput {
  const observations = input.observations.slice(-3).map((observation) => ({
    ...observation,
    files: observation.files?.map((file) => ({ ...file, text: file.text.slice(0, 900) })),
    matches: observation.matches?.slice(0, 8),
    history: observation.history?.slice(0, 8),
  }));
  return {
    ...input,
    observations,
    hypotheses: input.hypotheses.slice(-12),
    confirmedConcepts: input.confirmedConcepts.slice(-24),
    unknowns: input.unknowns.slice(-12),
    filesRead: input.filesRead.slice(-40),
  };
}

function decisionFromObject(value: Record<string, unknown> | undefined): ProjectAgentDecision | undefined {
  if (!value || typeof value.action !== "string" || !actions.has(value.action as ProjectAgentDecision["action"])) return undefined;
  const priority = value.priority === "critical" || value.priority === "high" || value.priority === "low" ? value.priority : "normal";
  const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 180) : "继续验证当前缺口";
  const decision: ProjectAgentDecision = { action: value.action as ProjectAgentDecision["action"], reason, priority };
  for (const key of ["target", "query", "hypothesisId", "expectedInformation"] as const) {
    if (typeof value[key] === "string" && value[key].trim()) decision[key] = value[key].trim().slice(0, 500);
  }
  return decision;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PROJECT_PLANNER_TIMEOUT")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Model-driven next-action selector. It receives compact state, not raw source text. */
export class ProjectLLMExplorationPlanner implements ProjectLLMPlanner {
  constructor(private readonly options: ProjectLLMExplorationPlannerOptions) {}

  async plan(input: ProjectComprehensionPlannerInput): Promise<ProjectAgentDecision> {
    const compact = compactPlannerInput(input);
    const output = await withTimeout(this.options.model.generate({
      input: { projectId: compact.repoMap.projectId, projectName: compact.projectName ?? compact.repoMap.projectId },
      repoMap: compact.repoMap,
      observations: compact.observations,
      purpose: "plan",
      plannerState: compact,
    }), this.options.timeoutMs ?? 60_000);
    const decision = decisionFromObject(parseObject(output));
    if (!decision) throw new Error("PROJECT_PLANNER_INVALID_DECISION");
    return decision;
  }
}

export function validateAgentDecision(decision: ProjectAgentDecision, repoMap: ProjectRepoMap, budget: { toolCalls: number; maxToolCalls: number; filesRead: number; maxFilesRead: number }): { valid: boolean; reason?: string } {
  if (!actions.has(decision.action)) return { valid: false, reason: "ACTION_NOT_ALLOWED" };
  if (budget.toolCalls >= budget.maxToolCalls && decision.action !== "synthesize") return { valid: false, reason: "TOOL_BUDGET_EXHAUSTED" };
  if (decision.action === "readFile") {
    if (!decision.target || !repoMap.files.some((file) => file.path === decision.target)) return { valid: false, reason: "PATH_NOT_IN_REPO" };
    if (budget.filesRead >= budget.maxFilesRead) return { valid: false, reason: "FILE_BUDGET_EXHAUSTED" };
  }
  if (["searchText", "findDefinitions", "findReferences", "verifyClaim"].includes(decision.action) && (!decision.query && !decision.target && !decision.hypothesisId)) return { valid: false, reason: "QUERY_MISSING" };
  if ((decision.query ?? decision.target ?? "").length > 500) return { valid: false, reason: "QUERY_TOO_LONG" };
  return { valid: true };
}

export function decisionToAction(decision: ProjectAgentDecision): ProjectExplorationAction {
  switch (decision.action) {
    case "readFile": return { type: "readFile", path: decision.target ?? "" };
    case "searchText": return { type: "searchText", query: decision.query ?? decision.target ?? "" };
    case "findDefinitions": return { type: "findDefinitions", symbol: decision.query ?? decision.target ?? "" };
    case "findReferences": return { type: "findReferences", symbol: decision.query ?? decision.target ?? "" };
    case "inspectProjectDocument": return { type: "inspectProjectDocument", ...(decision.target ? { role: decision.target } : {}) };
    case "inspectBuildConfig": return { type: "inspectBuildConfig" };
    case "inspectTests": return { type: "inspectTests" };
    case "inspectGitHistory": return { type: "inspectGitHistory" };
    case "verifyClaim": return { type: "searchText", query: decision.query ?? decision.target ?? decision.hypothesisId ?? "" };
    case "synthesize": return { type: "synthesize" };
  }
}
