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
  relation: QuestionFrameRelation;
  questionType: QuestionFrameType;
  intent: string;
  subQuestions: QuestionSlot[];
  entities: QuestionFrameEntities;
  references: ReferenceCandidate[];
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
}

