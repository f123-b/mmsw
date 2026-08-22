import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { applyOverlayMode, nextOverlayMode, type OverlayMode } from "./overlay-mode";
import { applyCaptureProtection, getCaptureProtectionCapabilities, type CaptureProtectionCapabilities, type CaptureProtectionState } from "./overlay-capture-protection";
import { initialHUDState, reduceHUDState, type HUDAction, type HUDState } from "./hud-state";
import { calculateHUDLayout, type HUDLayout, type HUDWorkArea } from "./hud-layout";

export { applyOverlayMode, nextOverlayMode } from "./overlay-mode";
export type { OverlayMode, OverlayWindowLike } from "./overlay-mode";
export { getCaptureProtectionCapabilities } from "./overlay-capture-protection";
export type { CaptureProtectionCapabilities, CaptureProtectionState } from "./overlay-capture-protection";
export { initialHUDState, reduceHUDState } from "./hud-state";
export type { HUDAction, HUDMode, HUDMouseMode, HUDState } from "./hud-state";
export { calculateHUDLayout } from "./hud-layout";
export type { HUDLayout, HUDPanelLayout, HUDWorkArea } from "./hud-layout";

export interface OverlayManagerOptions {
  preloadPath?: string;
  loadRenderer: (window: BrowserWindow) => Promise<void>;
  getMainWindow?: () => BrowserWindow | undefined;
  captureProtectionEnabled?: boolean;
  onCaptureProtectionDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
  onHUDStateChange?: (state: HUDState) => void;
}

export type OverlayPanelCommand = "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end";

export class OverlayManager {
  private window: BrowserWindow | undefined;
  private mode: OverlayMode = "passive";
  private interactiveRegion = false;
  private hudStateValue: HUDState = { ...initialHUDState };
  private hudLayoutValue: HUDLayout = calculateHUDLayout({ x: 0, y: 0, width: 1440, height: 900 });
  private captureProtectionEnabled: boolean;
  private captureProtectionState: CaptureProtectionState;
  private readonly capabilities: CaptureProtectionCapabilities;

  constructor(private readonly options: OverlayManagerOptions) {
    this.captureProtectionEnabled = options.captureProtectionEnabled ?? true;
    this.capabilities = getCaptureProtectionCapabilities();
    this.captureProtectionState = {
      platform: this.capabilities.platform,
      supported: this.capabilities.captureProtectionSupported,
      requested: this.captureProtectionEnabled,
      osFlagApplied: false,
      enabled: this.captureProtectionEnabled,
      applied: false,
      externalCaptureVerified: null,
      displayCaptureVerified: null,
      windowCaptureVerified: null
    };
  }

  get currentMode(): OverlayMode {
    return this.mode;
  }

  get hudState(): HUDState {
    return this.hudStateValue;
  }

  get hudLayout(): HUDLayout {
    return this.hudLayoutValue;
  }

  get currentWindow(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined;
  }

  get captureProtection(): boolean {
    return this.captureProtectionEnabled;
  }

  get captureProtectionSupported(): boolean {
    return this.capabilities.captureProtectionSupported;
  }

  get captureProtectionStatus(): CaptureProtectionState {
    return this.captureProtectionState;
  }

  get captureProtectionCapabilities(): CaptureProtectionCapabilities {
    return this.capabilities;
  }

  /** Enter the desktop HUD mode and cover the active display work area. */
  enterInterviewMode(): BrowserWindow {
    return this.enterHUDMode();
  }

  /** Enter the same HUD window for screenshot-only written-test mode. */
  enterWrittenTestMode(): BrowserWindow {
    return this.enterHUDMode();
  }

  private enterHUDMode(): BrowserWindow {
    // Every new interview starts click-through. Users can still reach the
    // toolbar because the renderer reports when the pointer enters a control
    // region, at which point only the native hit-test state is relaxed.
    this.transition({ type: "start" });
    this.mode = "passive";
    this.interactiveRegion = false;
    const window = this.show();
    this.coverCurrentMonitor();
    window.showInactive();
    return window;
  }

  /** Leave the desktop HUD mode and restore an interactive native window. */
  exitInterviewMode(): void {
    this.exitHUDMode();
  }

  /** Leave the HUD window without coupling to the interview audio session. */
  exitWrittenTestMode(): void {
    this.exitHUDMode();
  }

  private exitHUDMode(): void {
    this.transition({ type: "stop" });
    this.mode = "interactive";
    this.interactiveRegion = false;
    this.applyMode();
    this.hide();
  }

  showAll(): void { this.transition({ type: "show-all" }); }
  hideAll(): void { this.transition({ type: "hide-all" }); }
  toggleAll(): void { this.transition({ type: "toggle-panels" }); }
  toggleTranscript(): void { this.transition({ type: "toggle-transcript" }); }
  toggleAnswer(): void { this.transition({ type: "toggle-answer" }); }
  resetLayout(): void {
    this.refreshLayout(this.currentWindow?.getBounds() ?? this.targetMonitorBounds());
  }
  toggleShortcuts(): void { this.transition({ type: "toggle-shortcuts" }); }
  requestEndInterviewConfirmation(): void { this.sendPanelCommand("confirm-end"); }
  setShareMode(enabled: boolean): void {
    this.transition({ type: "set-share-mode", enabled });
    if (this.hudState.shareMode) {
      this.mode = "passive";
      this.interactiveRegion = false;
      this.applyMode();
      // Sharing must remove the HUD from the captured desktop, not merely
      // render transparent DOM. Keep the BrowserWindow alive so the ASR/AI
      // session and the previous HUD state can be restored without recreation.
      this.hide();
    } else if (this.hudState.running) {
      this.mode = this.hudState.mouseMode === "interactive" ? "interactive" : "passive";
      this.interactiveRegion = false;
      this.applyMode();
      this.show().showInactive();
    }
  }
  toggleShareMode(): void { this.setShareMode(!this.hudState.shareMode); }
  setClickThrough(enabled: boolean): void { this.setMode(enabled ? "passive" : "interactive"); }

  setControlRegion(interactive: boolean): void {
    this.interactiveRegion = this.hudState.shareMode ? false : Boolean(interactive);
    this.applyMode();
  }

  coverCurrentMonitor(): void {
    const window = this.currentWindow;
    if (!window) return;
    const bounds = this.targetMonitorBounds();
    window.setBounds(bounds, false);
    this.refreshLayout(bounds);
  }

  show(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      this.applyCaptureProtection();
      this.applyMode();
      this.sendHudState();
      this.refreshLayout(this.window.getBounds());
      this.window.showInactive();
      return this.window;
    }

    const bounds = this.targetMonitorBounds();
    const { x, y, width, height } = bounds;
    this.window = new BrowserWindow({
      x,
      y,
      width,
      height,
      title: "Interview Copilot Overlay",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      // Never make the HUD active while it is being created. Passive mode
      // will keep the browser/meeting window focused underneath it.
      focusable: false,
      webPreferences: {
        preload: this.options.preloadPath ?? join(__dirname, "../preload/index.mjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    this.window.setAlwaysOnTop(true, "screen-saver");
    void this.options.loadRenderer(this.window);
    this.window.once("ready-to-show", () => {
      // Chromium may only expose the final native HWND after the first compositor frame.
      // Re-apply and re-check here so packaged and dev windows use the same native handle.
      this.applyCaptureProtection();
      this.sendHudState();
      this.refreshLayout(this.window?.getBounds() ?? bounds);
      this.window?.showInactive();
    });
    this.window.on("closed", () => { this.window = undefined; });
    this.applyMode();
    this.applyCaptureProtection();
    return this.window;
  }

  hide(): void {
    this.window?.hide();
  }

  toggle(): void {
    if (this.window?.isVisible()) this.hide();
    else this.show();
  }

  setMode(mode: OverlayMode): void {
    this.mode = this.hudStateValue.shareMode ? "passive" : mode;
    this.interactiveRegion = false;
    this.transition({ type: "set-mouse-mode", mode: this.mode === "interactive" ? "interactive" : "passthrough" });
    this.applyMode();
  }

  toggleMode(): OverlayMode {
    this.setMode(nextOverlayMode(this.mode));
    return this.mode;
  }

  setCaptureProtection(enabled: boolean): void {
    this.captureProtectionEnabled = enabled;
    this.applyCaptureProtection();
  }

  applyCaptureProtection(): void {
    this.captureProtectionState = applyCaptureProtection(this.currentWindow, this.captureProtectionEnabled, this.capabilities, this.options.onCaptureProtectionDiagnostic);
    const window = this.currentWindow;
    if (window) window.webContents.send("overlay:capture-protection", this.captureProtectionState);
  }

  recordExternalCaptureVerification(mode: "window" | "display", verified: boolean, fields: Record<string, unknown> = {}): void {
    this.captureProtectionState = {
      ...this.captureProtectionState,
      externalCaptureVerified: verified,
      ...(mode === "window" ? { windowCaptureVerified: verified } : { displayCaptureVerified: verified })
    };
    this.options.onCaptureProtectionDiagnostic?.(
      verified
        ? `CAPTURE_PROTECTION_EXTERNAL_${mode === "window" ? "WINDOW" : "DISPLAY"}_PASS`
        : `CAPTURE_PROTECTION_EXTERNAL_${mode === "window" ? "WINDOW" : "DISPLAY"}_FAIL`,
      { mode, verified, ...fields }
    );
    const window = this.currentWindow;
    if (window) window.webContents.send("overlay:capture-protection", this.captureProtectionState);
  }

  destroy(): void {
    this.window?.destroy();
    this.window = undefined;
    this.hudStateValue = { ...initialHUDState };
  }

  private applyMode(): void {
    if (!this.window || this.window.isDestroyed()) return;
    applyOverlayMode(this.window, this.mode, this.interactiveRegion);
    this.window.webContents.send("overlay:mode", this.mode);
    this.sendHudState();
  }

  private transition(action: HUDAction): void {
    const next = reduceHUDState(this.hudStateValue, action);
    this.hudStateValue = next;
    this.options.onHUDStateChange?.(next);
    this.sendHudState();
  }

  private sendHudState(): void {
    const window = this.currentWindow;
    if (window) window.webContents.send("overlay:state", this.hudStateValue);
  }

  private refreshLayout(bounds: Electron.Rectangle): void {
    const workArea: HUDWorkArea = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    this.hudLayoutValue = calculateHUDLayout(workArea);
    const window = this.currentWindow;
    if (window) window.webContents.send("overlay:layout", this.hudLayoutValue);
  }

  private sendPanelCommand(command: OverlayPanelCommand): void {
    const window = this.currentWindow;
    if (window) window.webContents.send("overlay:command", command);
  }

  private targetMonitorBounds(): Electron.Rectangle {
    const main = this.options.getMainWindow?.();
    if (main && !main.isDestroyed()) {
      const bounds = main.getBounds();
      const point = { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) };
      return screen.getDisplayNearestPoint(point).workArea;
    }
    return screen.getPrimaryDisplay().workArea;
  }
}

/** Backwards-compatible name for the singleton HUD window manager. */
export { OverlayManager as HUDWindowManager };
