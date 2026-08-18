import { BrowserWindow } from "electron";
import { join } from "node:path";

export type OverlayMode = "interactive" | "passive";

export interface OverlayWindowLike {
  isDestroyed(): boolean;
  setFocusable(focusable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  webContents: { send(channel: string, payload: unknown): void };
}

export function applyOverlayMode(window: OverlayWindowLike, mode: OverlayMode): void {
  const passive = mode === "passive";
  window.setFocusable(!passive);
  window.setIgnoreMouseEvents(passive, { forward: true });
}

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
        preload: this.options.preloadPath ?? join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
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
