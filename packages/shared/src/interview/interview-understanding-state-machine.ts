import type { ProjectAliasCandidate } from "../project-alias-resolver";
import { ConversationAnchorState } from "./conversation-anchor-state";
import { QuestionCommitGate, type QuestionCommitGateResult } from "./question-commit-gate";
import { QuestionFrameBuilder } from "./question-frame-builder";
import { QuestionPendingLedger } from "./question-pending-ledger";
import type { ActiveProjectContext, AnswerFrame, InterviewUnderstandingState, QuestionFrame, QuestionThreadState } from "./question-frame";
import { cleanQuestionDiscourse, spokenEntities } from "./question-subject";
import { classifySpeechActV3 } from "./speech-act-v3";
import { analyzeSelfIntroductionIntent } from "./self-introduction-intent";

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

function cloneFrame(frame: QuestionFrame): QuestionFrame { return { ...frame, segmentIds: [...frame.segmentIds], rawSegments: [...frame.rawSegments], subQuestions: frame.subQuestions.map((slot) => ({ ...slot })), requirements: frame.requirements.map((item) => ({ ...item })), entities: { ...frame.entities, projects: [...frame.entities.projects], components: [...frame.entities.components], technologies: [...frame.entities.technologies], concepts: [...frame.entities.concepts] }, references: frame.references.map((reference) => ({ ...reference, evidence: [...reference.evidence] })), contextSnapshot: { ...frame.contextSnapshot, activeEntities: frame.contextSnapshot.activeEntities.map((item) => ({ ...item })), recentRelevantTurns: [...frame.contextSnapshot.recentRelevantTurns], references: frame.contextSnapshot.references.map((item) => ({ ...item })), inherited: { ...frame.contextSnapshot.inherited }, ...(frame.contextSnapshot.project ? { project: { ...frame.contextSnapshot.project, entities: [...frame.contextSnapshot.project.entities], topics: [...frame.contextSnapshot.project.topics] } } : {}) }, confidence: { ...frame.confidence }, unresolvedSlots: [...frame.unresolvedSlots] };
}

function activeProjectFrom(input: UnderstandingMachineOptions, current?: ActiveProjectContext): ActiveProjectContext | undefined {
  return input.activeProject ?? current;
}

function isDirectAnswerableQuestion(text: string): boolean {
  const compact = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (compact.length < 4 || /(?:为什么.*(?:要)?选|(?:是)?用的什么)[？?。！!，,、\s]*$/u.test(text)) return false;
  return /(?:为何|为什么|怎么|如何|哪(?:个|些|一种)|多少|是否|是不是|能否|可否|区别|优点|缺点|优势|劣势|作用|原理|(?:是|有|做|负责|用|选|包含|包括)什么|什么(?:是|区别|作用|原理|优势|项目|原因|特点|问题))/u.test(text)
    || /(?:介绍|讲述|讲讲|说说).{0,12}(?:项目|经历|自己|优势|技术|系统)|(?:项目|经历).{0,8}(?:介绍|讲述|讲讲|说说)/u.test(text);
}

function shouldAppend(frame: QuestionFrame, text: string): boolean {
  if (!text.trim()) return false;
  const nextEntities = spokenEntities(text);
  const currentEntities = spokenEntities(frame.normalizedText);
  if (nextEntities.length && /(?:什么|怎么|如何|区别|原理|作用|为什么)/u.test(text)
    && (frame.completion === "ASR_UNCERTAIN" || currentEntities.length && !nextEntities.some((entity) => currentEntities.includes(entity)))) return false;
  if (frame.completion === "ASR_UNCERTAIN") return /(?:ADC|DMA|PWM|SPI|CAN|F405|STM32|栈|stack|中断|向量|内核)/iu.test(text);
  if (frame.completion !== "COMPLETE") return true;
  const next = text.trim();
  const previous = frame.canonicalQuestion;
  // SEMANTIC_COMPLETE is not a hard boundary. A short follow-up, a
  // dangling selection object, or an explicit continuation can still be
  // appended while the frame is in its adaptive stability window.
  return next.length <= 22
    || /^(?:什么样的原因|为什么这样|为什么这么做|用的什么|多久|哪个|哪一个|具体|还有|以及|包括|然后|并且|而且|F[四4]|F405|STM32)/iu.test(next)
    || /(?:为什么(?:要)?选|为什么(?:要)?选择|包括|分别|以及|并且|而且|比如|例如)[？?。！!，,、\s]*$/iu.test(previous);
}

function mergeFrame(previous: QuestionFrame, next: QuestionFrame, now: number): QuestionFrame {
  const rawSegments = previous.rawSegments.every((value, index) => next.rawSegments[index] === value)
    ? [...next.rawSegments]
    : [...previous.rawSegments, ...next.rawSegments];
  const merged: QuestionFrame = {
    ...next,
    id: previous.id,
    segmentIds: [...new Set([...previous.segmentIds, ...next.segmentIds])],
    rawSegments,
    rawCombinedText: rawSegments.join(" "),
    stabilityState: next.stabilityState,
    requirements: [...new Map([...previous.requirements, ...next.requirements].map((item) => [item.id, item])).values()],
    contextSnapshot: next.contextSnapshot,
    ...(next.asrRepair ?? previous.asrRepair ? { asrRepair: next.asrRepair ?? previous.asrRepair } : {}),
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
    const threads: QuestionThreadState[] = [...this.threads.values()].map((thread) => ({ ...thread, questionIds: [...thread.questionIds], updatedAt: this.lastCommittedQuestion?.updatedAt ?? this.now() }));
    const currentThread = this.lastCommittedQuestion ? threads.find((thread) => thread.questionIds.includes(this.lastCommittedQuestion?.id ?? "")) : undefined;
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
      ,context: {
        sessionId: this.sessionId,
        ...(this.activeProject ? { activeProject: { ...this.activeProject, entities: [...this.activeProject.entities], topics: [...this.activeProject.topics] } } : {}),
        ...(anchor.currentTopic ? { currentTopic: { name: anchor.currentTopic.name, confidence: anchor.currentTopic.confidence, updatedAt: anchor.currentTopic.createdAt } } : {}),
        activeEntities: anchor.entities.map((item) => ({ ...item })),
        ...(this.pendingQuestion ? { pendingQuestion: cloneFrame(this.pendingQuestion) } : {}),
        pendingFragments: this.pendingTurn ? [{ ...this.pendingTurn, segmentIds: [...this.pendingTurn.segmentIds], rawSegments: [...this.pendingTurn.rawSegments] }] : [],
        ...(this.lastCommittedQuestion ? { lastCommittedQuestion: cloneFrame(this.lastCommittedQuestion) } : {}),
        ...(this.lastAnsweredQuestion ? { lastAnsweredQuestion: cloneFrame(this.lastAnsweredQuestion) } : {}),
        recentQuestions: this.recentQuestions.map(cloneFrame),
        recentAnswers: this.recentAnswers.map((item) => ({ ...item })),
        unresolvedReferences: anchor.unresolvedReferences.map((item) => ({ ...item, evidence: [...item.evidence] })),
        unresolvedAsr: this.unresolvedAsr.map((item) => ({ ...item, candidates: [...item.candidates] })),
        ...(currentThread ? { currentThread: { ...currentThread, questionIds: [...currentThread.questionIds] } } : {}),
        threads,
        sessionMemo: {
          projectsDiscussed: this.activeProject ? [this.activeProject.name] : [],
          topicsDiscussed: anchor.currentTopic ? [anchor.currentTopic.name] : [],
          interviewerFocus: this.recentQuestions.slice(-8).map((item) => item.canonicalQuestion),
          verifiedCandidateClaims: []
        }
      }
    };
  }

  setActiveProject(project?: ActiveProjectContext): void { this.activeProject = project; this.anchors.updateProject(project); }
  recordAnswer(answer: AnswerFrame): void {
    const question = this.recentQuestions.find((item) => item.id === answer.questionId || `v3-question-${item.id}` === answer.questionId);
    this.lastAnsweredQuestion = question ? cloneFrame(question) : undefined;
    this.recentAnswers.push({ ...answer });
    while (this.recentAnswers.length > 12) this.recentAnswers.shift();
    this.anchors.updateAnswer(answer);
  }

  /**
   * Commits a structurally complete pending question after its stability
   * window has elapsed. Accurate mode still refuses unresolved ASR,
   * unresolved references, and incomplete frames; only the confidence
   * threshold is allowed to degrade to the fast-mode floor. This prevents a
   * valid question from remaining in WAIT forever when no additional ASR
   * fragment arrives after the interviewer stops speaking.
   */
  commitPending(mode: "ACCURATE_INTERVIEW" | "FAST_PRACTICE" = "FAST_PRACTICE"): UnderstandingEvent | undefined {
    const pending = this.pendingQuestion;
    if (!pending) return undefined;
    if (pending.completion !== "COMPLETE") return undefined;
    if (!["QUESTION", "FOLLOW_UP", "CLARIFICATION"].includes(pending.speechAct)) return undefined;
    if (pending.speechAct === "FOLLOW_UP" && pending.references.some((reference) => !reference.resolved)) return undefined;
    const gate = this.gate.evaluate(pending, mode);
    if (gate.decision === "WAIT") return { type: "QUESTION_WAITING", frame: cloneFrame(pending), gate };
    const stabilizedGate: QuestionCommitGateResult = {
      ...gate,
      reason: `stability-timeout-${gate.reason}`
    };
    return this.commitFrame({ ...cloneFrame(pending), updatedAt: this.now() }, stabilizedGate);
  }

  /** Preserve a complete question before the next independent topic replaces it. */
  commitBeforeNewTurn(text: string): UnderstandingEvent | undefined {
    if (!this.pendingQuestion || shouldAppend(this.pendingQuestion, text)) return undefined;
    return this.commitPending("FAST_PRACTICE");
  }

  process(input: UnderstandingSegmentInput, projectCandidates: readonly ProjectAliasCandidate[] = []): UnderstandingEvent {
    const now = input.timestamp ?? this.now();
    const speaker = input.speaker ?? "interviewer";
    this.previousSpeaker = this.currentSpeaker;
    this.currentSpeaker = speaker;
    const rawText = input.rawText ?? input.text;
    const initialSpeechAct = classifySpeechActV3(input.text).speechAct;
    if (speaker === "candidate" || ["BACKCHANNEL", "FILLER"].includes(initialSpeechAct) || (initialSpeechAct === "CONFIRMATION_CHECK" && !isDirectAnswerableQuestion(input.text))) {
      const built = this.builder.build({ id: input.id, sessionId: this.sessionId, rawText, final: input.final, speaker, timestamp: now, anchors: this.anchors.snapshot(), activeProject: this.activeProject, now });
      return { type: "NON_ACTIONABLE", frame: { ...built.frame, commitStatus: "REJECTED" }, gate: { decision: "REJECT", status: "REJECTED", reason: speaker === "candidate" ? "candidate-speech" : "non-question-backchannel", postCompletionReady: false } };
    }
    if (!input.final) {
      const previous = this.pendingTurn?.speaker === speaker ? this.pendingTurn : undefined;
      const segmentIds = [...new Set([...(previous?.segmentIds ?? []), ...(input.segmentIds ?? [input.id])])];
      // Interim events replace one live preview; do not concatenate every
      // revision (or let a long utterance grow this buffer without a bound).
      const rawSegments = [rawText];
      this.pendingTurn = { segmentIds, rawSegments, rawCombinedText: rawSegments.join(" "), speaker, firstSeenAt: previous?.firstSeenAt ?? now, lastUpdatedAt: now };
      const built = this.builder.build({ id: input.id, sessionId: this.sessionId, rawText, rawSegments: [rawText], segmentIds: input.segmentIds, final: false, speaker, timestamp: now, asrConfidence: input.asrConfidence, anchors: this.anchors.snapshot(), activeProject: activeProjectFrom({}, this.activeProject), projectCandidates, now });
      return { type: "QUESTION_DRAFT_UPDATED", frame: built.frame, gate: { decision: "WAIT", status: "BUFFERING", reason: "interim-transcript", postCompletionReady: false } };
    }

    const existingPending = this.pendingQuestion && now - this.pendingQuestion.updatedAt <= 12_000 && shouldAppend(this.pendingQuestion, input.text) ? this.pendingQuestion : undefined;
    if (this.pendingQuestion && !existingPending) {
      this.ledger.remove(this.pendingQuestion.id);
      this.pendingQuestion = undefined;
    }
    const pendingTurn = this.pendingTurn?.speaker === speaker ? this.pendingTurn : undefined;
    const rawSegments = input.rawSegments?.length ? input.rawSegments : pendingTurn ? [...pendingTurn.rawSegments, rawText] : [rawText];
    const segmentIds = input.segmentIds?.length ? input.segmentIds : pendingTurn ? [...new Set([...pendingTurn.segmentIds, input.id])] : [input.id];
    const built = this.builder.build({ id: input.id, sessionId: this.sessionId, rawText, rawSegments: existingPending ? [...existingPending.rawSegments, ...rawSegments] : rawSegments, segmentIds, final: true, speaker, timestamp: now, asrConfidence: input.asrConfidence, anchors: this.anchors.snapshot(), activeProject: activeProjectFrom({}, this.activeProject), previousAnswer: this.lastAnsweredQuestion ? this.recentAnswers.at(-1)?.text : undefined, projectCandidates, now });
    const mergedFrame = existingPending ? mergeFrame(existingPending, built.frame, now) : built.frame;
    const isAnswerConstraintFragment = Boolean(existingPending && /^(?:F[四4]零五|F405|STM32F405|DMA|ADC|PWM|向量终端|非向量终端)[。！？?！\s]*$/iu.test(input.text.trim()));
    const frame: QuestionFrame = isAnswerConstraintFragment
      ? { ...mergedFrame, completion: "WAITING_CONSTRAINT", stabilityState: "STABILIZING", commitStatus: "WAITING", unresolvedSlots: [...new Set([...mergedFrame.unresolvedSlots, "follow-up-constraint"])], reason: `${mergedFrame.reason}+fragment-needs-constraint` }
      : mergedFrame;
    this.pendingTurn = undefined;
    if (frame.contextSnapshot?.project?.lockState === "LOCKED" && frame.projectId && frame.projectId !== this.activeProject?.id) {
      this.activeProject = frame.contextSnapshot.project;
      this.anchors.updateProject(this.activeProject);
    }
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
    return this.commitFrame(frame, gate, now);
  }

  private commitFrame(frame: QuestionFrame, gate: QuestionCommitGateResult, now = this.now()): UnderstandingEvent {
    this.pendingQuestion = undefined;
    this.ledger.remove(frame.id);
    if (gate.decision === "REJECT") {
      if (frame.entities.technologies[0] || frame.entities.concepts[0]) this.anchors.updateTopic(frame.entities.technologies[0] ?? frame.entities.concepts[0], frame.confidence.speechAct, now);
      return { type: "NON_ACTIONABLE", frame: { ...cloneFrame(frame), commitStatus: "REJECTED" }, gate };
    }
    const key = (text: string) => cleanQuestionDiscourse(text).replace(/[\s\p{P}\p{S}]/gu, "").replace(/^(?:那|那么)/u, "").toLowerCase();
    const repeated = this.lastCommittedQuestion && now - this.lastCommittedQuestion.updatedAt <= 15_000
      && (key(frame.canonicalQuestion) === key(this.lastCommittedQuestion.canonicalQuestion)
        || analyzeSelfIntroductionIntent(frame.canonicalQuestion).matched && analyzeSelfIntroductionIntent(this.lastCommittedQuestion.canonicalQuestion).matched
          && !analyzeSelfIntroductionIntent(frame.canonicalQuestion).hasAdditionalConstraint);
    if (repeated && !/再说|再讲|重说|重新|没听清/u.test(frame.rawCombinedText)) {
      return { type: "NON_ACTIONABLE", frame: { ...cloneFrame(frame), commitStatus: "REJECTED" }, gate: { decision: "REJECT", status: "REJECTED", reason: "duplicate-question", postCompletionReady: false } };
    }
    const committed: QuestionFrame = { ...cloneFrame(frame), commitStatus: "COMMITTED", stabilityState: "STABLE", updatedAt: now };
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
    return { type: "QUESTION_COMMITTED", frame: committed, gate, decisionTrace: { rawSegments: committed.rawSegments, normalizedSegments: [committed.normalizedText], canonicalQuestion: committed.canonicalQuestion, speechAct: committed.speechAct, completion: committed.completion, stabilityState: committed.stabilityState, requirements: committed.requirements, contextSnapshotId: committed.contextSnapshot.id, references: committed.references, activeProject: this.activeProject, questionType: committed.questionType, questionIntent: committed.intent, unresolvedSlots: committed.unresolvedSlots, decision: gate.decision, reason: gate.reason } };
  }
}
