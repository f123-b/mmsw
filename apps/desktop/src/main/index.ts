import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { join } from "node:path";
import { AudioManager, type AudioStartOptions } from "./audio-manager";
import { OverlayManager, type OverlayMode } from "./overlay-manager";
import { ScreenshotManager } from "./screenshot-manager";
import { GLOBAL_SHORTCUTS } from "./shortcuts";
import { RealtimeSession, type RealtimeConnectOptions } from "./realtime-session";
import { AnswerAgent, ModelRouter, OpenAICompatibleAnswerProvider, SessionStateMachine } from "@interview-copilot/shared";
import { InterviewCoordinator, type InterviewStartOptions } from "./interview-coordinator";

let mainWindow: BrowserWindow | undefined;
let overlayManager: OverlayManager | undefined;
const audioManager = new AudioManager();
const screenshotManager = new ScreenshotManager({
  onDiagnostic: (message) => broadcast("screenshot:diagnostic", message)
});
const session = new SessionStateMachine();
const realtimeSession = new RealtimeSession();
const configuredModel = process.env.INTERVIEW_COPILOT_LLM_MODEL ?? "gpt-4o-mini";
const answerProvider = new OpenAICompatibleAnswerProvider({
  providerName: process.env.INTERVIEW_COPILOT_LLM_PROVIDER ?? "OpenAI-compatible",
  baseUrl: process.env.INTERVIEW_COPILOT_LLM_BASE_URL ?? "https://api.openai.com",
  apiKey: process.env.INTERVIEW_COPILOT_LLM_API_KEY ?? "",
  model: configuredModel,
  timeoutMs: Number(process.env.INTERVIEW_COPILOT_LLM_TIMEOUT_MS ?? 30_000),
  maxRetries: Number(process.env.INTERVIEW_COPILOT_LLM_MAX_RETRIES ?? 2)
});
const answerAgent = new AnswerAgent(
  { fast: answerProvider, "low-latency": answerProvider, reasoning: answerProvider, vision: answerProvider },
  new ModelRouter({ fast: configuredModel, "low-latency": configuredModel, reasoning: configuredModel, vision: configuredModel })
);
const interviewCoordinator = new InterviewCoordinator({ audio: audioManager, realtime: realtimeSession, session, answerAgent });
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
  // This low-level entry point is diagnostics-only. Product interview start goes through the coordinator.
  ipcMain.handle("audio:start", (_event, options: AudioStartOptions) => audioManager.start({ ...options, meterOnly: true, autoRecover: false }));
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
  ipcMain.handle("realtime:connect", (_event, options: RealtimeConnectOptions) => {
    realtimeSession.connect(options);
    return true;
  });
  ipcMain.handle("realtime:disconnect", () => {
    realtimeSession.disconnect();
    return true;
  });
  ipcMain.handle("interview:start", (_event, options: InterviewStartOptions) => interviewCoordinator.start(options));
  ipcMain.handle("interview:stop", () => interviewCoordinator.stop("user"));
  ipcMain.handle("interview:answer-latest", () => interviewCoordinator.answerLatest());
}

function registerShortcuts(): void {
  const shortcuts: Record<string, () => void> = {
    [GLOBAL_SHORTCUTS.answerLatest]: () => void interviewCoordinator.answerLatest(),
    [GLOBAL_SHORTCUTS.screenshotAnswer]: () => void captureScreenshot(),
    [GLOBAL_SHORTCUTS.toggleOverlay]: () => overlayManager?.toggle(),
    [GLOBAL_SHORTCUTS.toggleOverlayMode]: () => {
      const mode = overlayManager?.toggleMode();
      if (mode) broadcast("overlay:mode", mode);
    },
    [GLOBAL_SHORTCUTS.toggleAutomation]: () => broadcast("shortcut", "toggle-automation"),
    [GLOBAL_SHORTCUTS.endInterview]: () => {
      void interviewCoordinator.stop("user");
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
  audioManager.on("diagnostic", (message) => broadcast("audio:diagnostic", message));
  interviewCoordinator.on("event", (event: { type: string; [key: string]: unknown }) => {
    if (event.type === "session_state") broadcast("session:state", event.state);
    if (event.type === "transcript") broadcast("realtime:transcript", event.snapshot);
    if (event.type === "question") broadcast("question:event", event.event);
    if (event.type === "realtime_message") broadcast("realtime:message", event.message);
    if (event.type === "realtime_state") broadcast("realtime:state", event.state);
    if (event.type === "diagnostic") broadcast("realtime:diagnostic", event.message);
  });
  session.subscribe((state) => broadcast("session:state", state));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  void interviewCoordinator.stop("user");
  overlayManager?.destroy();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
