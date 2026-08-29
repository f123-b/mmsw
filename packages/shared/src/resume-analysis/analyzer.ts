import { detectResumeSections, extractResumeProjects } from "./section-parser";
import type { ResumeAnalysis, ResumeDocument } from "./types";

function firstMatch(text: string, pattern: RegExp): string | undefined { return text.match(pattern)?.[1]?.trim(); }

export class ResumeAnalyzer {
  analyze(document: ResumeDocument): ResumeAnalysis {
    const sections = detectResumeSections(document);
    const sectionText = (kind: string) => sections.find((section) => section.title === kind)?.lines.map((line) => line.text).filter(Boolean) ?? [];
    const projects = extractResumeProjects(document);
    const warnings = projects.length === 0 ? ["未找到带证据的项目经历 section，请人工新增或补充项目标题"] : ["当前结果来自本地 section parser，建议逐项确认后再用于正式档案"];
    return {
      version: 1,
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
}

export function analyzeResume(document: ResumeDocument): ResumeAnalysis { return new ResumeAnalyzer().analyze(document); }
