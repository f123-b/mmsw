import { describe, expect, it } from "vitest";
import { InterviewUnderstandingStateMachine, type ActiveProjectContext } from "./interview-understanding-state-machine";

const foc: ActiveProjectContext = { id: "foc", name: "FOC 电机控制", lockState: "LOCKED", confidence: 0.99, entities: ["FOC", "STM32F405", "ADC", "PWM", "DMA"], topics: ["电机"], source: "manual" };

function session(project = true) {
  const machine = new InterviewUnderstandingStateMachine({ activeProject: project ? foc : undefined });
  let clock = 1_000;
  let sequence = 0;
  const push = (text: string, gap = 1_000, speaker: "interviewer" | "candidate" = "interviewer") => {
    clock += gap;
    return machine.process({ id: `segment-${++sequence}`, text, rawText: text, final: true, speaker, timestamp: clock });
  };
  return { machine, push };
}

describe("September 1–3 live interview failures", () => {
  it("keeps the DMA subject across ASR finals and a filler", () => {
    const { push } = session();
    push("线程和进程有什么区别？");
    expect(push("那DMA。").type).not.toBe("QUESTION_COMMITTED");
    expect(push("嗯。").type).not.toBe("QUESTION_COMMITTED");
    const answer = push("的原理是什么？");
    expect(answer.type).toBe("QUESTION_COMMITTED");
    expect(answer.frame.canonicalQuestion).toContain("DMA");
    expect(answer.frame.canonicalQuestion).not.toMatch(/线程|进程|vector/iu);
  });

  it("does not attach independent technical questions to the previous project", () => {
    const { push } = session();
    push("你这个FOC项目，你主要负责了什么？");
    const spi = push("什么是SPI？", 15_000);
    expect(spi.type).toBe("QUESTION_COMMITTED");
    expect(spi.frame.relation).toBe("NEW_TOPIC");
    expect(spi.frame.entities.technologies).toEqual(["SPI"]);
    const i2c = push("什么 IIC。");
    expect(i2c.frame.entities.technologies).toEqual(["I2C"]);
  });

  it("deduplicates repeated self introduction with acknowledgement", () => {
    const { push } = session(false);
    expect(push("嗯，先做一下自我介绍吧。").type).toBe("QUESTION_COMMITTED");
    expect(push("做一下自我介绍吧。", 8_000).type).not.toBe("QUESTION_COMMITTED");
    expect(push("好。").type).not.toBe("QUESTION_COMMITTED");
  });

  it.each(["那么，你想现场和现场有什么区别？", "正常和近场有区别。"]) ("holds ambiguous ASR without guessing a different question: %s", (text) => {
    const { push, machine } = session();
    push("Linux里面线程和进程有什么区别？");
    expect(push(text).type).not.toBe("QUESTION_COMMITTED");
    expect(machine.commitPending()?.type).not.toBe("QUESTION_COMMITTED");
    const corrected = push("线程和进程有什么区别？", 5_000);
    expect(corrected.type).toBe("QUESTION_COMMITTED");
    expect(corrected.frame.canonicalQuestion).not.toMatch(/现场|近场/);
  });

  it("waits for the actual predicate in an unfinished Linux question", () => {
    const { push, machine } = session();
    push("什么是SPI？");
    expect(push("来讲一讲这个什么Linux系统里边。").type).not.toBe("QUESTION_COMMITTED");
    expect(machine.commitPending()?.type).not.toBe("QUESTION_COMMITTED");
    const complete = push("线程和进程有什么区别？", 18_000);
    expect(complete.type).toBe("QUESTION_COMMITTED");
    expect(complete.frame.canonicalQuestion).not.toContain("来讲一讲");
  });

  it.each([
    "这个是比较基础的东西。",
    "当然，这些肯定是会也会有参考的，如果你的专业够扎实。你有比较。丰富的项目。实习经历那肯定是。",
    "呃，因为我们是半导体的行业嘛，其实我们主要是做芯片设计，我们都有自己的芯片，所以我们。",
    "对，那就反正就是一样的方式。他怎么通知你初试的，就会怎么通知你复试。",
    "呃，这个没什么建议。"
  ])("does not answer interviewer explanations: %s", (text) => {
    const { push } = session();
    push("DMA的原理是什么？");
    expect(push(text).type).toBe("NON_ACTIONABLE");
  });

  it("does not turn candidate speech into an interviewer question", () => {
    const { push, machine } = session();
    push("那DMA。");
    expect(push("请问结果什么时候出来？", 1_000, "candidate").type).not.toBe("QUESTION_COMMITTED");
    expect(machine.state.recentQuestions).toHaveLength(0);
  });

  it("records a completed answer against its own committed question", () => {
    const { push, machine } = session();
    const spi = push("什么是SPI？");
    push("什么是DMA？");
    machine.recordAnswer({ id: "answer-spi", questionId: `v3-question-${spi.frame.id}`, text: "SPI 是同步串行接口。", createdAt: 6_000 });
    expect(machine.state.lastAnsweredQuestion?.id).toBe(spi.frame.id);
  });
});
