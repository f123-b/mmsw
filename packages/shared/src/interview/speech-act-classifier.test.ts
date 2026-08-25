import { describe, expect, it } from "vitest";
import { SpeechActClassifier, shouldHardRejectSpeechAct } from "./speech-act-classifier";

describe("interview speech acts", () => {
  const classifier = new SpeechActClassifier();

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
});
