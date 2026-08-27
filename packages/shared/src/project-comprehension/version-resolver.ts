import type { ProjectMemorySource } from "../knowledge/types";
import type { ProjectGitHistoryEntry, ProjectParameterUnderstanding, ProjectParameterVersionStatus } from "./types";

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
  line?: number;
  isCode?: boolean;
}

export interface ProjectVersionResolution {
  current?: ProjectParameterCandidate;
  historical: ProjectParameterCandidate[];
  /** Non-Git alternatives are deliberately not called historical. */
  alternatives?: ProjectParameterCandidate[];
  status: "current" | "historical" | "contextual" | "unknown";
  currentStatus?: ProjectParameterVersionStatus;
  historyAvailable?: boolean;
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

function comparable(candidate: ProjectParameterCandidate): string { return `${candidate.value ?? ""}|${candidate.unit ?? ""}|${candidate.context ?? ""}`.toLowerCase(); }
function display(candidate: ProjectParameterCandidate): string { return `${candidate.value ?? ""}${candidate.unit ?? ""}`.toLowerCase(); }

function historyConfirmsChange(current: ProjectParameterCandidate, alternatives: ProjectParameterCandidate[], history: ProjectGitHistoryEntry[]): boolean {
  if (!history.length || !alternatives.length) return false;
  const currentText = display(current).replace(/\s+/g, "");
  const oldText = alternatives.map((candidate) => display(candidate).replace(/\s+/g, "")).filter(Boolean);
  return history.some((entry) => {
    const subject = entry.subject.toLowerCase().replace(/\s+/g, "");
    const looksLikeChange = /change|changed|update|migrat|switch|from|to|改|修改|调整|变更|切换|升级/.test(subject);
    return looksLikeChange && subject.includes(currentText) && oldText.some((value) => subject.includes(value));
  });
}

/** Resolves semantic versions with Git as the only source of historical certainty. */
export class ProjectVersionResolver {
  resolve(candidates: ProjectParameterCandidate[], history: ProjectGitHistoryEntry[] = []): ProjectVersionResolution {
    if (candidates.length === 0) return { historical: [], status: "unknown", currentStatus: "unknown", historyAvailable: history.length > 0 };
    const ordered = [...candidates].sort((left, right) => priority(right) - priority(left) || right.evidenceRefs.length - left.evidenceRefs.length);
    const current = ordered[0];
    const alternatives = ordered.slice(1).filter((candidate) => comparable(candidate) !== comparable(current));
    const confirmedHistory = historyConfirmsChange(current, alternatives, history);
    return {
      current,
      // Historical is strict: it is populated only when Git explicitly
      // confirms the transition. Without Git, these remain alternatives.
      historical: confirmedHistory ? alternatives : [],
      alternatives: confirmedHistory ? undefined : alternatives.length ? alternatives : undefined,
      // “current” is retained as the stable API value from V6. The richer
      // currentStatus is used by the V6.1 Understanding schema.
      status: "current",
      currentStatus: confirmedHistory ? "confirmed_current" : "preferred_current",
      historyAvailable: history.length > 0,
    };
  }

  resolveAll(candidates: ProjectParameterCandidate[], history: ProjectGitHistoryEntry[] = []): Map<string, ProjectVersionResolution> {
    const groups = new Map<string, ProjectParameterCandidate[]>();
    for (const candidate of candidates) groups.set(candidate.semanticKey, [...(groups.get(candidate.semanticKey) ?? []), candidate]);
    return new Map([...groups.entries()].map(([key, values]) => [key, this.resolve(values, history)]));
  }
}

export function resolveProjectParameterVersions(candidates: ProjectParameterCandidate[], history: ProjectGitHistoryEntry[] = []): Map<string, ProjectVersionResolution> { return new ProjectVersionResolver().resolveAll(candidates, history); }

export function markHistoricalParameters(parameters: ProjectParameterUnderstanding[], candidates: ProjectParameterCandidate[], history: ProjectGitHistoryEntry[] = []): ProjectParameterUnderstanding[] {
  const resolutions = resolveProjectParameterVersions(candidates, history);
  return parameters.map((parameter) => {
    const resolution = resolutions.get(parameter.semanticKey);
    if (!resolution?.current) return parameter;
    return { ...parameter, versionStatus: resolution.currentStatus ?? parameter.versionStatus, historicalValues: resolution.historical.length ? resolution.historical.map((item) => ({ value: item.value, unit: item.unit, sourceIds: item.sourceIds, evidenceRefs: item.evidenceRefs, ...(item.context ? { context: item.context } : {}) })) : parameter.historicalValues, alternativeValues: resolution.alternatives?.length ? resolution.alternatives.map((item) => ({ value: item.value, unit: item.unit, sourceIds: item.sourceIds, evidenceRefs: item.evidenceRefs, ...(item.context ? { context: item.context } : {}) })) : parameter.alternativeValues };
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
