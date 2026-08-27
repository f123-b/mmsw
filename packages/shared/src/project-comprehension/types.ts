import type { ProjectMemoryAnalysisInput, ProjectMemorySource } from "../knowledge/types";

export const PROJECT_COMPREHENSION_SCHEMA_VERSION = 1;

export type ProjectComprehensionStatus = "scan" | "mapping" | "exploring" | "synthesizing" | "grounding" | "completed" | "failed";
export type ProjectComponentKind = "control" | "sampling" | "feedback" | "communication" | "storage" | "ui" | "protection" | "driver" | "service" | "other";
export type ProjectRelationshipKind = "calls" | "feeds" | "triggers" | "reads" | "writes" | "publishes" | "subscribes" | "controls" | "depends-on" | "provides" | "produces" | "other";
export type ProjectFlowKind = "runtime" | "data" | "control" | "startup" | "fault";
export type ProjectParameterVersionStatus = "current" | "historical" | "contextual" | "unknown";

export interface ProjectEvidenceRef {
  id: string;
  sourceId: string;
  filePath?: string;
  quote: string;
  locator?: string;
  kind: "code" | "document" | "test" | "config" | "inference";
  confidence: number;
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
  category: "architecture" | "flow" | "parameter" | "decision" | "problem" | "result" | "version" | "general";
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
  inspectGitHistory(): Array<{ subject: string; path?: string; date?: string }>;
}

export type ProjectExplorationAction =
  | { type: "readFile"; path: string }
  | { type: "searchText"; query: string }
  | { type: "findDefinitions"; symbol: string }
  | { type: "findReferences"; symbol: string }
  | { type: "inspectBuildConfig" }
  | { type: "inspectTests" }
  | { type: "inspectProjectDocument"; role?: string }
  | { type: "inspectGitHistory" }
  | { type: "synthesize" };

export interface ProjectExplorerObservation {
  action: ProjectExplorationAction;
  files?: ProjectFileReadResult[];
  matches?: ProjectSearchMatch[];
  history?: Array<{ subject: string; path?: string; date?: string }>;
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
}

export interface ProjectComprehensionModel {
  generate(input: ProjectComprehensionModelInput): Promise<string>;
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
