export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
}

export class ShutdownController {
  private completion: Promise<void> | undefined;
  private completed = false;
  readonly errors: Array<{ step: string; error: unknown }> = [];

  constructor(private readonly steps: ShutdownStep[]) {}

  get inProgress(): boolean { return Boolean(this.completion) && !this.completed; }
  get isComplete(): boolean { return this.completed; }

  run(): Promise<void> {
    if (this.completion) return this.completion;
    this.completion = (async () => {
      for (const step of this.steps) {
        try {
          await step.run();
        } catch (error) {
          this.errors.push({ step: step.name, error });
        }
      }
      this.completed = true;
    })();
    return this.completion;
  }
}
