import type { AnswerMode, AnswerTelemetry } from "./answer";
import type { TerminologyCorrection } from "./terminology";
import type { QuestionSemanticFrame } from "./question/semantic-frame";

export type InterviewStatus = "created" | "running" | "ended" | "error";
export type HistoryQuestionStatus = "candidate" | "confirmed" | "answering" | "superseded" | "answered" | "ignored";

export interface InterviewRecord {
  id: string;
  profileId: string;
  projectId?: string;
  jobTargetId?: string;
  startedAt: number;
  endedAt?: number;
  status: InterviewStatus;
  language: string;
  automationMode: "MANUAL" | "AUTO";
  createdAt: number;
}

export interface TranscriptRecord {
  id: string;
  interviewId: string;
  source: "mic" | "remote";
  text: string;
  rawText?: string;
  normalizedText?: string;
  canonicalText?: string;
  terminologyCorrections?: TerminologyCorrection[];
  startMs: number;
  endMs: number;
  final: boolean;
  confidence?: number;
  createdAt: number;
}

export interface QuestionRecord {
  id: string;
  interviewId: string;
  text: string;
  confidence: "low" | "medium" | "high";
  source: "rules" | "extractor";
  detectedAt: number;
  status: HistoryQuestionStatus;
  parentQuestionId?: string;
  rootQuestionId?: string;
  rawTranscript?: string;
  normalizedQuestion?: string;
  canonicalQuestion?: string;
  contextRelation?: "standalone" | "follow_up" | "continuation" | "repair" | "topic_announcement" | "instruction_modifier";
  inheritedTopic?: string;
  topic?: string;
  terminologyCorrections?: TerminologyCorrection[];
  semanticFrame?: QuestionSemanticFrame;
  groupId?: string;
  relationType?: "ASR_REVISION" | "SAME_QUESTION_AUGMENTATION" | "ANSWER_CONSTRAINT" | "EXAMPLE" | "PARALLEL_SUBQUESTION" | "FOLLOW_UP" | "NEW_TOPIC";
  threadItemType?: string;
}

export interface HistoryChangedEvent {
  interviewId: string;
  revision: number;
  type: "transcript" | "question" | "answer" | "state";
  createdAt?: number;
}

export interface AnswerRecord {
  id: string;
  questionId: string;
  text: string;
  model: string;
  mode?: AnswerMode;
  latencyFirstToken?: number;
  latencyTotal?: number;
  startedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
  cancelReason?: "user" | "superseded" | "timeout";
  telemetry?: AnswerTelemetry;
  groupId?: string;
  relation?: "PRIMARY" | "AUGMENTATION" | "FOLLOW_UP" | "PARALLEL_SUBQUESTION";
  answerRunId?: string;
  createdAt: number;
}

export interface InterviewSnapshot {
  interview: InterviewRecord;
  transcripts: TranscriptRecord[];
  questions: QuestionRecord[];
  answers: AnswerRecord[];
}

function id(prefix: string, now: number): string { return `${prefix}-${now}-${Math.random().toString(36).slice(2, 7)}`; }

export class InterviewHistoryStore {
  private readonly interviews = new Map<string, InterviewRecord>();
  private readonly transcripts: TranscriptRecord[] = [];
  private readonly questions: QuestionRecord[] = [];
  private readonly answers: AnswerRecord[] = [];
  private readonly runtimeContexts = new Map<string, { context: unknown; updatedAt: number }>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<(event: HistoryChangedEvent) => void>();

  onChanged(listener: (event: HistoryChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getRevision(interviewId: string): number { return this.revisions.get(interviewId) ?? 0; }

  createInterview(input: Omit<InterviewRecord, "id" | "createdAt">, now = Date.now()): InterviewRecord {
    const interview = { ...input, id: id("interview", now), createdAt: now };
    this.interviews.set(interview.id, interview);
    this.emitChanged(interview.id, "state");
    return { ...interview };
  }

  endInterview(interviewId: string, status: "ended" | "error" = "ended", endedAt = Date.now()): InterviewRecord {
    const interview = this.requireInterview(interviewId);
    const next = { ...interview, status, endedAt };
    this.interviews.set(interviewId, next);
    this.emitChanged(interviewId, "state");
    return { ...next };
  }

  addTranscript(input: Omit<TranscriptRecord, "id" | "createdAt">, now = Date.now()): TranscriptRecord | undefined {
    if (!input.final) return undefined;
    const record = { ...input, id: id("transcript", now), createdAt: now };
    this.transcripts.push(record);
    this.emitChanged(record.interviewId, "transcript");
    return { ...record };
  }

  addQuestion(input: Omit<QuestionRecord, "id">): QuestionRecord {
    const record = { ...input, id: id("question", input.detectedAt) };
    this.questions.push(record);
    this.emitChanged(record.interviewId, "question");
    return { ...record };
  }

  updateQuestionStatus(questionId: string, status: HistoryQuestionStatus): QuestionRecord | undefined {
    const index = this.questions.findIndex((question) => question.id === questionId);
    if (index < 0) return undefined;
    const next = { ...this.questions[index], status };
    this.questions[index] = next;
    this.emitChanged(next.interviewId, "question");
    return { ...next };
  }

  addAnswer(input: Omit<AnswerRecord, "id">): AnswerRecord {
    const record = { ...input, id: id("answer", input.createdAt) };
    this.answers.push(record);
    const interviewId = this.questions.find((question) => question.id === record.questionId)?.interviewId;
    if (interviewId) this.emitChanged(interviewId, "answer");
    return { ...record };
  }

  saveRuntimeContext(interviewId: string, context: unknown, now = Date.now()): void {
    this.runtimeContexts.set(interviewId, { context, updatedAt: now });
    this.emitChanged(interviewId, "state");
  }

  getRuntimeContext<T = unknown>(interviewId: string): T | undefined {
    return this.runtimeContexts.get(interviewId)?.context as T | undefined;
  }

  snapshot(interviewId: string): InterviewSnapshot {
    return {
      interview: { ...this.requireInterview(interviewId) },
      transcripts: this.transcripts.filter((record) => record.interviewId === interviewId).map((record) => ({ ...record })),
      questions: this.questions.filter((record) => record.interviewId === interviewId).map((record) => ({ ...record })),
      answers: this.answers.filter((record) => this.questions.find((question) => question.id === record.questionId)?.interviewId === interviewId).map((record) => ({ ...record }))
    };
  }

  listInterviews(): InterviewRecord[] { return [...this.interviews.values()].sort((left, right) => right.createdAt - left.createdAt).map((record) => ({ ...record })); }

  private requireInterview(interviewId: string): InterviewRecord {
    const interview = this.interviews.get(interviewId);
    if (!interview) throw new Error(`Interview not found: ${interviewId}`);
    return interview;
  }

  private emitChanged(interviewId: string, type: HistoryChangedEvent["type"]): void {
    const revision = (this.revisions.get(interviewId) ?? 0) + 1;
    this.revisions.set(interviewId, revision);
    const event = { interviewId, revision, type, createdAt: Date.now() } satisfies HistoryChangedEvent;
    this.listeners.forEach((listener) => listener(event));
  }
}

export interface InterviewMetrics {
  durationMs: number;
  remoteTranscriptCount: number;
  micTranscriptCount: number;
  remoteWordCount: number;
  micWordCount: number;
  questionCount: number;
  answeredQuestionCount: number;
  answerRate: number;
  averageFirstTokenMs?: number;
  averageAnswerLatencyMs?: number;
}

function wordCount(text: string): number { return text.trim().split(/\s+|(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])/).filter(Boolean).length; }

export function analyzeInterview(snapshot: InterviewSnapshot): InterviewMetrics {
  const remote = snapshot.transcripts.filter((record) => record.source === "remote");
  const mic = snapshot.transcripts.filter((record) => record.source === "mic");
  const answered = snapshot.questions.filter((question) => question.status === "answered" || snapshot.answers.some((answer) => answer.questionId === question.id));
  const firstTokens = snapshot.answers.map((answer) => answer.latencyFirstToken).filter((value): value is number => value !== undefined);
  const totalLatencies = snapshot.answers.map((answer) => answer.latencyTotal).filter((value): value is number => value !== undefined);
  return {
    durationMs: Math.max(0, (snapshot.interview.endedAt ?? Date.now()) - snapshot.interview.startedAt),
    remoteTranscriptCount: remote.length,
    micTranscriptCount: mic.length,
    remoteWordCount: remote.reduce((sum, record) => sum + wordCount(record.text), 0),
    micWordCount: mic.reduce((sum, record) => sum + wordCount(record.text), 0),
    questionCount: snapshot.questions.length,
    answeredQuestionCount: answered.length,
    answerRate: snapshot.questions.length ? answered.length / snapshot.questions.length : 0,
    averageFirstTokenMs: firstTokens.length ? firstTokens.reduce((sum, value) => sum + value, 0) / firstTokens.length : undefined,
    averageAnswerLatencyMs: totalLatencies.length ? totalLatencies.reduce((sum, value) => sum + value, 0) / totalLatencies.length : undefined
  };
}

export const RECOVERY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export class SessionRecovery {
  private attempt = 0;
  nextDelayMs(): number { const delay = RECOVERY_DELAYS_MS[Math.min(this.attempt, RECOVERY_DELAYS_MS.length - 1)]; this.attempt += 1; return delay; }
  reset(): void { this.attempt = 0; }
}

export interface UpdateManifest {
  version: string;
  url: string;
  sha256: string;
  signature: string;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part) || 0);
  const b = right.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function isSafeUpdate(currentVersion: string, manifest: UpdateManifest): boolean {
  return Boolean(manifest.url && /^[a-f0-9]{64}$/i.test(manifest.sha256) && manifest.signature.length > 0 && compareVersions(manifest.version, currentVersion) > 0);
}
