import type { TranscriptSegment } from "@interview-copilot/protocol";
import { normalizeTechnicalTerms } from "../terminology";
import { SemanticTurnGate, type SemanticTurnContext, type SemanticTurnDecision } from "./semantic-turn-gate";
import { fragmentFromSegment, sourceForSpeaker, type TranscriptFragment, type TranscriptSpeaker } from "../transcript/transcript-segment";
import type { TranscriptUtterance } from "../transcript-aggregator";

export interface CanonicalRemoteTurnAssemblerOptions {
  maxGapMs?: number;
  maxChars?: number;
  maxDurationMs?: number;
  semanticGate?: SemanticTurnGate;
}

export interface CanonicalRemoteTurn extends TranscriptUtterance {
  speaker: TranscriptSpeaker;
  startTs: number;
  endTs: number;
  fragments: string[];
  rawSegments: TranscriptFragment[];
  semantic: SemanticTurnDecision;
  commitDelayMs: number;
}

export interface CanonicalRemoteTurnUpdate {
  current?: CanonicalRemoteTurn;
  completed: CanonicalRemoteTurn[];
  merged: boolean;
  reason: "partial" | "started" | "merged" | "revised" | "speaker-boundary" | "semantic-boundary" | "time-boundary" | "length-boundary";
  semantic?: SemanticTurnDecision;
}

function clean(value: string): string { return normalizeTechnicalTerms(value).replace(/\s+/g, " ").trim(); }

function join(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/^[，。！？、,.!?；;：:]/u.test(right)) return `${left}${right}`;
  if (/^[\u4e00-\u9fff]/u.test(right) && /[\u4e00-\u9fff]$/u.test(left)) return `${left}${right}`;
  if (/^[\u4e00-\u9fff]/u.test(right) && /[A-Za-z0-9+#]$/u.test(left)) return `${left}${right}`;
  if (/^[A-Za-z0-9+#]/u.test(right) && /[\u4e00-\u9fff]$/u.test(left)) return `${left}${right}`;
  return `${left} ${right}`;
}

function copyFragment(fragment: TranscriptFragment): TranscriptFragment { return { ...fragment }; }

function copy(turn: CanonicalRemoteTurn): CanonicalRemoteTurn {
  return { ...turn, fragments: [...turn.fragments], segmentIds: [...turn.segmentIds], rawSegments: turn.rawSegments.map(copyFragment), semantic: { ...turn.semantic, answerability: { ...turn.semantic.answerability }, classification: { ...turn.semantic.classification, entities: [...turn.semantic.classification.entities] } } };
}

function isTopicBoundary(text: string): boolean {
  return /^(?:换个话题|换个方向|另一个问题|下一个问题|下一题|再问一个|接下来问)[。！？?！\s，,、]*$/iu.test(text);
}

function hasIndependentSubject(text: string): boolean {
  const compact = text.replace(/[\s，。！？、,.!?；;:：]/g, "");
  return compact.length >= 6 && /(?:内存|SPI|I2C|UART|CAN|MCU|项目|架构|软件|系统|函数|volatile|HardFault|中断|malloc|电机|RTOS|Linux|协议|区别|原理)/iu.test(compact);
}

function hasContinuationCue(text: string): boolean {
  return /(?:比如|例如|包括|哪些|分别|不能|绝对|场景|第一步|首先|然后|以及|这几个角度|最难|举个)/iu.test(text);
}

function isProjectCompoundContinuation(previousText: string, nextText: string): boolean {
  return /(?:项目|系统|方案|架构)/iu.test(previousText)
    && /(?:几个人|多少人|负责|分工|主要做|分别)/iu.test(previousText)
    && /(?:负责|分工|主要做|分别|职责|几个人|多少人)/iu.test(nextText);
}

function adaptiveCommitDelay(text: string, semantic: SemanticTurnDecision, fragmentCount: number): number {
  const compoundProject = fragmentCount >= 2
    && /(?:项目|系统|方案|架构)/iu.test(text)
    && /(?:几个人|多少人|负责|分工|主要做|分别)/iu.test(text);
  if (compoundProject) return Math.max(1_000, Math.min(1_600, semantic.recommendedWaitMs));
  return semantic.recommendedWaitMs;
}

function preserveAnswerableSemantic(previous: CanonicalRemoteTurn, next: SemanticTurnDecision): SemanticTurnDecision {
  if (!previous.semantic.shouldAnswer || !["STATEMENT", "INCOMPLETE"].includes(next.speechAct)) return next;
  return {
    ...next,
    speechAct: previous.semantic.speechAct,
    shouldAnswer: true,
    sourceSpeechAct: previous.semantic.sourceSpeechAct,
    classification: { ...next.classification, speechAct: previous.semantic.classification.speechAct, shouldAnswer: true, reason: `${next.classification.reason}+assembled-answer-request` },
    answerability: { ...next.answerability, shouldAnswer: true, state: previous.semantic.answerabilityState === "CONTEXT_DEPENDENT" ? "CONTEXT_DEPENDENT" : "ANSWERABLE" },
    answerabilityState: previous.semantic.answerabilityState === "CONTEXT_DEPENDENT" ? "CONTEXT_DEPENDENT" : "ANSWERABLE",
    reason: `${next.reason}+assembled-answer-request`
  };
}

function shouldSplit(previous: CanonicalRemoteTurn, next: SemanticTurnDecision, nextText: string): boolean {
  if (isTopicBoundary(nextText)) return true;
  if (isProjectCompoundContinuation(previous.text, nextText)) return false;
  if (previous.semantic.dependency === "EXPECTS_NEXT") return false;
  const nextIsAnswerableQuestion = ["QUESTION", "ANSWER_REQUEST", "FOLLOW_UP_REQUEST"].includes(next.speechAct);
  const nextIsExplicitAnswerRequest = /^(?:请|你|能否|可以)?(?:说说|讲讲|介绍一下|解释一下|说明一下|回答一下|谈谈|聊聊|给我讲|告诉我)/iu.test(nextText);
  const nextLooksComplete = /[？?]$/u.test(nextText) || nextIsExplicitAnswerRequest;
  // A complete dependent question is a new conversational turn. A short
  // dependent tail (or an unpunctuated constraint) remains attached to the
  // preceding fragment so “C语言里，指针和数组。有什么区别？” and its
  // later dimensions still form one canonical question.
  if (nextIsAnswerableQuestion && next.dependency === "DEPENDS_ON_PREVIOUS" && previous.semantic.completeness !== "INCOMPLETE" && nextLooksComplete && !hasContinuationCue(previous.text)) return true;
  if (next.dependency === "CONTINUATION" || next.dependency === "DEPENDS_ON_PREVIOUS") return false;
  if (/[。！？?！]$/u.test(previous.text) && nextIsAnswerableQuestion && next.dependency === "INDEPENDENT" && (hasIndependentSubject(nextText) || nextLooksComplete) && !hasContinuationCue(previous.text)) return true;
  return false;
}

function makeTurn(fragment: TranscriptFragment, semantic: SemanticTurnDecision, receivedAt: number): CanonicalRemoteTurn {
  const text = clean(fragment.text);
  return {
    id: `utterance-${fragment.speaker}-${fragment.utteranceId ?? fragment.id}`,
    source: sourceForSpeaker(fragment.speaker),
    final: true,
    startMs: fragment.startTs,
    endMs: fragment.endTs,
    speaker: fragment.speaker,
    text,
    rawText: fragment.rawText ?? fragment.text,
    startTs: fragment.startTs,
    endTs: fragment.endTs,
    fragments: [text],
    segmentIds: [fragment.id],
    firstSegmentReceivedAt: receivedAt,
    lastFinalReceivedAt: receivedAt,
    rawSegments: [copyFragment(fragment)],
    semantic,
    commitDelayMs: adaptiveCommitDelay(text, semantic, 1),
    ...(fragment.confidence !== undefined ? { confidence: fragment.confidence } : {})
  };
}

/**
 * CanonicalRemoteTurnAssembler is the only owner of remote ASR turn state.
 * Provider finality is deliberately treated as fragment finality: a final ASR
 * segment is not an interviewer-turn boundary.
 */
export class CanonicalRemoteTurnAssembler {
  private readonly current = new Map<TranscriptSpeaker, CanonicalRemoteTurn>();
  private readonly partials = new Map<TranscriptSpeaker, TranscriptFragment>();
  private readonly maxGapMs: number;
  private readonly maxChars: number;
  private readonly maxDurationMs: number;
  private readonly semanticGate: SemanticTurnGate;

  constructor(options: CanonicalRemoteTurnAssemblerOptions = {}) {
    this.maxGapMs = Math.max(250, options.maxGapMs ?? 2_000);
    this.maxChars = Math.max(80, options.maxChars ?? 640);
    this.maxDurationMs = Math.max(1_000, options.maxDurationMs ?? 12_000);
    this.semanticGate = options.semanticGate ?? new SemanticTurnGate();
  }

  get pending(): CanonicalRemoteTurn[] { return [...this.current.values()].map(copy); }

  push(input: TranscriptSegment | TranscriptFragment, receivedAt = Date.now(), context: SemanticTurnContext = {}, rawText?: string): CanonicalRemoteTurnUpdate {
    const fragment = "speaker" in input ? { ...input, rawText: input.rawText ?? rawText } : fragmentFromSegment(input, rawText ?? input.text);
    const text = clean(fragment.text);
    if (!fragment.final) {
      this.partials.set(fragment.speaker, { ...fragment, text });
      const current = this.current.get(fragment.speaker);
      return { ...(current ? { current: copy(current) } : {}), completed: [], merged: false, reason: "partial" };
    }
    if (!text) return { completed: [], merged: false, reason: "partial" };
    this.partials.delete(fragment.speaker);
    const previous = this.current.get(fragment.speaker);
    const previousContext: SemanticTurnContext = {
      ...context,
      previousInterviewerTurn: previous?.text ?? context.previousInterviewerTurn,
      asrEndpoint: Boolean(fragment.endpoint || fragment.speechFinal || fragment.utteranceEnd || fragment.endOfTurn)
    };
    const semantic = this.semanticGate.decide(text, previousContext);
    if (previous) {
      const revisionIndex = previous.rawSegments.findIndex((item) => item.id === fragment.id || Boolean(item.utteranceId && item.utteranceId === fragment.utteranceId));
      if (revisionIndex >= 0) {
        const replacement = copyFragment(fragment);
        previous.rawSegments[revisionIndex] = replacement;
        previous.fragments[revisionIndex] = text;
        previous.segmentIds[revisionIndex] = fragment.id;
        previous.text = previous.fragments.reduce(join, "");
        previous.rawText = previous.rawSegments.map((item) => item.rawText ?? item.text).reduce(join, "");
        previous.endTs = Math.max(previous.endTs, fragment.endTs);
        previous.endMs = previous.endTs;
        previous.lastFinalReceivedAt = receivedAt;
        previous.semantic = preserveAnswerableSemantic(previous, this.semanticGate.decide(previous.text, context));
        previous.commitDelayMs = adaptiveCommitDelay(previous.text, previous.semantic, previous.fragments.length);
        return { current: copy(previous), completed: [], merged: true, reason: "revised", semantic: previous.semantic };
      }
      const gap = fragment.startTs - previous.endTs;
      const duration = fragment.endTs - previous.startTs;
      const exceedsLength = previous.text.length + text.length > this.maxChars || duration > this.maxDurationMs;
      // ASR providers commonly overlap adjacent finals while revising the
      // endpoint timestamp. Treat a bounded overlap as continuity; otherwise
      // a phrase such as “问题，比如。” → “急速抖动。” is split before the
      // semantic gate can see the complete question.
      const canMerge = gap >= -500 && gap <= this.maxGapMs && !exceedsLength && !shouldSplit(previous, semantic, text);
      if (canMerge) {
        previous.rawSegments.push(copyFragment(fragment));
        previous.fragments.push(text);
        previous.segmentIds.push(fragment.id);
        previous.text = join(previous.text, text);
        previous.rawText = join(previous.rawText ?? "", fragment.rawText ?? fragment.text);
        previous.endTs = Math.max(previous.endTs, fragment.endTs);
        previous.endMs = previous.endTs;
        previous.lastFinalReceivedAt = receivedAt;
        previous.semantic = preserveAnswerableSemantic(previous, this.semanticGate.decide(previous.text, context));
        previous.commitDelayMs = adaptiveCommitDelay(previous.text, previous.semantic, previous.fragments.length);
        if (fragment.confidence !== undefined) previous.confidence = fragment.confidence;
        return { current: copy(previous), completed: [], merged: true, reason: "merged", semantic: previous.semantic };
      }
      const completed = [{ ...copy(previous), finalized: true, finalizedAt: receivedAt }];
      const reason = gap > this.maxGapMs ? "time-boundary" : exceedsLength ? "length-boundary" : shouldSplit(previous, semantic, text) ? "semantic-boundary" : "speaker-boundary";
      const current = makeTurn(fragment, semantic, receivedAt);
      this.current.set(fragment.speaker, current);
      void receivedAt;
      return { current: copy(current), completed, merged: false, reason, semantic };
    }
    const current = makeTurn(fragment, semantic, receivedAt);
    this.current.set(fragment.speaker, current);
    void receivedAt;
    return { current: copy(current), completed: [], merged: false, reason: "started", semantic };
  }

  flush(speaker?: TranscriptSpeaker, finalizedAt = Date.now()): CanonicalRemoteTurn[] {
    const speakers = speaker ? [speaker] : [...this.current.keys()];
    return speakers.flatMap((item) => {
      const value = this.current.get(item);
      if (!value) return [];
      this.current.delete(item);
      return [{ ...copy(value), finalized: true, finalizedAt }];
    });
  }

  /** Flushes turns whose semantic deadline has elapsed before a new fragment. */
  flushDue(receivedAt: number, speaker?: TranscriptSpeaker): CanonicalRemoteTurn[] {
    const speakers = speaker ? [speaker] : [...this.current.keys()];
    return speakers.flatMap((item) => {
      const value = this.current.get(item);
      if (!value) return [];
      const lastReceivedAt = value.lastFinalReceivedAt ?? value.firstSegmentReceivedAt ?? value.endMs;
      if (receivedAt - lastReceivedAt < value.commitDelayMs) return [];
      this.current.delete(item);
      return [{ ...copy(value), finalized: true, finalizedAt: receivedAt }];
    });
  }

  clear(): void {
    this.current.clear();
    this.partials.clear();
  }
}

/** Compatibility spelling used by integrations that still say “transcript”. */
export { CanonicalRemoteTurnAssembler as RemoteTurnAssembler };
