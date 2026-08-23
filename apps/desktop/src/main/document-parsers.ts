import JSZip from "jszip";
import mammoth from "mammoth";
import { createHash } from "node:crypto";
import { DocumentParserRegistry, plainTextDocumentParser, type ParsedDocument } from "@interview-copilot/shared";

function decodeXml(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

function sectionsFromText(text: string): string[] {
  return text.split(/\n(?=#{1,6}\s)/).map((section) => section.trim()).filter(Boolean).map((section) => (section.split("\n", 1)[0] ?? "").replace(/^#{1,6}\s+/, "").trim());
}

const htmlDocumentParser = {
  async parse(input: { bytes: Uint8Array }) {
    const html = new TextDecoder().decode(input.bytes).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
    const text = decodeXml(html).replace(/\s{2,}/g, " ").trim();
    return { text, sections: sectionsFromText(text) };
  }
};

const docxDocumentParser = {
  async parse(input: { bytes: Uint8Array }) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(input.bytes) });
    const text = result.value.trim();
    return { text, sections: sectionsFromText(text) };
  }
};

const pdfDocumentParser = {
  async parse(input: { bytes: Uint8Array }) {
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
  async parse(input: { bytes: Uint8Array }) {
    const zip = await JSZip.loadAsync(input.bytes);
    const allowed = /\.(c|h|cc|cpp|cxx|hpp|py|ts|tsx|js|jsx|rs|md|markdown|cmake|json|toml|yml|yaml|txt|ini|cfg|conf)$/i;
    const allowedBasename = /(^|\/)(readme(?:\.[^/]+)?|makefile|cmakelists\.txt|kconfig(?:\.[^/]+)?)$/i;
    const ignored = /(^|\/)(node_modules|dist|build|target|\.git|__pycache__)(\/|$)/i;
    const names = Object.keys(zip.files).filter((name) => !zip.files[name]?.dir && (allowed.test(name) || allowedBasename.test(name)) && !ignored.test(name)).sort();
    const blocks: string[] = [];
    for (const name of names.slice(0, 300)) {
      const entry = zip.file(name);
      if (!entry) continue;
      const text = await entry.async("text");
      blocks.push(`文件：${name}\n${text.slice(0, 40_000)}`);
    }
    const text = blocks.join("\n\n---\n\n").trim();
    if (!text) throw new Error("ZIP_NO_SUPPORTED_FILES: 压缩包中没有可分析的源码、README 或项目配置文件");
    return { text, sections: names.slice(0, 300) };
  }
};

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

function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08);
}

export async function parseDocument(input: { documentId: string; filename: string; mimeType: string; bytes: unknown }, registry = createDocumentParserRegistry()): Promise<ParsedDocument> {
  const bytes = normalizeDocumentBytes(input.bytes);
  const extension = input.filename.toLowerCase().split(".").pop();
  const extensionMime: Record<string, string> = { txt: "text/plain", md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", pdf: "application/pdf", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const normalizedMimeType = (input.mimeType ?? "").split(";", 1)[0]?.trim().toLowerCase();
  const mimeType = isZipBytes(bytes) ? "application/zip" : extensionMime[extension ?? ""] ?? normalizedMimeType;
  const parsed = await registry.parse({ ...input, bytes, mimeType });
  return { documentId: input.documentId, filename: input.filename, mimeType, sha256: createHash("sha256").update(bytes).digest("hex"), text: parsed.text, sections: parsed.sections ?? [] };
}
