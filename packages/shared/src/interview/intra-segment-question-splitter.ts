import { extractTopicEntities } from "./topic-boundary-detector";

export interface IntraSegmentQuestionPart {
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface IntraSegmentQuestionSplitOptions {
  technicalAnchors?: readonly string[];
}

const QUESTION_SIGNAL = /(?:[？?]|(?:什么|为什么|为何|怎么|如何|怎样|哪些|哪种|哪个|是否|有没有|能不能|请问|介绍|解释|说明|说说|讲讲|重点讲|排查|定位|设计|优化|验证|解决|比较|对比))/u;

function isQuestionLike(text: string): boolean {
  const value = text.trim();
  return Boolean(value && QUESTION_SIGNAL.test(value));
}

function anchorsFor(text: string, extra: readonly string[]): string[] {
  const discovered = extractTopicEntities(text);
  const normalized = text.toLocaleLowerCase();
  return [...new Set([...discovered, ...extra.filter((item) => normalized.includes(item.toLocaleLowerCase()))])];
}

/**
 * Splits only independently phrased question clauses in one final ASR
 * segment. A shared technical anchor is intentionally kept together so
 * multi-slot questions such as “CAN 仲裁？CAN 错误处理？” remain one turn.
 */
export function splitIntraSegmentQuestions(text: string, options: IntraSegmentQuestionSplitOptions = {}): IntraSegmentQuestionPart[] {
  const parts: IntraSegmentQuestionPart[] = [];
  const boundary = /[？?！!。](?:\s*|(?=[\u4e00-\u9fffA-Za-z0-9]))/gu;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].trimEnd().length;
    const value = text.slice(start, end).trim();
    if (value) {
      const leading = text.slice(start, start + text.slice(start, end).search(/\S/u));
      const startOffset = start + (leading.length || 0);
      parts.push({ text: value, startOffset, endOffset: end });
    }
    start = match.index + match[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push({ text: tail, startOffset: text.length - text.slice(start).length + text.slice(start).search(/\S/u), endOffset: text.length });
  if (parts.length < 2 || parts.length > 5 || parts.some((part) => !isQuestionLike(part.text))) return [{ text, startOffset: 0, endOffset: text.length }];

  const anchorSets = parts.map((part) => anchorsFor(part.text, options.technicalAnchors ?? []));
  const hasDistinctAnchor = anchorSets.some((anchors, index) => index > 0 && anchors.some((anchor) => !anchorSets.slice(0, index).flat().includes(anchor)));
  if (!hasDistinctAnchor) return [{ text, startOffset: 0, endOffset: text.length }];
  return parts;
}
