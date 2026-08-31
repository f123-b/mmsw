import { describe, expect, it } from "vitest";
import { AnswerAgent, classifyAnswerQuestion, ContextRouter, ModelRouter, PromptBuilder, StableAnswerStateMachine, type AnswerProvider } from "./answer";
import { createEvidenceSnapshot } from "./answer/evidence-context";
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

  it("gives direct project QA a dedicated rewrite context and removes ordinary retrieval", () => {
    const context = new ContextRouter().route("FOC 项目的 ADC 如何保证实时性？", {
      answerSourcePlan: {
        mode: "project_qa_direct",
        projectAnchorAvailable: true,
        projectQuestionRequested: true,
        projectId: "foc",
        qaMatchLevel: "strong",
        preserveStoredAnswerFacts: true,
        allowProjectKnowledge: false,
        allowGeneralKnowledge: false,
        allowSessionEvidence: true,
        answerRewriteUsed: true
      },
      preparedAnswer: { content: "PWM 中点触发 ADC，并通过 DMA 搬运。", score: 0.92, verified: true, source: "project-question-bank" },
      projectQaEvidence: ["PWM 中点触发 ADC，并通过 DMA 搬运。"],
      projectEvidence: ["不应进入 direct prompt 的项目资料"],
      retrievedKnowledge: ["不应进入 direct prompt 的普通检索"]
    });
    const sections = new PromptBuilder().build({ id: "project-qa", text: "FOC 项目的 ADC 如何保证实时性？" }, "NORMAL", context);
    expect(context.projectEvidence).toEqual([]);
    expect(context.retrievedKnowledge).toEqual([]);
    expect(sections.find((section) => section.name === "project-qa-context")?.content).toContain("保留原答案中的事实");
    expect(sections.find((section) => section.name === "project-qa-context")?.content).toContain("PWM 中点触发 ADC");
  });

  it("allows safe first-person project wording but blocks unsupported ownership wording", () => {
    const context = new ContextRouter().route("这个系统为什么用 MQTT？", { projectEvidence: ["系统使用 MQTT 传输状态"] });
    const prompt = new PromptBuilder().build({ id: "safe-project", text: "这个系统为什么用 MQTT？" }, "NORMAL", context).map((section) => section.content).join("\n");
    expect(prompt).toContain("我这个项目里用的是 X");
    expect(prompt).toContain("不能改写成“我设计了 X”");
  });

  it("runs project QA through the final claim gate and exposes source telemetry", async () => {
    const stored = "项目中使用 PWM 中点触发 ADC，并通过 DMA 搬运采样数据。";
    const provider: AnswerProvider = { stream: async function* () { yield stored; } };
    let ended: unknown;
    for await (const event of new AnswerAgent({ normal: provider }, new ModelRouter({ normal: "test-model" })).stream(
      { id: "project-qa-answer", text: "ADC 怎么保证实时性？" },
      "NORMAL",
      {
        answerSourcePlan: { mode: "project_qa_direct", projectAnchorAvailable: true, projectQuestionRequested: true, projectId: "foc", qaMatchLevel: "exact", preserveStoredAnswerFacts: true, allowProjectKnowledge: false, allowGeneralKnowledge: false, allowSessionEvidence: true, answerRewriteUsed: true },
        preparedAnswer: { content: stored, score: 1, verified: true },
        projectQaEvidence: [stored]
      },
      undefined,
      { directDisplay: true, emitDeltas: false, allowQualityRepair: false, formatAnswer: false }
    )) if (event.type === "answer_end") ended = event;
    expect(ended).toMatchObject({ type: "answer_end", text: stored, quality: { claimGateDecision: "allow", blockedClaimCount: 0, answerSourceMode: "project_qa_direct", qaMatchLevel: "exact" } });
  });

  it("streams project answers through the local sentence ClaimGate without a repair request", async () => {
    let providerCalls = 0;
    const projectProvider: AnswerProvider = {
      stream: async function* () {
        providerCalls += 1;
        yield "系统使用 DMA 搬运采样数据。";
        yield "这样可以减少 CPU 的搬运开销。";
      }
    };
    const events = [] as Array<{ type: string; delta?: string; quality?: { telemetry?: { claimGateMs?: number } } }>;
    for await (const event of new AnswerAgent({ normal: projectProvider }, new ModelRouter({ normal: "test-model" })).stream(
      { id: "project-stream", text: "介绍一下这个项目的实现" },
      "NORMAL",
      { currentProject: "采样控制项目", projectEvidence: ["系统使用 DMA 搬运采样数据"] },
      undefined,
      { directDisplay: false, emitDeltas: true, allowQualityRepair: false, formatAnswer: false }
    )) events.push(event);

    expect(providerCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["answer_start", "claim_gate_pass", "answer_delta", "answer_delta", "answer_end"]);
    expect(events.findIndex((event) => event.type === "answer_delta")).toBeLessThan(events.findIndex((event) => event.type === "answer_end"));
    expect(events.at(-1)?.quality?.telemetry?.claimGateMs).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)?.quality?.telemetry?.claimGateMs).toBeLessThan(50);
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

  it("uses the evidence snapshot as the authoritative planning context", () => {
    const snapshot = createEvidenceSnapshot({
      questionId: "q-locked",
      currentProject: "锁定项目",
      currentModule: "锁定模块",
      currentTopic: "锁定主题",
      projectEvidence: ["锁定证据"]
    });
    const context = new ContextRouter().route("这个项目怎么设计？", {
      currentProject: "后来项目",
      currentModule: "后来模块",
      currentTopic: "后来主题",
      projectEvidence: ["后来证据"],
      evidenceSnapshot: snapshot
    });
    expect(context.currentProject).toBe("锁定项目");
    expect(context.currentModule).toBe("锁定模块");
    expect(context.currentTopic).toBe("锁定主题");
    expect(context.projectEvidence).toEqual(["锁定证据"]);
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

  it("rewrites unsupported project details even when a repair still invents facts", async () => {
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
      text: expect.not.stringContaining("没有足够证据"),
      quality: { needsRepair: false }
    });
    expect((events.at(-1) as { text: string }).text).not.toContain("50%");
    expect((events.at(-1) as { quality: { issues: string[] } }).quality.issues).toContain("claim-gate-rewrite");
  });

  it("answers project implementation questions with generic knowledge when project evidence is empty", async () => {
    const technicalProvider: AnswerProvider = { stream: async function* () { yield "可以让高级定时器在中心对齐 PWM 的中点触发 ADC，再用 DMA 搬运采样数据，减少中断抖动。"; } };
    let final = "";
    for await (const event of new AnswerAgent({ normal: technicalProvider }, new ModelRouter({ normal: "test-model" })).stream(
      { id: "q-generic-project", text: "FOC 项目中的 ADC 如何保证实时性？" },
      "NORMAL",
      {}
    )) if (event.type === "answer_end") final = event.text;
    expect(final).toContain("ADC");
    expect(final).not.toContain("当前资料");
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
