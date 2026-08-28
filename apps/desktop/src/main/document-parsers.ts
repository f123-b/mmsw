import JSZip from "jszip";
import mammoth from "mammoth";
import { createHash } from "node:crypto";
import { DocumentParserRegistry, plainTextDocumentParser, type DocumentParserResult, type ParsedDocument, type RepositoryManifest, type RepositorySourceFile, type RepositorySourceFileKind } from "@interview-copilot/shared";

function decodeXml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function sectionsFromText(text: string): string[] {
  return text.split(/\n(?=#{1,6}\s)/).map((section) => section.trim()).filter(Boolean).map((section) => (section.split("\n", 1)[0] ?? "").replace(/^#{1,6}\s+/, "").trim());
}

const htmlDocumentParser = {
  async parse(input: { bytes: Uint8Array }): Promise<DocumentParserResult> {
    const html = new TextDecoder().decode(input.bytes).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
    const text = decodeXml(html).replace(/\s{2,}/g, " ").trim();
    return { text, sections: sectionsFromText(text) };
  }
};

const docxDocumentParser = {
  async parse(input: { bytes: Uint8Array }): Promise<DocumentParserResult> {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(input.bytes) });
    const text = result.value.trim();
    return { text, sections: sectionsFromText(text) };
  }
};

const pdfDocumentParser = {
  async parse(input: { bytes: Uint8Array }): Promise<DocumentParserResult> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: input.bytes });
    try {
      const result = await parser.getText();
      return { text: result.text.trim(), sections: result.pages.map((page) => `Page ${page.num}`) };
    } finally {
      await parser.destroy();
    }
  }
};

const repositoryArchiveParser = {
  async parse(input: { bytes: Uint8Array; filename?: string; sha256?: string }): Promise<DocumentParserResult> {
    const maxArchiveSize = 50 * 1024 * 1024;
    const maxExpandedSize = 120 * 1024 * 1024;
    // Keep archive enumeration bounded without rejecting ordinary GitHub
    // source snapshots that contain generated metadata and examples.
    const maxFileCount = 2_000;
    const maxSingleFileSize = 2 * 1024 * 1024;
    if (input.bytes.byteLength > maxArchiveSize) throw new Error("ZIP_ARCHIVE_TOO_LARGE");
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(input.bytes); } catch (error) { throw new Error(`ZIP_CORRUPTED: ${String(error)}`); }
    const allowed = /\.(c|h|cc|cpp|cxx|hpp|s|ld|ioc|py|ts|tsx|js|jsx|mjs|rs|md|markdown|cmake|json|toml|yml|yaml|txt|ini|cfg|conf)$/i;
    const allowedBasename = /(^|\/)(readme(?:\.[^/]+)?|makefile|cmakelists\.txt|kconfig(?:\.[^/]+)?|dockerfile|meson\.build|requirements\.txt)$/i;
    const ignored = /(^|\/)(node_modules|vendor|dist|build|target|\.git|__pycache__|\.venv)(\/|$)/i;
    const safePath = (name: string): string | undefined => {
      const normalized = name.replaceAll("\\", "/").replace(/^\/+/, "");
      if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) return undefined;
      return normalized;
    };
    const entries = Object.entries(zip.files).flatMap(([originalName, entry]) => {
      const name = safePath(originalName);
      return name && !entry.dir ? [{ originalName, name, entry }] : [];
    });
    if (entries.length > maxFileCount) throw new Error("ZIP_FILE_COUNT_EXCEEDED");
    const eligibleEntries = entries.filter(({ name }) => (allowed.test(name) || allowedBasename.test(name)) && !ignored.test(name)).sort((left, right) => left.name.localeCompare(right.name));
    const commonRoot = commonArchiveRoot(eligibleEntries.map(({ name }) => name));
    const skippedFiles: Array<{ path: string; reason: string }> = entries.filter(({ name }) => !eligibleEntries.some((candidate) => candidate.name === name)).map(({ name }) => ({ path: name, reason: ignored.test(name) ? "ignored-directory" : "unsupported-file-type" }));
    const repositoryFiles: RepositorySourceFile[] = [];
    let expandedSize = 0;
    for (const { name: originalPath } of eligibleEntries.slice(300)) {
      skippedFiles.push({ path: stripArchiveRoot(originalPath, commonRoot), reason: "file-count-limit" });
    }
    for (const { name: originalPath, entry } of eligibleEntries.slice(0, 300)) {
      const name = stripArchiveRoot(originalPath, commonRoot);
      const declaredSize = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
      if (declaredSize > maxSingleFileSize) { skippedFiles.push({ path: name, reason: "single-file-too-large" }); continue; }
      let bytes: Uint8Array;
      try { bytes = await entry.async("uint8array"); } catch (error) { skippedFiles.push({ path: name, reason: `decode-failed:${String(error)}` }); continue; }
      if (bytes.byteLength > maxSingleFileSize) { skippedFiles.push({ path: name, reason: "single-file-too-large" }); continue; }
      if (expandedSize + bytes.byteLength > maxExpandedSize) { skippedFiles.push({ path: name, reason: "expanded-size-limit" }); break; }
      expandedSize += bytes.byteLength;
      const text = new TextDecoder().decode(bytes);
      if (text.includes("\u0000")) { skippedFiles.push({ path: name, reason: "binary-content" }); continue; }
      repositoryFiles.push({ path: name, kind: repositoryFileKind(name), language: repositoryLanguage(name), size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), text: text.slice(0, 2_000_000) });
    }
    const text = repositorySummary(input, repositoryFiles, skippedFiles, expandedSize, commonRoot).trim();
    if (!text) throw new Error("ZIP_NO_SUPPORTED_FILES: 压缩包中没有可分析的源码、README 或项目配置文件");
    const manifest: RepositoryManifest = repositoryManifest(input, repositoryFiles, skippedFiles, expandedSize, commonRoot, entries.length);
    return { text, sections: repositoryFiles.map((file) => file.path), repositoryFiles, repositoryManifest: manifest, repositorySkippedFiles: skippedFiles };
  }
};

function repositoryLanguage(path: string): string {
  const basename = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (basename === "makefile") return "Make";
  if (basename === "cmakelists.txt" || basename.endsWith(".cmake")) return "CMake";
  if (basename.endsWith(".c") || basename.endsWith(".h")) return "C";
  if (/\.(cc|cpp|cxx|hpp)$/.test(basename)) return "C++";
  if (/\.(s|ld|ioc)$/.test(basename)) return basename.endsWith(".ld") ? "Linker Script" : "Assembly/Config";
  if (/\.(py)$/.test(basename)) return "Python";
  if (/\.(ts|tsx)$/.test(basename)) return "TypeScript";
  if (/\.(js|jsx|mjs)$/.test(basename)) return "JavaScript";
  if (/\.json$/.test(basename)) return "JSON";
  if (/\.(ya?ml)$/.test(basename)) return "YAML";
  if (/\.toml$/.test(basename)) return "TOML";
  if (/\.md|\.markdown$/.test(basename) || /^readme/.test(basename)) return "Markdown";
  return "Text";
}

function repositoryFileKind(path: string): RepositorySourceFileKind {
  const normalized = path.toLowerCase();
  const basename = normalized.split("/").at(-1) ?? "";
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/.test(normalized)) return "test";
  if (/\.(h|hpp)$/.test(basename)) return "header";
  if (/^(readme(?:\.[^/]+)?|makefile|dockerfile|cmakelists\.txt)$/.test(basename) || /\.(md|markdown|txt)$/.test(basename)) return "document";
  if (/\.(json|ya?ml|toml|ini|cfg|conf|cmake|ioc|ld)$/.test(basename) || /(^|\/)(kconfig|config|configs?)(\/|$)/.test(normalized)) return "config";
  if (/\.(c|cc|cpp|cxx|s|py|ts|tsx|js|jsx|mjs|rs)$/.test(basename)) return "source";
  return "other";
}

function commonArchiveRoot(paths: string[]): string | undefined {
  const roots = paths.map((path) => path.split("/")[0]).filter(Boolean);
  if (!roots.length || !roots.every((root) => root === roots[0]) || paths.some((path) => !path.includes("/"))) return undefined;
  return roots[0];
}

function stripArchiveRoot(path: string, root?: string): string { return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path; }

function repositorySummary(input: { filename?: string }, files: RepositorySourceFile[], skipped: Array<{ path: string; reason: string }>, expandedBytes: number, root?: string): string {
  const languages = [...new Set(files.map((file) => file.language).filter(Boolean))];
  return [`Repository archive: ${input.filename ?? "archive.zip"}`, root ? `Root: ${root}` : undefined, `Files: ${files.length}`, `Expanded bytes: ${expandedBytes}`, `Languages: ${languages.join(", ") || "unknown"}`, `Entry candidates: ${files.slice(0, 12).map((file) => file.path).join(", ") || "none"}`, `Skipped: ${skipped.length}`].filter(Boolean).join("\n");
}

function repositoryManifest(input: { filename?: string; sha256?: string }, files: RepositorySourceFile[], skipped: Array<{ path: string; reason: string }>, expandedBytes: number, root: string | undefined, entriesTotal: number): RepositoryManifest {
  const directories = [...new Set(files.flatMap((file) => { const parts = file.path.split("/"); return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/")); }))].sort();
  return { archiveName: input.filename ?? "archive.zip", ...(root ? { rootName: root } : {}), archiveSha256: input.sha256 ?? "", fileCount: entriesTotal, eligibleFileCount: files.length, skippedFileCount: skipped.length, totalSourceBytes: expandedBytes, languages: [...new Set(files.map((file) => file.language).filter((value): value is string => Boolean(value)))].sort(), directories, configFiles: files.filter((file) => file.kind === "config").map((file) => file.path), testFiles: files.filter((file) => file.kind === "test").map((file) => file.path), documentFiles: files.filter((file) => file.kind === "document").map((file) => file.path), importedAt: Date.now() };
}

async function officeXmlParser(input: { bytes: Uint8Array; kind: "pptx" | "xlsx" }): Promise<{ text: string; sections: string[] }> {
  const zip = await JSZip.loadAsync(input.bytes);
  const names = Object.keys(zip.files).filter((name) => input.kind === "pptx" ? /^ppt\/slides\/slide\d+\.xml$/.test(name) : /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const blocks: string[] = [];
  for (const name of names) {
    const entry = zip.file(name);
    if (!entry) continue;
    blocks.push(decodeXml(await entry.async("text")));
  }
  const text = blocks.join("\n\n").trim();
  return { text, sections: blocks.map((_block, index) => `${input.kind.toUpperCase()} ${index + 1}`) };
}

export function createDocumentParserRegistry(): DocumentParserRegistry {
  return new DocumentParserRegistry()
    .register(["text/plain", "text/markdown"], plainTextDocumentParser)
    .register(["text/html", "application/xhtml+xml"], htmlDocumentParser)
    .register(["application/pdf"], pdfDocumentParser)
    .register(["application/zip", "application/x-zip-compressed"], repositoryArchiveParser)
    .register(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], docxDocumentParser)
    .register(["application/vnd.openxmlformats-officedocument.presentationml.presentation"], { parse: (input) => officeXmlParser({ ...input, kind: "pptx" }) })
    .register(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], { parse: (input) => officeXmlParser({ ...input, kind: "xlsx" }) });
}

export function normalizeDocumentBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input.map((value) => Number(value) & 0xff));
  if (input && typeof input === "object") {
    const record = input as { data?: unknown } & Record<string, unknown>;
    if (record.data !== undefined) return normalizeDocumentBytes(record.data);
    const numericKeys = Object.keys(record).filter((key) => /^\d+$/.test(key)).sort((left, right) => Number(left) - Number(right));
    if (numericKeys.length > 0) return Uint8Array.from(numericKeys.map((key) => Number(record[key]) & 0xff));
  }
  throw new Error("FILE_BYTES_INVALID: 文件二进制数据无效，请重新选择文件");
}

export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

export async function parseDocument(input: { documentId: string; filename: string; mimeType: string; bytes: unknown }, registry = createDocumentParserRegistry()): Promise<ParsedDocument> {
  const bytes = normalizeDocumentBytes(input.bytes);
  const extension = input.filename.toLowerCase().split(".").pop();
  const extensionMime: Record<string, string> = { txt: "text/plain", md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", pdf: "application/pdf", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const normalizedMimeType = (input.mimeType ?? "").split(";", 1)[0]?.trim().toLowerCase();
  const mimeType = isZipBytes(bytes) ? "application/zip" : extensionMime[extension ?? ""] ?? normalizedMimeType;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const parsed = await registry.parse({ ...input, bytes, mimeType, sha256 });
  return { documentId: input.documentId, filename: input.filename, mimeType, sha256, text: parsed.text, sections: parsed.sections ?? [], ...(parsed.repositoryFiles ? { repositoryFiles: parsed.repositoryFiles.map((file) => ({ ...file, documentId: input.documentId, size: file.size ?? file.text.length })) } : {}), ...(parsed.repositoryManifest ? { repositoryManifest: { ...parsed.repositoryManifest, archiveSha256: parsed.repositoryManifest.archiveSha256 || sha256 } } : {}), ...(parsed.repositorySkippedFiles ? { repositorySkippedFiles: parsed.repositorySkippedFiles } : {}) };
}
