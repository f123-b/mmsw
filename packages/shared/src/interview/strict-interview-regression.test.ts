import { describe, expect, it } from "vitest";
import { buildCanonicalQuestion, PendingQuestionDraftAssembler, classifySegmentRole } from "./pending-question-draft";

function segment(id: string, text: string, startMs: number) {
  return { id, source: "remote" as const, text, startMs, endMs: startMs + 400, final: true };
}

describe("strict interview multi-segment regression fixtures", () => {
  it("keeps the supplied A-G scenarios complete in a local semantic draft", () => {
    const fixtures = [
      {
        id: "A",
        segments: [
          "说说你做的 FOC 电机控制项目里，",
          "电流环和速度环是怎么设计的？",
          "采样频率、PI 参数整定，还有你怎么处理积分饱和？",
          "补充：尽量结合具体数值。"
        ],
        required: ["FOC 电机控制项目", "电流环和速度环", "采样频率", "PI 参数整定", "积分饱和", "具体数值"]
      },
      {
        id: "B",
        segments: ["在这个项目中，你是如何进行电流采样与 ADC 触发的？", "PWM 和 ADC 的同步怎么保证？"],
        required: ["电流采样", "ADC 触发", "PWM 和 ADC 的同步"]
      },
      {
        id: "C",
        segments: ["好，假设让你在两周内把 FOC 驱动方案交付给一个新客户，硬件不变。", "但电机参数不同。", "你如何快速适配并验证性能？", "请给出计划、风险点和应对措施。"],
        required: ["两周", "新客户", "硬件不变", "电机参数不同", "快速适配", "验证性能", "计划", "风险点", "应对措施"]
      },
      {
        id: "D",
        segments: ["最后一个追问：如果客户反馈在低速大扭矩时仍有轻微啸叫……", "不能更换硬件。", "仅软件优化，你会优先尝试哪些方向？", "请给两到三个可执行思路。"],
        required: ["低速大扭矩", "轻微啸叫", "不能更换硬件", "软件优化", "两到三个可执行思路"]
      },
      {
        id: "E",
        segments: ["假设现场出现偶发性 HardFault，系统无规律复位，你会如何一步步定位？", "包括：异常现场捕获、寄存器解析、栈回溯、map 文件、看门狗策略。", "请给出完整排查思路。"],
        required: ["HardFault", "无规律复位", "一步步定位", "异常现场捕获", "寄存器解析", "栈回溯", "map 文件", "看门狗策略", "完整排查思路"]
      },
      {
        id: "F",
        segments: ["另外，说说看。"],
        required: []
      },
      {
        id: "G",
        segments: ["优先级反转是什么？", "你在项目中会如何避免？"],
        required: ["优先级反转", "项目中会如何避免"]
      }
    ];
    const expectedQuestionTurns = 6;
    let detectedQuestionTurns = 0;
    let missedQuestionTurns = 0;
    let multiSegmentQuestions = 0;
    let fullyAssembledQuestions = 0;
    let constraintSegments = 0;
    let preservedConstraintSegments = 0;
    let falsePositiveQuestions = 0;

    for (const fixture of fixtures) {
      const assembler = new PendingQuestionDraftAssembler();
      fixture.segments.forEach((text, index) => assembler.add(segment(`${fixture.id}-${index}`, text, index * 400), index * 400));
      if (fixture.id === "F") {
        expect(assembler.current).toBeUndefined();
        falsePositiveQuestions += 0;
        continue;
      }
      const draft = assembler.finalize(3_000);
      expect(draft).toBeDefined();
      const canonical = buildCanonicalQuestion(draft!);
      detectedQuestionTurns += canonical ? 1 : 0;
      missedQuestionTurns += canonical ? 0 : 1;
      if (fixture.segments.length > 1) multiSegmentQuestions += 1;
      if (fixture.required.every((fragment) => canonical.includes(fragment))) fullyAssembledQuestions += 1;
      fixture.segments.forEach((text) => {
        const role = classifySegmentRole(text, { hasNucleus: true });
        if (role === "CONSTRAINT") {
          constraintSegments += 1;
          if (canonical.includes(text.replace(/[。！？?！]+$/u, ""))) preservedConstraintSegments += 1;
        }
      });
    }

    const lateAssembler = new PendingQuestionDraftAssembler();
    lateAssembler.add(segment("late-q", "假设现场出现偶发性 HardFault，你会如何一步步定位？", 0), 0);
    lateAssembler.finalize(300);
    const late = lateAssembler.add(segment("late-c", "包括异常现场捕获、寄存器解析、栈回溯、map 文件和看门狗策略。", 700), 700);
    expect(late.late).toBe(true);
    expect(late.draft && buildCanonicalQuestion(late.draft)).toContain("map 文件");

    const metrics = {
      expectedQuestionTurns,
      detectedQuestionTurns,
      missedQuestionTurns,
      multiSegmentQuestions,
      fullyAssembledQuestions,
      constraintSegments,
      preservedConstraintSegments,
      lateConstraintSegments: 1,
      preservedLateConstraintSegments: late.draft?.constraints.some((value) => value.includes("map 文件")) ? 1 : 0,
      semanticNoiseSegments: 1,
      falsePositiveQuestions
    };
    console.log(`STRICT_INTERVIEW_REGRESSION_METRICS ${JSON.stringify({
      ...metrics,
      questionRecall: metrics.detectedQuestionTurns / metrics.expectedQuestionTurns,
      multiSegmentCoverage: metrics.fullyAssembledQuestions / metrics.multiSegmentQuestions,
      constraintCoverage: metrics.preservedConstraintSegments / metrics.constraintSegments,
      lateConstraintCoverage: metrics.preservedLateConstraintSegments / metrics.lateConstraintSegments,
      falsePositiveRate: metrics.falsePositiveQuestions / metrics.detectedQuestionTurns
    })}`);
    expect(metrics.detectedQuestionTurns).toBe(metrics.expectedQuestionTurns);
    expect(metrics.missedQuestionTurns).toBe(0);
    expect(metrics.fullyAssembledQuestions).toBe(metrics.multiSegmentQuestions);
    expect(metrics.preservedConstraintSegments).toBe(metrics.constraintSegments);
    expect(metrics.preservedLateConstraintSegments).toBe(metrics.lateConstraintSegments);
    expect(metrics.falsePositiveQuestions).toBe(0);
  });
});
