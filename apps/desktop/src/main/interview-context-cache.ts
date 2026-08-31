import type { AnswerContextInput } from "@interview-copilot/shared";

export interface InterviewContextCacheKey {
  profileId: string;
  projectId?: string;
  jobTargetId?: string;
}

function keyOf(key: InterviewContextCacheKey): string {
  return [key.profileId, key.projectId ?? "", key.jobTargetId ?? ""].join("|");
}

function cloneContext(context: AnswerContextInput): AnswerContextInput {
  return {
    ...context,
    ...(context.selfIntroduction ? { selfIntroduction: { ...context.selfIntroduction } } : {}),
    skills: context.skills?.map((item) => ({ ...item })),
    experienceContext: [...(context.experienceContext ?? [])],
    personalMemoryEvidence: [...(context.personalMemoryEvidence ?? [])],
    retrievedKnowledge: [...(context.retrievedKnowledge ?? [])],
    projectEvidence: [...(context.projectEvidence ?? [])],
    verifiedResumeEvidence: [...(context.verifiedResumeEvidence ?? [])],
    verifiedPersonalProjectFacts: [...(context.verifiedPersonalProjectFacts ?? [])],
    recentTranscript: [...(context.recentTranscript ?? [])]
  };
}

/** Session-scoped immutable base context reused by every interview turn. */
export class InterviewContextCache {
  private readonly entries = new Map<string, AnswerContextInput>();
  private activeKey: string | undefined;

  prepare(key: InterviewContextCacheKey, context: AnswerContextInput): void {
    const cacheKey = keyOf(key);
    this.entries.set(cacheKey, cloneContext({ ...context, contextMode: "fast" }));
    this.activeKey = cacheKey;
  }

  get(key: InterviewContextCacheKey): AnswerContextInput | undefined {
    const value = this.entries.get(keyOf(key));
    return value ? cloneContext(value) : undefined;
  }

  getActive(): AnswerContextInput | undefined {
    const value = this.activeKey ? this.entries.get(this.activeKey) : undefined;
    return value ? cloneContext(value) : undefined;
  }

  invalidate(key?: InterviewContextCacheKey): void {
    if (!key) {
      this.entries.clear();
      this.activeKey = undefined;
      return;
    }
    const cacheKey = keyOf(key);
    this.entries.delete(cacheKey);
    if (this.activeKey === cacheKey) this.activeKey = undefined;
  }

  release(): void { this.invalidate(); }
}
