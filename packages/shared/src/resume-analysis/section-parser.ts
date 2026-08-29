import type { ResumeDocument, ResumeEvidence, ResumeProject } from "./types";

interface ResumeLine { text: string; start: number; end: number; }
export interface ResumeSection { title: string; startOffset: number; endOffset: number; lines: ResumeLine[]; }

const headingPatterns: Array<[RegExp, string]> = [
  [/^(?:项目经历|项目经验|项目背景|项目开发)(?:\s*[:：])?\s*(.*)$/i, "projects"],
  [/^(?:project(?:s| experience)?|selected projects)(?:\s*[:：])?\s*(.*)$/i, "projects"],
  [/^(?:教育经历|教育背景|education)(?:\s*[:：])?\s*(.*)$/i, "education"],
  [/^(?:工作经历|工作经验|professional experience|work experience|experience)(?:\s*[:：])?\s*(.*)$/i, "work"],
  [/^(?:实习经历|internships?)(?:\s*[:：])?\s*(.*)$/i, "internships"],
  [/^(?:技能特长|专业技能|skills?)(?:\s*[:：])?\s*(.*)$/i, "skills"],
  [/^(?:获奖经历|荣誉|awards?)(?:\s*[:：])?\s*(.*)$/i, "awards"]
];

function linesOf(text: string): ResumeLine[] {
  const lines: ResumeLine[] = [];
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    lines.push({ text: line.trim(), start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  return lines;
}

function heading(line: string): { kind: string; inline: string } | undefined {
  const normalized = line.replace(/[\t ]+/g, " ").trim();
  if (!normalized || normalized.length > 80) return undefined;
  for (const [pattern, kind] of headingPatterns) {
    const match = normalized.match(pattern);
    if (match) return { kind, inline: match[1]?.trim() ?? "" };
  }
  return undefined;
}

export function detectResumeSections(document: ResumeDocument): ResumeSection[] {
  const lines = linesOf(document.rawText);
  const found: Array<{ line: ResumeLine; kind: string; inline: string }> = [];
  for (const line of lines) {
    const match = heading(line.text);
    if (match) found.push({ line, ...match });
  }
  return found.map((item, index) => {
    const next = found[index + 1];
    const endOffset = next?.line.start ?? document.rawText.length;
    const title = item.kind === "projects" ? "projects" : item.kind;
    return { title, startOffset: item.line.end, endOffset, lines: lines.filter((line) => line.start >= item.line.end && line.start < endOffset) };
  });
}

function bullet(text: string): string | undefined {
  const value = text.replace(/^\s*(?:[-*•●▪]|\d+[.)、])\s*/, "").trim();
  return value && value !== text.trim() ? value : undefined;
}

function projectHeader(text: string): boolean {
  if (!text || bullet(text)) return false;
  if (/^(?:项目名称|project)\s*[:：]/i.test(text)) return true;
  const hasDate = /(?:19|20)\d{2}\s*[./-]\s*\d{1,2}|(?:19|20)\d{2}\s*[-~至到]\s*(?:(?:19|20)\d{2}|至今)/.test(text);
  const hasRoleOrTechnology = /(?:角色|职位|担任|负责(?:人)?|技术栈|tools?|technologies?|role)\s*[:：]/i.test(text);
  const hasProjectMetadata = /[|｜]/.test(text) && (hasDate || hasRoleOrTechnology);
  return text.length >= 2 && text.length <= 96 && hasProjectMetadata && !/^(?:职责|负责内容|技术栈|tools?|technologies?)\s*[:：]/i.test(text);
}

function projectName(header: string): string {
  const labeled = header.match(/^(?:项目名称|project)\s*[:：]\s*(.*)$/i)?.[1] ?? header;
  return labeled.split(/\s*[|｜]\s*|\s+[-—]\s+(?=20\d{2})/)[0].replace(/^[\d.)、\s]+/, "").trim();
}

function period(text: string): string | undefined {
  return text.match(/(?:19|20)\d{2}\s*[./-]\s*\d{1,2}(?:\s*[-~至到]\s*(?:(?:19|20)\d{2}\s*[./-]\s*)?\d{1,2})?|(?:19|20)\d{2}\s*[-~至到]\s*(?:(?:19|20)\d{2}|至今)/)?.[0]?.replace(/\s+/g, " ");
}

function role(text: string): string | undefined {
  const value = text.match(/(?:角色|职位|担任|负责(?:人)?|role)\s*[:：]\s*([^|｜，,；;]+)/i)?.[1]?.trim();
  if (value) return value;
  const pipe = text.split(/\s*[|｜]\s*/).find((part) => /负责人|主程|lead|developer|engineer/i.test(part));
  return pipe?.trim();
}

const technologyPattern = /(?:C\+\+|C#|C\/C\+\+|TypeScript|JavaScript|Python|Rust|ROS2?|CAN(?: FD)?|UART|SPI|I2C|DMA|PWM|FOC|Linux|Windows|Electron|SQLite|Docker|WebSocket|FreeRTOS)/gi;

function technologies(text: string): string[] { return [...new Set((text.match(technologyPattern) ?? []).map((item) => item.trim()))]; }

export function extractResumeProjects(document: ResumeDocument, section = detectResumeSections(document).find((item) => item.title === "projects")): ResumeProject[] {
  if (!section) return [];
  const blocks: Array<{ header: ResumeLine; lines: ResumeLine[] }> = [];
  let current: { header: ResumeLine; lines: ResumeLine[] } | undefined;
  for (const line of section.lines) {
    if (!line.text) continue;
    if (projectHeader(line.text)) {
      if (current) blocks.push(current);
      current = { header: line, lines: [] };
    } else if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks.map((block, index) => {
    const endOffset = block.lines.at(-1)?.end ?? block.header.end;
    const rawExcerpt = document.rawText.slice(block.header.start, endOffset).trim();
    const body = block.lines.map((line) => line.text).filter(Boolean);
    const responsibilities = body.map((line) => bullet(line) ?? line).filter(Boolean).slice(0, 12);
    const evidence: ResumeEvidence = { sourceId: document.sourceId, startOffset: block.header.start, endOffset, rawExcerpt };
    return { id: `resume-project-${index + 1}`, name: projectName(block.header.text), period: period(block.header.text), role: role(block.header.text), description: body.join(" ").slice(0, 1_200), responsibilities, technologies: technologies(rawExcerpt), evidence, confidence: rawExcerpt ? 0.92 : 0.4 } satisfies ResumeProject;
  }).filter((project) => project.name && project.evidence.rawExcerpt);
}
