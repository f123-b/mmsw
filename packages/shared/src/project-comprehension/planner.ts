import type { ProjectExplorationAction, ProjectExplorerObservation, ProjectRepoMap } from "./types";

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
  return candidates.length > 0 ? candidates.join("|") : "main|control|core|process|run|init";
}

/**
 * Chooses a small next step from the repository map and observations. The
 * planner derives focus from the repository itself; there is no fixed
 * technology inventory controlling the analysis path.
 */
export class ProjectExplorationPlanner {
  plan(context: ProjectExplorationPlannerContext): ProjectExplorationAction {
    if (!hasAction(context, "readFile")) {
      const entry = context.repoMap.entryPoints[0] ?? context.repoMap.likelyCoreFiles[0] ?? context.repoMap.documentFiles[0];
      return entry ? { type: "readFile", path: entry } : { type: "inspectProjectDocument" };
    }
    if (!hasAction(context, "searchText")) return { type: "searchText", query: explorationQuery(context) };
    const searchMatches = context.observations.flatMap((observation) => observation.matches ?? []);
    const matchedFile = searchMatches.map((match) => match.path).find((path) => !context.filesRead.has(path));
    if (matchedFile) return { type: "readFile", path: matchedFile };
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
