import { normalizeTechnicalTerms } from "./terminology";
export { buildVisionInput, type ScreenshotImage, type VisionInput } from "./vision";

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
import { classifyQuestion, questionFingerprint, type QuestionCategory } from "./question-classifier";
import type { QuestionAnalysis, QuestionDetectionType, QuestionScore, QuestionSpeechAct } from "./question/types";

export { classifyQuestion, questionFingerprint } from "./question-classifier";
export {
  QUESTION_BANK_TYPES,
  QUESTION_BANK_TYPE_LABELS,
  QUESTION_BANK_BANK_TYPES,
  QUESTION_BANK_BANK_LABELS,
  QUESTION_BANK_SCOPES,
  QUESTION_BANK_RELATION_TYPES,
  inferQuestionBankBankType,
  inferQuestionBankType,
  normalizeQuestionBankText,
  parseQuestionBankText,
  questionBankSimilarity
} from "./question-bank";
export type {
  QuestionBankAnswerCardRecord,
  QuestionBankAnswerMode,
  QuestionBankBankType,
  QuestionBankJobProfileRecord,
  QuestionBankMatch,
  QuestionBankQuestionRecord,
  QuestionBankRelationRecord,
  QuestionBankRelationType,
  QuestionBankScope,
  ParsedQuestionBankEntry,
  QuestionBankSkillPointRecord,
  QuestionBankSkillRecord,
  QuestionBankSourceType,
  QuestionBankType
} from "./question-bank";
export { QuestionBankRouter } from "./question-bank-router";
export type { QuestionBankRouteHit, QuestionBankRouteOptions, QuestionBankRouteResult } from "./question-bank-router";
export type { QuestionCategory, QuestionClassification } from "./question-classifier";

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
  return normalizeTechnicalTerms(text);
}

function transcriptTextSimilarity(left: string, right: string): number {
  const a = normalizeTranscriptText(left).replace(/[\s，。！？、,.!?；;:：]/g, "");
  const b = normalizeTranscriptText(right).replace(/[\s，。！？、,.!?；;:：]/g, "");
  if (!a || !b) return 0;
  if (a === b || a.includes(b) || b.includes(a)) return 1;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  let common = 0;
  for (const character of new Set(shorter)) if (longer.includes(character)) common += 1;
  return common / Math.max(1, new Set(longer).size);
}

function transcriptOverlap(left: TranscriptSegment, right: TranscriptSegment): number {
  const overlap = Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
  const shortest = Math.max(1, Math.min(left.endMs - left.startMs, right.endMs - right.startMs));
  return overlap / shortest;
}

function sameTranscriptUtterance(left: TranscriptSegment, right: TranscriptSegment): boolean {
  if (left.source !== right.source) return false;
  if (left.id && right.id && left.id === right.id) return true;
  if (left.utteranceId && right.utteranceId && left.utteranceId === right.utteranceId) return true;
  return transcriptOverlap(left, right) >= 0.75 && transcriptTextSimilarity(left.text, right.text) >= 0.55;
}

export class TranscriptStabilizer {
  private readonly finals: Record<TranscriptSource, TranscriptSegment[]> = { mic: [], remote: [] };
  private readonly partials: Partial<Record<TranscriptSource, TranscriptSegment>> = {};

  upsert(segment: TranscriptSegment): TranscriptUpdate {
    const normalized = { ...segment, text: normalizeTranscriptText(segment.text) };
    if (normalized.final) {
      delete this.partials[normalized.source];
      const list = this.finals[normalized.source];
      const existingIndex = list.findIndex((item) => sameTranscriptUtterance(item, normalized));
      if (existingIndex >= 0) {
        const existing = list[existingIndex];
        // Prefer the provider's longer revision when the same speech item is
        // finalized more than once. This replaces the old partial/final pair
        // instead of appending both to the visible transcript.
        list[existingIndex] = normalized.text.length >= existing.text.length
          ? normalized
          : { ...existing, ...normalized, text: existing.text };
      } else list.push(normalized);
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
  category?: QuestionCategory;
  detectionType?: QuestionDetectionType;
  speechAct?: QuestionSpeechAct;
  scoreBreakdown?: QuestionScore;
  asrConfidence?: number;
  fingerprint?: string;
  final?: boolean;
  triggerReason?: string;
  /** Stable conversation-thread links for follow-up questions. */
  parentQuestionId?: string;
  rootQuestionId?: string;
  shouldAnswer?: boolean;
  codeContext?: boolean;
  anchorId?: string;
  canonicalQuestion?: string;
  /** Runtime turn/group metadata added after final ASR assembly. */
  utteranceId?: string;
  segmentIds?: string[];
  turnId?: string;
  groupId?: string;
  relationType?: "ASR_REVISION" | "SAME_QUESTION_AUGMENTATION" | "PARALLEL_SUBQUESTION" | "FOLLOW_UP" | "NEW_TOPIC";
}

export type QuestionEvent =
  | { type: "question_candidate"; question: QuestionCandidate }
  | { type: "question_confirmed"; question: QuestionCandidate }
  | { type: "question_superseded"; previousQuestionId: string; question: QuestionCandidate }
  | { type: "question_ignored"; question: QuestionCandidate; reason: "duplicate" | "incomplete" }
  | { type: "question_diagnostic"; text: string; questionScore: number; confidence: number; candidate: boolean; confirmed: boolean; reason: string; category?: QuestionCategory; detectionType?: QuestionDetectionType; speechAct?: QuestionSpeechAct; fingerprint?: string; ignoredReason?: "duplicate" | "incomplete"; dedupeScore?: number };

export interface QuestionDetectorOptions {
  completenessThreshold?: number;
  silenceMs?: number;
  dedupeWindowMs?: number;
  similarityThreshold?: number;
  contextWindowMs?: number;
}

const QUESTION_WORDS = /为什么|为何|怎么|如何|能不能|可不可以|什么|哪个|哪里|哪几种|哪一类|是否|有没有|请问|解释|解释一下|说明|说明一下|介绍|说一下|说说|讲一下|讲讲|展开|继续|优势|优缺点|区别|原理|原因|怎么解决|怎么验证|第一步|先看什么|那如果|再说说|自我介绍|常见误区|时序|吗[？?。.!！]?|呢[？?。.!！]?/i;

function normalizeQuestionText(text: string): string {
  return normalizeTechnicalTerms(text).replace(/[\s，。！？、,.!?]+/g, "").toLowerCase();
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
  const unionScore = intersection / Math.max(1, new Set([...a, ...b]).size);
  // ASR often emits a short revision and then a longer final sentence. A
  // plain Jaccard score treats the longer sentence as a new question even
  // when it contains the complete short question, so use containment as a
  // second signal for dedupe.
  const containmentScore = intersection / Math.max(1, Math.min(a.size, b.size));
  return Math.max(unionScore, containmentScore * 0.96);
}

export function scoreQuestion(text: string, final: boolean, contextText = ""): { score: number; confidence: QuestionConfidence } {
  const normalized = text.trim();
  const hasQuestionWord = QUESTION_WORDS.test(normalized);
  const hasQuestionMark = /[？?]$/.test(normalized);
  const hasQuestionLabel = /(?:问题|题目)\s*[:：]/.test(normalized);
  const hasEnoughContext = normalized.length >= 6;
  const ruleScore = (hasQuestionWord ? 0.5 : 0) + (hasQuestionMark ? 0.15 : 0) + (hasQuestionLabel ? 0.5 : 0) + (final ? 0.2 : 0) + (hasEnoughContext ? 0.15 : 0);
  const semantic = classifyQuestion(normalized, contextText, final);
  const score = Math.min(0.98, Math.max(ruleScore, semantic.confidence));
  const confidence: QuestionConfidence = score >= 0.88 ? "high" : score >= 0.65 ? "medium" : "low";
  return { score, confidence };
}

function scoreFromAnalysis(analysis: QuestionAnalysis): { score: number; confidence: QuestionConfidence } {
  const score = Math.max(0, Math.min(1, analysis.score.finalScore));
  return { score, confidence: score >= 0.88 ? "high" : score >= 0.65 ? "medium" : "low" };
}

function isDeferredShortFollowUp(candidate: QuestionCandidate): boolean {
  if (candidate.speechAct !== "FOLLOW_UP") return false;
  return normalizeQuestionText(candidate.text).length <= 8;
}

export class QuestionDetector {
  private stateValue: QuestionState = "IDLE";
  private currentText = "";
  private currentStartMs = 0;
  private lastObservedAtMs = 0;
  private lastAudioEndMs = 0;
  private currentCandidate: QuestionCandidate | undefined;
  private currentUtteranceId: string | undefined;
  private questionCounter = 0;
  private answeringQuestionId: string | undefined;
  private readonly confirmed: QuestionCandidate[] = [];
  private readonly completenessThreshold: number;
  private readonly silenceMs: number;
  private readonly dedupeWindowMs: number;
  private readonly similarityThreshold: number;
  private readonly contextWindowMs: number;
  private readonly context = new Map<number, { startMs: number; endMs: number; text: string; final: boolean }>();

  constructor(options: QuestionDetectorOptions = {}) {
    // Question Detection 2.0 performs semantic/context filtering. This class
    // is the temporal gate, so the threshold should match the public detector
    // contract instead of silently accepting medium-confidence candidates.
    this.completenessThreshold = options.completenessThreshold ?? 0.82;
    this.silenceMs = options.silenceMs ?? 500;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 10_000;
    this.similarityThreshold = options.similarityThreshold ?? 0.9;
    this.contextWindowMs = options.contextWindowMs ?? 30_000;
  }

  get state(): QuestionState { return this.stateValue; }
  get lastConfirmed(): QuestionCandidate | undefined { return this.confirmed.at(-1); }

  reset(): void {
    this.stateValue = "IDLE";
    this.answeringQuestionId = undefined;
    this.confirmed.length = 0;
    this.context.clear();
    this.resetBuffer();
  }

  observe(input: { text: string; final: boolean; startMs: number; endMs: number; confidence?: number; analysis?: QuestionAnalysis; utteranceId?: string }, observedAtMs = Date.now()): QuestionEvent[] {
    const text = input.text.trim();
    if (!text) return [];
    const sameUtterance = Boolean(input.utteranceId && this.currentUtteranceId === input.utteranceId);
    const newUtterance = Boolean(this.currentUtteranceId && input.utteranceId && this.currentUtteranceId !== input.utteranceId)
      || (!sameUtterance && (!this.currentText || input.startMs > this.lastAudioEndMs + this.silenceMs));
    const boundaryEvents = newUtterance ? this.finalizePendingCandidateAtBoundary(observedAtMs) : [];
    if (newUtterance) {
      this.currentText = text;
      this.currentStartMs = input.startMs;
      this.currentCandidate = undefined;
      this.currentUtteranceId = input.utteranceId;
    } else {
      this.currentText = input.final ? text : text;
      if (input.utteranceId) this.currentUtteranceId = input.utteranceId;
    }
    this.lastObservedAtMs = observedAtMs;
    this.lastAudioEndMs = input.endMs;
    this.stateValue = "LISTENING";
    this.context.set(input.startMs, { startMs: input.startMs, endMs: input.endMs, text: this.currentText, final: input.final });
    for (const [startMs, item] of this.context) if (input.endMs - item.startMs > this.contextWindowMs) this.context.delete(startMs);
    const contextText = [...this.context.values()].sort((left, right) => left.startMs - right.startMs).map((item) => item.text).join(" ");
    const classification = input.analysis?.classification ?? classifyQuestion(this.currentText, contextText, input.final);
    const scored = input.analysis ? scoreFromAnalysis(input.analysis) : scoreQuestion(this.currentText, input.final, contextText);
    if (!(input.analysis?.isQuestion ?? classification.isQuestion)) {
      if (input.final) this.currentCandidate = undefined;
      return [...boundaryEvents, { type: "question_diagnostic", text: this.currentText, questionScore: scored.score, confidence: input.analysis?.confidence ?? classification.confidence, candidate: false, confirmed: false, reason: input.analysis?.reason ?? classification.reason, category: classification.category, detectionType: input.analysis?.type, speechAct: input.analysis?.speechAct, fingerprint: questionFingerprint(this.currentText) }];
    }
    const candidate = this.makeCandidate(this.currentText, scored, classification, observedAtMs, input.final, input.analysis, input.confidence);
    this.currentCandidate = candidate;
    this.stateValue = scored.score >= this.completenessThreshold ? "WAITING_COMPLETION" : "POSSIBLE_QUESTION";
    return [...boundaryEvents, { type: "question_candidate", question: candidate }, { type: "question_diagnostic", text: candidate.text, questionScore: candidate.score, confidence: input.analysis?.confidence ?? classification.confidence, candidate: true, confirmed: false, reason: input.analysis?.reason ?? classification.reason, category: classification.category, detectionType: input.analysis?.type, speechAct: input.analysis?.speechAct, fingerprint: candidate.fingerprint }];
  }

  flush(observedAtMs = Date.now()): QuestionEvent[] {
    const candidate = this.currentCandidate;
    if (!candidate) {
      this.stateValue = "IDLE";
      return [];
    }
    if (candidate.final === false) return [];
    // Keep elliptical follow-ups long enough to receive a trailing fragment,
    // but do not turn a short complete question into a one-second wait.
    const shortFollowUpHoldMs = isDeferredShortFollowUp(candidate) ? 220 : 0;
    if (observedAtMs - this.lastObservedAtMs < this.silenceMs + shortFollowUpHoldMs || candidate.score < this.completenessThreshold) {
      return [{ type: "question_ignored", question: { ...candidate, status: "ignored" }, reason: "incomplete" }, { type: "question_diagnostic", text: candidate.text, questionScore: candidate.score, confidence: candidate.score, candidate: true, confirmed: false, reason: "incomplete", category: candidate.category, detectionType: candidate.detectionType, speechAct: candidate.speechAct, fingerprint: candidate.fingerprint, ignoredReason: "incomplete" }];
    }
    return this.confirmCandidate(candidate, observedAtMs);
  }

  private finalizePendingCandidateAtBoundary(observedAtMs: number): QuestionEvent[] {
    const candidate = this.currentCandidate;
    // A new aggregated utterance is a hard boundary. If the previous final
    // candidate is already complete, confirm it before the new utterance can
    // replace the single temporal buffer. This covers short ASR gaps where
    // wall-clock debounce has not reached 500ms yet.
    if (!candidate || candidate.status !== "candidate" || candidate.final === false || candidate.score < this.completenessThreshold || isDeferredShortFollowUp(candidate)) return [];
    return this.confirmCandidate(candidate, observedAtMs);
  }

  private confirmCandidate(candidate: QuestionCandidate, observedAtMs: number): QuestionEvent[] {
    const dedupeScore = this.confirmed.reduce((maximum, previous) => {
      if (observedAtMs - previous.detectedAt >= this.dedupeWindowMs) return maximum;
      // Brain-normalized follow-ups deliberately contain the parent question
      // (“围绕…针对…追问：…”). Containment is useful for ASR revisions, but
      // must not collapse a real follow-up into its parent turn.
      const parentContextFollowUp = candidate.speechAct === "FOLLOW_UP"
        && candidate.fingerprint !== previous.fingerprint
        && /(?:围绕|追问：|追问:)/.test(candidate.text);
      if (parentContextFollowUp) return maximum;
      return Math.max(maximum, previous.fingerprint && candidate.fingerprint && previous.fingerprint === candidate.fingerprint ? 1 : questionSimilarity(previous.text, candidate.text));
    }, 0);
    if (dedupeScore >= this.similarityThreshold) {
      this.stateValue = "IDLE";
      this.resetBuffer();
      return [{ type: "question_ignored", question: { ...candidate, status: "ignored" }, reason: "duplicate" }, { type: "question_diagnostic", text: candidate.text, questionScore: candidate.score, confidence: candidate.score, candidate: true, confirmed: false, reason: "duplicate", category: candidate.category, detectionType: candidate.detectionType, speechAct: candidate.speechAct, fingerprint: candidate.fingerprint, ignoredReason: "duplicate", dedupeScore }];
    }
    const confirmed = { ...candidate, status: "confirmed" as const };
    this.confirmed.push(confirmed);
    this.currentCandidate = confirmed;
    this.stateValue = "CONFIRMED";
    // A distinct utterance is another interview question, not a replacement
    // for the previous one. ASR revisions have already been removed by the
    // similarity check above. Treating every rapid follow-up as superseding
    // caused the coordinator to cancel valid answers and lose multi-part
    // questions such as “怎么定位？最后怎么解决？”.
    const event: QuestionEvent = { type: "question_confirmed", question: confirmed };
    this.resetBuffer(false);
    return [event, { type: "question_diagnostic", text: confirmed.text, questionScore: confirmed.score, confidence: confirmed.score, candidate: true, confirmed: true, reason: confirmed.triggerReason ?? "confirmed", category: confirmed.category, detectionType: confirmed.detectionType, speechAct: confirmed.speechAct, fingerprint: confirmed.fingerprint, dedupeScore }];
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

  private makeCandidate(text: string, scored: { score: number; confidence: QuestionConfidence }, classification: ReturnType<typeof classifyQuestion>, detectedAt: number, final: boolean, analysis?: QuestionAnalysis, asrConfidence?: number): QuestionCandidate {
    return {
      id: `question-${++this.questionCounter}`,
      text,
      confidence: scored.confidence,
      score: scored.score,
      source: analysis ? "extractor" : "rules",
      detectedAt,
      status: "candidate",
      category: classification.category,
      detectionType: analysis?.type,
      speechAct: analysis?.speechAct,
      scoreBreakdown: analysis?.score,
      asrConfidence,
      fingerprint: questionFingerprint(text),
      final,
      triggerReason: analysis?.reason ?? classification.reason,
      shouldAnswer: analysis?.shouldAnswer,
      codeContext: analysis?.codeContext,
      canonicalQuestion: analysis?.normalizedQuestion
    };
  }

  private resetBuffer(clearCandidate = true): void {
    this.currentText = "";
    this.currentStartMs = 0;
    this.lastObservedAtMs = 0;
    this.lastAudioEndMs = 0;
    this.currentUtteranceId = undefined;
    if (clearCandidate) this.context.clear();
    if (clearCandidate) this.currentCandidate = undefined;
  }
}

export * from "./answer";
export * from "./chat";
export * from "./chat-response";
export * from "./question-bank-coverage";
export * from "./answer/interview-answer-formatter";
export * from "./answer/answer-quality-checker";
export * from "./answer/streaming-answer-sanitizer";
export { answerStrategyFor } from "./answer/answer-strategy";
export { AnswerLengthController, ANSWER_DURATION_POLICY, FOLLOW_UP_DURATION_POLICY } from "./answer/answer-length-controller";
export { SpokenAnswerFormatter } from "./answer/spoken-answer-formatter";
export { SpokenQualityChecker } from "./answer/spoken-quality-checker";
export type { SpokenQualityInput, SpokenQualityMetrics, SpokenQualityResult } from "./answer/spoken-quality-checker";
export * from "./follow-up-context";
export * from "./profile";
export * from "./knowledge";
export * from "./agent";
export * from "./history";
export * from "./transcript-aggregator";
export * from "./providers";
export * from "./asr";
export * from "./asr/index";
export * from "./analysis";
export * from "./question-detector-2";
export * from "./interview-memory";
export * from "./interview/speech-act-classifier";
export * from "./interview/context-anchor-store";
export * from "./interview/context-anchor-resolver";
export * from "./interview/turn-builder";
export * from "./interview/question-group";
export * from "./interview/answer-scheduler";
export * from "./question-trace";
export * from "./question";
export * from "./profile-builder";
export * from "./interview-brain";
export * from "./terminology";
export * from "./chat-intent";
export * from "./knowledge/index";
export * from "./project-comprehension";
