import { hasIndependentQuestionNucleus } from "./semantic-answerability";

export interface IntraSegmentQuestionPart {
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface IntraSegmentQuestionSplitOptions {
  /** Retained for callers that used the old splitter API. */
  technicalAnchors?: readonly string[];
}

export type ExplicitSplitReason =
  | "explicit-new-question"
  | "explicit-topic-switch"
  | "enumerated-independent-question"
  | "same-multislot-question"
  | "insufficient-boundary";

export interface ExplicitSplitDecision {
  shouldSplit: boolean;
  confidence: number;
  reason: ExplicitSplitReason;
}

interface BoundaryMatch {
  marker: string;
  index: number;
  reason: ExplicitSplitReason;
}

const EXPLICIT_BOUNDARY = /(?:^|[。！？?！]\s*|[，,、]\s*)(第二个问题|第三个问题|另外(?:一个问题)?|换个问题|换一个问题|再问一个完全不同的(?:问题)?|接下来问另一个(?:问题)?|下一个问题|下个问题|下一题|说到另一个)/giu;
const TRANSITION_CLOSE = /(?:这个(?:问题)?先到这里|这个(?:问题)?到这里)(?:[。！？?！\s，,、]*(?:下一题|换个问题|另一个问题))?/iu;

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function explicitBoundaryMatches(text: string): BoundaryMatch[] {
  const matches: BoundaryMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = EXPLICIT_BOUNDARY.exec(text))) {
    const marker = match[1];
    const index = match.index + match[0].lastIndexOf(marker);
    const reason: ExplicitSplitReason = /^(?:第二个问题|第三个问题)$/.test(marker)
      ? "enumerated-independent-question"
      : "explicit-topic-switch";
    matches.push({ marker, index, reason });
  }
  EXPLICIT_BOUNDARY.lastIndex = 0;
  return matches;
}

function stripBoundaryPrefix(text: string): string {
  return clean(text).replace(/^(?:第二个问题|第三个问题|另外(?:一个问题)?|换个问题|换一个问题|再问一个完全不同的(?:问题)?|接下来问另一个(?:问题)?|下一个问题|下个问题|下一题|说到另一个)[，,、:：\s]*/iu, "");
}

function independentNucleusAfterBoundary(text: string): boolean {
  const remainder = stripBoundaryPrefix(text);
  return Boolean(remainder && hasIndependentQuestionNucleus(remainder));
}

function part(text: string, startOffset: number, endOffset: number): IntraSegmentQuestionPart | undefined {
  const value = text.slice(startOffset, endOffset).trim();
  if (!value) return undefined;
  const source = text.slice(startOffset, endOffset);
  const leadingWhitespace = source.search(/\S/u);
  const leading = leadingWhitespace < 0 ? 0 : leadingWhitespace;
  const trailing = source.length - source.trimEnd().length;
  return { text: value, startOffset: startOffset + leading, endOffset: endOffset - trailing };
}

/**
 * Makes the split decision independently of punctuation and entity overlap.
 * A question mark or a new technical entity is deliberately insufficient:
 * both are common inside one interviewer turn with several answer slots.
 */
export function detectExplicitQuestionBoundary(text: string): ExplicitSplitDecision {
  const normalized = clean(text);
  if (!normalized) return { shouldSplit: false, confidence: 1, reason: "insufficient-boundary" };
  const matches = explicitBoundaryMatches(normalized);
  if (!matches.length) {
    const questionMarks = (normalized.match(/[？?]/gu) ?? []).length;
    return { shouldSplit: false, confidence: questionMarks > 1 ? 0.98 : 0.99, reason: questionMarks > 1 ? "same-multislot-question" : "insufficient-boundary" };
  }
  const first = matches[0];
  const before = normalized.slice(0, first.index);
  const after = normalized.slice(first.index);
  const firstIsIndependent = hasIndependentQuestionNucleus(before);
  const transitionClose = TRANSITION_CLOSE.test(before);
  if ((firstIsIndependent || transitionClose) && independentNucleusAfterBoundary(after)) {
    return { shouldSplit: true, confidence: 0.99, reason: first.reason };
  }
  return { shouldSplit: false, confidence: 0.9, reason: "insufficient-boundary" };
}

/**
 * Retains the public splitter API for the production coordinator. The default
 * is now the complete ASR utterance; only an explicit topic/new-question
 * boundary with an independent subject and nucleus can create parts.
 */
export function splitIntraSegmentQuestions(text: string, _options: IntraSegmentQuestionSplitOptions = {}): IntraSegmentQuestionPart[] {
  const decision = detectExplicitQuestionBoundary(text);
  if (!decision.shouldSplit) return [{ text, startOffset: 0, endOffset: text.length }];
  const matches = explicitBoundaryMatches(text);
  const first = matches[0];
  const firstPart = part(text, 0, first.index);
  const secondPart = part(text, first.index, text.length);
  if (!firstPart || !secondPart || !independentNucleusAfterBoundary(secondPart.text)) return [{ text, startOffset: 0, endOffset: text.length }];
  return [firstPart, secondPart];
}
