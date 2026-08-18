import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { join } from "node:path";
import { AudioManager, type AudioStartOptions } from "./audio-manager";
import { OverlayManager, type OverlayMode } from "./overlay-manager";
import { ScreenshotManager } from "./screenshot-manager";
import { GLOBAL_SHORTCUTS } from "./shortcuts";
import { SessionStateMachine } from "@interview-copilot/shared";

let mainWindow: BrowserWindow | undefined;
let overlayManager: OverlayManager | undefined;
const audioManager = new AudioManager();
const screenshotManager = new ScreenshotManager();
const session = new SessionStateMachine();
const preloadPath = join(__dirname, "../preload/index.js");
const rendererFile = join(__dirname, "../renderer/index.html");

function isDevelopment(): boolean {
  return Boolean(process.env.ELECTRON_RENDERER_URL);
}

async function loadRenderer(window: BrowserWindow, overlay = false): Promise<void> {
  if (isDevelopment()) {
    const url = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
    await window.loadURL(`${url}${overlay ? "?window=overlay" : ""}`);
  } else {
    await window.loadFile(rendererFile, overlay ? { search: "window=overlay" } : undefined);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of [mainWindow, overlayManager?.currentWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

async function captureScreenshot(trigger = "screenshot-answer"): Promise<void> {
  try {
    const result = await screenshotManager.capturePrimaryDisplay();
    broadcast("screenshot:captured", result);
    broadcast("shortcut", trigger);
  } catch (error) {
    broadcast("screenshot:error", String(error));
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: "Interview Copilot",
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  void loadRenderer(mainWindow);
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

function registerIpc(): void {
  ipcMain.handle("audio:start", (_event, options: AudioStartOptions) => audioManager.start(options));
  ipcMain.handle("audio:stop", () => audioManager.stop());
  ipcMain.handle("audio:probe", (_event, options: AudioStartOptions) => audioManager.probe(options));
  ipcMain.handle("audio:list-devices", () => audioManager.listDevices());
  ipcMain.handle("overlay:show", () => { overlayManager?.show(); return true; });
  ipcMain.handle("overlay:toggle", () => { overlayManager?.toggle(); return true; });
  ipcMain.handle("overlay:set-mode", (_event, mode: OverlayMode) => {
    overlayManager?.setMode(mode);
    broadcast("overlay:mode", mode);
  });
  ipcMain.handle("screenshot:capture", () => screenshotManager.capturePrimaryDisplay());
  ipcMain.handle("session:get-state", () => session.state);
}

function registerShortcuts(): void {
  const shortcuts: Record<string, () => void> = {
    [GLOBAL_SHORTCUTS.answerLatest]: () => broadcast("shortcut", "answer-latest"),
    [GLOBAL_SHORTCUTS.screenshotAnswer]: () => void captureScreenshot(),
    [GLOBAL_SHORTCUTS.toggleOverlay]: () => overlayManager?.toggle(),
    [GLOBAL_SHORTCUTS.toggleAutomation]: () => broadcast("shortcut", "toggle-automation"),
    [GLOBAL_SHORTCUTS.endInterview]: () => {
      if (session.canTransition("ENDING")) session.transition("ENDING");
      broadcast("shortcut", "end-interview");
      broadcast("session:state", session.state);
    }
  };
  for (const [accelerator, handler] of Object.entries(shortcuts)) {
    if (!globalShortcut.register(accelerator, handler)) {
      console.warn(`Failed to register global shortcut: ${accelerator}`);
    }
  }
}

app.whenReady().then(() => {
  createMainWindow();
  overlayManager = new OverlayManager({
    preloadPath,
    loadRenderer: (window) => loadRenderer(window, true)
  });
  registerIpc();
  registerShortcuts();

  audioManager.on("event", (event) => broadcast("audio:event", event));
  audioManager.on("process", (state) => broadcast("audio:process", state));
  audioManager.on("pcm", (chunk) => broadcast("audio:pcm", chunk));
  audioManager.on("diagnostic", (message) => broadcast("audio:diagnostic", message));
  session.subscribe((state) => broadcast("session:state", state));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  audioManager.stop();
  overlayManager?.destroy();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
