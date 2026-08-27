import { buildProjectSymbolIndex } from "./repo-explorer";
import type { ProjectExplorer, ProjectRepoFile, ProjectRepoMap } from "./types";

const buildFileNames = /^(cmakelists\.txt|makefile|meson\.build|cargo\.toml|package\.json|package-lock\.json|pyproject\.toml|requirements\.txt|build\.gradle|pom\.xml|dockerfile)$/i;
const entryPattern = /(^|\/)(main|app|application|index|startup|boot|init)\.[^.]+$/i;
const corePattern = /(motor|foc|control|adc|pwm|dma|encoder|feedback|velocity|speed|can|uart|mqtt|modbus|communication|protocol|fault|protect|driver|service|thread|task|databus|lvgl|ota)/i;

function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

function scoreCoreFile(file: ProjectRepoFile): number {
  const path = file.path.toLowerCase();
  let score = file.kind === "source" ? 2 : 0;
  if (entryPattern.test(path)) score += 12;
  if (/(^|\/)src\//.test(path)) score += 3;
  if (/(^|\/)(core|app|include)\//.test(path)) score += 2;
  if (corePattern.test(path)) score += 5;
  return score;
}

export function buildProjectRepoMap(input: { projectId: string; tree: ReturnType<ProjectExplorer["listTree"]> }): ProjectRepoMap {
  const files = input.tree.filter((file) => file.kind !== "generated" && file.kind !== "third-party");
  const sourceIds = unique(files.map((file) => file.sourceId));
  const languages = unique(files.map((file) => file.language).filter((language) => language !== "text" && language !== "unknown" && language !== "Markdown" && language !== "JSON" && language !== "YAML" && language !== "TOML"));
  const buildSystems: string[] = [];
  for (const file of files) {
    const name = file.path.split("/").at(-1) ?? "";
    if (/cmakelists\.txt|\.cmake$/i.test(name)) buildSystems.push("CMake");
    else if (/^makefile$/i.test(name)) buildSystems.push("Make");
    else if (/cargo\.toml$/i.test(name)) buildSystems.push("Cargo");
    else if (/package\.json$/i.test(name)) buildSystems.push("npm");
    else if (/pyproject\.toml|requirements\.txt$/i.test(name)) buildSystems.push("Python");
    else if (/dockerfile$/i.test(name)) buildSystems.push("Docker");
  }
  const directories = unique(files.flatMap((file) => {
    const parts = file.path.split("/");
    return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
  })).sort();
  const entryPoints = files.filter((file) => file.kind === "source" && entryPattern.test(file.path)).map((file) => file.path);
  const likelyCoreFiles = files.filter((file) => file.kind === "source").sort((left, right) => scoreCoreFile(right) - scoreCoreFile(left) || left.path.localeCompare(right.path)).map((file) => file.path).slice(0, 40);
  const testFiles = files.filter((file) => file.kind === "test").map((file) => file.path);
  const configFiles = files.filter((file) => file.kind === "config" || buildFileNames.test(file.path.split("/").at(-1) ?? "")).map((file) => file.path);
  const documentFiles = files.filter((file) => file.kind === "document").map((file) => file.path);
  return { projectId: input.projectId, languages: unique(languages), buildSystems: unique(buildSystems), entryPoints: unique(entryPoints), directories, likelyCoreFiles, testFiles, configFiles: unique(configFiles), documentFiles: unique(documentFiles), files, excludedPatterns: ["node_modules", "vendor", "build", "dist", "target", ".git", "generated", "third_party", "__pycache__", ".venv"], sourceIds, symbolIndex: buildProjectSymbolIndex(input.tree as Array<ProjectRepoFile & { text?: string }>) };
}

export class ProjectRepoMapper {
  map(projectId: string, explorer: ProjectExplorer): ProjectRepoMap {
    return buildProjectRepoMap({ projectId, tree: explorer.listTree() });
  }
}
