import { isFactUserActionRequired } from "./project-fact-eligibility";
import { semanticLabel } from "./project-semantics";
import type { ProjectConflictGroup, ProjectFact, ProjectUserAction } from "./types";

export function listConflictGroups(facts: ProjectFact[], options: { projectId?: string; includeResolved?: boolean } = {}): ProjectConflictGroup[] {
  const groups = new Map<string, ProjectFact[]>();
  for (const fact of facts) {
    if (options.projectId && fact.projectId !== options.projectId) continue;
    if ((fact.stale && !options.includeResolved) || (fact.status === "rejected" && !options.includeResolved) || !fact.conflictGroupId) continue;
    if (!options.includeResolved && fact.conflictStatus !== "conflicting" && fact.status !== "conflicting") continue;
    const list = groups.get(fact.conflictGroupId) ?? [];
    list.push(fact);
    groups.set(fact.conflictGroupId, list);
  }
  return [...groups.entries()].map(([id, group]) => {
    const unresolved = group.some((fact) => fact.conflictStatus === "conflicting" || fact.status === "conflicting");
    const canonicalKey = group.find((fact) => fact.canonicalKey)?.canonicalKey;
    const createdAt = group.map((fact) => fact.createdAt).filter((value): value is number => Number.isFinite(value));
    const updatedAt = group.map((fact) => fact.updatedAt).filter((value): value is number => Number.isFinite(value));
    return { id, projectId: group[0]?.projectId ?? "", canonicalKey: canonicalKey ?? "", factIds: group.map((fact) => fact.id), facts: group, type: "single-value" as const, label: semanticLabel(canonicalKey, group), status: unresolved ? "unresolved" as const : "resolved" as const, resolved: !unresolved, preferredFactId: group.find((fact) => fact.verified)?.id, ...(createdAt.length ? { createdAt: Math.min(...createdAt) } : {}), ...(updatedAt.length ? { updatedAt: Math.max(...updatedAt) } : {}) };
  });
}

export function listUserActions(facts: ProjectFact[], projectId?: string): ProjectUserAction[] {
  const scoped = facts.filter((fact) => (!projectId || fact.projectId === projectId) && !fact.stale && fact.status !== "rejected");
  const actions: ProjectUserAction[] = [];
  for (const group of listConflictGroups(scoped)) actions.push({ id: `conflict:${group.id}`, projectId: group.projectId, type: "conflict_group", factIds: group.factIds, label: group.label, status: "pending" });
  const actionable = scoped.filter(isFactUserActionRequired).filter((fact) => !fact.conflictGroupId || !(fact.status === "conflicting" || fact.conflictStatus === "conflicting"));
  const responsibility = actionable.filter((fact) => fact.type === "responsibility");
  if (responsibility.length) actions.push({ id: `responsibility:${responsibility[0]?.projectId ?? projectId ?? "project"}`, projectId: responsibility[0]?.projectId ?? projectId ?? "", type: "responsibility_confirmation", factIds: responsibility.map((fact) => fact.id), label: "确认本人职责", status: "pending" });
  const grouped = new Map<string, ProjectFact[]>();
  for (const fact of actionable.filter((item) => item.type === "metric" || item.type === "result")) {
    const key = `${fact.type}:${fact.canonicalKey ?? fact.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), fact]);
  }
  for (const [key, group] of grouped) actions.push({ id: `${key}:${group[0]?.projectId ?? "project"}`, projectId: group[0]?.projectId ?? projectId ?? "", type: group[0]?.type === "metric" ? "metric_confirmation" : "result_confirmation", factIds: group.map((fact) => fact.id), label: group[0]?.type === "metric" ? "确认性能指标" : "确认项目成果", status: "pending" });
  return actions;
}
