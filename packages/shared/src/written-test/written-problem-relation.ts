import type { WrittenProblemFrame, WrittenProblemRelation } from "./written-test-types";

export function resolveWrittenProblemRelation(current: WrittenProblemFrame | undefined, previous: WrittenProblemFrame | undefined, screenshotCount: number): WrittenProblemRelation {
  if (!previous || screenshotCount === 0) return "NEW_QUESTION";
  if (!current) return "NEW_QUESTION";
  const currentText = `${current.canonicalQuestion} ${current.rawText}`.toLowerCase();
  const previousText = `${previous.canonicalQuestion} ${previous.rawText}`.toLowerCase();
  const continuation = /继续|补充|上图|如下|第二问|第[二三四]部分|基于.*图|同一题/.test(currentText);
  if (continuation || (previousText.length > 18 && currentText.includes(previousText.slice(0, 18)))) return "CONTINUATION";
  if (currentText === previousText || (current.canonicalQuestion.length > 16 && previous.canonicalQuestion.includes(current.canonicalQuestion))) return "REPLACE_SCREENSHOT";
  return "NEW_QUESTION";
}
