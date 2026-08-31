export interface ShutdownStep {
  name: string;
  timeoutMs?: number;
  run: () => void | Promise<void>;
}

export interface ShutdownEvent {
  event: "SHUTDOWN_STARTED" | "SHUTDOWN_STEP_STARTED" | "SHUTDOWN_STEP_COMPLETED" | "SHUTDOWN_STEP_FAILED" | "SHUTDOWN_STEP_TIMEOUT" | "SHUTDOWN_HARD_TIMEOUT" | "SHUTDOWN_COMPLETED";
  fields: Record<string, unknown>;
}

export interface ShutdownControllerOptions {
  defaultStepTimeoutMs?: number;
  globalTimeoutMs?: number;
  onEvent?: (event: ShutdownEvent) => void;
  now?: () => number;
}

const DEFAULT_STEP_TIMEOUT_MS = 3_000;
const DEFAULT_GLOBAL_TIMEOUT_MS = 9_000;

export class ShutdownController {
  private completion: Promise<void> | undefined;
  private completed = false;
  private currentStep: string | undefined;
  readonly errors: Array<{ step: string; error: unknown }> = [];

  constructor(private readonly steps: ShutdownStep[], private readonly options: ShutdownControllerOptions = {}) {}

  get inProgress(): boolean { return Boolean(this.completion) && !this.completed; }
  get isComplete(): boolean { return this.completed; }
  get activeStep(): string | undefined { return this.currentStep; }

  run(): Promise<void> {
    if (this.completion) return this.completion;
    this.completion = this.runBounded();
    return this.completion;
  }

  private async runBounded(): Promise<void> {
    const startedAt = this.now();
    this.emit("SHUTDOWN_STARTED", {});
    const work = this.runSteps();
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const hardDeadline = new Promise<false>((resolve) => {
      hardTimer = setTimeout(() => {
        this.emit("SHUTDOWN_HARD_TIMEOUT", { currentStep: this.currentStep, elapsedMs: this.now() - startedAt });
        resolve(false);
      }, Math.max(1, this.options.globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS));
      hardTimer.unref?.();
    });
    const finished = await Promise.race([work.then(() => true), hardDeadline]);
    if (hardTimer) clearTimeout(hardTimer);
    if (!finished) {
      this.completed = true;
      return;
    }
    this.completed = true;
    this.emit("SHUTDOWN_COMPLETED", { totalDurationMs: this.now() - startedAt });
  }

  private async runSteps(): Promise<void> {
    for (const step of this.steps) {
      this.currentStep = step.name;
      const stepStartedAt = this.now();
      this.emit("SHUTDOWN_STEP_STARTED", { step: step.name });
      const timeoutMs = Math.max(1, step.timeoutMs ?? this.options.defaultStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const task = Promise.resolve().then(() => step.run());
        const timeout = new Promise<false>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            this.errors.push({ step: step.name, error: new Error(`SHUTDOWN_STEP_TIMEOUT: ${step.name}`) });
            this.emit("SHUTDOWN_STEP_TIMEOUT", { step: step.name, timeoutMs, elapsedMs: this.now() - stepStartedAt });
            resolve(false);
          }, timeoutMs);
          timer.unref?.();
        });
        const finished = await Promise.race([task.then(() => true), timeout]);
        if (timer) clearTimeout(timer);
        if (finished && !timedOut) this.emit("SHUTDOWN_STEP_COMPLETED", { step: step.name, durationMs: this.now() - stepStartedAt });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.errors.push({ step: step.name, error });
        this.emit("SHUTDOWN_STEP_FAILED", { step: step.name, error: String(error), durationMs: this.now() - stepStartedAt });
      }
    }
    this.currentStep = undefined;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private emit(event: ShutdownEvent["event"], fields: Record<string, unknown>): void { this.options.onEvent?.({ event, fields }); }
}
