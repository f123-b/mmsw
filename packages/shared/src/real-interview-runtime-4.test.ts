import { describe, expect, it, vi } from "vitest";
import fixture from "../../../tests/fixtures/real-interview-20260901.json";
import { TranscriptAssembler } from "./transcript/transcript-assembler";
import { SpeechActDetector } from "./interview/speech-act-detector";
import { QuestionDebounceController } from "./interview/question-debounce-controller";
import { ActiveProjectResolver } from "./interview/active-project-resolver";
import { AntecedentResolver } from "./interview/antecedent-resolver";
import { InterviewMemo } from "./interview/interview-memo";
import { ProjectConsistencyGuard } from "./interview/project-consistency-guard";
import { buildStableInterviewPrefix } from "./interview/stable-interview-prefix";
import { WrittenProblemStateStore } from "./vision/written-problem-state";
import { ContextRouter, PromptBuilder } from "./answer";
import { ProjectTruthGuard } from "./answer/project-truth-guard";
import { extractProjectClaims } from "./answer/claim-extractor";
import { analyzeAnswerIntent } from "./answer/answer-intent";
import { analyzeProjectQuestionIntent } from "./answer/project-question-intent";
import { planAnswerSource } from "./answer/project-answer-source-planner";

const projects = [
  { id: "foc-motor-control", name: "STM32F405 FOC 电机控制项目", aliases: ["FOC 项目"], entities: ["FOC", "机器人", "电机", "ADC", "PWM"] },
  { id: "linux-gateway", name: "Linux 多协议设备管理系统", aliases: ["Linux 网关"], entities: ["Linux", "Modbus", "设备管理"] }
];

describe("Runtime 4.0 real-interview regression", () => {
  it("keeps speakers separate and assembles interviewer fragments before detection", () => {
    const assembler = new TranscriptAssembler({ maxGapMs: 2_000 });
    assembler.push({ id: "r1", source: "remote", text: "如果让你实现一个内存", startMs: 0, endMs: 400, final: true });
    const merged = assembler.push({ id: "r2", source: "remote", text: "泄漏检测工具", startMs: 500, endMs: 900, final: true });
    assembler.push({ id: "m1", source: "mic", text: "我会先看分配路径", startMs: 950, endMs: 1_200, final: true });
    expect(merged.current?.text).toContain("内存");
    expect(merged.current?.text).toContain("泄漏检测工具");
    expect(assembler.pending.map((item) => item.speaker)).toEqual(["interviewer", "candidate"]);
    expect(assembler.flush("interviewer")[0]?.fragments).toHaveLength(2);
  });

  it("blocks backchannels, noise, statements and incomplete fragments", () => {
    const detector = new SpeechActDetector();
    expect(detector.detect("还有。").speechAct).toBe("BACKCHANNEL");
    expect(detector.detect("我们公司主要是做芯片设计。").shouldTriggerAnswer).toBe(false);
    expect(detector.detect("如果让你实现一个内存").speechAct).toBe("INCOMPLETE");
    expect(detector.detect("日制日制色一块").speechAct).toBe("ASR_NOISE");
    expect(detector.detect("函数指针一般用在什么地方？").speechAct).toBe("QUESTION");
  });

  it("debounces a candidate question and cancels the old callback", () => {
    vi.useFakeTimers();
    const controller = new QuestionDebounceController<string>({ minDelayMs: 800, maxDelayMs: 1_200 });
    const received: string[] = [];
    controller.schedule("低速", received.push.bind(received), 0);
    controller.schedule("低速用了什么办法？", received.push.bind(received), 100);
    vi.advanceTimersByTime(799);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(received).toEqual(["低速用了什么办法？"]);
    vi.useRealTimers();
  });

  it("keeps the active project sticky and switches only on a strong explicit match", () => {
    const resolver = new ActiveProjectResolver();
    const foc = resolver.observe({ text: "我介绍一下基于 STM32F405 的 FOC 电机控制项目", speaker: "candidate", projects, now: 1 });
    expect(foc.activeProject?.projectId).toBe("foc-motor-control");
    const asrNoise = resolver.observe({ text: "达到电梯平稳运行", speaker: "interviewer", projects, now: 2 });
    expect(asrNoise.activeProject?.projectId).toBe("foc-motor-control");
    const linux = resolver.observe({ text: "下面看 Linux 多协议设备管理系统", speaker: "interviewer", projects, now: 3 });
    expect(linux.activeProject?.projectId).toBe("linux-gateway");
  });

  it("resolves project and module antecedents as follow-ups", () => {
    const resolver = new AntecedentResolver();
    expect(resolver.resolve({ text: "应用层具体包括哪些？", activeProject: { projectId: "linux-gateway", projectName: "Linux 网关", confidence: 1, source: "explicit_interviewer", activatedAt: 1, entities: ["Linux"], topics: ["设备管理"] }, currentModule: "应用层" })).toMatchObject({ type: "MODULE", relation: "FOLLOW_UP" });
    expect(resolver.resolve({ text: "这个项目主要做什么？", activeProject: { projectId: "linux-gateway", projectName: "Linux 网关", confidence: 1, source: "explicit_interviewer", activatedAt: 1, entities: [], topics: [] } })).toMatchObject({ type: "PROJECT", relation: "FOLLOW_UP" });
  });

  it("separates project intent from project resolution", () => {
    const intent = analyzeAnswerIntent("你在这个项目里面是什么角色？");
    expect(analyzeProjectQuestionIntent({ question: "你在这个项目里面是什么角色？", answerIntent: intent, questionAnalysisType: "project" })).toMatchObject({ projectQuestionRequested: true, projectAnchorAvailable: false });
    expect(planAnswerSource({ projectQuestion: true, personalQuestion: true }).mode).toBe("project_context_unresolved");
    expect(planAnswerSource({ projectQuestion: false, personalQuestion: false }).mode).toBe("general_technical");
  });

  it("blocks unsupported or contradicted personal project claims", () => {
    expect(extractProjectClaims("我们项目有 5 人")).toMatchObject([{ type: "team_size", value: "5 人", personal: true, highRisk: true }]);
    const contradicted = new ProjectTruthGuard().check({ answer: "我们项目有 5 人。", evidence: ["团队一共 4 人。"] });
    expect(contradicted).toMatchObject({ decision: "BLOCK", blockedClaimCount: 1 });
    const unsupported = new ProjectTruthGuard().check({ answer: "我负责 SPI 驱动。" });
    expect(unsupported.decision).toBe("BLOCK");
    expect(unsupported.answer).not.toContain("我负责 SPI 驱动");
    const uncertain = new ProjectTruthGuard().check({ answer: "项目实际使用 STM32F405。", evidence: ["项目使用 STM32F103。"] });
    expect(uncertain.decision).toBe("REWRITE");
    expect(uncertain.answer).not.toContain("STM32F405");
  });

  it("keeps the stable prefix and rolling memo bounded and visible to prompts", () => {
    const memo = new InterviewMemo({ maxChars: 1_200 });
    memo.setProject("STM32F405 FOC 电机控制");
    memo.setTopic("低速性能");
    memo.recordQuestion("低速用了什么手段？");
    memo.recordFact("团队人数：4");
    expect(memo.toText().length).toBeLessThanOrEqual(1_200);
    const prefix = buildStableInterviewPrefix({ resume: "R".repeat(10_000), jobDescription: "J", projectIndex: "项目 1：FOC" });
    expect(prefix.length).toBeLessThan(7_000);
    const context = new ContextRouter().route("volatile 是什么？", { stableInterviewPrefix: prefix, interviewMemo: memo.toText() });
    const sections = new PromptBuilder().build({ id: "q", text: "volatile 是什么？" }, "FAST", context).map((item) => item.name);
    expect(sections.slice(0, 2)).toEqual(["stable-prefix", "system/base"]);
    expect(sections).toContain("rolling-memo");
  });

  it("fuses spoken problem state into a vision prompt context", () => {
    const state = new WrittenProblemStateStore();
    state.addSpokenProblem("三字符串交错问题");
    state.addConstraint("时间复杂度 O(n)");
    state.setCurrentQuestion("请给出动态规划思路");
    expect(state.promptContext()).toContain("三字符串交错问题");
    expect(state.promptContext()).toContain("O(n)");
    expect(state.promptContext()).toContain("动态规划");
  });

  it("keeps the corpus schema complete", () => {
    expect(fixture.length).toBeGreaterThanOrEqual(10);
    for (const item of fixture) expect(item).toEqual(expect.objectContaining({ utterance: expect.any(String), speaker: expect.any(String), speechAct: expect.any(String), shouldTriggerAnswer: expect.any(Boolean), canonicalQuestion: expect.any(String), relation: expect.any(String), forbiddenClaims: expect.any(Array) }));
  });

  it("detects the FOC/elevator entity conflict without changing the anchor", () => {
    const result = new ProjectConsistencyGuard().evaluate("达到电梯平稳运行", { projectId: "foc-motor-control", projectName: "FOC", confidence: 1, source: "manual", activatedAt: 1, entities: ["FOC", "机器人", "电机"], topics: ["低速"] });
    expect(result).toMatchObject({ decision: "PROJECT_ENTITY_CONFLICT" });
  });
});
