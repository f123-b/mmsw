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
    .register(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"], docxDocumentParser)
    .register(["application/vnd.openxmlformats-officedocument.presentationml.presentation"], { parse: (input) => officeXmlParser({ ...input, kind: "pptx" }) })
    .register(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], { parse: (input) => officeXmlParser({ ...input, kind: "xlsx" }) });
}

export async function parseDocument(input: { documentId: string; filename: string; mimeType: string; bytes: Uint8Array }, registry = createDocumentParserRegistry()): Promise<ParsedDocument> {
  const extension = input.filename.toLowerCase().split(".").pop();
  const extensionMime: Record<string, string> = { txt: "text/plain", md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const mimeType = input.mimeType === "application/octet-stream" || !input.mimeType ? extensionMime[extension ?? ""] ?? input.mimeType : input.mimeType;
  const parsed = await registry.parse({ ...input, mimeType });
  return { ...input, mimeType, sha256: createHash("sha256").update(input.bytes).digest("hex"), text: parsed.text, sections: parsed.sections ?? [] };
}
