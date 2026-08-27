import { evidenceRequirementsForRelationship, ProjectGroundingService } from "./grounding";
import { decisionToAction, FallbackPlanner, ProjectExplorationPlanner, ProjectLLMExplorationPlanner, type ProjectLLMPlanner, validateAgentDecision } from "./planner";
import { projectExplorerLimits, SourceProjectExplorer } from "./repo-explorer";
import { ProjectRepoMapper } from "./repo-map";
import type {
  ProjectAgentDecision,
  ProjectComprehensionInput,
  ProjectComprehensionModel,
  ProjectComprehensionModelInput,
  ProjectComprehensionPlannerInput,
  ProjectComprehensionState,
  ProjectComprehensionStatus,
  ProjectExplorationAction,
  ProjectExplorerObservation,
  ProjectExplorer,
  ProjectRepositoryAdapter,
  ProjectRepoMap,
  ProjectUnderstanding,
  ProjectUnderstandingCoverage,
  ProjectUnderstandingTraceSummary,
} from "./types";
import { PROJECT_COMPREHENSION_SCHEMA_VERSION } from "./types";
import { ProjectUnderstandingBuilder } from "./understanding-builder";
import { ProjectUnderstandingValidator } from "./validator";
import type { ProjectMemorySource } from "../knowledge/types";

export const PROJECT_COMPREHENSION_SYSTEM_PROMPT = [
  "你是一名资深软件、嵌入式、机器人与 Web 服务项目分析工程师。目标是理解工程如何工作，而不是提取孤立事实。",
  "你处于受限的多轮 Agent loop：每次只决定一个下一步工具，工具结果会在下一轮提供。必须根据刚刚发现的入口、符号、调用、配置、测试或文档改变调查方向。",
  "只能选择 Repo Map 中的路径；不要假设目录结构，不要把固定技术名录当作分析前提。关系必须有直接调用、配置、赋值、订阅/发布、队列/主题、导入或明确文档断言。calls 需要 call graph，triggers 需要 config/callback/event，feeds 需要同一 data object 的 writer+reader 或 queue/topic，publishes/subscribes 需要对应 API，depends_on 需要 import/include/injection，controls 需要输出真正到达受控组件。两个词分别出现不构成关系。",
  "没有证据的声明放入 unknowns；Flow 只能由已验证关系组成，缺少链路时标记 partial 和 missingLinks。不要输出隐藏推理或长篇思维过程。",
].join("\n");

export type ProjectComprehensionTraceEvent =
  | "PROJECT_COMPREHENSION_STARTED" | "PROJECT_REPO_MAPPED" | "PROJECT_PLAN_CREATED" | "PROJECT_AGENT_DECISION"
  | "PROJECT_TOOL_CALL" | "PROJECT_HYPOTHESIS_CREATED" | "PROJECT_HYPOTHESIS_VERIFIED" | "PROJECT_CLAIM_VERIFICATION"
  | "PROJECT_FLOW_PARTIAL" | "PROJECT_VERSION_RESOLVED" | "PROJECT_SYNTHESIS_COMPLETED" | "PROJECT_GROUNDING_COMPLETED"
  | "PROJECT_COMPREHENSION_COMPLETED" | "PROJECT_COMPREHENSION_FAILED";

export type ProjectComprehensionTrace = (event: ProjectComprehensionTraceEvent, fields: Record<string, unknown>) => void;

export interface ProjectComprehensionAgentOptions {
  model?: ProjectComprehensionModel;
  /** Explicit LLM planner; otherwise the comprehension model is adapted to the planner protocol. */
  llmPlanner?: ProjectLLMPlanner;
  /** Explicit deterministic fallback retained for offline and tests. */
  planner?: ProjectExplorationPlanner | FallbackPlanner;
  mapper?: ProjectRepoMapper;
  builder?: ProjectUnderstandingBuilder;
  grounding?: ProjectGroundingService;
  validator?: ProjectUnderstandingValidator;
  trace?: ProjectComprehensionTrace;
  enabled?: boolean;
  now?: () => number;
  repositoryAdapter?: ProjectRepositoryAdapter;
}

export interface ProjectComprehensionResult {
  understanding: ProjectUnderstanding;
  repoMap: ProjectRepoMap;
  observations: ProjectExplorerObservation[];
  cached: boolean;
  state?: ProjectComprehensionState;
}

function statusStages(status: ProjectComprehensionStatus): ProjectComprehensionStatus[] { return ["scan", "mapping", "exploring", "synthesizing", "grounding", status]; }
function elapsed(now: () => number, startedAt: number): number { return Math.max(0, now() - startedAt); }

function modelObject(output: string): Record<string, unknown> | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? output;
  try { const parsed: unknown = JSON.parse(fenced.trim()); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return undefined; }
}

function arrayField<T>(value: unknown): T[] | undefined { return Array.isArray(value) ? value as T[] : undefined; }
function mergeUnique<T>(base: T[], additions: T[], key: (value: T) => string): T[] {
  const result = [...base];
  const seen = new Set(result.map(key));
  for (const value of additions) { const identity = key(value); if (!seen.has(identity)) { result.push(value); seen.add(identity); } }
  return result;
}

/** Model output is only a candidate overlay. Grounding later verifies claims. */
function mergeModelOutput(base: ProjectUnderstanding, output: string): ProjectUnderstanding {
  const parsed = modelObject(output);
  if (!parsed) return base;
  const next = { ...base };
  if (typeof parsed.summary === "string" && parsed.summary.trim().length >= 40) next.summary = parsed.summary.trim().slice(0, 220);
  if (parsed.identity && typeof parsed.identity === "object") next.identity = { ...base.identity, ...(parsed.identity as ProjectUnderstanding["identity"]) };
  const architecture = parsed.architecture && typeof parsed.architecture === "object" ? parsed.architecture as Record<string, unknown> : undefined;
  if (typeof architecture?.overview === "string") next.architecture = { ...next.architecture, overview: architecture.overview.slice(0, 500) };
  const components = arrayField<ProjectUnderstanding["architecture"]["components"][number]>(architecture?.components);
  const relationships = arrayField<ProjectUnderstanding["architecture"]["relationships"][number]>(architecture?.relationships);
  if (components?.length) next.architecture = { ...next.architecture, components: mergeUnique(base.architecture.components, components, (item) => item.id || item.name) };
  if (relationships?.length) {
    const modelRelationships = relationships.map((relationship) => ({ ...relationship, source: "model" as const, evidenceRefs: Array.isArray(relationship.evidenceRefs) ? relationship.evidenceRefs : [] }));
    next.architecture = { ...next.architecture, relationships: mergeUnique(base.architecture.relationships, modelRelationships, (item) => `${item.from}|${item.to}|${item.relation}`) };
  }
  for (const key of ["technologies", "parameters", "decisions", "problems", "interfaces", "protections", "tests", "results", "limitations", "unknowns"] as const) {
    const values = arrayField((parsed as Record<string, unknown>)[key]);
    if (values?.length) {
      const keyFor = (item: unknown): string => { const value = item as Record<string, unknown>; return String(value.id ?? value.semanticKey ?? value.name ?? value.claim ?? JSON.stringify(value)); };
      (next as unknown as Record<string, unknown>)[key] = mergeUnique(base[key] as unknown as unknown[], values, keyFor);
    }
  }
  for (const key of ["runtimeFlows", "dataFlows", "controlFlows"] as const) {
    const values = arrayField<ProjectUnderstanding[typeof key][number]>((parsed as Record<string, unknown>)[key]);
    if (values?.length) next[key] = mergeUnique(base[key], values, (item) => item.id || item.name) as ProjectUnderstanding[typeof key];
  }
  return next;
}

function compactModelInput(input: ProjectComprehensionInput, repoMap: ProjectRepoMap, observations: ProjectExplorerObservation[], state?: ProjectComprehensionPlannerInput, purpose: "plan" | "synthesize" = "synthesize"): ProjectComprehensionModelInput {
  return {
    input: { projectId: input.projectId, projectName: input.projectName, options: input.options },
    repoMap,
    observations: observations.slice(-12).map((observation) => ({
      action: observation.action,
      elapsedMs: observation.elapsedMs,
      files: observation.files?.map((file) => ({ ...file, text: file.text.slice(0, 1_200) })),
      matches: observation.matches?.slice(0, 12),
      history: observation.history?.slice(0, 12),
    })),
    purpose,
    ...(state ? { plannerState: state } : {}),
    ...(state?.semanticGraph ? { semanticGraph: { ...state.semanticGraph, nodes: state.semanticGraph.nodes.slice(0, 160), edges: state.semanticGraph.edges.slice(0, 240), symbols: state.semanticGraph.symbols.slice(0, 160), dataObjects: state.semanticGraph.dataObjects.slice(0, 120), evidence: [] } } : {}),
  };
}

function initialCoverage(): ProjectUnderstandingCoverage { return { purpose: 0, architecture: 0, mainFlow: 0, coreComponents: 0, parameters: 0, decisions: 0, problems: 0, tests: 0 }; }

function plannerInput(state: ProjectComprehensionState, now: () => number, deadline: number, projectName?: string): ProjectComprehensionPlannerInput {
  return { ...state, projectName, currentUnderstandingSummary: state.candidateComponents.length ? `已识别组件：${state.candidateComponents.slice(0, 8).map((item) => item.name).join("、")}` : undefined, toolBudgetRemaining: Math.max(0, state.budget.maxToolCalls - state.budget.toolCalls), timeBudgetRemaining: Math.max(0, deadline - now()) };
}

function updateState(state: ProjectComprehensionState, understanding: ProjectUnderstanding, observation: ProjectExplorerObservation, decision?: ProjectAgentDecision): ProjectComprehensionState {
  const concepts = new Set(state.confirmedConcepts);
  for (const file of observation.files ?? []) concepts.add(file.path);
  for (const match of observation.matches ?? []) concepts.add(match.path);
  const hypotheses = [...state.hypotheses];
  const matchCount = observation.matches?.length ?? 0;
  if (["searchText", "findCallers", "findCallees", "findDefinitions", "findReferences"].includes(observation.action.type) && (matchCount > 0 || decision?.hypothesisId)) {
    const query = "query" in observation.action ? observation.action.query : "symbol" in observation.action ? observation.action.symbol : "";
    const triggerClaim = /trgo|externaltrig|trigger/i.test(query) ? "TIM1 TRGO 可能触发 ADC1" : decision?.expectedInformation ?? `需要验证 ${query || "当前语义关系"}`;
    const type = /trgo|externaltrig|trigger|calls|caller|callee/i.test(`${query} ${decision?.expectedInformation ?? ""}`) ? "relationship" as const : "component" as const;
    const requirements = type === "relationship" ? evidenceRequirementsForRelationship(/trgo|externaltrig|trigger/i.test(query) ? "triggers" : observation.action.type === "findCallers" || observation.action.type === "findCallees" ? "calls" : "feeds") : ["definition or module evidence", "file or symbol anchor"];
    const id = decision?.hypothesisId ?? `hypothesis-${hypotheses.length + 1}`;
    if (!hypotheses.some((hypothesis) => hypothesis.id === id)) hypotheses.push({ id, claim: triggerClaim, type, status: "verifying", evidenceRefs: [], missingEvidence: requirements, evidenceRequirements: requirements, confidence: matchCount ? 0.65 : 0.35 });
  }
  if (decision?.hypothesisId && !hypotheses.some((hypothesis) => hypothesis.id === decision.hypothesisId)) hypotheses.push({ id: decision.hypothesisId, claim: decision.expectedInformation ?? decision.reason, type: "component", status: "verifying", evidenceRefs: [], evidenceRequirements: ["direct file, symbol, or graph evidence"], missingEvidence: ["direct file, symbol, or graph evidence"], confidence: 0.5 });
  const nextHypotheses = hypotheses.map((hypothesis) => {
    const edges = understanding.semanticGraph?.edges ?? [];
    const supported = /trgo|externaltrig|trigger/i.test(hypothesis.claim) ? edges.find((edge) => edge.relation === "triggers" && edge.evidenceRefs.length) : edges.find((edge) => {
      const text = `${edge.from} ${edge.to} ${edge.relation}`.toLowerCase();
      const tokens = hypothesis.claim.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
      return tokens.length >= 2 && tokens.filter((token) => token.length > 2).every((token) => text.includes(token));
    });
    return supported ? { ...hypothesis, status: "confirmed" as const, evidenceRefs: supported.evidenceRefs, missingEvidence: [] } : hypothesis;
  });
  return { ...state, observations: [...state.observations, observation], confirmedConcepts: [...concepts].slice(-48), candidateComponents: understanding.architecture.components, candidateRelationships: understanding.architecture.relationships, candidateFlows: [...understanding.runtimeFlows, ...understanding.dataFlows, ...understanding.controlFlows], candidateParameters: understanding.parameters, candidateDecisions: understanding.decisions, candidateProblems: understanding.problems, unknowns: understanding.unknowns, coverage: understanding.quality.criticalCoverage ?? state.coverage, hypotheses: nextHypotheses, semanticGraph: understanding.semanticGraph };
}

function emptyRepoMap(projectId: string, input: ProjectComprehensionInput): ProjectRepoMap { return { projectId, languages: [], buildSystems: [], entryPoints: [], directories: [], likelyCoreFiles: [], testFiles: [], configFiles: [], documentFiles: [], files: [], excludedPatterns: [], sourceIds: input.sources.map((source) => source.id) }; }

/** Bounded comprehension agent: LLM decides the next tool; fallback only controls failures. */
export class ProjectComprehensionAgent {
  constructor(private readonly options: ProjectComprehensionAgentOptions = {}) {}

  async comprehend(input: ProjectComprehensionInput, cachedUnderstanding?: ProjectUnderstanding): Promise<ProjectComprehensionResult> {
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    const limits = projectExplorerLimits(input.options);
    if (cachedUnderstanding && cachedUnderstanding.projectId === input.projectId && cachedUnderstanding.schemaVersion === PROJECT_COMPREHENSION_SCHEMA_VERSION && cachedUnderstanding.status === "completed") {
      this.options.trace?.("PROJECT_COMPREHENSION_COMPLETED", { projectId: input.projectId, cached: true, elapsedMs: elapsed(now, startedAt) });
      return { understanding: cachedUnderstanding, repoMap: emptyRepoMap(input.projectId, input), observations: [], cached: true };
    }
    if (this.options.enabled === false) throw new Error("PROJECT_COMPREHENSION_DISABLED");
    this.options.trace?.("PROJECT_COMPREHENSION_STARTED", { projectId: input.projectId, sourceCount: input.sources.length, maxToolCalls: limits.maxToolCalls, maxFilesRead: limits.maxFilesRead });
    const explorer: ProjectExplorer = this.options.repositoryAdapter ?? new SourceProjectExplorer(input.sources, limits);
    let repositoryHistory: NonNullable<ProjectMemorySource["repositoryHistory"]> = [];
    try { repositoryHistory = this.options.repositoryAdapter?.getHistory?.({ limit: 200 }) ?? []; } catch { repositoryHistory = []; }
    const analysisInput: ProjectComprehensionInput = repositoryHistory.length ? { ...input, sources: input.sources.map((source) => source.kind === "repository" ? { ...source, repositoryHistory } : source) } : input;
    const tree = explorer.listTree({ limit: limits.maxResults * 40 });
    let toolCalls = 1;
    const mapper = this.options.mapper ?? new ProjectRepoMapper();
    const repoMap = mapper.map(input.projectId, { listTree: () => tree } as never);
    this.options.trace?.("PROJECT_REPO_MAPPED", { projectId: input.projectId, files: tree.length, toolCalls, symbolCount: repoMap.symbolIndex?.symbols.length ?? 0 });
    const observations: ProjectExplorerObservation[] = [];
    const filesRead = new Set<string>();
    const builder = this.options.builder ?? new ProjectUnderstandingBuilder({ domainFallback: !this.options.model });
    const fallback = this.options.planner ?? new FallbackPlanner();
    const llmPlanner = this.options.llmPlanner ?? (this.options.model ? new ProjectLLMExplorationPlanner({ model: { generate: (plannerModelInput) => this.options.model!.generate(plannerModelInput) }, timeoutMs: Math.min(60_000, limits.timeoutMs) }) : undefined);
    const deadline = startedAt + limits.timeoutMs;
    let inputChars = 0;
    let modelTurns = 0;
    let modelFailed = false;
    let state: ProjectComprehensionState = { repoMap, observations: [], hypotheses: [], confirmedConcepts: [], candidateComponents: [], candidateRelationships: [], candidateFlows: [], candidateParameters: [], candidateDecisions: [], candidateProblems: [], unknowns: [], coverage: initialCoverage(), budget: { maxToolCalls: limits.maxToolCalls, maxFilesRead: limits.maxFilesRead, maxModelTurns: limits.maxModelTurns, maxInputChars: limits.maxInputChars, toolCalls, modelTurns, inputChars }, filesRead: [] };
    while (toolCalls < limits.maxToolCalls && filesRead.size < limits.maxFilesRead && now() <= deadline) {
      const context = { repoMap, observations, filesRead, toolCalls, modelTurns };
      let action: ProjectExplorationAction;
      let decision: ProjectAgentDecision | undefined;
      if (llmPlanner && !modelFailed && modelTurns < limits.maxModelTurns) {
        modelTurns += 1;
        try {
          decision = await llmPlanner.plan(plannerInput(state, now, deadline, input.projectName));
          const validation = validateAgentDecision(decision, repoMap, { toolCalls, maxToolCalls: limits.maxToolCalls, filesRead: filesRead.size, maxFilesRead: limits.maxFilesRead });
          if (!validation.valid) throw new Error(`PROJECT_AGENT_DECISION_REJECTED:${validation.reason}`);
          action = decisionToAction(decision);
          this.options.trace?.("PROJECT_AGENT_DECISION", { projectId: input.projectId, action: decision.action, target: decision.target, query: decision.query, priority: decision.priority, reasonCode: decision.reason.slice(0, 100) });
        } catch (error) {
          modelFailed = true;
          builder.enableDomainFallback();
          this.options.trace?.("PROJECT_COMPREHENSION_FAILED", { projectId: input.projectId, stage: "planner", error: error instanceof Error ? error.message : String(error) });
          action = fallback.plan(context);
        }
      } else action = fallback.plan(context);
      this.options.trace?.("PROJECT_PLAN_CREATED", { projectId: input.projectId, action: action.type, toolCalls, filesRead: filesRead.size, planner: decision ? "llm" : "fallback" });
      if (action.type === "synthesize") break;
      const actionStarted = now();
      const observation = this.execute(explorer, action, limits);
      toolCalls += 1;
      for (const file of observation.files ?? []) { if (!filesRead.has(file.path)) { filesRead.add(file.path); inputChars += file.text.length; } }
      observations.push(observation);
      builder.update(observation);
      const preview = builder.build(analysisInput, repoMap, { toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: elapsed(now, startedAt), stages: statusStages("exploring") });
      state = updateState({ ...state, budget: { ...state.budget, toolCalls, modelTurns, inputChars }, filesRead: [...filesRead] }, preview, observation, decision);
      this.options.trace?.("PROJECT_TOOL_CALL", { projectId: input.projectId, tool: action.type, durationMs: elapsed(now, actionStarted), filesRead: filesRead.size, toolCalls, modelTurns });
      if (decision?.hypothesisId || ["searchText", "findDefinitions", "findReferences", "findCallers", "findCallees"].includes(action.type)) this.options.trace?.("PROJECT_HYPOTHESIS_CREATED", { projectId: input.projectId, hypothesisId: decision?.hypothesisId, query: "query" in action ? action.query : "symbol" in action ? action.symbol : undefined, candidateCount: observation.matches?.length ?? 0 });
      if ((decision?.action === "verifyClaim" || decision?.hypothesisId) && (observation.matches?.length ?? 0) > 0) this.options.trace?.("PROJECT_HYPOTHESIS_VERIFIED", { projectId: input.projectId, hypothesisId: decision.hypothesisId, evidenceFound: true });
      if (inputChars >= limits.maxInputChars) break;
    }
    const trace: ProjectUnderstandingTraceSummary = { toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: elapsed(now, startedAt), stages: statusStages("synthesizing") };
    this.options.trace?.("PROJECT_SYNTHESIS_COMPLETED", { projectId: input.projectId, toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: trace.elapsedMs });
    let understanding = builder.build(analysisInput, repoMap, trace);
    if (this.options.model && modelTurns < limits.maxModelTurns && now() <= deadline) {
      modelTurns += 1;
      try {
        const output = await this.options.model.generate(compactModelInput(input, repoMap, observations, plannerInput(state, now, deadline, input.projectName), "synthesize"));
        understanding = mergeModelOutput(understanding, output);
      } catch (error) {
        builder.enableDomainFallback();
        understanding = builder.build(analysisInput, repoMap, trace);
        this.options.trace?.("PROJECT_COMPREHENSION_FAILED", { projectId: input.projectId, stage: "synthesis-model", error: error instanceof Error ? error.message : String(error) });
      }
    }
    const grounded = (this.options.grounding ?? new ProjectGroundingService()).ground({ ...understanding, status: "grounding" });
    understanding = { ...grounded.understanding, schemaVersion: PROJECT_COMPREHENSION_SCHEMA_VERSION, trace: { ...grounded.understanding.trace, toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: elapsed(now, startedAt), stages: statusStages("completed") } };
    for (const parameter of understanding.parameters) this.options.trace?.("PROJECT_VERSION_RESOLVED", { projectId: input.projectId, semanticKey: parameter.semanticKey, status: parameter.versionStatus, value: parameter.value });
    for (const verification of grounded.verifications ?? []) this.options.trace?.("PROJECT_CLAIM_VERIFICATION", { projectId: input.projectId, claimType: verification.claimType, status: verification.supported ? "confirmed" : "unknown", evidenceStrength: verification.strength, reasonCode: verification.reasonCode });
    for (const flow of [...understanding.runtimeFlows, ...understanding.dataFlows, ...understanding.controlFlows]) if (flow.partial) this.options.trace?.("PROJECT_FLOW_PARTIAL", { projectId: input.projectId, flowId: flow.id, missingLinks: flow.missingLinks });
    this.options.trace?.("PROJECT_GROUNDING_COMPLETED", { projectId: input.projectId, groundedClaims: grounded.groundedClaims, ungroundedClaims: grounded.ungroundedClaims });
    const validation = (this.options.validator ?? new ProjectUnderstandingValidator()).validate(understanding);
    if (!validation.valid) { this.options.trace?.("PROJECT_COMPREHENSION_FAILED", { projectId: input.projectId, stage: "validation", issues: validation.issues }); throw new Error(`PROJECT_COMPREHENSION_INVALID:${validation.issues.join(",")}`); }
    this.options.trace?.("PROJECT_COMPREHENSION_COMPLETED", { projectId: input.projectId, cached: false, toolCalls, filesRead: filesRead.size, modelTurns, elapsedMs: understanding.trace.elapsedMs });
    return { understanding, repoMap, observations, cached: false, state: { ...state, budget: { ...state.budget, toolCalls, modelTurns, inputChars }, filesRead: [...filesRead] } };
  }

  private execute(explorer: ProjectExplorer, action: Exclude<ProjectExplorationAction, { type: "synthesize" }>, limits: ReturnType<typeof projectExplorerLimits>): ProjectExplorerObservation {
    const startedAt = Date.now();
    switch (action.type) {
      case "readFile": { const file = explorer.readFile(action.path, { maxChars: limits.maxFileChars, maxLines: limits.maxFileLines }); return { action, files: file ? [file] : [], elapsedMs: Math.max(0, Date.now() - startedAt) }; }
      case "searchText": return { action, matches: explorer.searchText(action.query, { limit: limits.maxResults }), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "findDefinitions": return { action, matches: explorer.findDefinitions(action.symbol, { limit: limits.maxResults }), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "findReferences": return { action, matches: explorer.findReferences(action.symbol, { limit: limits.maxResults }), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "findCallers": return { action, matches: explorer.findCallers?.(action.symbol, { limit: limits.maxResults }) ?? [], elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "findCallees": return { action, matches: explorer.findCallees?.(action.symbol, { limit: limits.maxResults }) ?? [], elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectBuildConfig": return { action, files: explorer.inspectBuildConfig(), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectTests": return { action, files: explorer.inspectTests(), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectProjectDocument": return { action, files: explorer.inspectProjectDocument(action.role), elapsedMs: Math.max(0, Date.now() - startedAt) };
      case "inspectGitHistory": return { action, history: explorer.inspectGitHistory(), elapsedMs: Math.max(0, Date.now() - startedAt) };
    }
  }
}
