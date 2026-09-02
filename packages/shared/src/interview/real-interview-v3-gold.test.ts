import { describe, expect, it } from "vitest";
import fixture from "../../../../tests/fixtures/real-interview-20260902.json";
import { InterviewUnderstandingStateMachine, type ActiveProjectContext, type UnderstandingEvent } from "./interview-understanding-state-machine";

const foc: ActiveProjectContext = {
  id: "foc-motor-control",
  name: "FOC / 电机控制",
  lockState: "LOCKED",
  confidence: 0.99,
  entities: ["FOC", "电机", "STM32F405", "DMA", "ADC", "PWM"],
  topics: ["FOC", "MCU 选型"],
  source: "manual"
};

function runCase(item: typeof fixture[number]): UnderstandingEvent[] {
  const machine = new InterviewUnderstandingStateMachine({ activeProject: item.id === "case-2-f405-selection" || item.id === "case-8-dma-multi-slot" ? foc : undefined, now: () => 1_000 });
  return item.segments.map((segment) => machine.process({ id: `${item.id}-${segment.segmentOrder}`, text: segment.rawAsrText, rawText: segment.rawAsrText, final: segment.final, speaker: segment.speaker as "interviewer", timestamp: segment.timestamp }, []));
}

describe("real interview V3 gold regression", () => {
  it("keeps all supplied raw fragments and enforces the no-guessing contract", () => {
    const byId = new Map(fixture.map((item) => [item.id, runCase(item)]));
    expect(byId.get("case-1-incomplete-introduction")?.at(-1)).toMatchObject({ type: "QUESTION_WAITING", frame: { completion: "OPEN", commitStatus: "WAITING" } });
    expect(byId.get("case-3-confirmation-check")?.at(-1)).toMatchObject({ type: "NON_ACTIONABLE", frame: { speechAct: "CONFIRMATION_CHECK", commitStatus: "REJECTED" } });
    expect(byId.get("case-4-asr-unresolved")?.at(-1)).toMatchObject({ type: "QUESTION_WAITING", frame: { completion: "ASR_UNCERTAIN" } });
    expect(byId.get("case-7-advice")?.at(-1)).toMatchObject({ type: "NON_ACTIONABLE", frame: { speechAct: "ADVICE" } });

    const f405 = byId.get("case-2-f405-selection") ?? [];
    const f405Commit = f405.find((event) => event.type === "QUESTION_COMMITTED");
    expect(f405Commit).toMatchObject({ type: "QUESTION_COMMITTED", frame: { canonicalQuestion: "为什么在 FOC / 电机控制项目中选择 STM32F405？选型时主要考虑了哪些因素？", projectId: "foc-motor-control", asrRepair: { canonical: "STM32F405" } } });
    expect(f405.some((event) => event.type === "QUESTION_WAITING")).toBe(true);

    const dma = byId.get("case-8-dma-multi-slot")?.find((event) => event.type === "QUESTION_COMMITTED");
    expect(dma).toMatchObject({ type: "QUESTION_COMMITTED", frame: { questionType: "PROJECT", subQuestions: [{ question: "DMA 在项目哪里使用" }, { question: "数据流是什么" }, { question: "DMA 模式是什么" }] } });

    const stack = byId.get("case-6-stack-asr")?.at(-1);
    expect(stack).toMatchObject({ type: "QUESTION_COMMITTED", frame: { canonicalQuestion: "哪个栈？", asrRepair: { canonical: "哪个栈" } } });
    const retrospective = byId.get("case-9-retrospective-reference")?.at(-1);
    expect(retrospective).toMatchObject({ type: "QUESTION_COMMITTED", frame: { canonicalQuestion: "ADC 采样多久触发一次？" } });
  });
});
