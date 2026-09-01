export interface DebouncedQuestion<T> {
  value: T;
  receivedAt: number;
  dueAt: number;
}

export interface QuestionDebounceOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** Small, cancellable debounce primitive for already assembled interviewer turns. */
export class QuestionDebounceController<T> {
  private pendingValue: DebouncedQuestion<T> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: QuestionDebounceOptions = {}) {
    this.minDelayMs = Math.max(0, options.minDelayMs ?? 800);
    this.maxDelayMs = Math.max(this.minDelayMs, options.maxDelayMs ?? 1_200);
  }

  get pending(): DebouncedQuestion<T> | undefined { return this.pendingValue ? { ...this.pendingValue } : undefined; }

  offer(value: T, receivedAt = Date.now(), delayMs = this.minDelayMs): DebouncedQuestion<T> {
    this.cancelTimer();
    const delay = Math.max(this.minDelayMs, Math.min(this.maxDelayMs, delayMs));
    this.pendingValue = { value, receivedAt, dueAt: receivedAt + delay };
    return { ...this.pendingValue };
  }

  schedule(value: T, callback: (value: T) => void, receivedAt = Date.now(), delayMs = this.minDelayMs): DebouncedQuestion<T> {
    const pending = this.offer(value, receivedAt, delayMs);
    this.timer = setTimeout(() => {
      const next = this.pendingValue;
      this.pendingValue = undefined;
      this.timer = undefined;
      if (next) callback(next.value);
    }, Math.max(0, pending.dueAt - receivedAt));
    return pending;
  }

  flush(): T | undefined {
    this.cancelTimer();
    const value = this.pendingValue?.value;
    this.pendingValue = undefined;
    return value;
  }

  cancel(): void {
    this.cancelTimer();
    this.pendingValue = undefined;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
