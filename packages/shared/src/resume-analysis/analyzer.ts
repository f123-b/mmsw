import { detectResumeSections, extractResumeProjects } from "./section-parser";
import type { ResumeAnalysis, ResumeAnalysisModel, ResumeDocument, ResumeProject } from "./types";

export const RESUME_ANALYSIS_VERSION = 2;

function firstMatch(text: string, pattern: RegExp): string | undefined { return text.match(pattern)?.[1]?.trim(); }

export class ResumeAnalyzer {
  analyze(document: ResumeDocument): ResumeAnalysis {
    const sections = detectResumeSections(document);
    const sectionText = (kind: string) => sections.find((section) => section.title === kind)?.lines.map((line) => line.text).filter(Boolean) ?? [];
    const projects = extractResumeProjects(document);
    const warnings = projects.length === 0 ? ["未找到带证据的项目经历 section，请人工新增或补充项目标题"] : ["当前结果来自本地 section parser，建议逐项确认后再用于正式档案"];
    return {
      version: RESUME_ANALYSIS_VERSION,
      sourceId: document.sourceId,
      ...(document.filename ? { filename: document.filename } : {}),
      analysisQuality: "fallback",
      basicInfo: { name: firstMatch(document.rawText.split(/\r?\n/).slice(0, 5).join("\n"), /^(?:姓名|name)\s*[:：]\s*(.+)$/im), email: firstMatch(document.rawText, /([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/), phone: firstMatch(document.rawText, /(1[3-9]\d{9}|\+?\d[\d -]{8,})/) },
      education: sectionText("education"),
      workExperience: sectionText("work"),
      internships: sectionText("internships"),
      projects,
      skills: sectionText("skills"),
      awards: sectionText("awards"),
      summary: document.rawText.replace(/\s+/g, " ").trim().slice(0, 500),
      warnings
    };
  }

  async analyzeWithModel(document: ResumeDocument, model?: ResumeAnalysisModel): Promise<ResumeAnalysis> {
    const fallback = this.analyze(document);
    if (!model) return fallback;
    try {
      const raw = await model.generate({ document, fallback });
      return validateResumeAnalysisEvidence(normalizeModelAnalysis(raw, fallback, document), document);
    } catch {
      return { ...fallback, warnings: [...fallback.warnings, "LLM 简历解析不可用，已明确回退到本地 section parser"] };
    }
  }
}

export function analyzeResume(document: ResumeDocument): ResumeAnalysis { return new ResumeAnalyzer().analyze(document); }

function normalizeModelAnalysis(raw: string, fallback: ResumeAnalysis, document: ResumeDocument): ResumeAnalysis {
  const candidate = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return fallback;
  const parsed = JSON.parse(candidate) as Partial<ResumeAnalysis>;
  const projects = Array.isArray(parsed.projects) ? parsed.projects.map((project, index) => {
    const item = project as Partial<ResumeProject>;
    return {
      id: String(item.id ?? `resume-project-model-${index + 1}`),
      name: String(item.name ?? "").trim(),
      ...(item.period ? { period: String(item.period) } : {}),
      ...(item.role ? { role: String(item.role) } : {}),
      description: String(item.description ?? "").trim(),
      responsibilities: Array.isArray(item.responsibilities) ? item.responsibilities.map(String).filter(Boolean).slice(0, 12) : [],
      technologies: Array.isArray(item.technologies) ? item.technologies.map(String).filter(Boolean).slice(0, 24) : [],
      evidence: {
        sourceId: String(item.evidence?.sourceId ?? fallback.sourceId),
        startOffset: Number(item.evidence?.startOffset ?? 0),
        endOffset: Number(item.evidence?.endOffset ?? 0),
        rawExcerpt: String(item.evidence?.rawExcerpt ?? "")
      },
      confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.75)))
    } satisfies ResumeProject;
  }).filter((project) => project.name && project.description) : fallback.projects;
  return {
    ...fallback,
    version: RESUME_ANALYSIS_VERSION,
    analysisQuality: projects === fallback.projects ? fallback.analysisQuality : "structured",
    basicInfo: parsed.basicInfo && typeof parsed.basicInfo === "object" ? {
      name: typeof parsed.basicInfo.name === "string" && resumeContains(document, parsed.basicInfo.name) ? parsed.basicInfo.name : fallback.basicInfo.name,
      email: typeof parsed.basicInfo.email === "string" && resumeContains(document, parsed.basicInfo.email) ? parsed.basicInfo.email : fallback.basicInfo.email,
      phone: typeof parsed.basicInfo.phone === "string" && resumeContains(document, parsed.basicInfo.phone) ? parsed.basicInfo.phone : fallback.basicInfo.phone
    } : fallback.basicInfo,
    education: groundedModelStrings(parsed.education, fallback.education, document),
    workExperience: groundedModelStrings(parsed.workExperience, fallback.workExperience, document),
    internships: groundedModelStrings(parsed.internships, fallback.internships, document),
    projects,
    skills: groundedModelStrings(parsed.skills, fallback.skills, document),
    awards: groundedModelStrings(parsed.awards, fallback.awards, document),
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : fallback.summary,
    warnings: [...fallback.warnings, "结构化结果已通过 Resume 原文证据校验"]
  };
}

function normalizedEvidence(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

const skillAliases: Record<string, string[]> = {
  "c/c++": ["c++", "cpp", "c/c++"],
  iic: ["iic", "i2c"],
  i2c: ["iic", "i2c"],
  rtos: ["rtos", "freertos"],
  freertos: ["freertos", "rtos"]
};

function resumeContains(document: ResumeDocument, value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  const raw = document.rawText.toLocaleLowerCase();
  const lower = candidate.toLocaleLowerCase();
  const aliases = skillAliases[lower] ?? [lower];
  return aliases.some((alias) => raw.includes(alias) || normalizedEvidence(document.rawText).includes(normalizedEvidence(alias)));
}

function groundedModelStrings(values: unknown, fallback: string[], document: ResumeDocument): string[] {
  if (!Array.isArray(values)) return fallback;
  const grounded = values.map(String).map((value) => value.trim()).filter((value) => value && resumeContains(document, value));
  return grounded.length ? [...new Set(grounded)] : fallback;
}

export function resumeEvidenceMatches(document: ResumeDocument, evidence: ResumeProject["evidence"]): boolean {
  if (evidence.sourceId !== document.sourceId || !evidence.rawExcerpt.trim()) return false;
  const start = Math.max(0, Math.floor(evidence.startOffset));
  const end = Math.min(document.rawText.length, Math.ceil(evidence.endOffset));
  if (end <= start) return false;
  const excerpt = document.rawText.slice(start, end);
  return excerpt.includes(evidence.rawExcerpt) || normalizedEvidence(excerpt).includes(normalizedEvidence(evidence.rawExcerpt));
}

export function validateResumeAnalysisEvidence(analysis: ResumeAnalysis, document: ResumeDocument): ResumeAnalysis {
  const projects = analysis.projects.filter((project) => resumeEvidenceMatches(document, project.evidence));
  const dropped = analysis.projects.length - projects.length;
  return {
    ...analysis,
    version: RESUME_ANALYSIS_VERSION,
    sourceId: document.sourceId,
    ...(document.filename ? { filename: document.filename } : {}),
    projects,
    warnings: dropped > 0 ? [...analysis.warnings, `已丢弃 ${dropped} 个无法在当前 Resume 原文中定位证据的项目`] : analysis.warnings
  };
}
