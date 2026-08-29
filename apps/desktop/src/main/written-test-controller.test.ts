import { describe, expect, it } from "vitest";
import { AnswerAgent, ModelRouter, type AnswerProvider } from "@interview-copilot/shared";
import { WrittenTestController } from "./written-test-controller";

describe("WrittenTestController", () => {
  it("answers a screenshot without starting audio/ASR and keeps the answer stream complete", async () => {
    const requests: Array<{ maxOutputTokens?: number; attachments?: Array<{ dataUrl: string }>; sections: Array<{ content: string }> }> = [];
    const provider: AnswerProvider = {
      stream: async function* (next) {
        requests.push(next);
        yield "完整代码：\n```cpp\nint main() {}\n```";
        yield "\n复杂度 O(1)。";
      }
    };
    const controller = new WrittenTestController({
      answerAgent: new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "vision-test" })),
      contextProvider: async () => ({ profileSummary: "真实候选人资料" })
    });
    const messages: Array<{ type: string; text?: string }> = [];
    const states: boolean[] = [];
    controller.on("event", (event: { type: string; state?: { running: boolean }; message?: { type: string; text?: string } }) => {
      if (event.type === "state") states.push(Boolean(event.state?.running));
      if (event.type === "realtime_message" && event.message) messages.push(event.message);
    });

    controller.start({ profileId: "profile-1", answerMode: "NORMAL" });
    await controller.answerScreenshot("data:image/png;base64,abc");

    expect(controller.running).toBe(true);
    expect(states).toEqual([true]);
    expect(messages.map((message) => message.type)).toEqual(["question_group_updated", "answer_start", "answer_delta", "answer_delta", "answer_end"]);
    expect(messages.at(-1)?.text).toContain("复杂度");
    expect(requests[0]?.attachments?.[0]?.dataUrl).toBe("data:image/png;base64,abc");
    expect(requests[0]?.maxOutputTokens).toBe(2_400);
    expect(requests[0]?.sections.some((section) => section.content.includes("题型：technical"))).toBe(true);
    expect(requests[0]?.sections.some((section) => section.content.includes("笔试模式的截图题"))).toBe(true);

    controller.stop();
    expect(controller.running).toBe(false);
    expect(states).toEqual([true, false]);
  });
});
