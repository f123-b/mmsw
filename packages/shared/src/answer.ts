export type AnswerMode = "FAST" | "NORMAL" | "DEEP";

export interface AnswerQuestion {
  id: string;
  text: string;
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
  skills?: AnswerSkillContext[];
  retrievedKnowledge?: string[];
  recentTranscript?: string[];
}

export interface ContextPack {
  profileSummary?: string;
  jobDescriptionSummary?: string;
  skills: AnswerSkillContext[];
  retrievedKnowledge: string[];
  recentTranscript: string[];
}

function relevance(question: string, skill: AnswerSkillContext): number {
  const tokens = question.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i).filter(Boolean);
  const content = `${skill.name} ${skill.content}`.toLowerCase();
  return tokens.filter((token) => content.includes(token)).length / Math.max(1, tokens.length);
}

export class ContextRouter {
  route(question: string, input: AnswerContextInput = {}): ContextPack {
    const skills = (input.skills ?? [])
      .map((skill) => ({ ...skill, relevance: skill.relevance ?? relevance(question, skill) }))
      .sort((left, right) => (right.relevance ?? 0) - (left.relevance ?? 0))
      .slice(0, 3);
    return {
      profileSummary: input.profileSummary,
      jobDescriptionSummary: input.jobDescriptionSummary,
      skills,
      retrievedKnowledge: (input.retrievedKnowledge ?? []).slice(0, 6),
      recentTranscript: (input.recentTranscript ?? []).slice(-12)
    };
  }
}

export interface PromptSection {
  name: "system/base" | "interview-style" | "profile-context" | "skill-context" | "retrieval-context" | "question" | "output-format";
  content: string;
}

export class PromptBuilder {
  build(question: AnswerQuestion, mode: AnswerMode, context: ContextPack): PromptSection[] {
    const sections: PromptSection[] = [
      { name: "system/base", content: "你是实时面试辅助。回答必须真实、直接、便于快速阅读，不得虚构用户经历。" },
      { name: "interview-style", content: `回答模式：${mode}。先给核心回答，再给 2~4 个关键点；仅在资料真实匹配时结合项目。` }
    ];
    if (context.profileSummary || context.jobDescriptionSummary) sections.push({ name: "profile-context", content: [context.profileSummary, context.jobDescriptionSummary].filter(Boolean).join("\n") });
    if (context.skills.length > 0) sections.push({ name: "skill-context", content: context.skills.map((skill) => `${skill.name}: ${skill.content}`).join("\n") });
    if (context.retrievedKnowledge.length > 0) sections.push({ name: "retrieval-context", content: context.retrievedKnowledge.join("\n---\n") });
    if (context.recentTranscript.length > 0) sections.push({ name: "interview-style", content: `最近对话：\n${context.recentTranscript.join("\n")}` });
    sections.push({ name: "question", content: question.text });
    sections.push({ name: "output-format", content: "输出简洁的核心回答、关键点和适用时的项目结合，不要写成长篇论文。" });
    return sections;
  }
}

export type ModelRoute = "fast" | "reasoning" | "vision" | "low-latency";

export interface ModelSelection {
  route: ModelRoute;
  model: string;
}

export class ModelRouter {
  constructor(private readonly models: Partial<Record<ModelRoute, string>> = {}, private readonly fallbackModel = "") {}

  select(question: string, mode: AnswerMode = "NORMAL", hasScreenshot = false): ModelSelection {
    const route: ModelRoute = hasScreenshot ? "vision" : mode === "FAST" ? "fast" : mode === "DEEP" || question.length > 80 ? "reasoning" : "low-latency";
    return { route, model: this.models[route] ?? this.fallbackModel };
  }
}

export interface AnswerProviderRequest {
  model: string;
  sections: PromptSection[];
}

export interface AnswerProvider {
  stream(request: AnswerProviderRequest, signal?: AbortSignal): AsyncIterable<string>;
}

export type AnswerGenerationEvent =
  | { type: "answer_start"; answerId: string; questionId: string; mode: AnswerMode; model: string }
  | { type: "answer_delta"; answerId: string; delta: string }
  | { type: "answer_end"; answerId: string; text: string };

export class AnswerAgent {
  constructor(
    private readonly providers: Partial<Record<ModelRoute, AnswerProvider>>,
    private readonly modelRouter = new ModelRouter({}, "configured-default"),
    private readonly contextRouter = new ContextRouter(),
    private readonly promptBuilder = new PromptBuilder()
  ) {}

  async *stream(question: AnswerQuestion, mode: AnswerMode, contextInput: AnswerContextInput = {}, signal?: AbortSignal): AsyncGenerator<AnswerGenerationEvent> {
    const context = this.contextRouter.route(question.text, contextInput);
    const selection = this.modelRouter.select(question.text, mode);
    if (!selection.model) throw new Error(`No model configured for ${selection.route}`);
    const provider = this.providers[selection.route];
    if (!provider) throw new Error(`No AnswerProvider configured for ${selection.route}`);
    const answerId = `answer-${Date.now()}-${question.id}`;
    const sections = this.promptBuilder.build(question, mode, context);
    yield { type: "answer_start", answerId, questionId: question.id, mode, model: selection.model };
    let text = "";
    for await (const delta of provider.stream({ model: selection.model, sections }, signal)) {
      if (!delta) continue;
      text += delta;
      yield { type: "answer_delta", answerId, delta };
    }
    yield { type: "answer_end", answerId, text };
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

  start(answerId: string): StableAnswerSnapshot {
    this.value = { ...this.value, pendingAnswerId: answerId, pendingText: "", streaming: true };
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
