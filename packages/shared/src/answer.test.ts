import { describe, expect, it } from "vitest";
import { AnswerAgent, classifyAnswerQuestion, ContextRouter, ModelRouter, PromptBuilder, StableAnswerStateMachine, type AnswerProvider } from "./answer";
import { InterviewAnswerFormatter } from "./answer/interview-answer-formatter";
import { StreamingAnswerSanitizer } from "./answer/streaming-answer-sanitizer";

async function* chunks(values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

const provider: AnswerProvider = { stream: () => chunks(["核心回答。", "\n关键点：实时性。"]) };

describe("Answer routing and generation", () => {
  it("routes different question types to different answer strategies", () => {
    expect(classifyAnswerQuestion("请写一个二叉树遍历，并说明复杂度")).toBe("code");
    expect(classifyAnswerQuestion("设计一个高并发订单系统")).toBe("system-design");
    expect(classifyAnswerQuestion("IIC 和 SPI 有什么区别？")).toBe("comparison");
    expect(classifyAnswerQuestion("低速抖动怎么排查？")).toBe("embedded-debugging");
    expect(classifyAnswerQuestion("介绍一下你负责的项目")).toBe("project");
    expect(classifyAnswerQuestion("你如何处理团队冲突？")).toBe("behavioral");
  });

  it("does not inject personal profile or project evidence into generic technical prompts", () => {
    const context = new ContextRouter().route("同步机制的作用是什么？", {
      profileSummary: "候选人简历和项目履历",
      experienceContext: ["个人项目证据"],
      personalMemoryEvidence: ["个人记忆证据"]
    });
    const sections = new PromptBuilder().build({ id: "generic", text: "同步机制的作用是什么？" }, "NORMAL", context);
    expect(sections.some((section) => section.name === "profile-context")).toBe(false);
    expect(sections.some((section) => section.name === "experience-context")).toBe(false);
    expect(sections.map((section) => section.content).join("\n")).not.toContain("个人项目证据");
  });

  it("adds the selected plain-language policy to every answer prompt", () => {
    const context = new ContextRouter().route("解释一下DMA", { expressionLevel: "plain", explainAdvancedTerms: true });
    const prompt = new PromptBuilder().build({ id: "plain", text: "解释一下DMA" }, "NORMAL", context).map((section) => section.content).join("\n");
    expect(prompt).toContain("优先使用简单、口语化的中文");
    expect(prompt).toContain("首次出现较难术语");
  });

  it("passes a structured answer plan into the provider prompt", async () => {
    let prompt = "";
    const planningProvider: AnswerProvider = {
      stream: async function* (request) {
        prompt = request.sections.map((section) => section.content).join("\n");
        yield "我负责这个项目的通信模块。";
      }
    };
    for await (const event of new AnswerAgent({ normal: planningProvider }, new ModelRouter({ normal: "test-model" })).stream(
      { id: "planned", text: "介绍一下你负责的项目" },
      "NORMAL",
      { currentProject: "通信项目", projectEvidence: ["我负责通信模块"] },
      undefined,
      { allowQualityRepair: false }
    )) void event;
    expect(prompt).toContain("题型：project");
    expect(prompt).toContain("结构顺序：project_background");
    expect(prompt).toContain("目标口述时长约");
    expect(prompt).toContain("我负责通信模块");
  });

  it("keeps code answers complete instead of slicing the tail", () => {
    const code = "思路：双指针。\n```cpp\nint main() { return 0; }\n```\n复杂度 O(1)。";
    expect(new InterviewAnswerFormatter().format(code, "NORMAL", "code")).toBe(code);
    const output = new PromptBuilder().build({ id: "code", text: "请写代码实现二分查找" }, "NORMAL", new ContextRouter().route("请写代码实现二分查找"));
    expect(output.find((section) => section.name === "output-format")?.content).toContain("完整代码");
    expect(output.find((section) => section.name === "output-format")?.content).toContain("给面试官的思路");
  });

  it("keeps all sub-questions in one ordered answer", () => {
    const output = new PromptBuilder().build({ id: "multi", text: "TCP 和 UDP 有什么区别？分别用在什么场景？" }, "NORMAL", new ContextRouter().route("TCP 和 UDP 有什么区别？分别用在什么场景？"));
    expect(output.find((section) => section.name === "output-format")?.content).toContain("一次回答中按原顺序逐项覆盖");
  });

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
    expect(context.skills).toHaveLength(1);
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

  it("supports a frozen per-session routing snapshot and fallback model", () => {
    const router = new ModelRouter({ fast: "fast-v1", normal: "normal-v1" }, "fallback-v1");
    const snapshot = router.snapshot();
    router.setModels({ fast: "fast-v2", normal: "normal-v2" });
    router.setFallbackModel("fallback-v2");
    expect(router.select("普通问题", "NORMAL", false, snapshot).model).toBe("normal-v1");
    expect(router.select("普通问题", "DEEP", false, snapshot).model).toBe("fallback-v1");
    expect(router.select("普通问题", "DEEP").model).toBe("fallback-v2");
  });

  it("keeps a bounded recent transcript context for follow-up questions", () => {
    const context = new ContextRouter().route("为什么？", { recentTranscript: Array.from({ length: 20 }, (_, index) => `对话 ${index}`) });
    expect(context.recentTranscript.length).toBeLessThanOrEqual(12);
    expect(context.recentTranscript.at(-1)).toBe("对话 19");
  });

  it("repairs a low-quality grounded answer before finalizing", async () => {
    let calls = 0;
    const requests = [] as Array<Parameters<NonNullable<AnswerProvider["stream"]>>[0]>;
    const repairProvider: AnswerProvider = {
      stream: async function* (request) {
        calls += 1;
        requests.push(request);
        yield calls === 1 ? "技术说明。" : "我在项目中使用CAN做实时通信，主要看重它的仲裁和稳定性。";
      }
    };
    let final = "";
    for await (const event of new AnswerAgent({ normal: repairProvider }, new ModelRouter({ normal: "test-model" })).stream({ id: "q-repair", text: "为什么使用CAN" }, "NORMAL", { experienceContext: ["项目证据：使用 CAN 做实时通信"] })) if (event.type === "answer_end") final = event.text;
    expect(calls).toBe(2);
    expect(final).toContain("我在项目中使用CAN");
    const repairPrompt = requests[1]?.sections.map((section) => section.content).join("\n") ?? "";
    expect(repairPrompt).toContain("原始问题：为什么使用CAN");
    expect(repairPrompt).toContain("上一版答案 A：");
    expect(repairPrompt).toContain("技术说明");
    expect(repairPrompt).toContain("answer-too-short");
    expect(repairPrompt).toContain("项目证据：使用 CAN 做实时通信");
  });

  it("can return one stable completed answer without deltas or repair", async () => {
    let calls = 0;
    const directProvider: AnswerProvider = {
      stream: async function* () { calls += 1; yield "不会被直接显示"; },
      complete: async () => { calls += 1; return "首先，直接返回这一版。"; }
    };
    const events = [];
    for await (const event of new AnswerAgent({ normal: directProvider }, new ModelRouter({ normal: "test-model" })).stream(
      { id: "q-direct", text: "为什么使用CAN" },
      "NORMAL",
      { experienceContext: ["项目证据：使用 CAN 做实时通信"] },
      undefined,
      { directDisplay: true, emitDeltas: false, allowQualityRepair: false, formatAnswer: false }
    )) events.push(event);
    expect(calls).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["answer_start", "answer_end"]);
    expect(events.at(-1)).toMatchObject({ type: "answer_end", text: "首先，直接返回这一版。" });
  });

  it("blocks unsupported project details even when a repair still invents facts", async () => {
    let calls = 0;
    const unsafeProvider: AnswerProvider = {
      stream: async function* () { calls += 1; yield "我主导了STM32项目，把延迟降低了50%。"; },
      complete: async () => { calls += 1; return "我主导了STM32项目，把延迟降低了50%。"; }
    };
    const events = [];
    for await (const event of new AnswerAgent({ normal: unsafeProvider }, new ModelRouter({ normal: "test-model" })).stream(
      { id: "q-strict", text: "说说你在这个项目里最棘手的问题" },
      "NORMAL",
      {},
      undefined,
      { directDisplay: true, emitDeltas: false, allowQualityRepair: true, strictPersonalGrounding: true }
    )) events.push(event);
    expect(calls).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["answer_start", "answer_end"]);
    expect(events.at(-1)).toMatchObject({
      type: "answer_end",
      text: expect.stringContaining("没有足够证据"),
      quality: { issues: ["strict-grounding-fallback"], needsRepair: false }
    });
    expect((events.at(-1) as { text: string }).text).not.toContain("STM32");
  });

  it("sanitizes safe presentation noise without rewriting technical content", () => {
    const sanitizer = new StreamingAnswerSanitizer();
    expect(sanitizer.push("这个问题可以从以下几个方面回答")).toBe("");
    expect(sanitizer.push("：\n###\n- DMA 让 CPU 不再搬运数据。\n\n\n" )).toBe("DMA 让 CPU 不再搬运数据。\n\n");
    expect(sanitizer.finalize()).toBe("DMA 让 CPU 不再搬运数据。\n\n");
  });
});

describe("StableAnswerStateMachine", () => {
  it("keeps answer A until the first valid delta of replacement answer B", () => {
    const state = new StableAnswerStateMachine();
    state.start("a1");
    state.delta("a1", "旧答案");
    state.end("a1", "旧答案");
    state.start("a2");
    expect(state.snapshot.displayedText).toBe("旧答案");
    state.delta("a2", "");
    expect(state.snapshot.displayedText).toBe("旧答案");
    state.delta("a2", "新");
    expect(state.snapshot.displayedText).toBe("新");
    state.cancel("a2");
    expect(state.snapshot.displayedText).toBe("新");
  });

  it("keeps answer A when replacement B is cancelled before any delta", () => {
    const state = new StableAnswerStateMachine();
    state.start("a1");
    state.end("a1", "旧答案");
    state.start("a2");
    state.cancel("a2");
    expect(state.snapshot.displayedText).toBe("旧答案");
    expect(state.snapshot.displayedAnswerId).toBe("a1");
  });
});
