export type OverlayZOrderSurface = "question" | "answer" | "control" | "transient";

export interface OverlayZOrderWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  setAlwaysOnTop(flag: boolean, level?: string): void;
  moveTop(): void;
}

export interface OverlayZOrderDiagnostics {
  assertCount: number;
  repairCount: number;
  controlClickableCount: number;
  endConfirmVisibleCount: number;
  endConfirmNativeClickPassCount: number;
  lastReason?: string;
  lastAssertAt?: number;
  watchdogRunning: boolean;
}

export type OverlayZOrderDiagnosticEvent = "Z_ORDER_ASSERT" | "Z_ORDER_REPAIR" | "FOREIGN_TOPMOST_DETECTED" | "CONTROL_CLICKABLE" | "END_CONFIRM_VISIBLE" | "END_CONFIRM_NATIVE_CLICK_PASS";

export interface OverlayZOrderControllerOptions {
  watchdogIntervalMs?: number;
  onDiagnostic?: (event: OverlayZOrderDiagnosticEvent, fields: Record<string, unknown>) => void;
}

type WindowGroup = Partial<Record<OverlayZOrderSurface, OverlayZOrderWindow | undefined>>;

/**
 * Keeps the bounded overlay BrowserWindows as one native topmost group.
 * `moveTop()` does not activate a window; the controller never calls focus or
 * SetForegroundWindow. The watchdog is intentionally session-scoped and slow
 * enough not to compete with the interview renderer.
 */
export class OverlayZOrderController {
  private readonly intervalMs: number;
  private readonly onDiagnostic?: OverlayZOrderControllerOptions["onDiagnostic"];
  private windows: WindowGroup = {};
  private runtimeActive = false;
  private preferenceEnabled = true;
  private timer?: ReturnType<typeof setInterval>;
  private diagnosticsValue: OverlayZOrderDiagnostics = { assertCount: 0, repairCount: 0, controlClickableCount: 0, endConfirmVisibleCount: 0, endConfirmNativeClickPassCount: 0, watchdogRunning: false };
  private readonly emittedReasons = new Set<string>();
  private lastWatchdogDiagnosticAt = 0;

  constructor(options: OverlayZOrderControllerOptions = {}) {
    this.intervalMs = Math.max(300, Math.min(1_000, options.watchdogIntervalMs ?? 600));
    this.onDiagnostic = options.onDiagnostic;
  }

  get diagnostics(): OverlayZOrderDiagnostics { return { ...this.diagnosticsValue }; }

  setWindows(windows: WindowGroup): void {
    this.windows = { ...windows };
    this.assertOverlayZOrder("window-group-updated");
  }

  setPreferenceEnabled(enabled: boolean): void {
    this.preferenceEnabled = Boolean(enabled);
    this.assertOverlayZOrder("preferences-updated");
  }

  setRuntimeActive(active: boolean): void {
    const next = Boolean(active);
    if (next === this.runtimeActive) {
      if (next) this.assertOverlayZOrder("runtime-active");
      return;
    }
    this.runtimeActive = next;
    if (next) {
      this.startWatchdog();
      this.assertOverlayZOrder("runtime-start");
    } else {
      this.stopWatchdog();
      this.assertOverlayZOrder("runtime-stop");
    }
  }

  assertOverlayZOrder(reason = "explicit"): void {
    const visible = this.orderedWindows().filter((window) => window.isVisible());
    if (!visible.length) return;
    const topmost = this.runtimeActive || this.preferenceEnabled;
    for (const window of visible) {
      window.setAlwaysOnTop(topmost, topmost ? "screen-saver" : undefined);
      if (topmost) window.moveTop();
    }
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      assertCount: this.diagnosticsValue.assertCount + 1,
      lastReason: reason,
      lastAssertAt: Date.now()
    };
    if (reason === "watchdog") {
      this.diagnosticsValue = { ...this.diagnosticsValue, repairCount: this.diagnosticsValue.repairCount + 1 };
      // Keep the counter exact, but rate-limit repeated watchdog diagnostics so
      // a healthy interview does not fill the production log every 600 ms.
      const now = Date.now();
      if (now - this.lastWatchdogDiagnosticAt >= 5_000) {
        this.lastWatchdogDiagnosticAt = now;
        this.onDiagnostic?.("Z_ORDER_REPAIR", { reason, visibleSurfaces: this.visibleSurfaces(), runtimeActive: this.runtimeActive, repairCount: this.diagnosticsValue.repairCount });
      }
      return;
    }
    // Explicit lifecycle events are useful in diagnostics, but deduplicate
    // repeated renderer callbacks so production logs remain quiet.
    if (!this.emittedReasons.has(reason)) {
      this.emittedReasons.add(reason);
      this.onDiagnostic?.("Z_ORDER_ASSERT", { reason, visibleSurfaces: this.visibleSurfaces(), runtimeActive: this.runtimeActive });
    }
  }

  notifyForeignTopmost(reason = "external-window"): void {
    if (!this.runtimeActive) return;
    this.onDiagnostic?.("FOREIGN_TOPMOST_DETECTED", { reason, visibleSurfaces: this.visibleSurfaces() });
    this.assertOverlayZOrder("foreign-topmost");
  }

  recordControlClickable(fields: Record<string, unknown> = {}): void {
    this.diagnosticsValue = { ...this.diagnosticsValue, controlClickableCount: this.diagnosticsValue.controlClickableCount + 1 };
    this.onDiagnostic?.("CONTROL_CLICKABLE", fields);
  }

  recordEndConfirmVisible(fields: Record<string, unknown> = {}): void {
    this.diagnosticsValue = { ...this.diagnosticsValue, endConfirmVisibleCount: this.diagnosticsValue.endConfirmVisibleCount + 1 };
    this.onDiagnostic?.("END_CONFIRM_VISIBLE", fields);
  }

  recordEndConfirmNativeClickPass(fields: Record<string, unknown> = {}): void {
    this.diagnosticsValue = { ...this.diagnosticsValue, endConfirmNativeClickPassCount: this.diagnosticsValue.endConfirmNativeClickPassCount + 1 };
    this.onDiagnostic?.("END_CONFIRM_NATIVE_CLICK_PASS", fields);
  }

  destroy(): void {
    this.stopWatchdog();
    this.windows = {};
    this.runtimeActive = false;
    this.lastWatchdogDiagnosticAt = 0;
  }

  private orderedWindows(): OverlayZOrderWindow[] {
    const ordered = (["question", "answer", "control", "transient"] as const)
      .map((surface) => this.windows[surface])
      .filter((window): window is OverlayZOrderWindow => Boolean(window && !window.isDestroyed()));
    return ordered;
  }

  private visibleSurfaces(): OverlayZOrderSurface[] {
    return (["question", "answer", "control", "transient"] as const).filter((surface) => {
      const window = this.windows[surface];
      return Boolean(window && !window.isDestroyed() && window.isVisible());
    });
  }

  private startWatchdog(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.assertOverlayZOrder("watchdog"), this.intervalMs);
    const maybeUnref = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
    maybeUnref.unref?.();
    this.diagnosticsValue = { ...this.diagnosticsValue, watchdogRunning: true };
  }

  private stopWatchdog(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.diagnosticsValue = { ...this.diagnosticsValue, watchdogRunning: false };
  }
}
