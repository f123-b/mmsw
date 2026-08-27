import type { ProjectMemorySource } from "../knowledge/types";
import type { ProjectExplorer, ProjectExplorerLimits, ProjectFileReadResult, ProjectRepoEntryKind, ProjectRepoFile, ProjectSearchMatch, ProjectSymbolIndex, ProjectTreeEntry, ProjectGitHistoryEntry, ProjectRepositoryAdapter } from "./types";
import { ProjectSemanticGraphBuilder, type ProjectSemanticFile } from "./semantic-graph";

export const DEFAULT_PROJECT_EXCLUDED_PATTERNS = ["node_modules", "vendor", "build", "dist", "target", ".git", "generated", "third_party", "__pycache__", ".venv"];
export const DEFAULT_PROJECT_ALLOWED_TEXT_EXTENSIONS = ["c", "h", "cc", "cpp", "cxx", "hpp", "py", "rs", "ts", "tsx", "js", "jsx", "java", "go", "lua", "json", "yaml", "yml", "toml", "md", "markdown", "txt", "cmake", "sh", "bat", "ps1", "ini", "cfg", "conf"];

const DEFAULT_LIMITS: ProjectExplorerLimits = {
  maxToolCalls: 50,
  maxFilesRead: 35,
  maxInputChars: 120_000,
  timeoutMs: 60_000,
  maxModelTurns: 12,
  maxResults: 12,
  maxFileChars: 24_000,
  maxFileLines: 500
};

const languageByExtension: Record<string, string> = {
  c: "C", h: "C", cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", py: "Python", rs: "Rust", ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", java: "Java", go: "Go", lua: "Lua", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", md: "Markdown", markdown: "Markdown", cmake: "CMake", sh: "Shell", bat: "Batch", ps1: "PowerShell" 
};

function extension(path: string): string {
  return path.toLowerCase().split(".").pop() ?? "";
}

function languageForPath(path: string): string {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "makefile") return "Make";
  if (name === "cmakelists.txt") return "CMake";
  if (name === "dockerfile") return "Dockerfile";
  return languageByExtension[extension(path)] ?? "text";
}

function isExcluded(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return segments.some((segment) => DEFAULT_PROJECT_EXCLUDED_PATTERNS.includes(segment.toLowerCase()));
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) throw new Error("PROJECT_EXPLORER_PATH_OUTSIDE_ROOT");
  return normalized;
}

function isAllowedTextPath(path: string): boolean {
  const base = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (["readme", "makefile", "dockerfile", "cmakelists.txt", "kconfig"].includes(base)) return true;
  const ext = extension(base);
  return DEFAULT_PROJECT_ALLOWED_TEXT_EXTENSIONS.includes(ext);
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function classifyPath(path: string): ProjectRepoEntryKind {
  const normalized = path.toLowerCase();
  if (isExcluded(normalized)) return "generated";
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(normalized)) return "test";
  if (/(^|\/)(readme|docs?|documentation)(\/|$)|\.(md|markdown)$/.test(normalized)) return "document";
  if (/(^|\/)(cmakelists\.txt|makefile|meson\.build|cargo\.toml|package\.json|package-lock\.json|pyproject\.toml|requirements\.txt|config|configs?)(\/|$)|\.(json|ya?ml|toml|ini|cfg|conf|cmake)$/.test(normalized)) return "config";
  if (Object.prototype.hasOwnProperty.call(languageByExtension, extension(normalized)) || /(^|\/)(src|include|lib|app|core)(\/|$)/.test(normalized)) return "source";
  return "other";
}

interface VirtualFile extends ProjectRepoFile {
  text: string;
}

function parseArchiveSource(source: ProjectMemorySource): VirtualFile[] {
  if (source.repositoryFiles?.length) {
    return source.repositoryFiles.flatMap((entry) => {
      try {
        const path = normalizePath(entry.path);
        if (isExcluded(path) || !isAllowedTextPath(path) || entry.text.length > 2_000_000) return [];
        return [{ path, sourceId: source.id, kind: classifyPath(path), language: languageForPath(path), size: entry.size ?? entry.text.length, text: entry.text }];
      } catch { return []; }
    });
  }
  let archiveText = source.text;
  const encoded = source.text.match(/PROJECT_REPO_ARCHIVE_BASE64:([A-Za-z0-9+/=]+)/)?.[1];
  if (encoded && encoded.length <= 40_000_000) {
    try {
      const binary = globalThis.atob(encoded);
      archiveText = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    } catch { archiveText = source.text; }
  }
  if (archiveText.length > 12_000_000) archiveText = archiveText.slice(0, 12_000_000);
  const matches = [...archiveText.matchAll(/(?:^|\n)文件：([^\n]+)\n([\s\S]*?)(?=\n\n---\n\n文件：|$)/g)];
  if (!matches.length) {
    const path = normalizePath(source.filePath ?? source.title);
    if (!isAllowedTextPath(path)) return [];
    return [{ path, sourceId: source.id, kind: classifyPath(path), language: source.language ?? languageForPath(path), size: source.text.length, text: source.text }];
  }
  return matches.flatMap((match) => {
    try {
      const path = normalizePath(match[1] ?? "");
      const text = match[2] ?? "";
      if (isExcluded(path) || !isAllowedTextPath(path) || text.length > 2_000_000) return [];
      return [{ path, sourceId: source.id, kind: classifyPath(path), language: languageForPath(path), size: text.length, text }];
    } catch { return []; }
  });
}

function sourceFiles(sources: ProjectMemorySource[]): VirtualFile[] {
  const files = sources.flatMap(parseArchiveSource).filter((file) => !isExcluded(file.path));
  return files.filter((file, index, all) => all.findIndex((candidate) => candidate.path === file.path && candidate.sourceId === file.sourceId) === index);
}

function snippet(text: string, lineNumber: number, radius = 1): string {
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.slice(Math.max(0, lineNumber - 1 - radius), lineNumber + radius).join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function matchesFor(files: VirtualFile[], query: string, limit: number): ProjectSearchMatch[] {
  const safeQuery = query.trim();
  if (!safeQuery) return [];
  let pattern: RegExp;
  try { pattern = new RegExp(safeQuery, "i"); } catch { pattern = new RegExp(safeQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  const result: ProjectSearchMatch[] = [];
  for (const file of files) {
    const lines = file.text.replace(/\r/g, "").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!pattern.test(lines[index] ?? "")) continue;
      result.push({ path: file.path, sourceId: file.sourceId, line: index + 1, snippet: snippet(file.text, index + 1), kind: file.kind });
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function lineNumber(text: string, index: number): number { return text.slice(0, index).split(/\r?\n/).length; }

/** Lightweight, language-agnostic symbol/call index used before AST/LSP integration. */
export function buildProjectSymbolIndex(files: Array<ProjectRepoFile & { text?: string }>): ProjectSymbolIndex {
  const semanticFiles: ProjectSemanticFile[] = files.filter((file) => Boolean(file.text)).map((file) => ({ path: file.path, sourceId: file.sourceId, kind: file.kind, language: file.language, text: file.text ?? "" }));
  const graph = new ProjectSemanticGraphBuilder().build(semanticFiles);
  const definitions: ProjectSymbolIndex["definitions"] = {};
  const references: ProjectSymbolIndex["references"] = {};
  const calls: ProjectSymbolIndex["calls"] = {};
  const calledBy: ProjectSymbolIndex["calledBy"] = {};
  const readVariables: ProjectSymbolIndex["readVariables"] = {};
  const writeVariables: ProjectSymbolIndex["writeVariables"] = {};
  const imports: ProjectSymbolIndex["imports"] = {};
  const includes: ProjectSymbolIndex["includes"] = {};
  const callbacks: ProjectSymbolIndex["callbacks"] = {};
  const registrations: ProjectSymbolIndex["registrations"] = {};
  for (const symbol of graph.symbols) {
    definitions[symbol.name] = [...(definitions[symbol.name] ?? []), { path: symbol.path, line: symbol.line, kind: symbol.kind }];
    references[symbol.name] = [...(references[symbol.name] ?? []), ...(symbol.references ?? [])];
    if (symbol.calls?.length) calls[symbol.name] = [...new Set([...(calls[symbol.name] ?? []), ...symbol.calls])];
    if (symbol.calledBy?.length) calledBy[symbol.name] = [...new Set([...(calledBy[symbol.name] ?? []), ...symbol.calledBy])];
    if (symbol.readVariables?.length) readVariables[symbol.name] = [...new Set([...(readVariables[symbol.name] ?? []), ...symbol.readVariables])];
    if (symbol.writeVariables?.length) writeVariables[symbol.name] = [...new Set([...(writeVariables[symbol.name] ?? []), ...symbol.writeVariables])];
    if (symbol.imports?.length) imports[symbol.name] = [...new Set([...(imports[symbol.name] ?? []), ...symbol.imports])];
    if (symbol.includes?.length) includes[symbol.name] = [...new Set([...(includes[symbol.name] ?? []), ...symbol.includes])];
    if (symbol.callbacks?.length) callbacks[symbol.name] = [...new Set([...(callbacks[symbol.name] ?? []), ...symbol.callbacks])];
    if (symbol.registrations?.length) registrations[symbol.name] = [...new Set([...(registrations[symbol.name] ?? []), ...symbol.registrations])];
  }
  return { symbols: graph.symbols, definitions, references, calls, calledBy, readVariables, writeVariables, imports, includes, callbacks, registrations };
}

export class SourceProjectExplorer implements ProjectRepositoryAdapter {
  private readonly files: VirtualFile[];
  readonly symbolIndex: ProjectSymbolIndex;
  private readonly history: ProjectGitHistoryEntry[];
  private readonly limits: ProjectExplorerLimits;
  constructor(sources: ProjectMemorySource[], limits: Partial<ProjectExplorerLimits> = {}) {
    this.files = sourceFiles(sources);
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.symbolIndex = buildProjectSymbolIndex(this.files);
    this.history = sources.flatMap((source) => source.repositoryHistory ?? []).map((entry) => ({ ...entry }));
  }

  listTree(options: { prefix?: string; limit?: number } = {}): ProjectTreeEntry[] {
    const prefix = options.prefix ? normalizePath(options.prefix).replace(/\/$/, "") : "";
    const entries = this.files.filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`)).map((file) => ({ ...file, directory: file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "" }));
    return entries.slice(0, Math.min(options.limit ?? 500, 500));
  }

  searchText(query: string, options: { limit?: number } = {}): ProjectSearchMatch[] {
    return matchesFor(this.files, query, Math.min(options.limit ?? this.limits.maxResults, this.limits.maxResults));
  }

  search(query: string, options: { limit?: number } = {}): ProjectSearchMatch[] { return this.searchText(query, options); }

  readFile(path: string, options: { maxChars?: number; maxLines?: number } = {}): ProjectFileReadResult | undefined {
    const normalized = normalizePath(path);
    const file = this.files.find((candidate) => candidate.path === normalized);
    if (!file) return undefined;
    const maxChars = Math.min(options.maxChars ?? this.limits.maxFileChars, this.limits.maxInputChars);
    const maxLines = Math.min(options.maxLines ?? this.limits.maxFileLines, this.limits.maxFileLines);
    const lines = file.text.replace(/\r/g, "").split("\n");
    const limitedText = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
    return { path: file.path, sourceId: file.sourceId, kind: file.kind, language: file.language, text: limitedText, lineCount: lines.length, truncated: limitedText.length < file.text.length };
  }

  findDefinitions(symbol: string, options: { limit?: number } = {}): ProjectSearchMatch[] {
    return matchesFor(this.files, `(?:^|[^A-Za-z0-9_])${escapeRegExp(symbol.trim())}\\s*(?:\\(|=|:)`, options.limit ?? this.limits.maxResults);
  }

  findReferences(symbol: string, options: { limit?: number } = {}): ProjectSearchMatch[] {
    return matchesFor(this.files, `\\b${escapeRegExp(symbol.trim())}\\b`, options.limit ?? this.limits.maxResults);
  }

  findCallers(symbol: string, options: { limit?: number } = {}): ProjectSearchMatch[] {
    const callers = new Set(this.symbolIndex.calledBy[symbol.trim()] ?? []);
    if (!callers.size) return [];
    return this.searchText(`\\b(?:${[...callers].map(escapeRegExp).join("|")})\\b`, options).slice(0, options.limit ?? this.limits.maxResults);
  }

  findCallees(symbol: string, options: { limit?: number } = {}): ProjectSearchMatch[] {
    const callees = this.symbolIndex.calls[symbol.trim()] ?? [];
    if (!callees.length) return [];
    return this.searchText(`\\b(?:${callees.map(escapeRegExp).join("|")})\\b`, options).slice(0, options.limit ?? this.limits.maxResults);
  }

  inspectBuildConfig(): ProjectFileReadResult[] {
    return this.files.filter((file) => file.kind === "config" || /(^|\/)(makefile|cmakelists\.txt|package\.json|cargo\.toml|pyproject\.toml|requirements\.txt)$/i.test(file.path)).slice(0, 8).flatMap((file) => { const value = this.readFile(file.path); return value ? [value] : []; });
  }

  inspectTests(): ProjectFileReadResult[] {
    return this.files.filter((file) => file.kind === "test").slice(0, 8).flatMap((file) => { const value = this.readFile(file.path); return value ? [value] : []; });
  }

  inspectProjectDocument(role?: string): ProjectFileReadResult[] {
    const rolePattern = role ? new RegExp(escapeRegExp(role), "i") : undefined;
    return this.files.filter((file) => file.kind === "document" && (!rolePattern || rolePattern.test(file.path))).slice(0, 8).flatMap((file) => { const value = this.readFile(file.path); return value ? [value] : []; });
  }

  inspectGitHistory(): ProjectGitHistoryEntry[] {
    return this.history.length ? this.history.slice(0, this.limits.maxResults) : [{ subject: "git history unavailable", changedPaths: [] }];
  }

  getHistory(options: { path?: string; limit?: number } = {}): ProjectGitHistoryEntry[] {
    const entries = options.path ? this.history.filter((entry) => entry.path === options.path || entry.changedPaths?.includes(options.path as string)) : this.history;
    return (entries.length ? entries : [{ subject: "git history unavailable", changedPaths: [] }]).slice(0, options.limit ?? this.limits.maxResults);
  }
}

/** V6.2 public name; the in-memory/source-backed adapter remains the default. */
export class SourceRepositoryAdapter extends SourceProjectExplorer {}

export function projectExplorerLimits(input?: Partial<ProjectExplorerLimits>): ProjectExplorerLimits {
  return { ...DEFAULT_LIMITS, ...input };
}
