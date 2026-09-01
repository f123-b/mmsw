export interface WrittenProblemState {
  spokenProblem: string[];
  screenshotContext?: string;
  codeContext?: string;
  constraints: string[];
  currentQuestion?: string;
}

function clean(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function unique(values: readonly string[], limit = 12): string[] { return [...new Set(values.map(clean).filter(Boolean))].slice(-limit); }

/** Keeps written and spoken problem context in one small, replaceable value. */
export class WrittenProblemStateStore {
  private value: WrittenProblemState = { spokenProblem: [], constraints: [] };
  get snapshot(): WrittenProblemState { return { ...this.value, spokenProblem: [...this.value.spokenProblem], constraints: [...this.value.constraints] }; }
  reset(): void { this.value = { spokenProblem: [], constraints: [] }; }
  addSpokenProblem(text: string): WrittenProblemState { this.value.spokenProblem = unique([...this.value.spokenProblem, text]); return this.snapshot; }
  setScreenshotContext(text?: string): WrittenProblemState { this.value.screenshotContext = text ? clean(text) : undefined; return this.snapshot; }
  setCodeContext(text?: string): WrittenProblemState { this.value.codeContext = text ? clean(text) : undefined; return this.snapshot; }
  addConstraint(text: string): WrittenProblemState { this.value.constraints = unique([...this.value.constraints, text]); return this.snapshot; }
  setCurrentQuestion(text?: string): WrittenProblemState { this.value.currentQuestion = text ? clean(text) : undefined; return this.snapshot; }
  promptContext(): string { const value = this.value; return [`最近语音题目：${value.spokenProblem.join("；")}`, value.screenshotContext ? `截图上下文：${value.screenshotContext}` : "", value.codeContext ? `代码上下文：${value.codeContext}` : "", value.constraints.length ? `已有约束：${value.constraints.join("；")}` : "", value.currentQuestion ? `当前问题：${value.currentQuestion}` : ""].filter(Boolean).join("\n"); }
}
