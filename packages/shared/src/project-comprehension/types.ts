import type { ProjectMemoryAnalysisInput, ProjectMemorySource } from "../knowledge/types";

export const PROJECT_COMPREHENSION_SCHEMA_VERSION = 3;

export type ProjectComprehensionStatus = "scan" | "mapping" | "exploring" | "synthesizing" | "grounding" | "completed" | "failed";
export type ProjectComponentKind = "control" | "sampling" | "feedback" | "communication" | "storage" | "ui" | "protection" | "driver" | "service" | "other";
export type ProjectRelationshipKind = "calls" | "feeds" | "triggers" | "reads" | "writes" | "publishes" | "subscribes" | "controls" | "configures" | "depends-on" | "depends_on" | "provides" | "produces" | "creates" | "invokes" | "sends" | "receives" | "other";
export type ProjectFlowKind = "runtime" | "data" | "control" | "startup" | "fault";
export type ProjectParameterVersionStatus = "current" | "preferred_current" | "confirmed_current" | "historical" | "alternative" | "contextual" | "unknown";
export type ProjectEvidenceStrength = "direct" | "strong" | "weak" | "unsupported";
export type ProjectComprehensionVerificationStatus = "confirmed" | "candidate" | "unknown";

export interface ProjectEvidenceRef {
  id: string;
  sourceId: string;
  filePath?: string;
  quote: string;
  locator?: string;
  kind: "code" | "document" | "test" | "config" | "inference";
  confidence: number;
  sourceRole?: string;
}

export interface ProjectComponent {
  id: string;
  name: string;
  kind: ProjectComponentKind;
  description: string;
  files?: string[];
  symbols?: string[];
  confidence: number;
  evidenceRefs?: string[];
}

export interface ProjectRelationship {
  from: string;
  to: string;
  relation: ProjectRelationshipKind;
  description?: string;
  evidenceRefs: string[];
  confidence?: number;
  evidenceStrength?: ProjectEvidenceStrength;
  verificationStatus?: ProjectComprehensionVerificationStatus;
  confidenceReason?: string;
  semanticEdgeId?: string;
  source?: "semantic" | "fallback" | "model";
}

export interface ProjectFlowStep {
  component?: string;
  action: string;
  evidenceRefs?: string[];
}

export interface ProjectFlow {
  id: string;
  name: string;
  kind: ProjectFlowKind;
  steps: ProjectFlowStep[];
  description: string;
  evidenceRefs?: string[];
  confidence?: number;
  partial?: boolean;
  missingLinks?: string[];
}

export interface ProjectTechnologyUnderstanding {
  name: string;
  category: string;
  role?: string;
  evidenceRefs: string[];
  confidence: number;
}

export interface ProjectParameterUnderstanding {
  id: string;
  name: string;
  semanticKey: string;
  value?: string | number;
  unit?: string;
  context?: string;
  versionStatus: ProjectParameterVersionStatus;
  sourceIds: string[];
  evidenceRefs: string[];
  historicalValues?: Array<{ value?: string | number; unit?: string; sourceIds: string[]; evidenceRefs: string[]; context?: string }>;
  alternativeValues?: Array<{ value?: string | number; unit?: string; sourceIds: string[]; evidenceRefs: string[]; context?: string }>;
  relatedComponent?: string;
  sourceSymbol?: string;
  sourceKind?: "code" | "config" | "document" | "test" | "inference";
  confidence: number;
}

export interface ProjectDecisionUnderstanding {
  id: string;
  decision: string;
  choice: string;
  rationale?: string;
  tradeoff?: string;
  relatedComponents: string[];
  flowIds: string[];
  evidenceRefs: string[];
  confidence: number;
}

export interface ProjectProblemUnderstanding {
  id: string;
  problem: string;
  symptom: string;
  affectedComponents: string[];
  causeChain: string[];
  fix: string;
  result?: string;
  codeChangeRefs?: string[];
  evidenceRefs: string[];
  confidence: number;
}

export interface ProjectInterfaceUnderstanding {
  id: string;
  name: string;
  kind: string;
  direction?: string;
  components: string[];
  evidenceRefs: string[];
  confidence: number;
}

export interface ProjectProtectionUnderstanding {
  id: string;
  name: string;
  trigger: string;
  action: string;
  components: string[];
  evidenceRefs: string[];
  confidence: number;
}

export interface ProjectTestUnderstanding {
  id: string;
  name: string;
  status: "exists" | "passed" | "failed" | "unknown";
  measuredValues?: string[];
  evidenceRefs: string[];
  confidence: number;
}

export interface ProjectResultUnderstanding {
  id: string;
  name: string;
  value: string;
  measured: boolean;
  evidenceRefs: string[];
  confidence: number;
}

export interface ProjectUnknown {
  id: string;
  claim: string;
  reason: string;
  category: "architecture" | "flow" | "parameter" | "decision" | "problem" | "result" | "version" | "unverifiedRelationship" | "missingFlowLink" | "ambiguousComponent" | "parameterConflict" | "measurementUnknown" | "general";
  evidenceRefs: string[];
}

export interface ProjectUnderstandingQuality {
  architectureCoverage: number;
  flowCoverage: number;
  parameterCoverage: number;
  decisionCoverage: number;
  problemCoverage: number;
  groundingCoverage: number;
  sufficient: boolean;
  unsupportedClaimRate?: number;
  falseRelationshipRate?: number;
  criticalCoverage?: ProjectUnderstandingCoverage;
}

export interface ProjectUnderstandingCoverage {
  purpose: number;
  architecture: number;
  mainFlow: number;
  coreComponents: number;
  parameters: number;
  decisions: number;
  problems: number;
  tests: number;
}

export interface ProjectUnderstandingTraceSummary {
  toolCalls: number;
  filesRead: number;
  modelTurns: number;
  elapsedMs: number;
  stages: ProjectComprehensionStatus[];
}

export interface ProjectUnderstanding {
  projectId: string;
  schemaVersion: number;
  version?: number;
  status: ProjectComprehensionStatus;
  identity: {
    name: string;
    purpose?: string;
    domain?: string;
    application?: string[];
  };
  summary: string;
  architecture: {
    overview?: string;
    components: ProjectComponent[];
    relationships: ProjectRelationship[];
  };
  runtimeFlows: ProjectFlow[];
  dataFlows: ProjectFlow[];
  controlFlows: ProjectFlow[];
  technologies: ProjectTechnologyUnderstanding[];
  parameters: ProjectParameterUnderstanding[];
  decisions: ProjectDecisionUnderstanding[];
  problems: ProjectProblemUnderstanding[];
  interfaces: ProjectInterfaceUnderstanding[];
  protections: ProjectProtectionUnderstanding[];
  tests: ProjectTestUnderstanding[];
  results: ProjectResultUnderstanding[];
  limitations: ProjectUnknown[];
  unknowns: ProjectUnknown[];
  evidenceRefs: ProjectEvidenceRef[];
  semanticGraph?: ProjectSemanticGraph;
  quality: ProjectUnderstandingQuality;
  trace: ProjectUnderstandingTraceSummary;
}

export type ProjectRepoEntryKind = "source" | "test" | "config" | "document" | "generated" | "third-party" | "other";

export interface ProjectRepoFile {
  path: string;
  sourceId: string;
  kind: ProjectRepoEntryKind;
  language: string;
  size: number;
  symbols?: string[];
}

export interface ProjectRepoMap {
  projectId: string;
  languages: string[];
  buildSystems: string[];
  entryPoints: string[];
  directories: string[];
  likelyCoreFiles: string[];
  testFiles: string[];
  configFiles: string[];
  documentFiles: string[];
  files: ProjectRepoFile[];
  excludedPatterns: string[];
  sourceIds: string[];
  symbolIndex?: ProjectSymbolIndex;
}

export interface ProjectSymbol {
  name: string;
  kind: "function" | "class" | "module" | "variable" | "macro" | "topic" | "other";
  path: string;
  line?: number;
  references?: Array<{ path: string; line?: number }>;
  calls?: string[];
  calledBy?: string[];
  readVariables?: string[];
  writeVariables?: string[];
  imports?: string[];
  includes?: string[];
  callbacks?: string[];
  registrations?: string[];
  definedAt?: { path: string; line?: number };
}

export interface ProjectSymbolIndex {
  symbols: ProjectSymbol[];
  definitions: Record<string, Array<{ path: string; line?: number; kind?: string }>>;
  references: Record<string, Array<{ path: string; line?: number }>>;
  calls: Record<string, string[]>;
  calledBy: Record<string, string[]>;
  readVariables: Record<string, string[]>;
  writeVariables: Record<string, string[]>;
  imports: Record<string, string[]>;
  includes: Record<string, string[]>;
  callbacks: Record<string, string[]>;
  registrations: Record<string, string[]>;
}

export type ProjectSemanticNodeKind = "function" | "class" | "module" | "task" | "thread" | "service" | "driver" | "topic" | "queue" | "buffer" | "config" | "device" | "component" | "variable" | "other";
export type ProjectSemanticEdgeRelation = "calls" | "reads" | "writes" | "triggers" | "publishes" | "subscribes" | "sends" | "receives" | "depends_on" | "configures" | "creates" | "feeds" | "controls" | "invokes";
export type ProjectSemanticEdgeSource = "symbol" | "config" | "assignment" | "document" | "test" | "model";

export interface ProjectSemanticNode {
  id: string;
  kind: ProjectSemanticNodeKind;
  name: string;
  filePath?: string;
  symbol?: string;
  evidenceRefs: string[];
}

export interface ProjectDataObject {
  id: string;
  name: string;
  type?: string;
  files: string[];
  writers: string[];
  readers: string[];
  evidenceRefs: string[];
}

export interface ProjectConfigBinding {
  id: string;
  key: string;
  value?: string;
  filePath?: string;
  symbol?: string;
  evidenceRefs: string[];
}

export interface ProjectInterfaceBinding {
  id: string;
  name: string;
  kind: "import" | "include" | "topic" | "queue" | "callback" | "api" | "other";
  producer?: string;
  consumer?: string;
  evidenceRefs: string[];
}

export interface ProjectSemanticEvidence {
  id: string;
  type: "symbol" | "call" | "assignment" | "config" | "registration" | "document" | "test";
  description: string;
  evidenceRefs: string[];
  filePath?: string;
  line?: number;
}

export interface ProjectSemanticEdge {
  id?: string;
  from: string;
  to: string;
  relation: ProjectSemanticEdgeRelation;
  evidenceRefs: string[];
  strength: Exclude<ProjectEvidenceStrength, "unsupported">;
  source: ProjectSemanticEdgeSource;
  dataObjectId?: string;
}

export interface ProjectCallGraph {
  callers: Record<string, string[]>;
  callees: Record<string, string[]>;
  edges: Array<{ caller: string; callee: string; path: string; line?: number; evidenceRefs: string[] }>;
}

export interface ProjectSemanticGraph {
  nodes: ProjectSemanticNode[];
  edges: ProjectSemanticEdge[];
  symbols: ProjectSymbol[];
  dataObjects: ProjectDataObject[];
  configs: ProjectConfigBinding[];
  interfaces: ProjectInterfaceBinding[];
  evidence: ProjectSemanticEvidence[];
  callGraph?: ProjectCallGraph;
}

export interface ProjectExplorerLimits {
  maxToolCalls: number;
  maxFilesRead: number;
  maxInputChars: number;
  timeoutMs: number;
  maxModelTurns: number;
  maxResults: number;
  maxFileChars: number;
  maxFileLines: number;
}

export interface ProjectTreeEntry extends ProjectRepoFile {
  directory: string;
}

export interface ProjectSearchMatch {
  path: string;
  sourceId: string;
  line: number;
  snippet: string;
  kind: ProjectRepoEntryKind;
}

export interface ProjectFileReadResult {
  path: string;
  sourceId: string;
  kind: ProjectRepoEntryKind;
  language: string;
  text: string;
  lineCount: number;
  truncated: boolean;
}

export interface ProjectExplorer {
  listTree(options?: { prefix?: string; limit?: number }): ProjectTreeEntry[];
  searchText(query: string, options?: { limit?: number }): ProjectSearchMatch[];
  readFile(path: string, options?: { maxChars?: number; maxLines?: number }): ProjectFileReadResult | undefined;
  findDefinitions(symbol: string, options?: { limit?: number }): ProjectSearchMatch[];
  findReferences(symbol: string, options?: { limit?: number }): ProjectSearchMatch[];
  inspectBuildConfig(): ProjectFileReadResult[];
  inspectTests(): ProjectFileReadResult[];
  inspectProjectDocument(role?: string): ProjectFileReadResult[];
  inspectGitHistory(): ProjectGitHistoryEntry[];
  findCallers?(symbol: string, options?: { limit?: number }): ProjectSearchMatch[];
  findCallees?(symbol: string, options?: { limit?: number }): ProjectSearchMatch[];
}

export interface ProjectRepositoryAdapter extends ProjectExplorer {
  search(query: string, options?: { limit?: number }): ProjectSearchMatch[];
  getHistory(options?: { path?: string; limit?: number }): ProjectGitHistoryEntry[];
  getCommit?(hash: string): { hash: string; subject: string; date?: string; changedPaths?: string[] } | undefined;
  getDiff?(base: string, head?: string): { path: string; summary: string }[];
}

export interface ProjectGitHistoryEntry {
  hash?: string;
  subject: string;
  path?: string;
  date?: string;
  changedPaths?: string[];
}

export type ProjectExplorationAction =
  | { type: "readFile"; path: string }
  | { type: "searchText"; query: string }
  | { type: "findDefinitions"; symbol: string }
  | { type: "findReferences"; symbol: string }
  | { type: "findCallers"; symbol: string }
  | { type: "findCallees"; symbol: string }
  | { type: "inspectBuildConfig" }
  | { type: "inspectTests" }
  | { type: "inspectProjectDocument"; role?: string }
  | { type: "inspectGitHistory" }
  | { type: "synthesize" };

export interface ProjectExplorerObservation {
  action: ProjectExplorationAction;
  files?: ProjectFileReadResult[];
  matches?: ProjectSearchMatch[];
  history?: ProjectGitHistoryEntry[];
  elapsedMs: number;
}

export interface ProjectComprehensionInput extends ProjectMemoryAnalysisInput {
  projectId: string;
  projectName: string;
  options?: Partial<ProjectExplorerLimits>;
}

export interface ProjectComprehensionModelInput {
  /** Metadata only: model input must not contain the full repository/source text. */
  input: Pick<ProjectComprehensionInput, "projectId" | "projectName" | "options">;
  repoMap: ProjectRepoMap;
  observations: ProjectExplorerObservation[];
  purpose?: "plan" | "synthesize";
  plannerState?: ProjectComprehensionPlannerInput;
  semanticGraph?: ProjectSemanticGraph;
  signal?: AbortSignal;
}

export interface ProjectComprehensionModel {
  generate(input: ProjectComprehensionModelInput): Promise<string>;
}

export type ProjectAgentAction = "readFile" | "searchText" | "findDefinitions" | "findReferences" | "findCallers" | "findCallees" | "inspectBuildConfig" | "inspectTests" | "inspectProjectDocument" | "inspectGitHistory" | "verifyClaim" | "synthesize";

export interface ProjectAgentDecision {
  action: ProjectAgentAction;
  reason: string;
  target?: string;
  query?: string;
  hypothesisId?: string;
  expectedInformation?: string;
  priority: "critical" | "high" | "normal" | "low";
}

export interface ProjectHypothesis {
  id: string;
  claim: string;
  type: "component" | "relationship" | "flow" | "parameter" | "decision" | "problem" | "version";
  status: "candidate" | "verifying" | "confirmed" | "rejected" | "unknown";
  evidenceRefs: string[];
  missingEvidence?: string[];
  evidenceRequirements?: string[];
  confidence: number;
}

export interface ProjectComprehensionBudget {
  maxToolCalls: number;
  maxFilesRead: number;
  maxModelTurns: number;
  maxInputChars: number;
  toolCalls: number;
  modelTurns: number;
  inputChars: number;
}

export interface ProjectComprehensionState {
  repoMap: ProjectRepoMap;
  observations: ProjectExplorerObservation[];
  hypotheses: ProjectHypothesis[];
  confirmedConcepts: string[];
  candidateComponents: ProjectComponent[];
  candidateRelationships: ProjectRelationship[];
  candidateFlows: ProjectFlow[];
  candidateParameters: ProjectParameterUnderstanding[];
  candidateDecisions: ProjectDecisionUnderstanding[];
  candidateProblems: ProjectProblemUnderstanding[];
  unknowns: ProjectUnknown[];
  coverage: ProjectUnderstandingCoverage;
  budget: ProjectComprehensionBudget;
  filesRead: string[];
  semanticGraph?: ProjectSemanticGraph;
}

export type ProjectComprehensionPlannerInput = Pick<ProjectComprehensionState, "repoMap" | "observations" | "hypotheses" | "confirmedConcepts" | "unknowns" | "coverage" | "budget" | "filesRead" | "semanticGraph"> & {
  projectName?: string;
  signal?: AbortSignal;
  currentUnderstandingSummary?: string;
  toolBudgetRemaining: number;
  timeBudgetRemaining: number;
};

export interface ProjectComprehensionPlannerModel {
  generate(input: ProjectComprehensionModelInput): Promise<string>;
}

export interface ProjectVersionHistory {
  available: boolean;
  entries: ProjectGitHistoryEntry[];
  reason?: string;
}

export interface ProjectUnderstandingSnapshotRecord {
  id: string;
  projectId: string;
  version: number;
  inputHash: string;
  model?: string;
  status: ProjectComprehensionStatus;
  understanding: ProjectUnderstanding;
  createdAt: number;
  updatedAt: number;
}
