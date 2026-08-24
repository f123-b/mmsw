export interface ProjectMarkdownTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  quotes: string[];
}

export interface ProjectMarkdownSection {
  level: number;
  title: string;
  path: string[];
  startLine: number;
  endLine: number;
  paragraphs: string[];
  bullets: string[];
  tables: ProjectMarkdownTable[];
}

export interface ProjectDocumentStructure {
  title?: string;
  sections: ProjectMarkdownSection[];
  tables: ProjectMarkdownTable[];
}

function cleanCell(value: string): string {
  return value.replace(/^\s*\|\s*/, "").replace(/\s*\|\s*$/, "").trim();
}

function splitRow(line: string): string[] {
  const value = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return value.split("|").map((cell) => cleanCell(cell));
}

function isTableSeparator(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith("|") && line.trim().endsWith("|") && splitRow(line).length > 0;
}

function makeTable(lines: string[], start: number): { table: ProjectMarkdownTable; end: number } | undefined {
  if (!isTableRow(lines[start] ?? "") || !isTableSeparator(lines[start + 1] ?? "")) return undefined;
  const headers = splitRow(lines[start] ?? "").map((header, index) => header || `列${index + 1}`);
  const rows: Array<Record<string, string>> = [];
  const quotes: string[] = [];
  let end = start + 2;
  while (end < lines.length && isTableRow(lines[end] ?? "")) {
    const cells = splitRow(lines[end] ?? "");
    if (!cells.length) break;
    const row: Record<string, string> = {};
    headers.forEach((header, index) => { row[header] = cells[index] ?? ""; });
    rows.push(row);
    quotes.push(`| ${headers.map((header) => row[header] ?? "").join(" | ")} |`);
    end += 1;
  }
  return { table: { headers, rows, quotes }, end: end - 1 };
}

function sectionFor(sections: ProjectMarkdownSection[], path: string[]): ProjectMarkdownSection {
  const current = sections[sections.length - 1];
  if (current) return current;
  const root: ProjectMarkdownSection = { level: 0, title: "文档正文", path, startLine: 1, endLine: 1, paragraphs: [], bullets: [], tables: [] };
  sections.push(root);
  return root;
}

/**
 * Parses headings, paragraphs, bullets and Markdown tables without assigning
 * business meaning. The fact extractor is responsible for field semantics.
 */
export function parseMarkdownProjectDocument(text: string): ProjectDocumentStructure {
  const rawLines = text.replace(/\r/g, "").split("\n");
  const sections: ProjectMarkdownSection[] = [];
  const tables: ProjectMarkdownTable[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let title: string | undefined;
  let paragraph: string[] = [];

  const flushParagraph = (section: ProjectMarkdownSection): void => {
    const value = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (value) section.paragraphs.push(value);
    paragraph = [];
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index] ?? "";
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const headingTitle = (heading[2] ?? "").trim();
      const previous = sectionFor(sections, headingStack.map((item) => item.title));
      flushParagraph(previous);
      previous.endLine = index;
      while (headingStack.length && (headingStack[headingStack.length - 1]?.level ?? 0) >= level) headingStack.pop();
      headingStack.push({ level, title: headingTitle });
      const section: ProjectMarkdownSection = { level, title: headingTitle, path: headingStack.map((item) => item.title), startLine: index + 1, endLine: index + 1, paragraphs: [], bullets: [], tables: [] };
      sections.push(section);
      if (!title && level === 1) title = headingTitle;
      continue;
    }

    const current = sectionFor(sections, headingStack.map((item) => item.title));
    const table = makeTable(rawLines, index);
    if (table) {
      flushParagraph(current);
      current.tables.push(table.table);
      tables.push(table.table);
      index = table.end;
      current.endLine = index + 1;
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)、]\s+)(.+)$/);
    if (bullet) {
      flushParagraph(current);
      current.bullets.push((bullet[1] ?? "").trim());
    } else if (line.trim()) {
      paragraph.push(line.trim());
    } else {
      flushParagraph(current);
    }
    current.endLine = index + 1;
  }
  const last = sections[sections.length - 1];
  if (last) flushParagraph(last);
  return { ...(title ? { title } : {}), sections, tables };
}

export function markdownSectionText(section: ProjectMarkdownSection): string {
  return [...section.paragraphs, ...section.bullets, ...section.tables.flatMap((table) => table.quotes)].join("\n");
}

export function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[\s_\-]/g, "").replace(/[：:]/g, "");
}
