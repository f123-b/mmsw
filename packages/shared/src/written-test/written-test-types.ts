export const WRITTEN_QUESTION_TYPES = [
  "SINGLE_CHOICE", "MULTIPLE_CHOICE", "SHORT_ANSWER", "CALCULATION", "ALGORITHM",
  "PROGRAMMING", "CODE_READING", "CODE_DEBUGGING", "DIGITAL_LOGIC", "FLOWCHART",
  "STATE_MACHINE", "SEQUENCE_DIAGRAM", "SYSTEM_DESIGN", "DATABASE_SQL", "NETWORK",
  "OPERATING_SYSTEM", "C_CPP", "EMBEDDED", "UNKNOWN"
] as const;

export type WrittenQuestionType = typeof WRITTEN_QUESTION_TYPES[number];
export type WrittenProblemRelation = "NEW_QUESTION" | "CONTINUATION" | "REPLACE_SCREENSHOT";
export type WrittenSessionStatus = "RUNNING" | "COMPLETED" | "ABORTED";
export type WrittenScreenshotStatus = "IDLE" | "CAPTURING" | "ANALYZING" | "SOLVING" | "SUCCESS" | "NEEDS_INPUT" | "REVIEW" | "ERROR";

export interface WrittenRequestedArtifacts {
  code?: boolean;
  diagram?: boolean;
  table?: boolean;
  formula?: boolean;
  derivation?: boolean;
}

export interface WrittenProblemFrame {
  rawText: string;
  canonicalQuestion: string;
  questionType: WrittenQuestionType;
  language?: string;
  requirements: string[];
  inputs: string[];
  outputs: string[];
  constraints: string[];
  codeContext?: string;
  formulas: string[];
  requestedArtifacts: WrittenRequestedArtifacts;
  confidence: number;
}

export interface DiagramNode {
  id: string;
  label: string;
  shape: "rectangle" | "rounded" | "diamond" | "circle" | "and" | "or" | "not" | "xor";
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  kind: "FLOWCHART" | "LOGIC" | "STATE" | "SEQUENCE" | "ARCHITECTURE" | "DIGITAL_LOGIC";
  title?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface WrittenAnswerStep {
  title: string;
  content: string;
}

export interface WrittenAnswerDocument {
  questionType: WrittenQuestionType;
  finalAnswer: string;
  steps: WrittenAnswerStep[];
  code?: { language: string; content: string };
  equations: string[];
  table?: { columns: string[]; rows: string[][] };
  diagram?: DiagramSpec;
  explanation: string;
  complexity?: string;
  warnings: string[];
  confidence: number;
}

export interface WrittenTestSession {
  id: string;
  profileId: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  status: WrittenSessionStatus;
  answerMode: "FAST" | "NORMAL" | "DEEP";
  questionCount: number;
  screenshotCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface WrittenTestScreenshot {
  id: string;
  sessionId: string;
  questionId?: string;
  filePath: string;
  thumbnailPath?: string;
  mimeType: "image/png" | "image/jpeg";
  sha256: string;
  width?: number;
  height?: number;
  capturedAt: number;
}

export interface WrittenTestQuestion {
  id: string;
  sessionId: string;
  sequence: number;
  screenshotIds: string[];
  rawQuestionText: string;
  normalizedQuestion: string;
  questionType: WrittenQuestionType;
  requirements: string[];
  answer?: WrittenAnswerDocument;
  answerText?: string;
  confidence: number;
  model?: string;
  latencyMs?: number;
  createdAt: number;
  finishedAt?: number;
}

export interface WrittenTestSessionDetail {
  session: WrittenTestSession;
  questions: WrittenTestQuestion[];
  screenshots: WrittenTestScreenshot[];
}

export interface WrittenTestResult {
  problem: WrittenProblemFrame;
  answer: WrittenAnswerDocument;
  inputStatus: "COMPLETE" | "NEEDS_INPUT";
  missingInformation: string[];
}
