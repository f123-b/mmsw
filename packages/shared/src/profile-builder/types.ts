export type ProfileBuilderSourceKind = "resume" | "job_target" | "project" | "interview" | "knowledge" | "skill";

export interface ProfileBuilderSource {
  id: string;
  kind: ProfileBuilderSourceKind;
  title: string;
  text: string;
  updatedAt?: number;
}

export interface ProfileBuilderSourceSnapshot {
  generatedAt: number;
  sources: Array<Pick<ProfileBuilderSource, "id" | "kind" | "title" | "updatedAt"> & { fingerprint: string }>;
}

export interface ProfileBuilderInput {
  profileId: string;
  profileName: string;
  sources: ProfileBuilderSource[];
}

export interface ProfileGraphNode {
  id: string;
  label: string;
  description: string;
  evidenceIds: string[];
}

export interface ProfileGraphEdge {
  from: string;
  to: string;
  relation: string;
  evidenceIds: string[];
}

export interface ProfileSkillGraph {
  nodes: ProfileGraphNode[];
  edges: ProfileGraphEdge[];
}

export interface ProfileProjectNode {
  id: string;
  name: string;
  summary: string;
  highlights: string[];
  skills: string[];
  evidenceIds: string[];
}

export interface ProfileProjectGraph {
  nodes: ProfileProjectNode[];
  edges: ProfileGraphEdge[];
}

export interface InterviewAnswerMaterial {
  id: string;
  question: string;
  answerPoints: string[];
  topic?: string;
  evidenceIds: string[];
}

export interface ProfileFAQ {
  id: string;
  question: string;
  category: "technical" | "project" | "behavior" | "general";
  answerMaterialId?: string;
  frequency: number;
  evidenceIds: string[];
}

export interface ProfileBuilderOutput {
  version: 1;
  profileId: string;
  generatedAt: number;
  status: "ready" | "partial" | "error";
  sourceIds: string[];
  skillGraph: ProfileSkillGraph;
  projectGraph: ProfileProjectGraph;
  answerMaterials: InterviewAnswerMaterial[];
  faqs: ProfileFAQ[];
  warnings: string[];
  error?: string;
}

export interface ProfileBuilderModel {
  generate(input: { profile: ProfileBuilderInput; fallback: ProfileBuilderOutput }): Promise<string>;
}
