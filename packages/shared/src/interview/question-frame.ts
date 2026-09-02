import type { QuestionSlot } from "../question/question-decomposer";

export type QuestionFrameSpeechAct =
  | "QUESTION"
  | "FOLLOW_UP"
  | "CLARIFICATION"
  | "CONFIRMATION_CHECK"
  | "BACKCHANNEL"
  | "RHETORICAL"
  | "ADVICE"
  | "EXPLANATION"
  | "FEEDBACK"
  | "TOPIC_TRANSITION"
  | "CONTROL"
  | "FILLER"
  | "ASR_UNRESOLVED";

export type QuestionFrameCompletion =
  | "OPEN"
  | "WAITING_SUBJECT"
  | "WAITING_OBJECT"
  | "WAITING_CONSTRAINT"
  | "WAITING_REFERENCE"
  | "ASR_UNCERTAIN"
  | "COMPLETE";

export type QuestionFrameRelation = "NEW_TOPIC" | "SAME_TOPIC" | "FOLLOW_UP" | "CLARIFICATION";
export type QuestionFrameType = "PROJECT" | "TECHNICAL" | "BEHAVIORAL" | "RESUME" | "GENERAL";
export type QuestionFrameCommitStatus = "BUFFERING" | "WAITING" | "READY" | "COMMITTED" | "REJECTED";
export type QuestionFrameStabilityState = "BUFFERING" | "STABILIZING" | "STABLE" | "UNRESOLVED";

export type QuestionRequirementType =
  | "definition"
  | "principle"
  | "difference"
  | "reason"
  | "implementation"
  | "architecture"
  | "process"
  | "example"
  | "tradeoff"
  | "verification"
  | "debugging"
  | "complexity"
  | "project_fact";

export interface QuestionRequirement {
  id: string;
  type: QuestionRequirementType;
  description: string;
  required: boolean;
}

export interface ActiveProjectContext {
  id: string;
  name: string;
  lockState: "UNRESOLVED" | "CANDIDATE" | "LOCKED" | "SWITCH_PENDING" | "CONFLICT";
  confidence: number;
  entities: string[];
  topics: string[];
  lockedAt?: number;
  source?: "interviewer" | "candidate" | "manual" | "resume" | "inherited";
}

export interface EntityAnchor {
  value: string;
  type: "project" | "component" | "technology" | "concept";
  confidence: number;
  source: string;
  createdAt: number;
}

export interface ReferenceCandidate {
  raw: string;
  resolved?: string;
  type?: "project" | "component" | "technology" | "concept" | "question" | "answer";
  confidence: number;
  evidence: string[];
}

export interface AsrAmbiguity {
  raw: string;
  candidates: string[];
  confidence: number;
  reason: string;
}

export interface AnswerFrame {
  id: string;
  questionId: string;
  text: string;
  createdAt: number;
}

export interface QuestionThread {
  id: string;
  rootQuestionId: string;
  questionIds: string[];
  topic?: string;
  projectId?: string;
}

export interface QuestionThreadState {
  id: string;
  rootQuestionId?: string;
  questionIds: string[];
  projectId?: string;
  topic?: string;
  component?: string;
  technology?: string;
  lastQuestionId?: string;
  lastAnswerId?: string;
  updatedAt: number;
}

export interface QuestionContextReference {
  raw: string;
  resolved: string;
  type: string;
  confidence: number;
}

export interface QuestionContextSnapshot {
  id: string;
  sessionId: string;
  capturedAt: number;
  project?: ActiveProjectContext;
  topic?: string;
  activeEntities: EntityAnchor[];
  parentQuestion?: { id?: string; text: string };
  rootQuestion?: { id?: string; text: string };
  recentRelevantTurns: string[];
  references: QuestionContextReference[];
  inherited: { project?: string; topic?: string; component?: string; technology?: string };
}

export interface InterviewContextState {
  sessionId: string;
  activeProject?: ActiveProjectContext;
  currentTopic?: { name: string; confidence: number; updatedAt: number };
  activeEntities: EntityAnchor[];
  pendingQuestion?: QuestionFrame;
  pendingFragments: PendingInterviewerTurn[];
  lastCommittedQuestion?: QuestionFrame;
  lastAnsweredQuestion?: QuestionFrame;
  recentQuestions: QuestionFrame[];
  recentAnswers: AnswerFrame[];
  unresolvedReferences: ReferenceCandidate[];
  unresolvedAsr: AsrAmbiguity[];
  currentThread?: QuestionThreadState;
  threads: QuestionThreadState[];
  sessionMemo: {
    projectsDiscussed: string[];
    topicsDiscussed: string[];
    interviewerFocus: string[];
    verifiedCandidateClaims: string[];
  };
}

export interface ContextResolution {
  rawText: string;
  references: QuestionContextReference[];
  inherited: { project?: string; topic?: string; component?: string; technology?: string };
  canonicalQuestion: string;
  confidence: number;
  unresolved: string[];
}

export interface AsrCandidateResolution {
  canonicalText: string;
  corrections: Array<{ raw: string; canonical: string; confidence: number; reason: string }>;
  candidates: Array<{ raw: string; candidate: string; confidence: number; reason: string }>;
  confidence: number;
  unresolved: string[];
}

export interface PendingInterviewerTurn {
  segmentIds: string[];
  rawSegments: string[];
  rawCombinedText: string;
  speaker: "interviewer" | "candidate";
  firstSeenAt: number;
  lastUpdatedAt: number;
}

export interface QuestionFrameEntities {
  projects: string[];
  components: string[];
  technologies: string[];
  concepts: string[];
}

export interface QuestionFrameConfidence {
  speechAct: number;
  completion: number;
  reference: number;
  project: number;
  asr: number;
  overall: number;
}

export interface QuestionFrame {
  id: string;
  segmentIds: string[];
  rawSegments: string[];
  rawCombinedText: string;
  normalizedText: string;
  canonicalQuestion: string;
  speechAct: QuestionFrameSpeechAct;
  completion: QuestionFrameCompletion;
  stabilityState: QuestionFrameStabilityState;
  relation: QuestionFrameRelation;
  questionType: QuestionFrameType;
  intent: string;
  subQuestions: QuestionSlot[];
  requirements: QuestionRequirement[];
  entities: QuestionFrameEntities;
  references: ReferenceCandidate[];
  contextSnapshot: QuestionContextSnapshot;
  projectId?: string;
  confidence: QuestionFrameConfidence;
  commitStatus: QuestionFrameCommitStatus;
  unresolvedSlots: string[];
  asrRepair?: { raw: string; canonical: string; confidence: number; reason: string };
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export interface PendingQuestionLedgerItem {
  frame: QuestionFrame;
  firstSeenAt: number;
  lastUpdatedAt: number;
  unresolvedSlots: string[];
  status: "WAITING_CONTEXT" | "WAITING_ASR_REPAIR" | "WAITING_REFERENCE" | "READY";
  expiryReason?: string;
}

export interface InterviewUnderstandingState {
  sessionId: string;
  currentSpeaker?: "interviewer" | "candidate";
  previousSpeaker?: "interviewer" | "candidate";
  pendingTurn?: PendingInterviewerTurn;
  pendingQuestion?: QuestionFrame;
  activeProject?: ActiveProjectContext;
  currentTopic?: { name: string; confidence: number; createdAt: number };
  activeEntities: EntityAnchor[];
  questionThread?: QuestionThread;
  lastCommittedQuestion?: QuestionFrame;
  lastAnsweredQuestion?: QuestionFrame;
  recentQuestions: QuestionFrame[];
  recentAnswers: AnswerFrame[];
  unresolvedReferences: ReferenceCandidate[];
  unresolvedAsr: AsrAmbiguity[];
  pendingLedger: PendingQuestionLedgerItem[];
  /** Unified structured context consumed by diagnostics and answer routing. */
  context: InterviewContextState;
}
