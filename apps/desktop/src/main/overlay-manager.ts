import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { applyOverlayMode, nextOverlayMode, type OverlayMode } from "./overlay-mode";
import { applyCaptureProtection, getCaptureProtectionCapabilities, type CaptureProtectionCapabilities, type CaptureProtectionState } from "./overlay-capture-protection";

export { applyOverlayMode, nextOverlayMode } from "./overlay-mode";
export type { OverlayMode, OverlayWindowLike } from "./overlay-mode";
export { getCaptureProtectionCapabilities } from "./overlay-capture-protection";
export type { CaptureProtectionCapabilities, CaptureProtectionState } from "./overlay-capture-protection";

export interface OverlayManagerOptions {
  preloadPath?: string;
  loadRenderer: (window: BrowserWindow) => Promise<void>;
  getMainWindow?: () => BrowserWindow | undefined;
  captureProtectionEnabled?: boolean;
  onCaptureProtectionDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
}

export type OverlayPanelCommand = "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts";

export class OverlayManager {
  private window: BrowserWindow | undefined;
  private mode: OverlayMode = "interactive";
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

  /** Enter the desktop HUD mode and cover the complete monitor bounds. */
  enterInterviewMode(): BrowserWindow {
    const window = this.show();
    this.coverCurrentMonitor();
    window.showInactive();
    return window;
  }

  /** Leave the desktop HUD mode and restore an interactive native window. */
  exitInterviewMode(): void {
    this.setMode("interactive");
    this.hide();
  }

  showAll(): void { this.sendPanelCommand("show-all"); }
  hideAll(): void { this.sendPanelCommand("hide-all"); }
  toggleAll(): void { this.sendPanelCommand("toggle-all"); }
  resetLayout(): void { this.sendPanelCommand("reset-layout"); }
  toggleShortcuts(): void { this.sendPanelCommand("toggle-shortcuts"); }
  setClickThrough(enabled: boolean): void { this.setMode(enabled ? "passive" : "interactive"); }

  coverCurrentMonitor(): void {
    const window = this.currentWindow;
    if (!window) return;
    const bounds = this.targetMonitorBounds();
    window.setBounds(bounds, false);
  }

  show(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      this.applyCaptureProtection();
      this.window.showInactive();
      return this.window;
    }

    const { x, y, width, height } = this.targetMonitorBounds();
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
      focusable: true,
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
    this.mode = mode;
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
  }

  private applyMode(): void {
    if (!this.window || this.window.isDestroyed()) return;
    applyOverlayMode(this.window, this.mode);
    this.window.webContents.send("overlay:mode", this.mode);
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
      return screen.getDisplayNearestPoint(point).bounds;
    }
    return screen.getPrimaryDisplay().bounds;
  }
}
