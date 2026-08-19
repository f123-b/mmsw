export const SESSION_STATES = [
  "IDLE",
  "CREATING",
  "CONNECTING",
  "READY",
  "RUNNING",
  "RECONNECTING",
  "ENDING",
  "ENDED",
  "ERROR"
] as const;

export type SessionState = typeof SESSION_STATES[number];

const transitions: Record<SessionState, readonly SessionState[]> = {
  IDLE: ["CREATING"],
  CREATING: ["CONNECTING", "ERROR"],
  CONNECTING: ["READY", "RECONNECTING", "ERROR"],
  READY: ["RUNNING", "ENDING", "ERROR"],
  RUNNING: ["RECONNECTING", "ENDING", "ERROR"],
  RECONNECTING: ["CONNECTING", "ENDING", "ERROR"],
  ENDING: ["ENDED", "ERROR"],
  ENDED: ["CREATING", "IDLE"],
  ERROR: ["CREATING", "IDLE", "ENDING"]
};

export class InvalidSessionTransitionError extends Error {
  constructor(public readonly from: SessionState, public readonly to: SessionState) {
    super(`Invalid session transition: ${from} → ${to}`);
    this.name = "InvalidSessionTransitionError";
  }
}

export class SessionStateMachine {
  private currentState: SessionState;
  private readonly listeners = new Set<(state: SessionState) => void>();

  constructor(initialState: SessionState = "IDLE") {
    this.currentState = initialState;
  }

  get state(): SessionState {
    return this.currentState;
  }

  canTransition(to: SessionState): boolean {
    return transitions[this.currentState].includes(to);
  }

  transition(to: SessionState): SessionState {
    if (!this.canTransition(to)) {
      throw new InvalidSessionTransitionError(this.currentState, to);
    }
    this.currentState = to;
    this.listeners.forEach((listener) => listener(to));
    return to;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function normalizeMeter(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

import type { TranscriptSegment, TranscriptSource } from "@interview-copilot/protocol";

export interface TranscriptSnapshot {
  source: TranscriptSource;
  final: TranscriptSegment[];
  partial?: TranscriptSegment;
}

export interface TranscriptUpdate {
  segment: TranscriptSegment;
  snapshot: TranscriptSnapshot;
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class TranscriptStabilizer {
  private readonly finals: Record<TranscriptSource, TranscriptSegment[]> = { mic: [], remote: [] };
  private readonly partials: Partial<Record<TranscriptSource, TranscriptSegment>> = {};

  upsert(segment: TranscriptSegment): TranscriptUpdate {
    const normalized = { ...segment, text: normalizeTranscriptText(segment.text) };
    if (normalized.final) {
      delete this.partials[normalized.source];
      const list = this.finals[normalized.source];
      const existingIndex = list.findIndex((item) => item.id === normalized.id);
      if (existingIndex >= 0) list[existingIndex] = normalized;
      else if (!list.some((item) => item.text === normalized.text && item.endMs === normalized.endMs)) list.push(normalized);
      list.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    } else {
      this.partials[normalized.source] = normalized;
    }
    return { segment: normalized, snapshot: this.snapshot(normalized.source) };
  }

  snapshot(source: TranscriptSource): TranscriptSnapshot {
    const partial = this.partials[source];
    return { source, final: [...this.finals[source]], ...(partial ? { partial } : {}) };
  }

  history(source: TranscriptSource): TranscriptSegment[] {
    return [...this.finals[source]];
  }

  clear(source?: TranscriptSource): void {
    if (source) {
      this.finals[source] = [];
      delete this.partials[source];
      return;
    }
    this.finals.mic = [];
    this.finals.remote = [];
    delete this.partials.mic;
    delete this.partials.remote;
  }
}

export interface PcmQueueStats {
  queuedBytes: number;
  queuedPackets: number;
  droppedPackets: number;
}

export class PcmBackpressureQueue {
  private readonly packets: Uint8Array[] = [];
  private queuedBytes = 0;
  private droppedPackets = 0;

  constructor(private readonly maxBytes = 192_000) {}

  push(packet: Uint8Array): PcmQueueStats {
    if (packet.byteLength > this.maxBytes) {
      this.droppedPackets += 1;
      return this.currentStats();
    }
    this.packets.push(packet);
    this.queuedBytes += packet.byteLength;
    while (this.queuedBytes > this.maxBytes) {
      const oldest = this.packets.shift();
      if (!oldest) break;
      this.queuedBytes -= oldest.byteLength;
      this.droppedPackets += 1;
    }
    return this.currentStats();
  }

  shift(): Uint8Array | undefined {
    const packet = this.packets.shift();
    if (packet) this.queuedBytes -= packet.byteLength;
    return packet;
  }

  get length(): number { return this.packets.length; }
  get stats(): PcmQueueStats { return this.currentStats(); }

  private currentStats(): PcmQueueStats {
    return { queuedBytes: this.queuedBytes, queuedPackets: this.packets.length, droppedPackets: this.droppedPackets };
  }

  clear(): void {
    this.packets.length = 0;
    this.queuedBytes = 0;
  }
}

export type QuestionState = "IDLE" | "LISTENING" | "POSSIBLE_QUESTION" | "WAITING_COMPLETION" | "CONFIRMED" | "ANSWERING";
export type QuestionConfidence = "low" | "medium" | "high";
export type QuestionStatus = "candidate" | "confirmed" | "answering" | "superseded" | "ignored" | "answered";

export interface QuestionCandidate {
  id: string;
  text: string;
  confidence: QuestionConfidence;
  score: number;
  source: "rules" | "extractor";
  detectedAt: number;
  status: QuestionStatus;
}

export type QuestionEvent =
  | { type: "question_candidate"; question: QuestionCandidate }
  | { type: "question_confirmed"; question: QuestionCandidate }
  | { type: "question_superseded"; previousQuestionId: string; question: QuestionCandidate }
  | { type: "question_ignored"; question: QuestionCandidate; reason: "duplicate" | "incomplete" }
  | { type: "question_diagnostic"; text: string; questionScore: number; candidate: boolean; confirmed: boolean; ignoredReason?: "duplicate" | "incomplete"; dedupeScore?: number };

export interface QuestionDetectorOptions {
  completenessThreshold?: number;
  silenceMs?: number;
  dedupeWindowMs?: number;
  similarityThreshold?: number;
}

const QUESTION_WORDS = /为什么|为何|怎么|如何|能不能|可不可以|什么|哪个|哪里|是否|有没有|请问|解释|介绍|说一下|讲讲|展开|继续|优势|区别|原理|原因|怎么解决|那如果|再说说|吗[？?。.!！]?|呢[？?。.!！]?/i;

function normalizeQuestionText(text: string): string {
  return text.replace(/[\s，。！？、,.!?]+/g, "").toLowerCase();
}

function tokenSet(text: string): Set<string> {
  const normalized = normalizeQuestionText(text);
  const tokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  return new Set(tokens);
}

export function questionSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

export function scoreQuestion(text: string, final: boolean): { score: number; confidence: QuestionConfidence } {
  const normalized = text.trim();
  const hasQuestionWord = QUESTION_WORDS.test(normalized);
  const hasQuestionMark = /[？?]$/.test(normalized);
  const hasEnoughContext = normalized.length >= 6;
  const score = Math.min(0.98, (hasQuestionWord ? 0.5 : 0) + (hasQuestionMark ? 0.15 : 0) + (final ? 0.2 : 0) + (hasEnoughContext ? 0.15 : 0));
  const confidence: QuestionConfidence = score >= 0.88 ? "high" : score >= 0.65 ? "medium" : "low";
  return { score, confidence };
}

export class QuestionDetector {
  private stateValue: QuestionState = "IDLE";
  private currentText = "";
  private currentStartMs = 0;
  private lastObservedAtMs = 0;
  private lastAudioEndMs = 0;
  private currentCandidate: QuestionCandidate | undefined;
  private questionCounter = 0;
  private answeringQuestionId: string | undefined;
  private readonly confirmed: QuestionCandidate[] = [];
  private readonly completenessThreshold: number;
  private readonly silenceMs: number;
  private readonly dedupeWindowMs: number;
  private readonly similarityThreshold: number;

  constructor(options: QuestionDetectorOptions = {}) {
    this.completenessThreshold = options.completenessThreshold ?? 0.82;
    this.silenceMs = options.silenceMs ?? 500;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 15_000;
    this.similarityThreshold = options.similarityThreshold ?? 0.9;
  }

  get state(): QuestionState { return this.stateValue; }
  get lastConfirmed(): QuestionCandidate | undefined { return this.confirmed.at(-1); }

  observe(input: { text: string; final: boolean; startMs: number; endMs: number }, observedAtMs = Date.now()): QuestionEvent[] {
    const text = input.text.trim();
    if (!text) return [];
    if (!this.currentText || input.startMs > this.lastAudioEndMs + this.silenceMs) {
      this.currentText = text;
      this.currentStartMs = input.startMs;
    } else {
      this.currentText = input.final ? text : text;
    }
    this.lastObservedAtMs = observedAtMs;
    this.lastAudioEndMs = input.endMs;
    this.stateValue = "LISTENING";
    const scored = scoreQuestion(this.currentText, input.final);
    if (!QUESTION_WORDS.test(this.currentText) && !/[？?]$/.test(this.currentText)) return [];
    const candidate = this.makeCandidate(scored, observedAtMs);
    this.currentCandidate = candidate;
    this.stateValue = scored.score >= this.completenessThreshold ? "WAITING_COMPLETION" : "POSSIBLE_QUESTION";
    return [{ type: "question_candidate", question: candidate }, { type: "question_diagnostic", text: candidate.text, questionScore: candidate.score, candidate: true, confirmed: false }];
  }

  flush(observedAtMs = Date.now()): QuestionEvent[] {
    const candidate = this.currentCandidate;
    if (!candidate) {
      this.stateValue = "IDLE";
      return [];
    }
    if (observedAtMs - this.lastObservedAtMs < this.silenceMs || candidate.score < this.completenessThreshold) {
      return [{ type: "question_ignored", question: { ...candidate, status: "ignored" }, reason: "incomplete" }, { type: "question_diagnostic", text: candidate.text, questionScore: candidate.score, candidate: true, confirmed: false, ignoredReason: "incomplete" }];
    }
    const dedupeScore = this.confirmed.reduce((maximum, previous) => observedAtMs - previous.detectedAt < this.dedupeWindowMs ? Math.max(maximum, questionSimilarity(previous.text, candidate.text)) : maximum, 0);
    if (dedupeScore >= this.similarityThreshold) {
      this.stateValue = "IDLE";
      this.resetBuffer();
      return [{ type: "question_ignored", question: { ...candidate, status: "ignored" }, reason: "duplicate" }, { type: "question_diagnostic", text: candidate.text, questionScore: candidate.score, candidate: true, confirmed: false, ignoredReason: "duplicate", dedupeScore }];
    }
    const confirmed = { ...candidate, status: "confirmed" as const };
    const previous = this.confirmed.at(-1);
    this.confirmed.push(confirmed);
    this.currentCandidate = confirmed;
    this.stateValue = "CONFIRMED";
    const event: QuestionEvent = previous && previous.id !== confirmed.id && (previous.status === "confirmed" || previous.id === this.answeringQuestionId)
      ? { type: "question_superseded", previousQuestionId: previous.id, question: confirmed }
      : { type: "question_confirmed", question: confirmed };
    this.resetBuffer(false);
    return [event, { type: "question_diagnostic", text: confirmed.text, questionScore: confirmed.score, candidate: true, confirmed: true, dedupeScore }];
  }

  markAnswering(questionId: string): void {
    this.answeringQuestionId = questionId;
    const question = this.confirmed.find((candidate) => candidate.id === questionId);
    if (question) question.status = "answering";
    if (this.currentCandidate?.id === questionId) this.stateValue = "ANSWERING";
  }

  markAnswered(questionId: string): void {
    const question = this.confirmed.find((candidate) => candidate.id === questionId);
    if (question) question.status = "answered";
    if (this.answeringQuestionId === questionId) this.answeringQuestionId = undefined;
    if (this.currentCandidate?.id === questionId) this.stateValue = "IDLE";
  }

  markSuperseded(questionId: string): void {
    const question = this.confirmed.find((candidate) => candidate.id === questionId);
    if (question) question.status = "superseded";
    if (this.answeringQuestionId === questionId) this.answeringQuestionId = undefined;
    if (this.currentCandidate?.id === questionId) this.stateValue = "IDLE";
  }

  private makeCandidate(scored: { score: number; confidence: QuestionConfidence }, detectedAt: number): QuestionCandidate {
    return {
      id: `question-${++this.questionCounter}`,
      text: this.currentText,
      confidence: scored.confidence,
      score: scored.score,
      source: "rules",
      detectedAt,
      status: "candidate"
    };
  }

  private resetBuffer(clearCandidate = true): void {
    this.currentText = "";
    this.currentStartMs = 0;
    this.lastObservedAtMs = 0;
    this.lastAudioEndMs = 0;
    if (clearCandidate) this.currentCandidate = undefined;
  }
}

export * from "./answer";
export * from "./profile";
export * from "./knowledge";
export * from "./agent";
export * from "./history";
export * from "./transcript-aggregator";
export * from "./providers";
export * from "./asr";
export * from "./analysis";
