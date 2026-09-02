import type { ProjectAliasCandidate } from "../project-alias-resolver";
import { ConversationAnchorState } from "./conversation-anchor-state";
import { QuestionCommitGate, type QuestionCommitGateResult } from "./question-commit-gate";
import { QuestionFrameBuilder } from "./question-frame-builder";
import { QuestionPendingLedger } from "./question-pending-ledger";
import type { ActiveProjectContext, AnswerFrame, InterviewUnderstandingState, QuestionFrame, ReferenceCandidate } from "./question-frame";

export type { ActiveProjectContext } from "./question-frame";

export interface UnderstandingSegmentInput {
  id: string;
  text: string;
  rawText?: string;
  rawSegments?: string[];
  segmentIds?: string[];
  final: boolean;
  speaker?: "interviewer" | "candidate";
  timestamp?: number;
  asrConfidence?: number;
}

export interface UnderstandingMachineOptions {
  sessionId?: string;
  mode?: "ACCURATE_INTERVIEW" | "FAST_PRACTICE";
  activeProject?: ActiveProjectContext;
  projectCandidates?: readonly ProjectAliasCandidate[];
  now?: () => number;
}

export type UnderstandingEvent =
  | { type: "QUESTION_DRAFT_UPDATED"; frame: QuestionFrame; gate: QuestionCommitGateResult }
  | { type: "QUESTION_WAITING"; frame: QuestionFrame; gate: QuestionCommitGateResult }
  | { type: "QUESTION_COMMITTED"; frame: QuestionFrame; gate: QuestionCommitGateResult; decisionTrace: Record<string, unknown> }
  | { type: "NON_ACTIONABLE"; frame: QuestionFrame; gate: QuestionCommitGateResult };

function cloneFrame(frame: QuestionFrame): QuestionFrame { return { ...frame, segmentIds: [...frame.segmentIds], rawSegments: [...frame.rawSegments], subQuestions: frame.subQuestions.map((slot) => ({ ...slot })), entities: { ...frame.entities, projects: [...frame.entities.projects], components: [...frame.entities.components], technologies: [...frame.entities.technologies], concepts: [...frame.entities.concepts] }, references: frame.references.map((reference) => ({ ...reference, evidence: [...reference.evidence] })), confidence: { ...frame.confidence }, unresolvedSlots: [...frame.unresolvedSlots] };
}

function activeProjectFrom(input: UnderstandingMachineOptions, current?: ActiveProjectContext): ActiveProjectContext | undefined {
  return input.activeProject ?? current;
}

function shouldAppend(frame: QuestionFrame, text: string): boolean {
  if (frame.completion === "COMPLETE") return false;
  return Boolean(text.trim()) && (frame.completion !== "ASR_UNCERTAIN" || /(?:ADC|DMA|PWM|SPI|CAN|F405|STM32|栈|stack)/iu.test(text));
}

function mergeFrame(previous: QuestionFrame, next: QuestionFrame, now: number): QuestionFrame {
  const merged: QuestionFrame = {
    ...next,
    id: previous.id,
    segmentIds: [...new Set([...previous.segmentIds, ...next.segmentIds])],
    rawSegments: [...previous.rawSegments, ...next.rawSegments],
    rawCombinedText: [...previous.rawSegments, ...next.rawSegments].join(" "),
    createdAt: previous.createdAt,
    updatedAt: now
  };
  return merged;
}

/** Single source of truth for question understanding and QUESTION_COMMITTED. */
export class InterviewUnderstandingStateMachine {
  private readonly anchors = new ConversationAnchorState();
  private readonly ledger = new QuestionPendingLedger();
  private readonly builder = new QuestionFrameBuilder();
  private readonly gate = new QuestionCommitGate();
  private readonly now: () => number;
  private mode: "ACCURATE_INTERVIEW" | "FAST_PRACTICE";
  private sessionId: string;
  private activeProject?: ActiveProjectContext;
  private currentSpeaker: InterviewUnderstandingState["currentSpeaker"];
  private previousSpeaker: InterviewUnderstandingState["previousSpeaker"];
  private pendingTurn?: InterviewUnderstandingState["pendingTurn"];
  private pendingQuestion?: QuestionFrame;
  private lastCommittedQuestion?: QuestionFrame;
  private lastAnsweredQuestion?: QuestionFrame;
  private readonly recentQuestions: QuestionFrame[] = [];
  private readonly recentAnswers: AnswerFrame[] = [];
  private readonly unresolvedAsr: InterviewUnderstandingState["unresolvedAsr"] = [];
  private readonly threads = new Map<string, { id: string; rootQuestionId: string; questionIds: string[]; topic?: string; projectId?: string }>();

  constructor(options: UnderstandingMachineOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.mode = options.mode ?? "ACCURATE_INTERVIEW";
    this.sessionId = options.sessionId ?? `understanding-session-${this.now()}`;
    this.activeProject = options.activeProject;
  }

  reset(options: Pick<UnderstandingMachineOptions, "sessionId" | "activeProject" | "mode"> = {}): void {
    this.anchors.reset();
    this.ledger.clear();
    this.activeProject = options.activeProject;
    this.currentSpeaker = undefined;
    this.previousSpeaker = undefined;
    this.pendingTurn = undefined;
    this.pendingQuestion = undefined;
    this.lastCommittedQuestion = undefined;
    this.lastAnsweredQuestion = undefined;
    this.recentQuestions.length = 0;
    this.recentAnswers.length = 0;
    this.unresolvedAsr.length = 0;
    this.threads.clear();
    if (options.sessionId) this.sessionId = options.sessionId;
    if (options.mode) this.mode = options.mode;
  }

  get state(): InterviewUnderstandingState {
    const anchor = this.anchors.snapshot();
    return {
      sessionId: this.sessionId,
      ...(this.currentSpeaker ? { currentSpeaker: this.currentSpeaker } : {}),
      ...(this.previousSpeaker ? { previousSpeaker: this.previousSpeaker } : {}),
      ...(this.pendingTurn ? { pendingTurn: { ...this.pendingTurn, segmentIds: [...this.pendingTurn.segmentIds], rawSegments: [...this.pendingTurn.rawSegments] } } : {}),
      ...(this.pendingQuestion ? { pendingQuestion: cloneFrame(this.pendingQuestion) } : {}),
      ...(this.lastCommittedQuestion ? { lastCommittedQuestion: cloneFrame(this.lastCommittedQuestion) } : {}),
      ...(this.lastAnsweredQuestion ? { lastAnsweredQuestion: cloneFrame(this.lastAnsweredQuestion) } : {}),
      ...(this.activeProject ? { activeProject: { ...this.activeProject, entities: [...this.activeProject.entities], topics: [...this.activeProject.topics] } } : {}),
      ...(anchor.currentTopic ? { currentTopic: { ...anchor.currentTopic } } : {}),
      activeEntities: anchor.entities.map((item) => ({ ...item })),
      recentQuestions: this.recentQuestions.map(cloneFrame),
      recentAnswers: this.recentAnswers.map((item) => ({ ...item })),
      ...(this.lastCommittedQuestion ? { questionThread: [...this.threads.values()].find((thread) => thread.questionIds.includes(this.lastCommittedQuestion?.id ?? "")) } : {}),
      unresolvedReferences: anchor.unresolvedReferences.map((item) => ({ ...item, evidence: [...item.evidence] })),
      unresolvedAsr: this.unresolvedAsr.map((item) => ({ ...item, candidates: [...item.candidates] })),
      pendingLedger: this.ledger.list(this.now())
    };
  }

  setActiveProject(project?: ActiveProjectContext): void { this.activeProject = project; this.anchors.updateProject(project); }
  recordAnswer(answer: AnswerFrame): void { this.lastAnsweredQuestion = this.lastCommittedQuestion ? cloneFrame(this.lastCommittedQuestion) : undefined; this.recentAnswers.push({ ...answer }); while (this.recentAnswers.length > 12) this.recentAnswers.shift(); this.anchors.updateAnswer(answer); }

  process(input: UnderstandingSegmentInput, projectCandidates: readonly ProjectAliasCandidate[] = []): UnderstandingEvent {
    const now = input.timestamp ?? this.now();
    const speaker = input.speaker ?? "interviewer";
    this.previousSpeaker = this.currentSpeaker;
    this.currentSpeaker = speaker;
    const rawText = input.rawText ?? input.text;
    if (!input.final) {
      const previous = this.pendingTurn?.speaker === speaker ? this.pendingTurn : undefined;
      const segmentIds = [...new Set([...(previous?.segmentIds ?? []), ...(input.segmentIds ?? [input.id])])];
      const rawSegments = [...(previous?.rawSegments ?? []), rawText];
      this.pendingTurn = { segmentIds, rawSegments, rawCombinedText: rawSegments.join(" "), speaker, firstSeenAt: previous?.firstSeenAt ?? now, lastUpdatedAt: now };
      const built = this.builder.build({ id: input.id, rawText, rawSegments: [rawText], segmentIds: input.segmentIds, final: false, speaker, timestamp: now, asrConfidence: input.asrConfidence, anchors: this.anchors.snapshot(), activeProject: activeProjectFrom({}, this.activeProject), projectCandidates, now });
      return { type: "QUESTION_DRAFT_UPDATED", frame: built.frame, gate: { decision: "WAIT", status: "BUFFERING", reason: "interim-transcript", postCompletionReady: false } };
    }

    const existingPending = this.pendingQuestion && shouldAppend(this.pendingQuestion, input.text) ? this.pendingQuestion : undefined;
    const pendingTurn = this.pendingTurn?.speaker === speaker ? this.pendingTurn : undefined;
    const rawSegments = input.rawSegments?.length ? input.rawSegments : pendingTurn ? [...pendingTurn.rawSegments, rawText] : [rawText];
    const segmentIds = input.segmentIds?.length ? input.segmentIds : pendingTurn ? [...new Set([...pendingTurn.segmentIds, input.id])] : [input.id];
    const built = this.builder.build({ id: input.id, rawText, rawSegments: existingPending ? [...existingPending.rawSegments, ...rawSegments] : rawSegments, segmentIds, final: true, speaker, timestamp: now, asrConfidence: input.asrConfidence, anchors: this.anchors.snapshot(), activeProject: activeProjectFrom({}, this.activeProject), projectCandidates, now });
    const frame = existingPending ? mergeFrame(existingPending, built.frame, now) : built.frame;
    this.pendingTurn = undefined;
    this.activeProject = this.activeProject ?? (frame.projectId ? { id: frame.projectId, name: frame.projectId, lockState: "CANDIDATE", confidence: frame.confidence.project, entities: frame.entities.technologies, topics: frame.entities.concepts, source: "interviewer" } : undefined);
    if (frame.references.some((reference) => !reference.resolved)) frame.references.forEach((reference) => this.anchors.addReference(reference));
    if (frame.speechAct === "ASR_UNRESOLVED" || frame.completion === "ASR_UNCERTAIN") this.unresolvedAsr.push({ raw: frame.rawCombinedText, candidates: built.rewrite.unresolved.flatMap((item) => item.candidates), confidence: frame.confidence.asr, reason: frame.reason });
    const gate = this.gate.evaluate(frame, this.mode);
    if (gate.decision === "WAIT") {
      this.pendingQuestion = cloneFrame(frame);
      const status = frame.completion === "ASR_UNCERTAIN" ? "WAITING_ASR_REPAIR" : frame.completion === "WAITING_REFERENCE" ? "WAITING_REFERENCE" : "WAITING_CONTEXT";
      if (this.pendingQuestion && this.pendingQuestion.id === frame.id) this.ledger.rewrite(frame.id, frame, now, status);
      else this.ledger.upsert(frame, now, status);
      return { type: "QUESTION_WAITING", frame: cloneFrame(frame), gate };
    }
    this.pendingQuestion = undefined;
    this.ledger.remove(frame.id);
    if (gate.decision === "REJECT") {
      if (frame.entities.technologies[0] || frame.entities.concepts[0]) this.anchors.updateTopic(frame.entities.technologies[0] ?? frame.entities.concepts[0], frame.confidence.speechAct, now);
      return { type: "NON_ACTIONABLE", frame: { ...cloneFrame(frame), commitStatus: "REJECTED" }, gate };
    }
    const committed: QuestionFrame = { ...cloneFrame(frame), commitStatus: "COMMITTED", updatedAt: now };
    this.lastCommittedQuestion = committed;
    this.recentQuestions.push(cloneFrame(committed));
    while (this.recentQuestions.length > 20) this.recentQuestions.shift();
    this.anchors.updateQuestion(committed);
    this.anchors.addEntities([
      ...committed.entities.components.map((value) => ({ value, type: "component" as const, confidence: committed.confidence.asr, source: "question", createdAt: now })),
      ...committed.entities.technologies.map((value) => ({ value, type: "technology" as const, confidence: committed.confidence.asr, source: "question", createdAt: now })),
      ...committed.entities.concepts.map((value) => ({ value, type: "concept" as const, confidence: committed.confidence.asr, source: "question", createdAt: now }))
    ]);
    const topic = committed.entities.technologies[0] ?? committed.entities.concepts[0] ?? committed.entities.components[0];
    if (topic) this.anchors.updateTopic(topic, committed.confidence.overall, now);
    const threadId = committed.projectId ?? topic ?? committed.id;
    const thread = this.threads.get(threadId) ?? { id: `question-thread-${threadId}`, rootQuestionId: committed.id, questionIds: [], ...(topic ? { topic } : {}), ...(committed.projectId ? { projectId: committed.projectId } : {}) };
    thread.questionIds.push(committed.id);
    this.threads.set(threadId, thread);
    return { type: "QUESTION_COMMITTED", frame: committed, gate, decisionTrace: { rawSegments: committed.rawSegments, normalizedSegments: [committed.normalizedText], canonicalQuestion: committed.canonicalQuestion, speechAct: committed.speechAct, completion: committed.completion, references: committed.references, activeProject: this.activeProject, questionType: committed.questionType, questionIntent: committed.intent, unresolvedSlots: committed.unresolvedSlots, decision: gate.decision, reason: gate.reason } };
  }
}
