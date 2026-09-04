import type { RuntimeOperationMode } from "../shared/runtime-operation-mode";

interface MainWindowLike {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  setFocusable(focusable: boolean): void;
  hide(): void;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Keeps the main window from activating while the written-test HUD is in use. */
export class WrittenTestFocusGuard {
  private active = false;

  constructor(private readonly getMainWindow: () => MainWindowLike | undefined) {}

  update(mode: RuntimeOperationMode, enabled: boolean): void {
    this.active = mode === "WRITTEN_TEST" && enabled;
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) return;
    // Disable activation before hiding, including when enabled mid-session.
    window.setFocusable(!this.active);
    if (this.active && window.isVisible()) window.hide();
  }

  revealMainWindow(): boolean {
    if (this.active) return false;
    const window = this.getMainWindow();
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }
}
