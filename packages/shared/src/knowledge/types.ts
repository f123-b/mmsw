export type ProjectMemorySourceKind = "resume" | "project-document" | "repository" | "readme" | "interview" | "manual";

export interface ProjectMemorySource {
  id: string;
  kind: ProjectMemorySourceKind;
  title: string;
  text: string;
  filePath?: string;
  language?: string;
  updatedAt?: number;
}

export interface ProjectMemoryProject {
  id: string;
  profileId?: string;
  name: string;
  description: string;
  role: string;
  hardware: string[];
  software: string[];
  technologyStack: string[];
  time?: string;
  sourceIds: string[];
  confidence: number;
}

export const PROJECT_FACT_TYPES = [
  "background",
  "responsibility",
  "architecture",
  "module",
  "technology",
  "challenge",
  "decision",
  "result",
  "metric",
  "limitation"
] as const;

export type ProjectFactType = typeof PROJECT_FACT_TYPES[number];

export interface ProjectFact {
  id: string;
  projectId: string;
  profileId?: string;
  type: ProjectFactType;
  title: string;
  content: string;
  confidence: number;
  verified: boolean;
  sourceIds: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface ProjectMemoryModule {
  id: string;
  projectId: string;
  moduleName: string;
  description: string;
  filePath?: string;
  sourceIds: string[];
}

export interface ProjectTechnicalPoint {
  id: string;
  projectId: string;
  topic: string;
  content: string;
  importance: "high" | "medium" | "low";
  sourceIds: string[];
}

export interface ProjectProblem {
  id: string;
  projectId: string;
  problem: string;
  cause: string;
  solution: string;
  result: string;
  sourceIds: string[];
}

export interface ProjectInterviewQuestion {
  id: string;
  projectId: string;
  question: string;
  answerPoints: string[];
  keywords: string[];
  sourceIds: string[];
}

export interface ProjectMemorySnapshot {
  projects: ProjectMemoryProject[];
  modules: ProjectMemoryModule[];
  technicalPoints: ProjectTechnicalPoint[];
  problems: ProjectProblem[];
  interviewQuestions: ProjectInterviewQuestion[];
}

export interface ProjectMemoryAnalysisInput {
  profileId?: string;
  sources: ProjectMemorySource[];
}

export interface ProjectMemoryModel {
  generate(input: ProjectMemoryAnalysisInput): Promise<string>;
}
