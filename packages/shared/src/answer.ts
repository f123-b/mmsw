import type { InterviewMemorySnapshot } from "./interview-memory";
import { AnswerQualityChecker, type AnswerQualityResult } from "./answer/answer-quality-checker";
import { InterviewAnswerFormatter } from "./answer/interview-answer-formatter";
import { sanitizeStreamingAnswer, StreamingAnswerSanitizer } from "./answer/streaming-answer-sanitizer";
import { normalizeTechnicalTerms } from "./terminology";
import { PersonalAnswerValidator, QuestionAnalyzer } from "./knowledge/index";
import type { FollowUpContext } from "./follow-up-context";

export type AnswerMode = "FAST" | "NORMAL" | "DEEP";

export type AnswerQuestionKind =
  | "technical"
  | "concept"
  | "comparison"
  | "system-design"
  | "embedded-debugging"
  | "troubleshooting"
  | "code"
  | "project"
  | "behavioral"
  | "follow-up"
  | "clarification";

export interface AnswerQuestion {
  id: string;
  text: string;
  /** Optional detector hint. The answer router still validates it from text. */
  kind?: AnswerQuestionKind;
}

export interface AnswerSkillContext {
  id: string;
  name: string;
  content: string;
  relevance?: number;
}

export interface AnswerContextInput {
  profileSummary?: string;
  jobDescriptionSummary?: string;
  profileInstructions?: string;
  skills?: AnswerSkillContext[];
  experienceContext?: string[];
  personalMemoryEvidence?: string[];
  retrievedKnowledge?: string[];
  preparedAnswer?: { content: string; score: number; verified: boolean; source?: string };
  recentTranscript?: string[];
  interviewMemory?: InterviewMemorySnapshot;
  followUpContext?: FollowUpContext;
}

export interface ContextPack {
  profileSummary?: string;
  jobDescriptionSummary?: string;
  profileInstructions?: string;
  skills: AnswerSkillContext[];
  experienceContext: string[];
  personalMemoryEvidence: string[];
  retrievedKnowledge: string[];
  preparedAnswer?: { content: string; score: number; verified: boolean; source?: string };
  recentTranscript: string[];
  interviewMemory?: InterviewMemorySnapshot;
  followUpContext?: FollowUpContext;
}

const ANSWER_KIND_HINTS: Record<string, AnswerQuestionKind> = {
  technical: "technical",
  project: "project",
  behavior: "behavioral",
  behavioral: "behavioral",
  follow_up: "follow-up",
  "follow-up": "follow-up",
  clarification: "clarification"
};

/** Routes a question to a response strategy instead of using one universal template. */
export function classifyAnswerQuestion(text: string, hint?: string): AnswerQuestionKind {
  const normalized = normalizeTechnicalTerms(text);
  if (hint && ANSWER_KIND_HINTS[hint]) return ANSWER_KIND_HINTS[hint];
  if (/代码|编程|手写|实现一个|写一个|补全|伪代码|算法题|时间复杂度|空间复杂度|输出结果|leetcode|debug|修复这段|code\b/i.test(normalized)) return "code";
  if (/系统设计|架构设计|设计一个系统|高并发|可扩展|容灾|降级|限流|服务拆分|数据库设计|缓存设计|消息队列/.test(normalized)) return "system-design";
  if (/区别|对比|比较|优缺点|取舍|权衡|为什么不用|选型|差异/.test(normalized)) return "comparison";
  if (/低速抖动|IIC.*卡死|HardFault|DMA.*异常|CAN.*丢帧|丢帧|数据异常/.test(normalized)) return "embedded-debugging";
  if (/排查|定位|故障|报错|异常|线上问题|怎么解决|如何解决|怎么验证|监控|告警/.test(normalized)) return "troubleshooting";
  if (/团队|冲突|压力|困难|失败|沟通|协作|领导|决策|优势|缺点|成长/.test(normalized) && /你|我|经历|遇到|如何/.test(normalized)) return "behavioral";
  if (/项目|负责|主导|经历|做过|落地|交付|简历|成果|业绩|为什么.*设计|怎么.*实现|遇到什么问题|怎么解决|具体实现/.test(normalized)) return "project";
  if (/上一题|刚才|继续|具体一点|展开|那如果|然后|还有/.test(normalized) && normalized.length < 34) return "follow-up";
  if (/具体一点|什么意思|没听清|再说一遍|能展开|详细一点|指的是|怎么理解/.test(normalized)) return "clarification";
  if (/什么是|原理|定义|作用|为什么|如何|怎么|怎样|是什么/.test(normalized)) return "concept";
  return "technical";
}

function answerTokenBudget(mode: AnswerMode, kind: AnswerQuestionKind): number {
  if (kind === "code") return mode === "FAST" ? 1_024 : mode === "DEEP" ? 2_400 : 1_600;
  return mode === "FAST" ? 512 : mode === "DEEP" ? 1_600 : 1_024;
}

function relevance(question: string, skill: AnswerSkillContext): number {
  const tokens = normalizeTechnicalTerms(question).toLowerCase().match(/[a-z0-9+#]+|[\u4e00-\u9fff]{2,}/gi) ?? [];
  const content = normalizeTechnicalTerms(`${skill.name} ${skill.content}`).toLowerCase();
  return tokens.filter((token) => content.includes(token)).length / Math.max(1, tokens.length);
}

export class ContextRouter {
  route(question: string, input: AnswerContextInput = {}): ContextPack {
    const skills = (input.skills ?? [])
      .map((skill) => ({ ...skill, relevance: skill.relevance ?? relevance(question, skill) }))
      .filter((skill) => (skill.relevance ?? 0) > 0)
      .sort((left, right) => (right.relevance ?? 0) - (left.relevance ?? 0))
      .slice(0, 3);
    let transcriptBudget = 2_400;
    const recentTranscript = (input.recentTranscript ?? []).slice(-12).reverse().map((line) => line.slice(0, 500)).filter((line) => {
      if (transcriptBudget <= 0) return false;
      transcriptBudget -= line.length;
      return true;
    }).reverse();
    return {
      profileSummary: input.profileSummary,
      jobDescriptionSummary: input.jobDescriptionSummary,
      profileInstructions: input.profileInstructions,
      skills,
      experienceContext: (input.experienceContext ?? []).slice(0, 5),
      personalMemoryEvidence: (input.personalMemoryEvidence ?? []).slice(0, 5),
      retrievedKnowledge: (input.retrievedKnowledge ?? []).slice(0, 6),
      preparedAnswer: input.preparedAnswer,
      recentTranscript,
      interviewMemory: input.interviewMemory,
      followUpContext: input.followUpContext
    };
  }
}

export interface PromptSection {
  name: "system/base" | "interview-style" | "profile-context" | "skill-context" | "experience-context" | "retrieval-context" | "recent-transcript" | "interview-memory" | "follow-up-context" | "conversation-history" | "question" | "output-format";
  content: string;
}

export class PromptBuilder {
  build(question: AnswerQuestion, mode: AnswerMode, context: ContextPack): PromptSection[] {
    const kind = classifyAnswerQuestion(question.text, question.kind);
    const sections: PromptSection[] = [
      { name: "system/base", content: `你是实时面试辅助。先判断题型，再按题型回答。回答必须真实、直接、便于候选人马上口述；第一句必须回应面试官当前问题，不能输出“面试策略”或“面试官一般喜欢”。不要输出“题库参考答案”“Resume”“岗位要求”“结构化项目事实”等资料标签，也不要评价面试官。嵌入式问题要使用标准专业术语，并根据上下文区分 Cortex-M、ARM32、ARM64、RTOS、Embedded Linux 等语境，不能把不同平台的概念混为一谈。只有问题明确要求个人经历时才使用项目经历，严禁虚构用户经历。${["project", "behavioral", "follow-up"].includes(kind) ? "当前是个人经历问题：你现在要以候选人本人第一人称回答，优先使用个人工程经验；资料中没有的内容必须明确说没有证据。" : "当前不是个人经历问题：不要为了个性化而虚构候选人经历。"}` },
      { name: "interview-style", content: `题型：${kind}。回答模式：${mode}。${new InterviewAnswerFormatter().instructions(mode, kind)}` }
    ];
    const experienceRequested = ["project", "behavioral", "follow-up", "clarification"].includes(kind)
      || /项目|经历|做过|负责|简历|实际|结合.*经验/.test(question.text);
    if (context.profileSummary || context.jobDescriptionSummary || context.profileInstructions) sections.push({ name: "profile-context", content: [context.profileSummary, context.jobDescriptionSummary, context.profileInstructions ? `候选人回答偏好：${context.profileInstructions}` : ""].filter(Boolean).join("\n") });
    if (context.skills.length > 0) sections.push({ name: "skill-context", content: context.skills.map((skill) => `${skill.name}: ${skill.content}`).join("\n") });
    if (context.personalMemoryEvidence.length > 0) sections.push({ name: "experience-context", content: `以下是优先级最高的个人工程经验。必须用第一人称，只使用其中有证据的内容；没有记录的内容明确说资料不足：\n${context.personalMemoryEvidence.join("\n---\n")}` });
    if (experienceRequested && context.experienceContext.length > 0) sections.push({ name: "experience-context", content: `以下是真实经历素材。只使用与问题直接相关的内容，不能补写未出现的事实：\n${context.experienceContext.join("\n---\n")}` });
    if (context.retrievedKnowledge.length > 0) sections.push({ name: "retrieval-context", content: context.retrievedKnowledge.join("\n---\n") });
    if (context.followUpContext) {
      const followUp = context.followUpContext;
      sections.push({ name: "follow-up-context", content: [
        `Root Question：${followUp.rootQuestion}`,
        `Parent Question：${followUp.parentQuestion}`,
        followUp.parentAnswer ? `Parent Answer：${followUp.parentAnswer}` : "",
        `Current Follow-up：${followUp.currentQuestion}`,
        followUp.currentTopic ? `Current Topic：${followUp.currentTopic}` : "",
        followUp.relatedProject ? `Related Project：${followUp.relatedProject}` : "",
        followUp.relatedTechnicalTopic ? `Related Technical Topic：${followUp.relatedTechnicalTopic}` : ""
      ].filter(Boolean).join("\n") });
    } else if (context.recentTranscript.length > 0) {
      sections.push({ name: "recent-transcript", content: `最近必要对话：\n${context.recentTranscript.join("\n")}` });
    }
    if (context.interviewMemory) {
      const memory = context.interviewMemory;
      const turns = context.followUpContext ? "" : memory.turns.slice(-10).map((turn) => `问题：${turn.question}${turn.answer ? `\n回答：${turn.answer}` : ""}`).join("\n");
      if (!context.followUpContext || memory.currentTopic) sections.push({ name: "interview-memory", content: [`当前主题：${memory.currentTopic || "未确定"}`, turns].filter(Boolean).join("\n") });
    }
    sections.push({ name: "question", content: question.text });
    const length = kind === "code"
      ? mode === "FAST" ? "先给最小可运行代码和一句解释" : "完整代码、关键解释、复杂度和边界情况"
      : mode === "FAST" ? "20-60" : mode === "DEEP" ? "120-250" : "60-130";
    const strategy = {
      code: "先说明思路，再给完整代码块（题目未指定语言时默认 C++17），然后解释关键行、时间/空间复杂度和边界情况；代码不要只写片段，也不要声称来自候选人的项目。",
      "system-design": "按需求和约束、整体架构、核心链路、数据一致性/稳定性、扩展性和权衡回答；只有明确问到项目时才引用项目。",
      comparison: "先给结论，再按核心差异、适用场景、优缺点和选型依据对比，不要强行加入项目经历。",
      troubleshooting: "按现象、可能原因、定位步骤、修复方案和验证方式回答；不要把排查方案包装成候选人已经做过的经历。",
      "embedded-debugging": "先说现象，再给最可能原因和排查顺序，最后说明如何验证；优先覆盖信号/时序、硬件连接、驱动状态和边界条件，不要虚构候选人的实际经历。",
      project: "只使用提供的简历、项目和面试素材，按‘核心回答、项目经历、具体实现、问题解决’组织，但要像面试口述一样自然，不要机械套模板；资料没有的内容明确说没有证据。",
      behavioral: "使用真实经历回答，按情境、任务、行动、结果和反思组织；没有对应经历就说明资料不足，不要编造。",
      "follow-up": "承接上一轮上下文，只补充面试官追问的新增信息，不重复整段答案。",
      clarification: "先直接解释被追问的概念，再用一个简短例子说明。",
      concept: "先给定义或结论，再解释原理、关键点和常见误区；不要为了显得个性化而硬塞项目经历。",
      technical: "直接回答技术问题，再补充关键依据、风险或验证方式；只有问题明确要求时才引用项目。"
    }[kind];
    sections.push({ name: "output-format", content: kind === "code" ? `${strategy} 保证答案完整，不要在代码或解释中途截断。` : `回答长度或结构：${length}。${strategy} 不要写“首先/其次/最后”的模板化标题，不要百科式展开。` });
    return sections;
  }
}

export type ModelRoute = "fast" | "normal" | "reasoning" | "vision" | "low-latency";
export type ModelSnapshot = Partial<Record<ModelRoute, string>> & { fallback?: string };

export interface ModelSelection {
  route: ModelRoute;
  model: string;
}

export class ModelRouter {
  constructor(private readonly models: Partial<Record<ModelRoute, string>> = {}, private fallbackModel = "") {}

  setModels(models: Partial<Record<ModelRoute, string>>): void {
    Object.assign(this.models, models);
  }

  setFallbackModel(model: string): void { this.fallbackModel = model; }

  snapshot(): ModelSnapshot { return { ...this.models, fallback: this.fallbackModel }; }

  select(question: string, mode: AnswerMode = "NORMAL", hasScreenshot = false, override?: ModelSnapshot): ModelSelection {
    const route: ModelRoute = hasScreenshot ? "vision" : mode === "FAST" ? "fast" : mode === "DEEP" ? "reasoning" : "normal";
    const models = override ?? this.models;
    const fallback = override?.fallback ?? this.fallbackModel;
    return { route, model: models[route] ?? (route === "normal" ? models["low-latency"] : undefined) ?? fallback };
  }
}

export interface AnswerProviderRequest {
  model: string;
  sections: PromptSection[];
  attachments?: Array<{ mimeType: string; dataUrl: string }>;
  thinking?: boolean;
  /** Provider-side output budget. Prevents default server limits cutting an answer off. */
  maxOutputTokens?: number;
  /** Optional per-request retry override. */
  maxRetries?: number;
}

export interface AnswerProvider {
  stream(request: AnswerProviderRequest, signal?: AbortSignal): AsyncIterable<string>;
  /** Optional non-streaming completion path used by the interview UI. */
  complete?(request: AnswerProviderRequest, signal?: AbortSignal): Promise<string>;
}

export type AnswerGenerationEvent =
  | { type: "answer_start"; answerId: string; questionId: string; mode: AnswerMode; model: string }
  | { type: "answer_delta"; answerId: string; delta: string }
  | { type: "answer_end"; answerId: string; text: string; quality?: AnswerQualityResult };

export interface AnswerGenerationOptions {
  hasScreenshot?: boolean;
  attachments?: Array<{ mimeType: string; dataUrl: string }>;
  maxOutputTokens?: number;
  instruction?: string;
  /** Keep the provider stream internal and emit only the final answer. */
  directDisplay?: boolean;
  /** Whether answer_delta events should be exposed to the UI. */
  emitDeltas?: boolean;
  /** Repair is intentionally disabled for low-latency live interview answers. */
  allowQualityRepair?: boolean;
  /** Preserve the model's completed text instead of rewriting it after generation. */
  formatAnswer?: boolean;
  /** Per-request retry override for latency-sensitive calls. */
  maxRetries?: number;
  /** Use the configured fast route for ordinary automatic interview questions. */
  preferFastRoute?: boolean;
  /** Freeze a model routing snapshot for a running interview session. */
  modelOverride?: ModelSnapshot;
}

export class AnswerAgent {
  constructor(
    private readonly providers: Partial<Record<ModelRoute, AnswerProvider>>,
    private readonly modelRouter = new ModelRouter({}, "configured-default"),
    private readonly contextRouter = new ContextRouter(),
    private readonly promptBuilder = new PromptBuilder(),
    private readonly formatter = new InterviewAnswerFormatter(),
    private readonly qualityChecker = new AnswerQualityChecker()
  ) {}

  getModelSnapshot(): ModelSnapshot { return this.modelRouter.snapshot(); }

  async *stream(question: AnswerQuestion, mode: AnswerMode, contextInput: AnswerContextInput = {}, signal?: AbortSignal, options: AnswerGenerationOptions = {}): AsyncGenerator<AnswerGenerationEvent> {
    const routedQuestion = { ...question, text: normalizeTechnicalTerms(question.text) };
    const context = this.contextRouter.route(routedQuestion.text, contextInput);
    const kind = classifyAnswerQuestion(routedQuestion.text, routedQuestion.kind);
    let selection = this.modelRouter.select(routedQuestion.text, mode, options.hasScreenshot ?? false, options.modelOverride);
    if (options.preferFastRoute && kind !== "code" && !(options.hasScreenshot ?? false)) {
      const fastSelection = this.modelRouter.select(routedQuestion.text, "FAST", false, options.modelOverride);
      if (fastSelection.model) selection = fastSelection;
    }
    if (!selection.model) throw new Error(`No model configured for ${selection.route}`);
    const provider = this.providers[selection.route] ?? (selection.route === "normal" ? this.providers["low-latency"] : undefined);
    if (!provider) throw new Error(`No AnswerProvider configured for ${selection.route}`);
    const answerId = `answer-${Date.now()}-${question.id}`;
    const sections = this.promptBuilder.build(routedQuestion, mode, context);
    if (options.instruction?.trim()) sections.push({ name: "output-format", content: options.instruction.trim() });
    yield { type: "answer_start", answerId, questionId: routedQuestion.id, mode, model: selection.model };
    const providerRequest: AnswerProviderRequest = {
      model: selection.model,
      sections,
      attachments: options.attachments,
      thinking: mode === "DEEP",
      maxOutputTokens: options.maxOutputTokens ?? answerTokenBudget(mode, kind),
      maxRetries: options.maxRetries
    };
    let text = "";
    const sanitizer = new StreamingAnswerSanitizer();
    if (options.directDisplay && provider.complete) {
      text = await provider.complete(providerRequest, signal);
    } else {
      for await (const delta of provider.stream(providerRequest, signal)) {
        if (!delta) continue;
        text += delta;
        const safeDelta = sanitizer.push(delta);
        if (options.emitDeltas !== false && !options.directDisplay && safeDelta) yield { type: "answer_delta", answerId, delta: safeDelta };
      }
    }
    const completedText = options.directDisplay && provider.complete ? sanitizeStreamingAnswer(text) : sanitizer.finalize();
    let formattedText = options.formatAnswer === false ? completedText.trim() : this.formatter.format(completedText, mode, kind);
    const groundingText = [context.profileSummary, context.jobDescriptionSummary, ...context.skills.map((skill) => skill.content), ...context.personalMemoryEvidence, ...context.experienceContext, ...context.retrievedKnowledge].filter(Boolean).join("\n");
    let quality = this.qualityChecker.check({ question: routedQuestion.text, answer: formattedText, mode, kind, groundingText });
    if (context.personalMemoryEvidence.length > 0 || kind === "project" || kind === "behavioral") {
      const validation = new PersonalAnswerValidator().validate({ question: routedQuestion.text, answer: formattedText, analysis: new QuestionAnalyzer().analyze(routedQuestion.text), evidence: context.personalMemoryEvidence.length > 0 ? context.personalMemoryEvidence : context.experienceContext });
      quality = { ...quality, score: Math.min(quality.score, validation.score), issues: [...quality.issues, ...validation.issues], suggestions: [...quality.suggestions, ...validation.suggestions], needsRepair: quality.needsRepair || !validation.valid };
    }
    // Repair only when grounded profile material exists. This keeps the
    // realtime path low-latency for generic answers while preventing a
    // clearly poor or ungrounded answer from being shown as final.
    if (options.allowQualityRepair !== false && quality.needsRepair && groundingText.trim()) {
      let repaired = "";
      for await (const delta of provider.stream({
        model: selection.model,
        sections: [...sections, { name: "output-format", content: `请修正上一版答案：${kind === "project" || kind === "behavioral" ? "只保留有证据的个人经历" : "不要强行添加项目经历"}，直接回答问题，保留代码题的完整代码和解释，不要在中途截断。只输出修正后的答案。` }],
        attachments: options.attachments,
        thinking: mode === "DEEP",
        maxOutputTokens: options.maxOutputTokens ?? answerTokenBudget(mode, kind),
        maxRetries: options.maxRetries
      }, signal)) repaired += delta;
      const repairedText = this.formatter.format(repaired, mode, kind);
      const repairedQuality = this.qualityChecker.check({ question: routedQuestion.text, answer: repairedText, mode, kind, groundingText });
      if (repairedText && repairedQuality.score >= quality.score) {
        formattedText = repairedText;
        quality = repairedQuality;
      }
    }
    yield { type: "answer_end", answerId, text: formattedText, quality };
  }
}

export interface StableAnswerSnapshot {
  displayedText: string;
  displayedAnswerId?: string;
  pendingAnswerId?: string;
  pendingText: string;
  streaming: boolean;
}

export class StableAnswerStateMachine {
  private value: StableAnswerSnapshot = { displayedText: "", pendingText: "", streaming: false };

  get snapshot(): StableAnswerSnapshot { return { ...this.value }; }

  reset(): StableAnswerSnapshot {
    this.value = { displayedText: "", pendingText: "", streaming: false };
    return this.snapshot;
  }

  start(answerId: string): StableAnswerSnapshot {
    this.value = { displayedText: "", displayedAnswerId: undefined, pendingAnswerId: answerId, pendingText: "", streaming: true };
    return this.snapshot;
  }

  delta(answerId: string, delta: string): StableAnswerSnapshot {
    if (this.value.pendingAnswerId !== answerId) return this.snapshot;
    const pendingText = this.value.pendingText + delta;
    this.value = {
      ...this.value,
      pendingText,
      displayedText: pendingText,
      displayedAnswerId: answerId
    };
    return this.snapshot;
  }

  end(answerId: string, text: string): StableAnswerSnapshot {
    if (this.value.pendingAnswerId !== answerId) return this.snapshot;
    this.value = { displayedText: text || this.value.pendingText, displayedAnswerId: answerId, pendingText: "", streaming: false };
    return this.snapshot;
  }

  cancel(answerId: string): StableAnswerSnapshot {
    if (this.value.pendingAnswerId !== answerId) return this.snapshot;
    this.value = { ...this.value, pendingAnswerId: undefined, pendingText: "", streaming: false };
    return this.snapshot;
  }
}
