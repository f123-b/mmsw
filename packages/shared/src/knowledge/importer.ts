import type { ProjectMemorySource, ProjectMemorySourceKind } from "./types";

export type ImportedCodeLanguage = "c" | "cpp" | "python" | "typescript" | "javascript" | "rust" | "unknown";

export interface ImportedSourceInput {
  id: string;
  filename: string;
  text: string;
  kind?: ProjectMemorySourceKind;
  filePath?: string;
  updatedAt?: number;
}

const LANGUAGE_BY_EXTENSION: Record<string, ImportedCodeLanguage> = {
  c: "c", h: "c", hpp: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp",
  py: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  rs: "rust"
};

export function languageForFilename(filename: string): ImportedCodeLanguage {
  return LANGUAGE_BY_EXTENSION[filename.toLowerCase().split(".").pop() ?? ""] ?? "unknown";
}

export function isCodeFilename(filename: string): boolean {
  return languageForFilename(filename) !== "unknown";
}

export function inferSourceKind(filename: string, text: string): ProjectMemorySourceKind {
  const name = filename.toLowerCase();
  if (/readme/.test(name)) return "readme";
  if (isCodeFilename(filename)) return "repository";
  if (/简历|resume|cv/.test(name) || /教育经历|工作经历|项目经历/.test(text)) return "resume";
  if (/面试|interview|问答/.test(name)) return "interview";
  return "project-document";
}

export function normalizeImportedSource(input: ImportedSourceInput): ProjectMemorySource {
  const text = input.text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  return {
    id: input.id,
    kind: input.kind ?? inferSourceKind(input.filename, text),
    title: input.filename,
    text,
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(languageForFilename(input.filename) !== "unknown" ? { language: languageForFilename(input.filename) } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {})
  };
}

export function summarizeCodeInventory(sources: ProjectMemorySource[]): string {
  return sources.filter((source) => source.kind === "repository" || source.kind === "readme")
    .map((source) => `${source.filePath ?? source.title} (${source.language ?? "text"})\n${source.text.slice(0, 2_000)}`)
    .join("\n---\n");
}
