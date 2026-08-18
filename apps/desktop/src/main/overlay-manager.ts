import { BrowserWindow } from "electron";
import { join } from "node:path";

export type OverlayMode = "interactive" | "passive";

export class OverlayManager {
  private window: BrowserWindow | undefined;
  private mode: OverlayMode = "interactive";

  constructor(private readonly rendererUrl: string) {}

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

    this.window = new BrowserWindow({
      width: 420,
      height: 320,
      minWidth: 320,
      minHeight: 220,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      focusable: true,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    this.window.setAlwaysOnTop(true, "screen-saver");
    void this.window.loadURL(`${this.rendererUrl}?window=overlay`);
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

  destroy(): void {
    this.window?.destroy();
    this.window = undefined;
  }

  private applyMode(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const passive = this.mode === "passive";
    this.window.setFocusable(!passive);
    this.window.setIgnoreMouseEvents(passive, { forward: true });
    this.window.webContents.send("overlay:mode", this.mode);
  }
}
