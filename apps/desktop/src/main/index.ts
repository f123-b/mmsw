import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { join } from "node:path";
import { AudioManager } from "./audio-manager";
import { OverlayManager, type OverlayMode } from "./overlay-manager";
import { SessionStateMachine } from "@interview-copilot/shared";

let mainWindow: BrowserWindow | undefined;
let overlayManager: OverlayManager | undefined;
const audioManager = new AudioManager();
const session = new SessionStateMachine();

function rendererUrl(): string {
  return process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of [mainWindow, overlayManager?.currentWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
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
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  void mainWindow.loadURL(rendererUrl());
  mainWindow.on("closed", () => { mainWindow = undefined; });
}

function registerIpc(): void {
  ipcMain.handle("audio:start", (_event, options) => audioManager.start(options));
  ipcMain.handle("audio:stop", () => audioManager.stop());
  ipcMain.handle("audio:probe", () => audioManager.probe());
  ipcMain.handle("audio:list-devices", () => audioManager.listDevices());
  ipcMain.handle("overlay:show", () => overlayManager?.show());
  ipcMain.handle("overlay:toggle", () => overlayManager?.toggle());
  ipcMain.handle("overlay:set-mode", (_event, mode: OverlayMode) => {
    overlayManager?.setMode(mode);
    broadcast("overlay:mode", mode);
  });
  ipcMain.handle("session:get-state", () => session.state);
}

function registerShortcuts(): void {
  const shortcuts: Record<string, () => void> = {
    "CommandOrControl+Alt+A": () => broadcast("shortcut", "answer-latest"),
    "CommandOrControl+Alt+S": () => broadcast("shortcut", "screenshot-answer"),
    "CommandOrControl+Alt+D": () => overlayManager?.toggle(),
    "CommandOrControl+Alt+X": () => broadcast("shortcut", "toggle-automation"),
    "CommandOrControl+Alt+Q": () => {
      if (session.canTransition("ENDING")) session.transition("ENDING");
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
  overlayManager = new OverlayManager(rendererUrl());
  registerIpc();
  registerShortcuts();

  audioManager.on("event", (event) => broadcast("audio:event", event));
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
