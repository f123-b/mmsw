import JSZip from "jszip";
import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";

type WorkerFile = { path: string; kind: "source" | "header" | "config" | "test" | "document" | "other"; language: string; size: number; sha256: string; text: string };
type WorkerMessage = { type: "parse"; documentId: string; filename: string; bytes: Uint8Array };

const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024;
const MAX_EXPANDED_SIZE = 120 * 1024 * 1024;
// Keep archive enumeration bounded without rejecting ordinary GitHub source
// snapshots that contain generated metadata and examples.
const MAX_FILE_COUNT = 2_000;
const MAX_SINGLE_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED = /\.(c|h|cc|cpp|cxx|hpp|s|ld|ioc|py|ts|tsx|js|jsx|mjs|rs|md|markdown|cmake|json|toml|yml|yaml|txt|ini|cfg|conf)$/i;
const ALLOWED_BASENAME = /(^|\/)(readme(?:\.[^/]+)?|makefile|cmakelists\.txt|kconfig(?:\.[^/]+)?|dockerfile|meson\.build|requirements\.txt)$/i;
const IGNORED = /(^|\/)(node_modules|vendor|dist|build|target|\.git|__pycache__|\.venv)(\/|$)/i;

function safePath(name: string): string | undefined {
  const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) return undefined;
  return normalized;
}
function rootFor(paths: string[]): string | undefined {
  const roots = paths.map((path) => path.split("/")[0]).filter(Boolean);
  return roots.length > 0 && roots.every((root) => root === roots[0]) && paths.every((path) => path.includes("/")) ? roots[0] : undefined;
}
function stripRoot(path: string, root?: string): string { return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path; }
function language(path: string): string {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "makefile") return "Make";
  if (name === "cmakelists.txt" || name.endsWith(".cmake")) return "CMake";
  if (/\.(c|h)$/.test(name)) return "C";
  if (/\.(cc|cpp|cxx|hpp)$/.test(name)) return "C++";
  if (/\.s$/.test(name)) return "Assembly";
  if (/\.ld$/.test(name)) return "Linker Script";
  if (/\.ioc$/.test(name)) return "STM32CubeMX";
  if (/\.py$/.test(name)) return "Python";
  if (/\.(ts|tsx)$/.test(name)) return "TypeScript";
  if (/\.(js|jsx|mjs)$/.test(name)) return "JavaScript";
  if (/\.json$/.test(name)) return "JSON";
  if (/\.(ya?ml)$/.test(name)) return "YAML";
  if (/\.toml$/.test(name)) return "TOML";
  if (/\.(md|markdown)$/.test(name) || /^readme/.test(name)) return "Markdown";
  return "Text";
}
function kind(path: string): WorkerFile["kind"] {
  const normalized = path.toLowerCase();
  const name = normalized.split("/").at(-1) ?? "";
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(normalized)) return "test";
  if (/\.(h|hpp)$/.test(name)) return "header";
  if (/^(readme(?:\.[^/]+)?|makefile|dockerfile|cmakelists\.txt)$/.test(name) || /\.(md|markdown|txt)$/.test(name)) return "document";
  if (/\.(json|ya?ml|toml|ini|cfg|conf|cmake|ioc|ld)$/.test(name) || /(^|\/)(kconfig|config|configs?)(\/|$)/.test(normalized)) return "config";
  if (/\.(c|cc|cpp|cxx|s|py|ts|tsx|js|jsx|mjs|rs)$/.test(name)) return "source";
  return "other";
}
function post(message: unknown): void { parentPort?.postMessage(message); }

async function parse(message: WorkerMessage): Promise<void> {
  const { bytes, filename, documentId } = message;
  if (bytes.byteLength > MAX_ARCHIVE_SIZE) throw new Error("ZIP_ARCHIVE_TOO_LARGE");
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch (error) { throw new Error(`ZIP_CORRUPTED: ${String(error)}`); }
  const entries = Object.entries(zip.files).flatMap(([originalName, entry]) => { const path = safePath(originalName); return path && !entry.dir ? [{ path, entry }] : []; });
  if (entries.length > MAX_FILE_COUNT) throw new Error("ZIP_FILE_COUNT_EXCEEDED");
  const eligible = entries.filter(({ path }) => (ALLOWED.test(path) || ALLOWED_BASENAME.test(path)) && !IGNORED.test(path)).sort((left, right) => left.path.localeCompare(right.path));
  const rootName = rootFor(eligible.map(({ path }) => path));
  const skippedFiles: Array<{ path: string; reason: string }> = entries.filter(({ path }) => !eligible.some((candidate) => candidate.path === path)).map(({ path }) => ({ path, reason: IGNORED.test(path) ? "ignored-directory" : "unsupported-file-type" }));
  const files: WorkerFile[] = [];
  let expandedBytes = 0;
  for (const item of eligible.slice(300)) skippedFiles.push({ path: stripRoot(item.path, rootName), reason: "file-count-limit" });
  for (let index = 0; index < eligible.length && index < 300; index += 1) {
    const item = eligible[index];
    if (!item) continue;
    const path = stripRoot(item.path, rootName);
    const declaredSize = Number((item.entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    if (declaredSize > MAX_SINGLE_FILE_SIZE) { skippedFiles.push({ path, reason: "single-file-too-large" }); continue; }
    let fileBytes: Uint8Array;
    try { fileBytes = await item.entry.async("uint8array"); } catch (error) { skippedFiles.push({ path, reason: `decode-failed:${String(error)}` }); continue; }
    if (fileBytes.byteLength > MAX_SINGLE_FILE_SIZE) { skippedFiles.push({ path, reason: "single-file-too-large" }); continue; }
    if (expandedBytes + fileBytes.byteLength > MAX_EXPANDED_SIZE) { skippedFiles.push({ path, reason: "expanded-size-limit" }); break; }
    expandedBytes += fileBytes.byteLength;
    const text = new TextDecoder().decode(fileBytes);
    if (text.includes("\u0000")) { skippedFiles.push({ path, reason: "binary-content" }); continue; }
    files.push({ path, kind: kind(path), language: language(path), size: fileBytes.byteLength, sha256: createHash("sha256").update(fileBytes).digest("hex"), text: text.slice(0, 2_000_000) });
    if (index % 8 === 0 || index === eligible.length - 1) post({ type: "progress", progress: { entriesProcessed: index + 1, entriesTotal: eligible.length, filesAccepted: files.length, expandedBytes } });
  }
  post({ type: "progress", progress: { entriesProcessed: Math.min(eligible.length, 300), entriesTotal: eligible.length, filesAccepted: files.length, expandedBytes } });
  if (!files.length) throw new Error("ZIP_NO_SUPPORTED_FILES: 压缩包中没有可分析的源码、README 或项目配置文件");
  const directories = [...new Set(files.flatMap((file) => { const parts = file.path.split("/"); return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/")); }))].sort();
  const manifest = { archiveName: filename, ...(rootName ? { rootName } : {}), archiveSha256: createHash("sha256").update(bytes).digest("hex"), fileCount: entries.length, eligibleFileCount: files.length, skippedFileCount: skippedFiles.length, totalSourceBytes: expandedBytes, languages: [...new Set(files.map((file) => file.language))].sort(), directories, configFiles: files.filter((file) => file.kind === "config").map((file) => file.path), testFiles: files.filter((file) => file.kind === "test").map((file) => file.path), documentFiles: files.filter((file) => file.kind === "document").map((file) => file.path), importedAt: Date.now() };
  const text = [`Repository archive: ${filename}`, rootName ? `Root: ${rootName}` : undefined, `Files: ${files.length}`, `Expanded bytes: ${expandedBytes}`, `Languages: ${manifest.languages.join(", ") || "unknown"}`, `Entry candidates: ${files.slice(0, 12).map((file) => file.path).join(", ")}`, `Skipped: ${skippedFiles.length}`].filter(Boolean).join("\n");
  post({ type: "result", documentId, filename, mimeType: "application/zip", sha256: manifest.archiveSha256, text, sections: files.map((file) => file.path), repositoryFiles: files.map((file) => ({ documentId, ...file })), repositoryManifest: manifest, repositorySkippedFiles: skippedFiles });
}

parentPort?.on("message", (message: WorkerMessage) => { void parse(message).catch((error) => post({ type: "error", error: String(error) })); });
