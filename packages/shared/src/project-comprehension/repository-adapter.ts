import type {
  ProjectExplorer,
  ProjectFileReadResult,
  ProjectGitHistoryEntry,
  ProjectRepositoryAdapter,
  ProjectSearchMatch,
  ProjectTreeEntry,
  ProjectVersionHistory,
} from "./types";

export interface ProjectGitCommandResult {
  status: number;
  stdout: string;
  stderr?: string;
}

/** The host owns process creation; this keeps the shared package renderer-safe. */
export interface ProjectGitCommandRunner {
  run(root: string, args: string[]): ProjectGitCommandResult;
}

function safeRef(value: string): string {
  if (!/^[A-Za-z0-9._\-/]+$/.test(value) || value.includes("..")) throw new Error("PROJECT_REPOSITORY_UNSAFE_REF");
  return value;
}

function safePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").some((part) => part === "..") || normalized.startsWith("/")) throw new Error("PROJECT_REPOSITORY_PATH_OUTSIDE_ROOT");
  return normalized;
}

function parseHistory(stdout: string): ProjectGitHistoryEntry[] {
  const entries: ProjectGitHistoryEntry[] = [];
  let current: ProjectGitHistoryEntry | undefined;
  for (const rawLine of stdout.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trimEnd();
    const header = line.match(/^([0-9a-f]{7,40})\t([^\t]*)\t(.*)$/i);
    if (header) {
      if (current) entries.push(current);
      current = { hash: header[1], date: header[2] || undefined, subject: header[3] ?? "", changedPaths: [] };
    } else if (current && line.trim()) current.changedPaths = [...(current.changedPaths ?? []), safePath(line.trim())];
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Repository adapter for a trusted local checkout. Git commands are passed as
 * argv to the host runner, so refs and paths are validated before execution.
 */
export class LocalGitRepositoryAdapter implements ProjectRepositoryAdapter {
  constructor(private readonly delegate: ProjectExplorer, private readonly root: string, private readonly runner: ProjectGitCommandRunner) {
    if (!root.trim()) throw new Error("PROJECT_REPOSITORY_ROOT_MISSING");
  }

  listTree(options?: { prefix?: string; limit?: number }): ProjectTreeEntry[] { return this.delegate.listTree(options); }
  searchText(query: string, options?: { limit?: number }): ProjectSearchMatch[] { return this.delegate.searchText(query, options); }
  search(query: string, options?: { limit?: number }): ProjectSearchMatch[] { return this.delegate.searchText(query, options); }
  readFile(path: string, options?: { maxChars?: number; maxLines?: number }): ProjectFileReadResult | undefined { return this.delegate.readFile(path, options); }
  findDefinitions(symbol: string, options?: { limit?: number }): ProjectSearchMatch[] { return this.delegate.findDefinitions(symbol, options); }
  findReferences(symbol: string, options?: { limit?: number }): ProjectSearchMatch[] { return this.delegate.findReferences(symbol, options); }
  findCallers(symbol: string, options?: { limit?: number }): ProjectSearchMatch[] { return this.delegate.findCallers?.(symbol, options) ?? []; }
  findCallees(symbol: string, options?: { limit?: number }): ProjectSearchMatch[] { return this.delegate.findCallees?.(symbol, options) ?? []; }
  inspectBuildConfig(): ProjectFileReadResult[] { return this.delegate.inspectBuildConfig(); }
  inspectTests(): ProjectFileReadResult[] { return this.delegate.inspectTests(); }
  inspectProjectDocument(role?: string): ProjectFileReadResult[] { return this.delegate.inspectProjectDocument(role); }

  inspectGitHistory(): ProjectGitHistoryEntry[] { return this.getHistory(); }

  getHistoryStatus(): ProjectVersionHistory {
    const entries = this.getHistory();
    return entries.length ? { available: true, entries } : { available: false, entries: [], reason: "Git history unavailable for trusted repository root" };
  }

  getHistory(options: { path?: string; limit?: number } = {}): ProjectGitHistoryEntry[] {
    const args = ["log", "--date=iso-str", "--pretty=format:%H%x09%ad%x09%s", "--name-only", "-n", String(Math.min(options.limit ?? 50, 200))];
    if (options.path) args.push("--", safePath(options.path));
    const result = this.runner.run(this.root, args);
    if (result.status !== 0) return [];
    return parseHistory(result.stdout).slice(0, options.limit ?? 50);
  }

  getCommit(hash: string): { hash: string; subject: string; date?: string; changedPaths?: string[] } | undefined {
    const result = this.runner.run(this.root, ["show", "-s", "--format=%H%x09%ad%x09%s", "--date=iso-str", safeRef(hash)]);
    if (result.status !== 0) return undefined;
    const parsed = parseHistory(result.stdout)[0];
    return parsed?.hash ? { hash: parsed.hash, subject: parsed.subject, ...(parsed.date ? { date: parsed.date } : {}), ...(parsed.changedPaths?.length ? { changedPaths: parsed.changedPaths } : {}) } : undefined;
  }

  getDiff(base: string, head?: string): { path: string; summary: string }[] {
    const refs = [safeRef(base), ...(head ? [safeRef(head)] : [])];
    const result = this.runner.run(this.root, ["diff", "--name-status", ...refs]);
    if (result.status !== 0) return [];
    return result.stdout.replace(/\r/g, "").split("\n").flatMap((line) => {
      const match = line.match(/^([A-Z?]+)\t(.+)$/);
      if (!match) return [];
      const path = safePath(match[2] ?? "");
      return [{ path, summary: `${match[1]} ${path}` }];
    });
  }
}
