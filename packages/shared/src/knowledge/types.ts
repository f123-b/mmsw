export type ProjectMemorySourceKind = "resume" | "resume-section" | "project-document" | "repository" | "readme" | "interview" | "manual" | "user-fact";

export type ProjectSourceType = "document" | "repository" | "resume_section" | "user_fact" | "interview_note";
export type ProjectSourceRelationship = "primary" | "supporting" | "reference";
export type ProjectSourceRole = "overview" | "code" | "resume" | "responsibility" | "debug" | "test" | "architecture" | "reference" | "other";
export type ProjectSourceAssignmentMethod = "explicit" | "matched" | "manual" | "imported";

export interface ProjectSourceAssignment {
  id?: string;
  projectId: string;
  sourceType: ProjectSourceType;
  sourceId: string;
  relationship: ProjectSourceRelationship;
  sourceRole?: ProjectSourceRole;
  assignmentMethod?: ProjectSourceAssignmentMethod;
  confidence: number;
  verified: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface ProjectMemorySource {
  id: string;
  kind: ProjectMemorySourceKind;
  sourceType?: ProjectSourceType;
  sourceRole?: ProjectSourceRole;
  projectId?: string;
  title: string;
  text: string;
  filePath?: string;
  language?: string;
  projectName?: string;
  locator?: string;
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
  "goal",
  "responsibility",
  "hardware",
  "software",
  "architecture",
  "module",
  "technology",
  "technical_decision",
  "challenge",
  "decision",
  "cause",
  "solution",
  "result",
  "metric",
  "application",
  "timeline",
  "limitation"
] as const;

export type ProjectFactType = typeof PROJECT_FACT_TYPES[number];

export interface ProjectFactEvidence {
  sourceId: string;
  quote: string;
  locator?: string;
  relation?: "support" | "refute";
}

export type ProjectFactScope = "project" | "module" | "problem" | "architecture";
export type ProjectFactEvidenceLevel = "confirmed-user" | "confirmed-code" | "confirmed-document" | "inferred" | "pending" | "risk" | "not-measured";
export type ProjectFactOwnership = "project" | "self" | "team" | "unknown";

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
  evidence?: ProjectFactEvidence[];
  scope?: ProjectFactScope;
  sectionPath?: string[];
  evidenceLevel?: ProjectFactEvidenceLevel;
  subtype?: string;
  factType?: ProjectFactType;
  status?: "active" | "pending_review" | "rejected" | "conflicting";
  conflictStatus?: "confirmed" | "conflicting" | "pending_review";
  conflictGroupId?: string;
  ownership?: ProjectFactOwnership;
  stale?: boolean;
  embedding?: number[];
  embeddingHash?: string;
  embeddingModel?: string;
  embeddingVersion?: string;
  embeddingUpdatedAt?: number;
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
  factIds?: string[];
  stale?: boolean;
}

export interface ProjectMemorySnapshot {
  projects: ProjectMemoryProject[];
  modules: ProjectMemoryModule[];
  technicalPoints: ProjectTechnicalPoint[];
  problems: ProjectProblem[];
  interviewQuestions: ProjectInterviewQuestion[];
  facts?: ProjectFact[];
}

export interface ProjectMemoryAnalysisInput {
  profileId?: string;
  projectId?: string;
  projectName?: string;
  sources: ProjectMemorySource[];
}

export interface ProjectMemoryModel {
  generate(input: ProjectMemoryAnalysisInput): Promise<string>;
}
