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
  captureProtectionEnabled?: boolean;
  onCaptureProtectionDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
}

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
      enabled: this.captureProtectionEnabled,
      applied: false
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

  show(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      this.applyCaptureProtection();
      this.window.showInactive();
      return this.window;
    }

    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    this.window = new BrowserWindow({
      x,
      y,
      width,
      height,
      title: "Interview Copilot Overlay",
      minWidth: width,
      minHeight: height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: true,
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
    this.window.once("ready-to-show", () => this.window?.showInactive());
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

  destroy(): void {
    this.window?.destroy();
    this.window = undefined;
  }

  private applyMode(): void {
    if (!this.window || this.window.isDestroyed()) return;
    applyOverlayMode(this.window, this.mode);
    this.window.webContents.send("overlay:mode", this.mode);
  }
}
