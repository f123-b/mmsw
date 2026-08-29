export interface Material {
  rawContent: string;
  summary: string;
  filename?: string;
  mimeType?: string;
  uploadedAt?: number;
  parseStatus?: "pending" | "parsed" | "failed";
  analysisStatus?: "not_started" | "in_progress" | "completed" | "stale" | "failed";
  analysisStats?: {
    education: number;
    projects: number;
    skills: number;
  };
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  content: string;
  tags: string[];
  source?: "manual" | "resume" | "project" | "interview";
  evidenceRefs?: string[];
  confirmedAt?: number;
}

export type SkillSuggestionStatus = "pending" | "confirmed" | "rejected";

export interface SkillSuggestion {
  id: string;
  profileId: string;
  name: string;
  description: string;
  confidence: number;
  evidenceIds: string[];
  evidenceQuotes: string[];
  sourceKinds: Array<"resume" | "job_target" | "project" | "interview" | "knowledge" | "skill">;
  status: SkillSuggestionStatus;
  confirmedAt?: number;
  rejectedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SalaryExpectation {
  min?: number;
  max?: number;
  currency?: string;
  period?: "month" | "year";
  negotiable?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  language: string;
  resume?: Material;
  jobDescription?: Material;
  instructions?: string;
  expressionLevel: "plain" | "standard" | "expert";
  explainAdvancedTerms: boolean;
  companyContext?: string;
  salaryExpectation?: SalaryExpectation;
  skills: Skill[];
  knowledgeBaseIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProfileInput {
  name: string;
  language?: string;
  resume?: Material;
  jobDescription?: Material;
  instructions?: string;
  expressionLevel?: "plain" | "standard" | "expert";
  explainAdvancedTerms?: boolean;
  companyContext?: string;
  salaryExpectation?: SalaryExpectation;
  skills?: Skill[];
  knowledgeBaseIds?: string[];
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createProfile(input: ProfileInput, now = Date.now()): Profile {
  const name = input.name.trim();
  if (!name) throw new Error("Profile name is required");
  return {
    id: makeId("profile"),
    name,
    language: input.language ?? "zh-CN",
    resume: input.resume,
    jobDescription: input.jobDescription,
    instructions: input.instructions,
    expressionLevel: input.expressionLevel ?? "plain",
    explainAdvancedTerms: input.explainAdvancedTerms ?? true,
    ...(input.companyContext?.trim() ? { companyContext: input.companyContext.trim() } : {}),
    ...(input.salaryExpectation ? { salaryExpectation: { ...input.salaryExpectation } } : {}),
    skills: [...(input.skills ?? [])],
    knowledgeBaseIds: [...(input.knowledgeBaseIds ?? [])],
    createdAt: now,
    updatedAt: now
  };
}

export function createSkill(input: Omit<Skill, "id">): Skill {
  const name = input.name.trim();
  if (!name) throw new Error("Skill name is required");
  return { ...input, id: makeId("skill"), name, tags: [...input.tags] };
}

export class ProfileStore {
  private readonly profiles = new Map<string, Profile>();

  constructor(initial: Profile[] = []) {
    initial.forEach((profile) => this.profiles.set(profile.id, { ...profile, skills: [...profile.skills] }));
  }

  list(): Profile[] {
    return [...this.profiles.values()].sort((left, right) => right.updatedAt - left.updatedAt).map((profile) => ({ ...profile, skills: [...profile.skills] }));
  }

  get(id: string): Profile | undefined {
    const profile = this.profiles.get(id);
    return profile ? { ...profile, skills: [...profile.skills] } : undefined;
  }

  save(profile: Profile, now = Date.now()): Profile {
    const next = { ...profile, updatedAt: now, skills: [...profile.skills] };
    this.profiles.set(next.id, next);
    return { ...next, skills: [...next.skills] };
  }

  addSkill(profileId: string, skill: Skill, now = Date.now()): Profile {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    profile.skills = [...profile.skills.filter((item) => item.id !== skill.id), skill];
    profile.updatedAt = now;
    return this.get(profileId) as Profile;
  }
}

function terms(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).filter((term) => term.length > 1);
}

export interface RankedSkill extends Skill {
  score: number;
}

export class SkillRouter {
  route(question: string, profile: Profile, limit = 3): RankedSkill[] {
    const queryTerms = terms(question);
    return profile.skills
      .map((skill) => {
        const searchable = terms(`${skill.name} ${skill.description} ${skill.content} ${skill.tags.join(" ")}`);
        const matched = queryTerms.filter((term) => searchable.includes(term)).length;
        const score = matched / Math.max(1, queryTerms.length);
        return { ...skill, score };
      })
      .filter((skill) => skill.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
      .slice(0, limit);
  }
}
