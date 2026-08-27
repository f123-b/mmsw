import { ProjectGroundingService } from "./grounding";
import { ProjectExplorationPlanner } from "./planner";
import { projectExplorerLimits, SourceProjectExplorer } from "./repo-explorer";
import { ProjectRepoMapper } from "./repo-map";
import type {
  ProjectComprehensionInput,
  ProjectComprehensionModel,
  ProjectComprehensionModelInput,
  ProjectComprehensionStatus,
  ProjectExplorationAction,
  ProjectExplorerObservation,
  ProjectRepoMap,
  ProjectUnderstanding,
  ProjectUnderstandingTraceSummary,
} from "./types";
import { PROJECT_COMPREHENSION_SCHEMA_VERSION } from "./types";
import { ProjectUnderstandingBuilder } from "./understanding-builder";
import { ProjectUnderstandingValidator } from "./validator";

export const PROJECT_COMPREHENSION_SYSTEM_PROMPT = [
  "你是一名资深软件、嵌入式与机器人项目分析工程师。你的目标不是提取孤立事实，而是理解整个工程如何工作。",
  "你需要主动浏览项目结构，识别模块、入口、运行流程、数据流、控制链、接口、参数、设计决策、问题与结果。",
  "先建立 Repo Map，再根据 Repo Map 选择最有信息量的文件和符号；不要假设目录结构，也不要把固定技术名录当作分析前提。",
  "每个架构、流程、参数、决策、问题声明都必须能够回指探索到的文件证据；没有证据的内容放入 unknowns。",
  "不要因为两个数字不同就立即判定冲突：先判断它们是否属于不同语义、不同版本、不同上下文或不同测量阶段。",
  "输出用于 Grounding 的项目理解 JSON，不要输出孤立 facts 列表，不要输出长篇思维过程。",
].join("\n");

export type ProjectComprehensionTraceEvent =
  | "PROJECT_COMPREHENSION_STARTED"
  | "PROJECT_REPO_MAPPED"
  | "PROJECT_PLAN_CREATED"
  | "PROJECT_TOOL_CALL"
  | "PROJECT_HYPOTHESIS_CREATED"
  | "PROJECT_HYPOTHESIS_VERIFIED"
  | "PROJECT_SYNTHESIS_COMPLETED"
  | "PROJECT_GROUNDING_COMPLETED"
  | "PROJECT_COMPREHENSION_COMPLETED"
  | "PROJECT_COMPREHENSION_FAILED";

export type ProjectComprehensionTrace = (event: ProjectComprehensionTraceEvent, fields: Record<string, unknown>) => void;

export interface ProjectComprehensionAgentOptions {
  model?: ProjectComprehensionModel;
  planner?: ProjectExplorationPlanner;
  mapper?: ProjectRepoMapper;
  builder?: ProjectUnderstandingBuilder;
  grounding?: ProjectGroundingService;
  validator?: ProjectUnderstandingValidator;
  trace?: ProjectComprehensionTrace;
  enabled?: boolean;
  now?: () => number;
}

export interface ProjectComprehensionResult {
  understanding: ProjectUnderstanding;
  repoMap: ProjectRepoMap;
  observations: ProjectExplorerObservation[];
  cached: boolean;
}

function statusStages(status: ProjectComprehensionStatus): ProjectComprehensionStatus[] {
  return ["scan", "mapping", "exploring", "synthesizing", "grounding", status];
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, now() - startedAt);
}

function modelObject(output: string): Record<string, unknown> | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? output;
  try {
    const parsed: unknown = JSON.parse(fenced.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function arrayField<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? value as T[] : undefined;
}

function mergeModelOutput(base: ProjectUnderstanding, output: string): ProjectUnderstanding {
  const parsed = modelObject(output);
  if (!parsed) return base;
  const architecture = parsed.architecture && typeof parsed.architecture === "object" ? parsed.architecture as Record<string, unknown> : undefined;
  const next = { ...base };
  if (typeof parsed.summary === "string" && parsed.summary.trim().length >= 40) next.summary = parsed.summary.trim().slice(0, 220);
  if (parsed.identity && typeof parsed.identity === "object") next.identity = { ...base.identity, ...(parsed.identity as ProjectUnderstanding["identity"]) };
  if (architecture?.overview && typeof architecture.overview === "string") next.architecture = { ...base.architecture, overview: architecture.overview };
  const fields: Array<[keyof ProjectUnderstanding, unknown]> = [
    ["technologies", parsed.technologies], ["parameters", parsed.parameters], ["decisions", parsed.decisions],
    ["problems", parsed.problems], ["interfaces", parsed.interfaces], ["protections", parsed.protections],
    ["tests", parsed.tests], ["results", parsed.results], ["limitations", parsed.limitations], ["unknowns", parsed.unknowns],
  ];
  for (const [key, value] of fields) {
    const values = arrayField(value);
    if (values && values.length > 0) (next as unknown as Record<string, unknown>)[key] = values;
  }
  const modelComponents = arrayField(architecture?.components);
  const modelRelationships = arrayField(architecture?.relationships);
  if (modelComponents?.length) next.architecture = { ...next.architecture, components: modelComponents as ProjectUnderstanding["architecture"]["components"] };
  if (modelRelationships?.length) next.architecture = { ...next.architecture, relationships: modelRelationships as ProjectUnderstanding["architecture"]["relationships"] };
  for (const key of ["runtimeFlows", "dataFlows", "controlFlows"] as const) {
    const values = arrayField(parsed[key]);
    if (values?.length) next[key] = values as ProjectUnderstanding[typeof key];
  }
  return next;
}

function actionName(action: ProjectExplorationAction): string { return action.type; }

function compactModelInput(input: ProjectComprehensionInput, repoMap: ProjectRepoMap, observations: ProjectExplorerObservation[]): ProjectComprehensionModelInput {
  return {
    input: { projectId: input.projectId, projectName: input.projectName, options: input.options },
    repoMap,
    observations: observations.map((observation) => ({
      action: observation.action,
      elapsedMs: observation.elapsedMs,
      files: observation.files?.map((file) => ({ ...file, text: file.text.slice(0, 600) })),
      matches: observation.matches,
      history: observation.history,
    })),
  };
}

/**
 * Bounded agent loop for project comprehension. It owns repository exploration
 * and synthesis, while the existing ProjectMemoryAgent remains the Fact-first
 * grounding path used by Project Memory.
 */
export class ProjectComprehensionAgent {
  private readonly options: ProjectComprehensionAgentOptions;

  constructor(options: ProjectComprehensionAgentOptions = {}) {
    this.options = options;
  }

  async comprehend(input: ProjectComprehensionInput, cachedUnderstanding?: ProjectUnderstanding): Promise<ProjectComprehensionResult> {
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    const limits = projectExplorerLimits(input.options);
    if (cachedUnderstanding && cachedUnderstanding.projectId === input.projectId && cachedUnderstanding.schemaVersion === PROJECT_COMPREHENSION_SCHEMA_VERSION && cachedUnderstanding.status === "completed") {
      this.options.trace?.("PROJECT_COMPREHENSION_COMPLETED", { projectId: input.projectId, cached: true, elapsedMs: elapsed(now, startedAt) });
      return { understanding: cachedUnderstanding, repoMap: { projectId: input.projectId, languages: [], buildSystems: [], entryPoints: [], directories: [], likelyCoreFiles: [], testFiles: [], configFiles: [], documentFiles: [], files: [], excludedPatterns: [], sourceIds: input.sources.map((source) => source.id) }, observations: [], cached: true };
    }
    if (this.options.enabled === false) throw new Error("PROJECT_COMPREHENSION_DISABLED");
    this.options.trace?.("PROJECT_COMPREHENSION_STARTED", { projectId: input.projectId, sourceCount: input.sources.length, maxToolCalls: limits.maxToolCalls, maxFilesRead: limits.maxFilesRead });
    const explorer = new SourceProjectExplorer(input.sources, limits);
    const observations: ProjectExplorerObservation[] = [];
    const filesRead = new Set<string>();
    let inputChars = 0;
    let toolCalls = 0;
    let modelTurns = 0;
    const tree = explorer.listTree({ limit: limits.maxResults });
    toolCalls += 1;
    this.options.trace?.("PROJECT_REPO_MAPPED", { projectId: input.projectId, files: tree.length, toolCalls });
    const mapper = this.options.mapper ?? new ProjectRepoMapper();
    const repoMap = mapper.map(input.projectId, { listTree: () => tree } as never);
    const builder = this.options.builder ?? new ProjectUnderstandingBuilder();
    const planner = this.options.planner ?? new ProjectExplorationPlanner();
    const deadline = startedAt + limits.timeoutMs;
    while (toolCalls < limits.maxToolCalls && filesRead.size < limits.maxFilesRead && now() <= deadline) {
      const action = planner.plan({ repoMap, observations, filesRead, toolCalls, modelTurns });
      this.options.trace?.("PROJECT_PLAN_CREATED", { projectId: input.projectId, action: actionName(action), toolCalls, filesRead: filesRead.size });
      if (action.type === "synthesize") break;
      const actionStarted = now();
      const observation = this.execute(explorer, action, limits);
      toolCalls += 1;
      for (const file of observation.files ?? []) {
        if (!filesRead.has(file.path)) {
          filesRead.add(file.path);
          inputChars += file.text.length;
        }
      }
      observations.push(observation);
      builder.update(observation);
      this.options.trace?.("PROJECT_TOOL_CALL", { projectId: input.projectId, tool: action.type, durationMs: elapsed(now, actionStarted), filesRead: filesRead.size, toolCalls });
      if (action.type === "searchText" && (observation.matches?.length ?? 0) > 0) this.options.trace?.("PROJECT_HYPOTHESIS_CREATED", { projectId: input.projectId, query: action.query, candidateCount: observation.matches?.length ?? 0 });
      if (action.type === "readFile" && observation.files?.length && observations.some((candidate) => candidate.action.type === "searchText" && candidate.matches?.some((match) => match.path === action.path))) this.options.trace?.("PROJECT_HYPOTHESIS_VERIFIED", { projectId: input.projectId, path: action.path, evidenceFound: true });
      if (inputChars >= limits.maxInputChars) break;
    }
    const trace: ProjectUnderstandingTraceSummary = { toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: elapsed(now, startedAt), stages: statusStages("synthesizing") };
    this.options.trace?.("PROJECT_SYNTHESIS_COMPLETED", { projectId: input.projectId, toolCalls, filesRead: filesRead.size, elapsedMs: trace.elapsedMs });
    let understanding = builder.build(input, repoMap, trace);
    if (this.options.model && modelTurns < limits.maxModelTurns && now() <= deadline) {
      modelTurns += 1;
      const modelInput = compactModelInput(input, repoMap, observations);
      try {
        const output = await this.options.model.generate(modelInput);
        understanding = mergeModelOutput(understanding, output);
        understanding.trace = { ...understanding.trace, modelTurns, elapsedMs: elapsed(now, startedAt), stages: statusStages("grounding") };
      } catch (error) {
        this.options.trace?.("PROJECT_COMPREHENSION_FAILED", { projectId: input.projectId, stage: "model", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const grounding = (this.options.grounding ?? new ProjectGroundingService()).ground({ ...understanding, status: "grounding" });
    understanding = { ...grounding.understanding, trace: { ...grounding.understanding.trace, toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: elapsed(now, startedAt), stages: statusStages("completed") } };
    this.options.trace?.("PROJECT_GROUNDING_COMPLETED", { projectId: input.projectId, groundedClaims: grounding.groundedClaims, ungroundedClaims: grounding.ungroundedClaims });
    const validation = (this.options.validator ?? new ProjectUnderstandingValidator()).validate(understanding);
    if (!validation.valid) {
      this.options.trace?.("PROJECT_COMPREHENSION_FAILED", { projectId: input.projectId, stage: "validation", issues: validation.issues });
      throw new Error(`PROJECT_COMPREHENSION_INVALID:${validation.issues.join(",")}`);
    }
    this.options.trace?.("PROJECT_COMPREHENSION_COMPLETED", { projectId: input.projectId, cached: false, toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: understanding.trace.elapsedMs });
    return { understanding, repoMap, observations, cached: false };
  }

  private execute(explorer: SourceProjectExplorer, action: Exclude<ProjectExplorationAction, { type: "synthesize" }>, limits: ReturnType<typeof projectExplorerLimits>): ProjectExplorerObservation {
    const startedAt = Date.now();
    switch (action.type) {
      case "readFile": {
        const file = explorer.readFile(action.path, { maxChars: limits.maxFileChars, maxLines: limits.maxFileLines });
        return { action, files: file ? [file] : [], elapsedMs: Math.max(0, Date.now() - startedAt) };
      }
      case "searchText": return { action, matches: explorer.searchText(action.query, { limit: limits.maxResults }), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "findDefinitions": return { action, matches: explorer.findDefinitions(action.symbol, { limit: limits.maxResults }), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "findReferences": return { action, matches: explorer.findReferences(action.symbol, { limit: limits.maxResults }), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectBuildConfig": return { action, files: explorer.inspectBuildConfig(), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectTests": return { action, files: explorer.inspectTests(), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectProjectDocument": return { action, files: explorer.inspectProjectDocument(action.role), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectGitHistory": return { action, history: explorer.inspectGitHistory(), elapsedMs: Math.max(0, Date.now() - startedAt) };
    }
  }
}
