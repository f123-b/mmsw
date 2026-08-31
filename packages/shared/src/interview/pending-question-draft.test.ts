import { describe, expect, it } from "vitest";
import { PendingQuestionDraftAssembler, classifySegmentRole } from "./pending-question-draft";

function segment(id: string, text: string, startMs: number, endMs = startMs + 300) {
  return { id, source: "remote" as const, text, startMs, endMs, final: true };
}

describe("PendingQuestionDraftAssembler", () => {
  it("classifies semantic roles without waiting for a remote model", () => {
    expect(classifySegmentRole("在这个项目中，最后一个追问是", {})).toBe("SETUP");
    expect(classifySegmentRole("你是如何定位这个问题的？", {})).toBe("NUCLEUS");
    expect(classifySegmentRole("不能换硬件，必须说明具体数值", { hasNucleus: true })).toBe("CONSTRAINT");
    expect(classifySegmentRole("需要覆盖两到三个方案和风险", { hasNucleus: true })).toBe("OUTPUT_REQUIREMENT");
    expect(classifySegmentRole("另外，说说看", {})).toBe("FILLER");
  });

  it("holds setup and constraints until a question nucleus arrives", () => {
    const assembler = new PendingQuestionDraftAssembler();
    assembler.add(segment("a", "在这个项目中，最后一个追问是", 0), 1_000);
    assembler.add(segment("b", "你是如何定位这个问题的？", 350), 1_120);
    assembler.add(segment("c", "不能换硬件", 700), 1_200);
    const draft = assembler.current!;
    expect(draft.setup).toContain("在这个项目中，最后一个追问是");
    expect(draft.nucleus).toContain("你是如何定位这个问题的？");
    expect(draft.constraints).toContain("不能换硬件");
    expect(assembler.canonicalText(draft)).toContain("不能换硬件");
    expect(assembler.canonicalText(draft).endsWith("？")).toBe(true);
    expect(assembler.shouldFinalize(1_350)).toBe(false);
    expect(assembler.shouldFinalize(1_450)).toBe(true);
  });

  it("keeps examples and multiple subquestions in one canonical prompt", () => {
    const assembler = new PendingQuestionDraftAssembler();
    assembler.add(segment("a", "说说你会怎么设计？", 0), 2_000);
    assembler.add(segment("b", "比如现场网络断开时怎么办？", 400), 2_100);
    assembler.add(segment("c", "还要说明如何验证恢复。", 800), 2_150);
    const draft = assembler.current!;
    expect(draft.nucleus).toHaveLength(1);
    expect(draft.examples).toContain("比如现场网络断开时怎么办？");
    expect(draft.outputRequirements).toContain("还要说明如何验证恢复。");
    expect(assembler.canonicalText(draft)).toContain("现场网络断开");
    expect(assembler.canonicalText(draft)).toContain("验证恢复");
  });

  it("attaches a late constraint to the last finalized question instead of creating a new question", () => {
    const assembler = new PendingQuestionDraftAssembler({ lateConstraintWindowMs: 3_000 });
    assembler.add(segment("a", "为什么需要看门狗？", 0), 3_000);
    const finalized = assembler.finalize(3_250)!;
    const late = assembler.add(segment("b", "需要给出具体数值，不能换硬件", 600), 4_100);
    expect(finalized.nucleus).toContain("为什么需要看门狗？");
    expect(late.late).toBe(true);
    expect(late.draft?.constraints).toContain("需要给出具体数值，不能换硬件");
    expect(assembler.current).toBeUndefined();
  });

  it("does not answer a filler-only turn", () => {
    const assembler = new PendingQuestionDraftAssembler();
    const update = assembler.add(segment("f", "另外，说说看", 0), 5_000);
    expect(update.accepted).toBe(false);
    expect(assembler.current).toBeUndefined();
  });
});
