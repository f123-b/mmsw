import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { applyOverlayMode, nextOverlayMode, type OverlayMode } from "./overlay-mode";

export { applyOverlayMode, nextOverlayMode } from "./overlay-mode";
export type { OverlayMode, OverlayWindowLike } from "./overlay-mode";

export interface OverlayManagerOptions {
  preloadPath?: string;
  loadRenderer: (window: BrowserWindow) => Promise<void>;
}

export class OverlayManager {
  private window: BrowserWindow | undefined;
  private mode: OverlayMode = "interactive";

  constructor(private readonly options: OverlayManagerOptions) {}

  get currentMode(): OverlayMode {
    return this.mode;
  }

  get currentWindow(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined;
  }

  show(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive();
      return this.window;
    }

    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    this.window = new BrowserWindow({
      x,
      y,
      width,
      height,
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
