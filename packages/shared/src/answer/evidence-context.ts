import type { InterviewMemorySnapshot } from "../interview-memory";
import type { CandidateStatementEvidence } from "./session-evidence";

export type EvidenceSource = "personal" | "project" | "retrieval" | "profile" | "job" | "candidate_statement";
export type EvidenceTrust = "personal" | "project" | "reference";

export interface EvidenceItem {
  id: string;
  text: string;
  source: EvidenceSource;
  trust: EvidenceTrust;
  verified: boolean;
  sourceId?: string;
  projectId?: string;
}

export interface EvidenceSnapshotInput {
  questionId: string;
  profileId?: string;
  projectId?: string;
  jobTargetId?: string;
  profileSummary?: string;
  jobDescriptionSummary?: string;
  profileInstructions?: string;
  currentProject?: string;
  currentModule?: string;
  currentTopic?: string;
  capturedAt?: number;
  personalMemoryEvidence?: readonly string[];
  experienceContext?: readonly string[];
  projectEvidence?: readonly string[];
  verifiedResumeEvidence?: readonly string[];
  verifiedPersonalProjectFacts?: readonly string[];
  retrievedKnowledge?: readonly string[];
  recentTranscript?: readonly string[];
  interviewMemory?: InterviewMemorySnapshot;
  sessionEvidence?: readonly CandidateStatementEvidence[];
  candidateStatements?: readonly CandidateStatementEvidence[];
}

export interface EvidenceSnapshot {
  id: string;
  questionId: string;
  capturedAt: number;
  profileId?: string;
  projectId?: string;
  jobTargetId?: string;
  profileSummary?: string;
  jobDescriptionSummary?: string;
  profileInstructions?: string;
  currentProject?: string;
  currentModule?: string;
  currentTopic?: string;
  personalMemoryEvidence: string[];
  experienceContext: string[];
  projectEvidence: string[];
  verifiedResumeEvidence?: string[];
  verifiedPersonalProjectFacts?: string[];
  retrievedKnowledge: string[];
  recentTranscript: string[];
  interviewMemory?: InterviewMemorySnapshot;
  sessionEvidence?: CandidateStatementEvidence[];
  candidateStatements?: CandidateStatementEvidence[];
  items: EvidenceItem[];
  fingerprint: string;
}

function clean(values: readonly string[] | undefined, limit: number): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, limit);
}

function hash(text: string): string {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

function cloneMemory(memory?: InterviewMemorySnapshot): InterviewMemorySnapshot | undefined {
  if (!memory) return undefined;
  return {
    ...memory,
    recentQuestions: [...memory.recentQuestions],
    recentAnswers: [...memory.recentAnswers],
    topics: [...memory.topics],
    entities: [...memory.entities],
    turns: memory.turns.map((turn) => ({ ...turn })),
    ...(memory.entries ? { entries: memory.entries.map((entry) => ({ ...entry })) } : {})
  };
}

function cloneSnapshot(snapshot: EvidenceSnapshot): EvidenceSnapshot {
  return {
    ...snapshot,
    personalMemoryEvidence: [...snapshot.personalMemoryEvidence],
    experienceContext: [...snapshot.experienceContext],
    projectEvidence: [...snapshot.projectEvidence],
    verifiedResumeEvidence: [...(snapshot.verifiedResumeEvidence ?? [])],
    verifiedPersonalProjectFacts: [...(snapshot.verifiedPersonalProjectFacts ?? [])],
    retrievedKnowledge: [...snapshot.retrievedKnowledge],
    recentTranscript: [...snapshot.recentTranscript],
    sessionEvidence: (snapshot.sessionEvidence ?? []).map((item) => ({ ...item, extractedClaims: item.extractedClaims.map((claim) => ({ ...claim })) })),
    candidateStatements: (snapshot.candidateStatements ?? []).map((item) => ({ ...item, extractedClaims: item.extractedClaims.map((claim) => ({ ...claim })) })),
    items: snapshot.items.map((item) => ({ ...item })),
    ...(snapshot.interviewMemory ? { interviewMemory: cloneMemory(snapshot.interviewMemory) } : {})
  };
}

/** Creates an immutable-by-convention evidence view for one answer request. */
export function createEvidenceSnapshot(input: EvidenceSnapshotInput): EvidenceSnapshot {
  const personalMemoryEvidence = clean(input.personalMemoryEvidence, 12);
  const experienceContext = clean(input.experienceContext, 12);
  const projectEvidence = clean(input.projectEvidence ?? input.personalMemoryEvidence ?? input.experienceContext, 20);
  const verifiedResumeEvidence = clean(input.verifiedResumeEvidence, 12);
  const verifiedPersonalProjectFacts = clean(input.verifiedPersonalProjectFacts, 12);
  const retrievedKnowledge = clean(input.retrievedKnowledge, 20);
  const recentTranscript = clean(input.recentTranscript, 12);
  const statementMap = new Map<string, CandidateStatementEvidence>();
  [...(input.sessionEvidence ?? []), ...(input.candidateStatements ?? [])].forEach((item) => {
    if (!statementMap.has(item.id)) statementMap.set(item.id, { ...item, extractedClaims: item.extractedClaims.map((claim) => ({ ...claim })) });
  });
  const sessionEvidence = [...statementMap.values()].slice(-24);
  const candidateStatements = sessionEvidence.map((item) => ({ ...item, extractedClaims: item.extractedClaims.map((claim) => ({ ...claim })) }));
  const items: EvidenceItem[] = [];
  const add = (values: string[], source: EvidenceSource, trust: EvidenceTrust, verified: boolean): void => {
    values.forEach((text, index) => items.push({ id: `${source}-${index}`, text, source, trust, verified, ...(input.projectId ? { projectId: input.projectId } : {}) }));
  };
  if (input.profileSummary?.trim()) add([input.profileSummary], "profile", "personal", true);
  if (input.jobDescriptionSummary?.trim()) add([input.jobDescriptionSummary], "job", "reference", true);
  add(personalMemoryEvidence, "personal", "personal", true);
  add(experienceContext, "personal", "personal", true);
  add(verifiedResumeEvidence, "profile", "personal", true);
  add(verifiedPersonalProjectFacts, "personal", "personal", true);
  add(projectEvidence, "project", "project", true);
  add(retrievedKnowledge, "retrieval", "reference", false);
  sessionEvidence.forEach((item) => items.push({ ...item, sourceId: item.sessionId }));
  const capturedAt = input.capturedAt ?? Date.now();
  const fingerprint = hash(JSON.stringify({ questionId: input.questionId, profileId: input.profileId, projectId: input.projectId, jobTargetId: input.jobTargetId, profileSummary: input.profileSummary, jobDescriptionSummary: input.jobDescriptionSummary, profileInstructions: input.profileInstructions, currentProject: input.currentProject, currentModule: input.currentModule, currentTopic: input.currentTopic, personalMemoryEvidence, experienceContext, verifiedResumeEvidence, verifiedPersonalProjectFacts, projectEvidence, retrievedKnowledge, recentTranscript, sessionEvidence }));
  return {
    id: `evidence-snapshot-${input.questionId}-${fingerprint}`,
    questionId: input.questionId,
    capturedAt,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.jobTargetId ? { jobTargetId: input.jobTargetId } : {}),
    ...(input.profileSummary ? { profileSummary: input.profileSummary } : {}),
    ...(input.jobDescriptionSummary ? { jobDescriptionSummary: input.jobDescriptionSummary } : {}),
    ...(input.profileInstructions ? { profileInstructions: input.profileInstructions } : {}),
    ...(input.currentProject ? { currentProject: input.currentProject } : {}),
    ...(input.currentModule ? { currentModule: input.currentModule } : {}),
    ...(input.currentTopic ? { currentTopic: input.currentTopic } : {}),
    personalMemoryEvidence,
    experienceContext,
    projectEvidence,
    verifiedResumeEvidence,
    verifiedPersonalProjectFacts,
    retrievedKnowledge,
    recentTranscript,
    sessionEvidence,
    candidateStatements,
    ...(input.interviewMemory ? { interviewMemory: cloneMemory(input.interviewMemory) } : {}),
    items,
    fingerprint
  };
}

/**
 * Locks the first evidence view for a question. Repeated retries or later
 * provider calls receive a clone of the original snapshot, never live data.
 */
export class ContextLock {
  private readonly snapshots = new Map<string, EvidenceSnapshot>();

  private readonly maxSnapshots: number;

  constructor(maxSnapshots = 64) {
    this.maxSnapshots = Math.max(1, maxSnapshots);
  }

  lock(input: EvidenceSnapshotInput): EvidenceSnapshot;
  lock(questionId: string, input: Omit<EvidenceSnapshotInput, "questionId">): EvidenceSnapshot;
  lock(inputOrQuestionId: EvidenceSnapshotInput | string, partial?: Omit<EvidenceSnapshotInput, "questionId">): EvidenceSnapshot {
    const input: EvidenceSnapshotInput = typeof inputOrQuestionId === "string"
      ? { ...partial, questionId: inputOrQuestionId }
      : inputOrQuestionId;
    const existing = this.snapshots.get(input.questionId);
    if (existing) return cloneSnapshot(existing);
    const snapshot = createEvidenceSnapshot(input);
    while (this.snapshots.size >= this.maxSnapshots) {
      const oldest = this.snapshots.keys().next().value;
      if (typeof oldest !== "string") break;
      this.snapshots.delete(oldest);
    }
    this.snapshots.set(input.questionId, snapshot);
    return cloneSnapshot(snapshot);
  }

  get(questionId: string): EvidenceSnapshot | undefined {
    const snapshot = this.snapshots.get(questionId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  has(questionId: string): boolean { return this.snapshots.has(questionId); }
  get size(): number { return this.snapshots.size; }
  release(questionId: string): void { this.snapshots.delete(questionId); }
  clear(): void { this.snapshots.clear(); }
}

export { ContextLock as EvidenceContextLock };
