import { describe, expect, it } from "vitest";
import { AnswerAgent, ContextRouter, ModelRouter, PromptBuilder, StableAnswerStateMachine, type AnswerProvider } from "./answer";

async function* chunks(values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

const provider: AnswerProvider = { stream: () => chunks(["核心回答。", "\n关键点：实时性。"]) };

describe("Answer routing and generation", () => {
  it("selects only the top three skills and separates prompt sections", async () => {
    const context = new ContextRouter().route("FOC 电流采样", {
      skills: [
        { id: "1", name: "FOC", content: "电流采样和 Clarke" },
        { id: "2", name: "Linux", content: "进程" },
        { id: "3", name: "RTOS", content: "任务" },
        { id: "4", name: "TCP", content: "网络" }
      ],
      retrievedKnowledge: ["a", "b", "c", "d", "e", "f", "g"]
    });
    expect(context.skills[0]?.name).toBe("FOC");
    expect(context.skills).toHaveLength(3);
    expect(new PromptBuilder().build({ id: "q1", text: "为什么要同步采样？" }, "FAST", context).map((section) => section.name)).toContain("question");
    const events = [];
    for await (const event of new AnswerAgent({ "fast": provider }).stream({ id: "q1", text: "为什么要同步采样？" }, "FAST", {})) events.push(event.type);
    expect(events).toEqual(["answer_start", "answer_delta", "answer_delta", "answer_end"]);
  });

  it("routes deep and screenshot requests to different models", () => {
    const router = new ModelRouter({ fast: "fast-v1", normal: "normal-v1", reasoning: "reasoning-v1", vision: "vision-v1" });
    expect(router.select("一个很长的问题".repeat(100), "FAST")).toEqual({ route: "fast", model: "fast-v1" });
    expect(router.select("一个很长的问题".repeat(100), "NORMAL")).toEqual({ route: "normal", model: "normal-v1" });
    expect(router.select("解释系统设计", "DEEP").model).toBe("reasoning-v1");
    expect(router.select("识别截图中的代码", "FAST", true).route).toBe("vision");
  });

  it("keeps a bounded recent transcript context for follow-up questions", () => {
    const context = new ContextRouter().route("为什么？", { recentTranscript: Array.from({ length: 20 }, (_, index) => `对话 ${index}`) });
    expect(context.recentTranscript.length).toBeLessThanOrEqual(12);
    expect(context.recentTranscript.at(-1)).toBe("对话 19");
  });
});

describe("StableAnswerStateMachine", () => {
  it("keeps the previous answer until the first delta of the replacement arrives", () => {
    const state = new StableAnswerStateMachine();
    state.start("a1");
    state.delta("a1", "旧答案");
    state.end("a1", "旧答案");
    state.start("a2");
    expect(state.snapshot.displayedText).toBe("旧答案");
    state.delta("a2", "新");
    expect(state.snapshot.displayedText).toBe("新");
    state.cancel("a2");
    expect(state.snapshot.displayedText).toBe("新");
  });
});
