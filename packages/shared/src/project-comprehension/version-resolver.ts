import type { ProjectMemorySource } from "../knowledge/types";
import type { ProjectParameterUnderstanding, ProjectParameterVersionStatus } from "./types";

export interface ProjectParameterCandidate {
  semanticKey: string;
  name: string;
  value?: string | number;
  unit?: string;
  context?: string;
  sourceIds: string[];
  evidenceRefs: string[];
  sourceRole?: string;
  filePath?: string;
  isCode?: boolean;
}

export interface ProjectVersionResolution {
  current?: ProjectParameterCandidate;
  historical: ProjectParameterCandidate[];
  status: ProjectParameterVersionStatus;
}

function priority(candidate: ProjectParameterCandidate): number {
  const role = candidate.sourceRole ?? "other";
  if (candidate.isCode || role === "code") return 5;
  if (role === "test") return 4;
  if (role === "debug") return 3;
  if (role === "architecture") return 2.5;
  if (role === "overview") return 1;
  return 2;
}

function comparable(candidate: ProjectParameterCandidate): string {
  return `${candidate.value ?? ""}|${candidate.unit ?? ""}|${candidate.context ?? ""}`.toLowerCase();
}

/** Resolves semantic versions before candidates become canonical Facts. */
export class ProjectVersionResolver {
  resolve(candidates: ProjectParameterCandidate[]): ProjectVersionResolution {
    if (candidates.length === 0) return { historical: [], status: "unknown" };
    const ordered = [...candidates].sort((left, right) => priority(right) - priority(left) || right.evidenceRefs.length - left.evidenceRefs.length);
    const current = ordered[0];
    const historical = ordered.slice(1).filter((candidate) => comparable(candidate) !== comparable(current));
    return { current, historical, status: historical.length > 0 ? "current" : "current" };
  }

  resolveAll(candidates: ProjectParameterCandidate[]): Map<string, ProjectVersionResolution> {
    const groups = new Map<string, ProjectParameterCandidate[]>();
    for (const candidate of candidates) groups.set(candidate.semanticKey, [...(groups.get(candidate.semanticKey) ?? []), candidate]);
    return new Map([...groups.entries()].map(([key, values]) => [key, this.resolve(values)]));
  }
}

export function resolveProjectParameterVersions(candidates: ProjectParameterCandidate[]): Map<string, ProjectVersionResolution> {
  return new ProjectVersionResolver().resolveAll(candidates);
}

export function markHistoricalParameters(parameters: ProjectParameterUnderstanding[], candidates: ProjectParameterCandidate[]): ProjectParameterUnderstanding[] {
  const resolutions = resolveProjectParameterVersions(candidates);
  return parameters.map((parameter) => {
    const resolution = resolutions.get(parameter.semanticKey);
    if (!resolution?.current || resolution.current.value === parameter.value) return { ...parameter, versionStatus: resolution?.status ?? parameter.versionStatus, historicalValues: resolution?.historical.map((item) => ({ value: item.value, unit: item.unit, sourceIds: item.sourceIds, evidenceRefs: item.evidenceRefs, ...(item.context ? { context: item.context } : {}) })) };
    return parameter;
  });
}

export function sourcePriority(source: Pick<ProjectMemorySource, "sourceRole" | "kind" | "filePath" | "title">): number {
  if (source.sourceRole === "code" || source.kind === "repository") return 5;
  if (source.sourceRole === "test") return 4;
  if (source.sourceRole === "debug") return 3;
  if (source.sourceRole === "architecture") return 2.5;
  if (source.sourceRole === "overview" || /readme/i.test(source.filePath ?? source.title)) return 1;
  return 2;
}
