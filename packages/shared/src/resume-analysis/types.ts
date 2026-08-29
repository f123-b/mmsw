export interface ResumeDocument {
  sourceId: string;
  filename?: string;
  rawText: string;
  metadata?: Record<string, string | number | boolean | undefined>;
}

export interface ResumeEvidence {
  sourceId: string;
  startOffset: number;
  endOffset: number;
  rawExcerpt: string;
}

export interface ResumeProject {
  id: string;
  name: string;
  period?: string;
  role?: string;
  description: string;
  responsibilities: string[];
  technologies: string[];
  evidence: ResumeEvidence;
  confidence: number;
}

export interface ResumeAnalysis {
  version: 2;
  sourceId: string;
  filename?: string;
  analysisQuality: "structured" | "fallback";
  basicInfo: { name?: string; email?: string; phone?: string };
  education: string[];
  workExperience: string[];
  internships: string[];
  projects: ResumeProject[];
  skills: string[];
  awards: string[];
  summary: string;
  warnings: string[];
}

export interface ResumeAnalysisModel {
  generate(input: { document: ResumeDocument; fallback: ResumeAnalysis }): Promise<string>;
}
