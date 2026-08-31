import { describe, expect, it } from "vitest";
import { SpeechActClassifier, shouldHardRejectSpeechAct } from "./speech-act-classifier";

describe("interview speech acts", () => {
  const classifier = new SpeechActClassifier();

  it("recognizes short follow-up requests without a repeated technical noun", () => {
    const context = { currentTopic: "DMA", latestAnchor: { text: "DMA 和中断怎么配合？", speechAct: "QUESTION" as const } };
    expect(classifier.classify("你会关注哪些点？", context).speechAct).toBe("FOLLOW_UP");
    expect(classifier.classify("考虑哪些可能性？", context).speechAct).toBe("FOLLOW_UP");
    expect(classifier.classify("给个快速排查清单", context).shouldAnswer).toBe(true);
  });

  it("rescues quantity, command-style and code requests", () => {
    expect(classifier.classify("CAN 总线上最多能挂多少个节点？").speechAct).toBe("QUESTION");
    expect(classifier.classify("列举一下进程间通信的方式").speechAct).toBe("ANSWER_REQUEST");
    expect(classifier.classify("请写一个链表反转的 C++ 代码").speechAct).toBe("CODE_REQUEST");
  });

  it("keeps non-answer speech out of the answer route", () => {
    expect(classifier.classify("现在考你一个代码题").shouldAnswer).toBe(false);
    expect(classifier.classify("你在动我鼠标吗？").speechAct).toBe("META_CONVERSATION");
    expect(classifier.classify("嗯").speechAct).toBe("ACKNOWLEDGEMENT");
  });

  it("promotes an algorithm statement after a code-question anchor", () => {
    expect(classifier.classify("反转一个单链表", { pendingCodeContext: true })).toMatchObject({
      speechAct: "CODE_REQUEST",
      shouldAnswer: true,
      reason: "code-context-algorithm-request"
    });
  });

  it("uses an anchor for elliptical requests while preserving a complete standalone question", () => {
    const context = { currentTopic: "TCP", latestAnchor: { text: "TCP 三次握手", topic: "TCP", speechAct: "QUESTION" as const } };
    expect(classifier.classify("讲一下", context).speechAct).toBe("FOLLOW_UP");
    expect(classifier.classify("那核心竞争力在哪？", context).speechAct).toBe("QUESTION");
  });

  it.each([
    "那你这个项目低速的时候……",
    "你在这个地方主要负责……",
    "如果速度再低一点……",
    "CAN 这里你具体讲……",
    "那 FreeRTOS 这个……"
  ])("does not treat ASR-fragment candidate prompts as hard rejects: %s", (text) => {
    const result = classifier.classify(text, { currentTopic: "FOC" });
    expect(shouldHardRejectSpeechAct(result)).toBe(false);
  });

  it("separates topic announcements, instruction modifiers and self-introduction", () => {
    expect(classifier.classify("下面聊一下 RTOS").speechAct).toBe("TOPIC_ANNOUNCEMENT");
    expect(classifier.classify("请重点讲一下异常恢复").speechAct).toBe("INSTRUCTION_MODIFIER");
    expect(classifier.classify("请你先做一分钟自我介绍")).toMatchObject({ speechAct: "ANSWER_REQUEST", shouldAnswer: true });
    expect(classifier.classify("好的开始面试").topic).toBeUndefined();
  });

  it("treats a bare next-question marker as a boundary, not as a question", () => {
    expect(classifier.classify("下一个问题")).toMatchObject({ speechAct: "TOPIC_TRANSITION", shouldAnswer: false });
    expect(shouldHardRejectSpeechAct(classifier.classify("下一个问题"))).toBe(true);
  });

  it("keeps a transition-prefixed complete question answerable", () => {
    expect(classifier.classify("下个问题，如果现在电机在低速时出现抖动，你会怎样一步步定位和解决？")).toMatchObject({ speechAct: "QUESTION", shouldAnswer: true });
    expect(classifier.classify("比如低速抖动你会怎么定位？")).toMatchObject({ speechAct: "QUESTION", shouldAnswer: true });
    expect(classifier.classify("比如低速抖动、电流波形和编码器反馈").shouldAnswer).toBe(false);
  });

  it("recognizes angle-based answer constraints without turning them into questions", () => {
    const result = classifier.classify("空间大小和常见风险这几个角度也说一下。");
    expect(result.speechAct).toBe("INSTRUCTION_MODIFIER");
    expect(result.shouldAnswer).toBe(false);
  });
});
