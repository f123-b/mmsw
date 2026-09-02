import { describe, expect, it } from "vitest";
import { QuestionFrameBuilder } from "./question-frame-builder";
import { QuestionPendingLedger } from "./question-pending-ledger";

function frame(id: string) {
  return new QuestionFrameBuilder().build({
    id,
    rawText: "为什么选择 STM32F405？",
    final: true,
    anchors: { activeProject: undefined, currentTopic: undefined, lastQuestion: undefined, lastAnswer: undefined, entities: [], unresolvedReferences: [] }
  }).frame;
}

describe("QuestionPendingLedger", () => {
  it("supports append, rewrite, split and commit without discarding evidence", () => {
    const ledger = new QuestionPendingLedger();
    const original = frame("pending");
    ledger.upsert(original, 100, "WAITING_CONTEXT");
    const appended = { ...original, rawSegments: ["选型时还考虑了哪些因素？"], rawCombinedText: `${original.rawCombinedText} 选型时还考虑了哪些因素？` };
    expect(ledger.append("pending", appended, 200)?.frame.rawSegments).toHaveLength(2);
    expect(ledger.rewrite("pending", { ...appended, canonicalQuestion: "为什么选择 STM32F405？还考虑了哪些因素？" }, 300).frame.canonicalQuestion).toContain("还考虑");
    const split = ledger.split("pending", [frame("q1"), frame("q2")], 400);
    expect(split).toHaveLength(2);
    expect(ledger.commit(split[0].frame.id)?.id).toBe(split[0].frame.id);
    expect(ledger.size).toBe(1);
  });
});
