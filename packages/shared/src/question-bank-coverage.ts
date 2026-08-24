export interface QuestionBankCoverageSkillPoint {
  id: string;
  title: string;
  verified?: boolean;
}

export interface QuestionBankCoverageSkill {
  id: string;
  name: string;
  points?: QuestionBankCoverageSkillPoint[];
}

export interface QuestionBankCoverageQuestion {
  skillIds: string[];
  coveredPointIds?: string[];
  verified: boolean;
  stale?: boolean;
  answerCards?: Array<{ content: string; verified: boolean; stale?: boolean }>;
}

export interface QuestionBankCoverageTopic {
  skillId: string;
  skill: string;
  totalQuestions: number;
  answeredQuestions: number;
  verifiedQuestions: number;
  staleQuestions: number;
  coverage: number;
  missingAreas: string[];
}

export interface QuestionBankCoverageResult {
  jobProfileId?: string;
  overallCoverage: number;
  topics: QuestionBankCoverageTopic[];
  missingSkills: string[];
  generatedAt: number;
}

export function calculateQuestionBankCoverage(input: { skills: QuestionBankCoverageSkill[]; questions: QuestionBankCoverageQuestion[]; skillIds?: string[]; jobProfileId?: string; now?: number }): QuestionBankCoverageResult {
  const selected = new Set(input.skillIds ?? input.skills.map((skill) => skill.id));
  const topics = input.skills.filter((skill) => selected.has(skill.id)).map((skill) => {
    const questions = input.questions.filter((question) => question.skillIds.includes(skill.id));
    const answered = questions.filter((question) => (question.answerCards ?? []).some((card) => card.content.trim() && !card.stale)).length;
    const verified = questions.filter((question) => question.verified || (question.answerCards ?? []).some((card) => card.verified && !card.stale)).length;
    const stale = questions.filter((question) => question.stale || (question.answerCards ?? []).some((card) => card.stale)).length;
    const linkedTitles = new Set(questions.flatMap((question) => question.coveredPointIds ?? []));
    const missingAreas = (skill.points ?? []).filter((point) => !linkedTitles.has(point.id)).map((point) => point.title).slice(0, 8);
    const denominator = Math.max(questions.length, skill.points?.length ?? 0, 1);
    return { skillId: skill.id, skill: skill.name, totalQuestions: questions.length, answeredQuestions: answered, verifiedQuestions: verified, staleQuestions: stale, coverage: Math.round((verified / denominator) * 100), missingAreas };
  });
  const overallCoverage = topics.length ? Math.round(topics.reduce((sum, topic) => sum + topic.coverage, 0) / topics.length) : 0;
  return { ...(input.jobProfileId ? { jobProfileId: input.jobProfileId } : {}), overallCoverage, topics, missingSkills: topics.filter((topic) => topic.coverage < 60).map((topic) => topic.skill), generatedAt: input.now ?? Date.now() };
}
