export const WRITTEN_SCREENSHOT_HOVER_DELAY_MS = 800;
export const WRITTEN_EXIT_HOVER_DELAY_MS = 1_500;
export type WrittenScreenshotHoverPhase = "idle" | "arming" | "triggered";

/** One action per pointer visit, even when busy/ready state changes. */
export class WrittenScreenshotHoverTrigger {
  private timer?: ReturnType<typeof setTimeout>;
  private inside = false;
  private enabled = false;
  private disposed = false;
  private phase: WrittenScreenshotHoverPhase = "idle";

  constructor(private readonly trigger: () => void, private readonly onPhase: (phase: WrittenScreenshotHoverPhase) => void, private readonly delayMs = WRITTEN_SCREENSHOT_HOVER_DELAY_MS) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled && !this.disposed;
    if (!this.enabled) this.cancel();
  }

  enter(): void {
    if (this.disposed || this.inside) return;
    this.inside = true;
    if (!this.enabled) return;
    this.setPhase("arming");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.enabled || !this.inside || this.disposed) return;
      this.setPhase("triggered");
      this.trigger();
    }, this.delayMs);
  }

  leave(): void {
    this.inside = false;
    this.cancel();
    this.setPhase("idle");
  }

  private cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.phase === "arming") this.setPhase("idle");
  }

  private setPhase(phase: WrittenScreenshotHoverPhase): void {
    if (this.phase === phase || this.disposed) return;
    this.phase = phase;
    this.onPhase(phase);
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.cancel();
  }
}
