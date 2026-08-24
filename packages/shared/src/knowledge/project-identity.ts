import type { ProjectMemorySource, ProjectMemoryProject } from "./types";

export interface ResumeProjectSection {
  projectName: string;
  text: string;
  sourceId: string;
  locator: string;
  aliases: string[];
}

export interface ProjectIdentityCandidate {
  name: string;
  aliases: string[];
  confidence: number;
  reason: "explicit" | "metadata" | "filename" | "markdown-heading" | "readme-title" | "body";
}

export interface ProjectAssignmentResult {
  status: "assigned" | "needs_assignment";
  projectId?: string;
  confidence: number;
  reason: string;
}

function cleanName(value: string): string {
  return value
    .replace(/^\s*(?:项目名称|项目名|项目|project)\s*[:：-]\s*/i, "")
    .replace(/\.(?:md|markdown|txt|pdf|docx?|zip)$/i, "")
    .replace(/[\s|｜]+(?:负责人|个人职责|职责|技术栈|电话|邮箱|教育背景|求职方向)[\s\S]*$/i, "")
    .replace(/[\s_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value: string): string {
  return cleanName(value).toLowerCase().replace(/[\s\-_.:：/\\()[\]{}（）【】]/g, "");
}

function filenameName(source: Pick<ProjectMemorySource, "title" | "filePath">): string {
  const value = source.filePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? source.title;
  return cleanName(value);
}

function markdownHeading(text: string, readmeOnly = false): string | undefined {
  const headings = [...text.matchAll(/^#{1,2}\s+(.+)$/gm)].map((match) => cleanName(String(match[1] ?? ""))).filter((item) => item.length >= 2);
  if (readmeOnly) return headings.find((heading) => /readme|project|项目/i.test(heading));
  return headings[0];
}

function bodyName(text: string): string | undefined {
  const match = text.match(/(?:项目(?:名称|名)?|project\s*name)\s*[:：-]\s*([^\n。；;]{2,80})/i);
  return match ? cleanName(match[1] ?? "") : undefined;
}

/** Extracts a stable identity before any body-level fact extraction occurs. */
export function resolveProjectIdentity(source: ProjectMemorySource): ProjectIdentityCandidate {
  const explicit = source.projectName?.trim();
  if (explicit) return { name: cleanName(explicit), aliases: [explicit], confidence: 1, reason: "explicit" };
  const metadataName = source.title.match(/(?:项目名称|project\s*name)\s*[:：-]\s*(.+)$/i)?.[1];
  if (metadataName) return { name: cleanName(metadataName), aliases: [metadataName], confidence: 0.98, reason: "metadata" };
  const fromFilename = filenameName(source);
  if (fromFilename && !/^(?:resume|简历|readme|项目说明|技术文档|technical[-_ ]?doc)$/i.test(fromFilename)) {
    return { name: fromFilename, aliases: [fromFilename], confidence: 0.88, reason: "filename" };
  }
  const heading = markdownHeading(source.text);
  if (heading) return { name: heading, aliases: [heading], confidence: 0.78, reason: "markdown-heading" };
  const readme = markdownHeading(source.text, true);
  if (readme) return { name: readme, aliases: [readme], confidence: 0.72, reason: "readme-title" };
  const body = bodyName(source.text);
  if (body) return { name: body, aliases: [body], confidence: 0.65, reason: "body" };
  return { name: "待确认项目", aliases: [], confidence: 0.2, reason: "body" };
}

function sectionHeading(line: string): boolean {
  const value = line.trim();
  return /^#{1,6}\s+/.test(value) || /^(?:项目名称|项目名|项目经历|项目描述|教育背景|工作经历|实习经历|技能|证书|求职方向)\s*[:：]?\s*$/i.test(value) || (/项目|系统|平台|电机|控制/i.test(value) && /(20\d{2}|技术栈|负责人|职责)/.test(value));
}

function likelyProjectHeading(line: string): boolean {
  const value = line.replace(/^#{1,6}\s+/, "").trim();
  return /项目|系统|平台|电机|控制|app|软件|硬件|仓库|project/i.test(value) && !/项目经历|项目描述|工作经历|教育背景/.test(value);
}

/** Splits only the project sections of a resume; the resume document itself is never a project source. */
export function extractResumeProjectSections(text: string, sourceId: string): ResumeProjectSection[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const sections: ResumeProjectSection[] = [];
  let start = -1;
  let name = "";
  const flush = (end: number) => {
    if (start < 0 || !name) return;
    const body = lines.slice(start, end).join("\n").trim();
    if (body.length < 10) return;
    sections.push({ projectName: cleanName(name), text: body, sourceId, locator: `lines:${start + 1}-${Math.max(start + 1, end)}`, aliases: [cleanName(name)] });
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const explicit = trimmed.match(/^(?:项目名称|项目名|项目)\s*[:：]\s*(.+)$/i);
    const heading = sectionHeading(trimmed) && likelyProjectHeading(trimmed);
    if (explicit || heading) {
      flush(index);
      start = index;
      name = explicit?.[1] ?? trimmed.replace(/^#{1,6}\s+/, "");
    } else if (start >= 0 && sectionHeading(trimmed) && !likelyProjectHeading(trimmed)) {
      flush(index);
      start = -1;
      name = "";
    }
  });
  flush(lines.length);
  return sections;
}

function tokenSet(value: string): Set<string> {
  return new Set(compact(value).match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/gi) ?? []);
}

/** Conservative assignment: an ambiguous document is surfaced for user selection. */
export function resolveProjectAssignment(source: ProjectMemorySource, projects: Array<Pick<ProjectMemoryProject, "id" | "name"> & { aliases?: string[] }>, explicitProjectId?: string): ProjectAssignmentResult {
  if (explicitProjectId && projects.some((project) => project.id === explicitProjectId)) return { status: "assigned", projectId: explicitProjectId, confidence: 1, reason: "explicit project selection" };
  const identity = resolveProjectIdentity(source);
  const identityKey = compact(identity.name);
  const exact = projects.filter((project) => [project.name, ...(project.aliases ?? [])].some((alias) => compact(alias) === identityKey));
  if (exact.length === 1) return { status: "assigned", projectId: exact[0]?.id, confidence: Math.max(identity.confidence, 0.9), reason: "project name match" };
  const sourceTokens = tokenSet(`${identity.name} ${source.title} ${source.filePath ?? ""}`);
  const scored = projects.map((project) => {
    const projectTokens = tokenSet(`${project.name} ${(project.aliases ?? []).join(" ")}`);
    const overlap = [...sourceTokens].filter((token) => projectTokens.has(token)).length;
    return { project, score: overlap / Math.max(1, Math.min(sourceTokens.size, projectTokens.size)) };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0];
  const second = scored[1];
  if (best && best.score >= 0.6 && (!second || best.score - second.score >= 0.2)) return { status: "assigned", projectId: best.project.id, confidence: Math.min(0.88, 0.55 + best.score * 0.3), reason: "project alias similarity" };
  return { status: "needs_assignment", confidence: identity.confidence, reason: "项目资料无法唯一匹配，请选择所属项目" };
}

export { cleanName as normalizeProjectName };
