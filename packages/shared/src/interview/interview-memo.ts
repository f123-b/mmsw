export interface InterviewMemoSnapshot {
  currentProject?: string;
  askedQuestions: string[];
  claimedFacts: string[];
  interviewerFocus: string[];
  currentTopic?: string;
  unconfirmedFacts: string[];
  contradictions: string[];
  updatedAt: number;
}

export interface InterviewMemoOptions {
  maxChars?: number;
  now?: () => number;
}

function clean(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function unique(values: readonly string[], limit = 24): string[] { return [...new Set(values.map(clean).filter(Boolean))].slice(-limit); }

/** Bounded rolling interview state; updates are local and non-blocking. */
export class InterviewMemo {
  private currentProjectValue: string | undefined;
  private currentTopicValue: string | undefined;
  private asked: string[] = [];
  private facts: string[] = [];
  private focus: string[] = [];
  private unconfirmed: string[] = [];
  private contradictions: string[] = [];
  private readonly maxChars: number;
  private readonly now: () => number;
  private updatedAtValue = 0;

  constructor(options: InterviewMemoOptions = {}) {
    this.maxChars = Math.max(800, Math.min(1_500, options.maxChars ?? 1_200));
    this.now = options.now ?? (() => Date.now());
  }

  reset(): void { this.currentProjectValue = undefined; this.currentTopicValue = undefined; this.asked = []; this.facts = []; this.focus = []; this.unconfirmed = []; this.contradictions = []; this.updatedAtValue = 0; }
  setProject(project?: string): void { this.currentProjectValue = clean(project ?? "") || undefined; this.touch(); }
  setTopic(topic?: string): void { this.currentTopicValue = clean(topic ?? "") || undefined; this.touch(); }
  recordQuestion(question: string): void { this.asked = unique([...this.asked, question], 12); this.touch(); }
  recordFact(fact: string): void { this.facts = unique([...this.facts, fact], 16); this.touch(); }
  recordFocus(focus: string): void { this.focus = unique([...this.focus, focus], 12); this.touch(); }
  recordUnconfirmed(fact: string): void { this.unconfirmed = unique([...this.unconfirmed, fact], 12); this.touch(); }
  recordContradiction(value: string): void { this.contradictions = unique([...this.contradictions, value], 8); this.touch(); }

  snapshot(): InterviewMemoSnapshot {
    return { ...(this.currentProjectValue ? { currentProject: this.currentProjectValue } : {}), askedQuestions: [...this.asked], claimedFacts: [...this.facts], interviewerFocus: [...this.focus], ...(this.currentTopicValue ? { currentTopic: this.currentTopicValue } : {}), unconfirmedFacts: [...this.unconfirmed], contradictions: [...this.contradictions], updatedAt: this.updatedAtValue };
  }

  toText(): string {
    const value = this.snapshot();
    const lines = [
      `【当前项目】${value.currentProject ?? "未确认"}`,
      `【已问问题】${value.askedQuestions.join("；") || "暂无"}`,
      `【我已经声称的事实】${value.claimedFacts.join("；") || "暂无"}`,
      `【面试官关注点】${value.interviewerFocus.join("；") || "暂无"}`,
      `【当前技术主题】${value.currentTopic ?? "未确认"}`,
      `【未确认事实】${value.unconfirmedFacts.join("；") || "暂无"}`,
      `【需要避免的矛盾】${value.contradictions.join("；") || "暂无"}`
    ];
    return lines.join("\n").slice(0, this.maxChars);
  }

  private touch(): void { this.updatedAtValue = this.now(); }
}
