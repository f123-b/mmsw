import type { Profile } from "@interview-copilot/shared";
import type { JobTargetRecord } from "./database";

export interface CandidateContext {
  id: string;
  name: string;
  resumeSummary?: string;
  skills: Array<{ id: string; name: string; content: string }>;
  instructions?: string;
  companyContext?: string;
  salaryExpectation?: Profile["salaryExpectation"];
  expressionLevel: Profile["expressionLevel"];
  explainAdvancedTerms: boolean;
}

export interface JobTargetContext {
  id: string;
  name: string;
  description: string;
  requirements: Array<{ requirement: string; category: string; importance: string }>;
}

export interface InterviewProfileContext {
  candidate: CandidateContext;
  target?: JobTargetContext;
}

export function adaptProfileToInterviewContext(profile: Profile, jobTarget?: JobTargetRecord): InterviewProfileContext {
  const target = jobTarget ?? (profile.jobDescription ? { id: `job-${profile.id}`, name: "当前岗位", description: profile.jobDescription.rawContent, requirements: [] } : undefined);
  return {
    candidate: {
      id: profile.id,
      name: profile.name,
      ...(profile.resume?.summary ? { resumeSummary: profile.resume.summary } : {}),
      skills: profile.skills.map((skill) => ({ id: skill.id, name: skill.name, content: `${skill.description}\n${skill.content}` })),
      ...(profile.instructions ? { instructions: profile.instructions } : {}),
      ...(profile.companyContext ? { companyContext: profile.companyContext } : {}),
      ...(profile.salaryExpectation ? { salaryExpectation: profile.salaryExpectation } : {}),
      expressionLevel: profile.expressionLevel,
      explainAdvancedTerms: profile.explainAdvancedTerms
    },
    ...(target ? { target: { id: target.id, name: target.name, description: target.description, requirements: target.requirements.map((item) => ({ requirement: item.requirement, category: item.category, importance: item.importance })) } } : {})
  };
}
