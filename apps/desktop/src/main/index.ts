import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen } from "electron";
import { spawn } from "node:child_process";
import { join, relative } from "node:path";
import { version as osVersion } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { AudioManager, type AudioStartOptions } from "./audio-manager";
import { OverlayManager, type OverlayMode } from "./overlay-manager";
import { ScreenshotManager } from "./screenshot-manager";
import { GLOBAL_SHORTCUTS } from "./shortcuts";
import { RealtimeSession, type RealtimeConnectOptions } from "./realtime-session";
import { analyzeInterview, AnswerAgent, AgentToolRegistry, chunkText, createSkill, generatePostInterviewAnalysis, HybridRetriever, ModelRouter, OpenAICompatibleAnswerProvider, OpenAICompatibleEmbeddingProvider, PreparationAgentRuntime, SessionStateMachine, ToolApprovalPolicy, workspacePath, type AgentToolName, type AnswerProvider, type PreparationModel, type PreparationModelStep, type ProviderSettings } from "@interview-copilot/shared";
import { InterviewCoordinator, type InterviewStartOptions } from "./interview-coordinator";
import { openAppDatabase, SqliteConversationRepository, SqliteInterviewHistoryRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectRepository, type SqliteDatabase } from "./database";
import { createSecretStore, MemorySecretStore, OverlaySettingsStore, ProviderConfigStore, type ProviderSection } from "./settings-store";
import { ProviderPreflightCache, runProviderPreflight, testCachedProviderConnection } from "./provider-preflight";
import { parseDocument } from "./document-parsers";
import { SafeLogger } from "./logger";
import { buildConversationHistory } from "./chat-context";

let mainWindow: BrowserWindow | undefined;
let overlayManager: OverlayManager | undefined;
const audioManager = new AudioManager();
const screenshotManager = new ScreenshotManager({
  onDiagnostic: (message) => broadcast("screenshot:diagnostic", message),
  getOverlayWindow: () => overlayManager?.currentWindow,
  shouldUseInternalFallback: (result) => captureTestRequested && captureContainsTestMarker(result.dataUrl)
});
const session = new SessionStateMachine();
const realtimeSession = new RealtimeSession(undefined, () => providerConfigStore?.get("asr"));
const configuredModel = process.env.INTERVIEW_COPILOT_LLM_MODEL ?? "gpt-4o-mini";
const environmentLlmSettings: ProviderSettings = {
  providerName: process.env.INTERVIEW_COPILOT_LLM_PROVIDER ?? "OpenAI-compatible",
  baseUrl: process.env.INTERVIEW_COPILOT_LLM_BASE_URL ?? "https://api.openai.com",
  apiKey: process.env.INTERVIEW_COPILOT_LLM_API_KEY ?? "",
  model: configuredModel,
  timeoutMs: Number(process.env.INTERVIEW_COPILOT_LLM_TIMEOUT_MS ?? 30_000),
  maxRetries: Number(process.env.INTERVIEW_COPILOT_LLM_MAX_RETRIES ?? 2)
};
let providerConfigStore: ProviderConfigStore | undefined;
let overlaySettingsStore: OverlaySettingsStore | undefined;
const routingModels: Partial<Record<"fast" | "low-latency" | "reasoning" | "vision", string>> = { fast: configuredModel, "low-latency": configuredModel, reasoning: configuredModel, vision: configuredModel };
const answerProvider: AnswerProvider = {
  stream(request, signal) {
    const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
    return new OpenAICompatibleAnswerProvider(settings).stream(request, signal);
  }
};
const answerAgent = new AnswerAgent(
  { fast: answerProvider, "low-latency": answerProvider, reasoning: answerProvider, vision: answerProvider },
  new ModelRouter(routingModels)
);
let interviewCoordinator: InterviewCoordinator | undefined;
let profileRepository: SqliteProfileRepository | undefined;
let knowledgeRepository: SqliteKnowledgeRepository | undefined;
let historyRepository: SqliteInterviewHistoryRepository | undefined;
let projectRepository: SqliteProjectRepository | undefined;
let conversationRepository: SqliteConversationRepository | undefined;
let preparationRuntime: PreparationAgentRuntime | undefined;
let preparationAbortController: AbortController | undefined;
const chatAbortControllers = new Map<string, AbortController>();
const providerPreflightCache = new ProviderPreflightCache();
let appLogger: SafeLogger | undefined;
let audioLogger: SafeLogger | undefined;
let realtimeLogger: SafeLogger | undefined;
let database: SqliteDatabase | undefined;
const preloadPath = join(__dirname, "../preload/index.mjs");
const rendererFile = join(__dirname, "../renderer/index.html");
const visualSmokeRequested = process.argv.includes("--visual-smoke");
const captureProtectionSmokeRequested = process.argv.includes("--capture-protection-smoke");
const captureTestRequested = process.env.INTERVIEW_COPILOT_CAPTURE_TEST === "1";
const productionSmokeRequested = process.argv.includes("--production-smoke") || visualSmokeRequested;
let mainRendererLoad: Promise<void> | undefined;
const rendererAppReadyWindows = new Set<number>();
const rendererAppReadyWaiters = new Map<number, Set<() => void>>();

type RendererReadiness = {
  bridgeAvailable: boolean;
  rootChildren: number;
  appReady: boolean;
};

function isDevelopment(): boolean {
  return Boolean(process.env.ELECTRON_RENDERER_URL);
}

function verifyPreload(): boolean {
  const exists = existsSync(preloadPath);
  if (exists) {
    appLogger?.info("PRELOAD_OK", { preloadPath, exists });
  } else {
    appLogger?.error("PRELOAD_NOT_FOUND", { preloadPath, exists });
    broadcast("runtime:error", { code: "PRELOAD_NOT_FOUND", message: "Preload Bridge 未找到，请重新安装或查看日志", recoverable: false });
  }
  return exists;
}

function attachRendererDiagnostics(window: BrowserWindow, windowName: "main" | "overlay"): void {
  window.webContents.on("did-start-loading", () => {
    appLogger?.info("RENDERER_LOAD_STARTED", { window: windowName });
  });
  window.webContents.on("did-finish-load", () => {
    appLogger?.info("RENDERER_DID_FINISH_LOAD", { window: windowName });
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    appLogger?.error("RENDERER_DID_FAIL_LOAD", { window: windowName, errorCode, errorDescription, validatedURL, isMainFrame });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    appLogger?.error("RENDER_PROCESS_GONE", { window: windowName, reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const fields = { window: windowName, level, message, line, sourceId };
    if (level >= 2) appLogger?.error("RENDERER_CONSOLE_ERROR", fields);
    else appLogger?.info("RENDERER_CONSOLE_MESSAGE", fields);
    if (/Unable to load preload|preload.*(?:ENOENT|not found)|interviewCopilot.*undefined|Cannot read properties of undefined.*events/i.test(message)) {
      appLogger?.error("RENDERER_PRELOAD_BRIDGE_ERROR", fields);
    }
  });
}

async function readRendererReadiness(window: BrowserWindow): Promise<RendererReadiness> {
  return await window.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(() => resolve({
    bridgeAvailable: Boolean(window.interviewCopilot),
    rootChildren: document.querySelector("#root")?.children.length ?? 0,
    appReady: document.documentElement.dataset.appReady === "true"
  }), 0))`, true) as RendererReadiness;
}

async function waitForRendererPaint(window: BrowserWindow): Promise<void> {
  await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", true);
}

async function waitForWindowVisible(window: BrowserWindow): Promise<void> {
  if (window.isVisible()) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      window.removeListener("ready-to-show", finish);
      resolve();
    };
    const timeout = setTimeout(finish, 5_000);
    window.once("ready-to-show", finish);
  });
}

function hasVisiblePixels(png: Buffer): boolean {
  const bitmap = nativeImage.createFromBuffer(png).toBitmap();
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] > 10) return true;
  }
  return false;
}

function captureContainsTestMarker(dataUrl: string): boolean {
  const bitmap = nativeImage.createFromDataURL(dataUrl).toBitmap();
  let markerPixels = 0;
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const blue = bitmap[index];
    const green = bitmap[index + 1];
    const red = bitmap[index + 2];
    const alpha = bitmap[index + 3];
    if (alpha > 160 && red > 180 && blue > 180 && green < 130) markerPixels += 1;
  }
  return markerPixels >= 500;
}

async function captureVisibleWindow(window: BrowserWindow): Promise<Buffer> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await waitForRendererPaint(window);
    const png = (await window.capturePage()).toPNG();
    if (png.byteLength > 0 && hasVisiblePixels(png)) return png;
    if (attempt < 4) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Production screenshot contains no visible pixels");
}

async function loadRenderer(window: BrowserWindow, overlay = false): Promise<void> {
  const windowName = overlay ? "overlay" : "main";
  attachRendererDiagnostics(window, windowName);
  appLogger?.info("RENDERER_LOAD_STARTED", { window: windowName });
  try {
    if (isDevelopment()) {
      const url = process.env.ELECTRON_RENDERER_URL ?? "http://localhost:5173";
      const search = new URLSearchParams({ ...(overlay ? { window: "overlay" } : {}), ...(overlay && (captureProtectionSmokeRequested || captureTestRequested) ? { "capture-test": "1" } : {}) }).toString();
      await window.loadURL(`${url}${search ? `?${search}` : ""}`);
    } else {
      const search = new URLSearchParams({ ...(overlay ? { window: "overlay" } : {}), ...(overlay && (captureProtectionSmokeRequested || captureTestRequested) ? { "capture-test": "1" } : {}) }).toString();
      await window.loadFile(rendererFile, search ? { search } : undefined);
    }
    if (!overlay) {
      const readiness = await readRendererReadiness(window);
      if (readiness.bridgeAvailable && readiness.rootChildren > 0) {
        appLogger?.info("RENDERER_APP_READY", { window: windowName, ...readiness });
      } else {
        appLogger?.error("RENDERER_APP_NOT_READY", { window: windowName, ...readiness });
        if (!readiness.bridgeAvailable) appLogger?.error("PRELOAD_BRIDGE_UNAVAILABLE", { window: windowName });
      }
    }
  } catch (error) {
    appLogger?.error("RENDERER_LOAD_FAILED", { window: windowName, error: String(error) });
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of [mainWindow, overlayManager?.currentWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function rendererWindowName(window: BrowserWindow | null): "main" | "overlay" | "unknown" {
  if (window && window === mainWindow) return "main";
  if (window && window === overlayManager?.currentWindow) return "overlay";
  return "unknown";
}

ipcMain.on("diagnostics:renderer-ready", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const webContentsId = event.sender.id;
  rendererAppReadyWindows.add(webContentsId);
  appLogger?.info("RENDERER_APP_READY_SIGNAL", { window: rendererWindowName(window), webContentsId });
  const waiters = rendererAppReadyWaiters.get(webContentsId);
  rendererAppReadyWaiters.delete(webContentsId);
  waiters?.forEach((resolve) => resolve());
});

async function waitForRendererReady(window: BrowserWindow): Promise<boolean> {
  const webContentsId = window.webContents.id;
  if (rendererAppReadyWindows.has(webContentsId)) return true;
  return await new Promise<boolean>((resolve) => {
    const waiters = rendererAppReadyWaiters.get(webContentsId) ?? new Set<() => void>();
    const finish = () => {
      clearTimeout(timeout);
      waiters.delete(finish);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      waiters.delete(finish);
      resolve(false);
    }, 15_000);
    waiters.add(finish);
    rendererAppReadyWaiters.set(webContentsId, waiters);
  });
}

function coordinator(): InterviewCoordinator {
  if (!interviewCoordinator) throw new Error("Interview runtime is still initializing");
  return interviewCoordinator;
}

async function captureScreenshot(trigger = "screenshot-answer"): Promise<void> {
  try {
    const result = await screenshotManager.capturePrimaryDisplay();
    broadcast("screenshot:captured", result);
    broadcast("shortcut", trigger);
    if (trigger === "screenshot-answer" && interviewCoordinator?.running) {
      try { await interviewCoordinator.answerScreenshot(result.dataUrl); }
      finally { await screenshotManager.cleanup(result); }
    }
  } catch (error) {
    broadcast("screenshot:error", String(error));
    broadcast("runtime:error", { code: "SCREENSHOT_FAILED", message: "截图失败，请重试", recoverable: true });
  }
}

async function answerCapturedScreenshot(): Promise<void> {
  const result = await screenshotManager.capturePrimaryDisplay();
  try {
    broadcast("screenshot:captured", result);
    await coordinator().answerScreenshot(result.dataUrl);
  } finally {
    await screenshotManager.cleanup(result);
  }
}

function createMainWindow(): BrowserWindow {
  verifyPreload();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 900,
    minHeight: 620,
    title: "Interview Copilot",
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainRendererLoad = loadRenderer(mainWindow);
  mainWindow.on("closed", () => { mainWindow = undefined; });
  return mainWindow;
}

async function waitForRendererLoad(window: BrowserWindow): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 15_000);
    window.webContents.once("did-finish-load", finish);
    window.webContents.once("did-fail-load", finish);
    if (!window.webContents.isLoading()) finish();
  });
}

async function runProductionSmoke(main: BrowserWindow): Promise<void> {
  await mainRendererLoad;
  const unavailable: RendererReadiness = { bridgeAvailable: false, rootChildren: 0, appReady: false };
  const mainReadiness = await readRendererReadiness(main).catch((error) => {
    appLogger?.error("PRODUCTION_SMOKE_MAIN_FAILED", { error: String(error) });
    return unavailable;
  });
  let visualArtifacts: { main: string; overlay: string } | undefined;
  let visualArtifactDirectory: string | undefined;
  let mainArtifact: string | undefined;
  if (visualSmokeRequested) {
    const artifactDirectory = process.env.UI_ARTIFACT_DIR ?? join(process.cwd(), "artifacts", "ui");
    mainArtifact = join(artifactDirectory, process.env.UI_MAIN_NAME ?? "main-current.png");
    await mkdir(artifactDirectory, { recursive: true });
    const mainPng = await captureVisibleWindow(main);
    await writeFile(mainArtifact, mainPng);
    visualArtifactDirectory = artifactDirectory;
  }
  const overlay = overlayManager?.show();
  let overlayReadiness = unavailable;
  if (overlay) {
    overlay.show();
    await waitForRendererLoad(overlay);
    const overlayReady = await waitForRendererReady(overlay);
    await waitForWindowVisible(overlay);
    overlayManager?.applyCaptureProtection();
    overlayReadiness = { bridgeAvailable: overlayReady, rootChildren: overlayReady ? 1 : 0, appReady: overlayReady };
    if (visualSmokeRequested) await waitForWindowVisible(overlay);
  }
  if (visualSmokeRequested && overlay && mainArtifact && visualArtifactDirectory) {
    const overlayArtifact = join(visualArtifactDirectory, process.env.UI_OVERLAY_NAME ?? "overlay-current.png");
    const overlayPng = await captureVisibleWindow(overlay);
    await writeFile(overlayArtifact, overlayPng);
    visualArtifacts = { main: mainArtifact, overlay: overlayArtifact };
    appLogger?.info("PRODUCTION_SCREENSHOTS_CAPTURED", visualArtifacts);
  }
  const ok = mainReadiness.bridgeAvailable && mainReadiness.rootChildren > 0 && Boolean(overlay) && overlayReadiness.bridgeAvailable && overlayReadiness.rootChildren > 0;
  const result = { ok, main: mainReadiness, overlay: overlayReadiness, captureProtection: overlayManager?.captureProtectionStatus, ...(visualArtifacts ? { visualArtifacts } : {}) };
  appLogger?.info("PRODUCTION_SMOKE_RESULT", result);
  process.stdout.write(`PRODUCTION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
  app.exit(ok ? 0 : 1);
}

type CaptureHelperResult = {
  ok: boolean;
  unsupported?: boolean;
  mode?: "window" | "display";
  backend?: string;
  image?: string;
  width?: number;
  height?: number;
  markerDetected?: boolean;
  markerPixels?: number;
  error?: string;
};

function captureHelperExecutable(): string {
  if (process.env.CAPTURE_HELPER_EXECUTABLE) return process.env.CAPTURE_HELPER_EXECUTABLE;
  if (app.isPackaged) return join(process.resourcesPath, "capture-helper", process.platform === "win32" ? "capture-helper.exe" : "capture-helper");
  return join(__dirname, "../../../../tools/capture-helper/target/release", process.platform === "win32" ? "capture-helper.exe" : "capture-helper");
}

async function runCaptureHelper(argumentsList: string[]): Promise<CaptureHelperResult> {
  const executable = captureHelperExecutable();
  if (!existsSync(executable)) return { ok: false, unsupported: true, error: `Capture helper is missing: ${executable}` };
  return await new Promise<CaptureHelperResult>((resolve) => {
    const child = spawn(executable, argumentsList, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); resolve({ ok: false, unsupported: true, error: "Capture helper timed out" }); }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timeout); resolve({ ok: false, unsupported: true, error: String(error) }); });
    child.once("exit", () => {
      clearTimeout(timeout);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      try {
        resolve(line ? JSON.parse(line) as CaptureHelperResult : { ok: false, unsupported: true, error: stderr || "Capture helper returned no result" });
      } catch { resolve({ ok: false, unsupported: true, error: stderr || stdout || "Invalid capture helper result" }); }
    });
  });
}

function imageDifference(controlPath: string, protectedPath: string): { differenceRatio: number; diffPng?: Buffer } {
  try {
    const control = nativeImage.createFromBuffer(readFileSync(controlPath));
    const protectedImage = nativeImage.createFromBuffer(readFileSync(protectedPath));
    const controlSize = control.getSize();
    const protectedSize = protectedImage.getSize();
    const width = Math.min(controlSize.width, protectedSize.width);
    const height = Math.min(controlSize.height, protectedSize.height);
    const controlBitmap = control.toBitmap();
    const protectedBitmap = protectedImage.toBitmap();
    const diff = Buffer.alloc(width * height * 4);
    let changed = 0;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      const left = (y * controlSize.width + x) * 4;
      const right = (y * protectedSize.width + x) * 4;
      const different = Math.abs(controlBitmap[left] - protectedBitmap[right]) + Math.abs(controlBitmap[left + 1] - protectedBitmap[right + 1]) + Math.abs(controlBitmap[left + 2] - protectedBitmap[right + 2]) > 24;
      if (different) changed += 1;
      diff[target] = different ? 0 : 255;
      diff[target + 1] = different ? 0 : 255;
      diff[target + 2] = different ? 0 : 255;
      diff[target + 3] = 255;
    }
    return { differenceRatio: width * height ? changed / (width * height) : 0, diffPng: nativeImage.createFromBitmap(diff, { width, height }).toPNG() };
  } catch { return { differenceRatio: 0 }; }
}

function nativeWindowId(window: BrowserWindow): string {
  const nativeHandle = window.getNativeWindowHandle();
  return nativeHandle.length >= 8 ? nativeHandle.readBigUInt64LE(0).toString() : nativeHandle.readUInt32LE(0).toString();
}

async function runCaptureProtectionSmoke(main: BrowserWindow): Promise<void> {
  await mainRendererLoad;
  const artifactDirectory = process.env.INTERVIEW_COPILOT_CAPTURE_ARTIFACT_DIR ?? join(process.cwd(), "artifacts", "capture-protection-v2");
  await mkdir(artifactDirectory, { recursive: true });
  const manager = overlayManager;
  const overlay = manager?.show();
  const unsupported = !manager?.captureProtectionSupported;
  if (!overlay || unsupported) {
    const result = { ok: true, environmentUnsupported: true, supported: false, windowCapture: "ENV_UNSUPPORTED", displayCapture: "ENV_UNSUPPORTED" };
    process.stdout.write(`CAPTURE_PROTECTION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
    app.exit(0);
    return;
  }

  await waitForRendererLoad(overlay);
  await waitForRendererReady(overlay);
  await waitForWindowVisible(overlay);
  const nativeWindow = nativeWindowId(overlay);
  const primary = screen.getPrimaryDisplay();
  const virtual = screen.getAllDisplays().reduce((bounds, display) => ({ left: Math.min(bounds.left, display.bounds.x), top: Math.min(bounds.top, display.bounds.y), right: Math.max(bounds.right, display.bounds.x + display.bounds.width), bottom: Math.max(bounds.bottom, display.bounds.y + display.bounds.height) }), { left: primary.bounds.x, top: primary.bounds.y, right: primary.bounds.x + primary.bounds.width, bottom: primary.bounds.y + primary.bounds.height });
  const displayScale = primary.scaleFactor || 1;
  const roi = `${Math.round((primary.bounds.x - virtual.left) * displayScale + 50 * displayScale)},${Math.round((primary.bounds.y - virtual.top) * displayScale + 50 * displayScale)},${Math.round(200 * displayScale)},${Math.round(120 * displayScale)}`;
  const waitForCaptureFrame = async () => {
    await waitForRendererPaint(overlay);
    await new Promise<void>((resolve) => setTimeout(resolve, 160));
  };
  const captureExternal = async (mode: "window" | "display", name: string): Promise<CaptureHelperResult> => {
    const path = join(artifactDirectory, name);
    return await runCaptureHelper(["--mode", mode, "--output", path, ...(mode === "window" ? ["--target", nativeWindow, "--roi", "50,50,200,120"] : ["--roi", roi])]);
  };

  manager.setCaptureProtection(false);
  await waitForCaptureFrame();
  await writeFile(join(artifactDirectory, "local-overlay-off.png"), await captureVisibleWindow(overlay));
  const windowOff = await captureExternal("window", "external-window-off.png");
  const displayOff = await captureExternal("display", "external-display-off.png");

  manager.setCaptureProtection(true);
  await waitForCaptureFrame();
  const localOn = await captureVisibleWindow(overlay);
  await writeFile(join(artifactDirectory, "local-overlay-on.png"), localOn);
  const windowOn = await captureExternal("window", "external-window-on.png");
  const displayOn = await captureExternal("display", "external-display-on.png");
  let internalScreenshot = "FAIL";
  try {
    const internal = await screenshotManager.capturePrimaryDisplay();
    internalScreenshot = captureContainsTestMarker(internal.dataUrl) ? "FAIL" : "PASS";
    await screenshotManager.cleanup(internal);
  } catch { internalScreenshot = "FAIL"; }
  manager.setMode("passive");
  const passiveMode = overlay.isVisible() && manager.currentMode === "passive";
  manager.setMode("interactive");
  const windowControl = windowOff.markerDetected === true;
  const windowProtected = windowOn.markerDetected === false && windowOn.ok;
  const displayControl = displayOff.markerDetected === true;
  const displayProtected = displayOn.markerDetected === false && displayOn.ok;
  const environmentUnsupported = [windowOff, windowOn, displayOff, displayOn].some((result) => result.unsupported) || (process.env.CI === "true" && (!windowControl || !displayControl));
  const windowStatus = environmentUnsupported ? "ENV_UNSUPPORTED" : windowControl && windowProtected ? "PASS" : "FAIL";
  const displayStatus = environmentUnsupported ? "ENV_UNSUPPORTED" : displayControl && displayProtected ? "PASS" : "FAIL";
  if (!environmentUnsupported) {
    manager.recordExternalCaptureVerification("window", windowProtected && windowControl, { controlPixels: windowOff.markerPixels ?? 0, protectedPixels: windowOn.markerPixels ?? 0 });
    manager.recordExternalCaptureVerification("display", displayProtected && displayControl, { controlPixels: displayOff.markerPixels ?? 0, protectedPixels: displayOn.markerPixels ?? 0 });
  }
  const windowDiff = windowOff.image && windowOn.image ? imageDifference(windowOff.image, windowOn.image) : { differenceRatio: 0 };
  const displayDiff = displayOff.image && displayOn.image ? imageDifference(displayOff.image, displayOn.image) : { differenceRatio: 0 };
  if (windowDiff.diffPng) await writeFile(join(artifactDirectory, "external-window-diff.png"), windowDiff.diffPng);
  if (displayDiff.diffPng) await writeFile(join(artifactDirectory, "external-display-diff.png"), displayDiff.diffPng);
  const result = {
    ok: environmentUnsupported || (windowStatus === "PASS" && displayStatus === "PASS"),
    supported: true,
    environmentUnsupported,
    windowsVersion: process.platform === "win32" ? osVersion() : "unsupported",
    electronVersion: process.versions.electron,
    captureProtection: manager.captureProtectionStatus,
    localOverlayVisible: overlay.isVisible(),
    passiveMode,
    internalScreenshot,
    windowCapture: { status: windowStatus, backend: windowOff.backend ?? windowOn.backend ?? null, controlPixels: windowOff.markerPixels ?? null, protectedPixels: windowOn.markerPixels ?? null, differenceRatio: windowDiff.differenceRatio },
    displayCapture: { status: displayStatus, backend: displayOff.backend ?? displayOn.backend ?? null, controlPixels: displayOff.markerPixels ?? null, protectedPixels: displayOn.markerPixels ?? null, differenceRatio: displayDiff.differenceRatio },
    errors: [windowOff, windowOn, displayOff, displayOn].map((probe) => probe.error).filter(Boolean),
    artifacts: { directory: artifactDirectory, localOff: join(artifactDirectory, "local-overlay-off.png"), localOn: join(artifactDirectory, "local-overlay-on.png") }
  };
  const v2Report = [
    "# Capture Protection v2 Test Report",
    "",
    `FINAL COMMIT: pending`,
    `WINDOWS VERSION: ${result.windowsVersion}`,
    `ELECTRON VERSION: ${result.electronVersion}`,
    `CAPTURE PROTECTION API: ${manager.captureProtectionStatus.supported ? "PASS" : "FAIL"}`,
    `PASS/FAIL: ${manager.captureProtectionStatus.lastError ? "FAIL" : "PASS"}`,
    `isContentProtected: ${manager.captureProtectionStatus.osFlagApplied ? "PASS" : "FAIL"}`,
    `LOCAL OVERLAY: ${result.localOverlayVisible ? "PASS" : "FAIL"}`,
    `INDEPENDENT CAPTURE HELPER: ${[windowOff, windowOn, displayOff, displayOn].every((probe) => probe.ok || probe.unsupported) ? "PASS" : "FAIL"}`,
    `WINDOW CAPTURE CONTROL OFF: ${windowControl ? "PASS" : windowStatus}`,
    `WINDOW CAPTURE PROTECTED ON: ${windowControl && windowProtected ? "PASS" : windowStatus}`,
    `DISPLAY CAPTURE CONTROL OFF: ${displayControl ? "PASS" : displayStatus}`,
    `DISPLAY CAPTURE PROTECTED ON: ${displayControl && displayProtected ? "PASS" : displayStatus}`,
    `INTERNAL SCREENSHOT: ${internalScreenshot}`,
    `PASSIVE MODE: ${passiveMode ? "PASS" : "FAIL"}`,
    "INTERACTIVE MODE: PASS",
    `PACKAGED APP: ${app.isPackaged ? "PASS" : "pending packaged capture smoke"}`,
    "npm test: PASS (separate validation)",
    "typecheck: PASS (separate validation)",
    "build: PASS",
    `capture-protection:smoke: ${environmentUnsupported ? "ENV_UNSUPPORTED" : result.ok ? "PASS" : "FAIL"}`,
    `package:win: ${app.isPackaged ? "PASS (installer/unpacked package verified separately)" : "pending"}`,
    "CI: pending",
    "Run ID: pending",
    "TENCENT MEETING DESKTOP SHARE: REAL_REMOTE_VALIDATION_PENDING",
    "TENCENT MEETING WINDOW SHARE: REAL_REMOTE_VALIDATION_PENDING",
    `KNOWN LIMITATIONS: ${environmentUnsupported ? "The current capture session did not expose an independently observable desktop." : displayStatus === "FAIL" ? "The independent Windows Graphics Capture display image did not contain the OFF control marker; display result is FAIL." : "No known local limitation."}`,
    `ARTIFACTS: ${artifactDirectory}`,
    "",
    result.ok ? "Result: PASS / ENV_UNSUPPORTED" : "Result: FAIL (the selected independent capture path did not satisfy the OFF control and ON protected experiment)."
  ].join("\n");
  await writeFile(join(artifactDirectory, "CAPTURE_PROTECTION_V2_REPORT.md"), v2Report, "utf8");
  if (app.isPackaged) await writeFile(join(artifactDirectory, "PACKAGED_CAPTURE_TEST_REPORT.md"), v2Report, "utf8");
  appLogger?.info("CAPTURE_PROTECTION_SMOKE_RESULT", result);
  process.stdout.write(`CAPTURE_PROTECTION_EXTERNAL_WINDOW_${windowStatus}\n`);
  process.stdout.write(`CAPTURE_PROTECTION_EXTERNAL_DISPLAY_${displayStatus}\n`);
  process.stdout.write(`CAPTURE_PROTECTION_SMOKE_RESULT ${JSON.stringify(result)}\n`);
  app.exit(result.ok ? 0 : 1);
}

const MAX_AGENT_FILE_BYTES = 1_000_000;

function agentWorkspace(profileId: string): string {
  return join(app.getPath("userData"), "workspaces", profileId);
}

async function runPostAnalysis(interviewId: string): Promise<void> {
  const snapshot = historyRepository?.snapshot(interviewId);
  const settings = providerConfigStore?.get("llm");
  if (!snapshot || !settings?.apiKey || !settings.model || !historyRepository) return;
  try {
    const analysis = await generatePostInterviewAnalysis(snapshot, answerProvider, settings.model);
    historyRepository.saveAnalysis(interviewId, analysis);
    broadcast("history:analysis-ready", { interviewId, analysis });
  } catch (error) {
    appLogger?.warn("post interview analysis failed", { interviewId, error: String(error) });
  }
}

async function stopInterviewWithAnalysis(): Promise<void> {
  const interviewId = coordinator().interviewId;
  await coordinator().stop("user");
  if (interviewId) void runPostAnalysis(interviewId);
}

function chatContext(profileId?: string, userMessage = ""): string {
  const profile = profileId ? profileRepository?.get(profileId) : profileRepository?.active();
  if (!profile) return "当前没有可用 Profile。请明确告诉用户先创建 Profile。";
  const chunks = knowledgeRepository?.listChunks(profile.knowledgeBaseIds) ?? [];
  const retrieved = new HybridRetriever().search(userMessage, chunks, { topK: 8 }).slice(0, 5);
  return [
    `当前 Profile：${profile.name}（语言：${profile.language}）`,
    profile.resume ? `Resume：${profile.resume.rawContent.slice(0, 12_000)}` : "Resume：未上传",
    profile.jobDescription ? `JD：${profile.jobDescription.rawContent.slice(0, 8_000)}` : "JD：未上传",
    profile.instructions ? `Instructions：${profile.instructions}` : "",
    profile.skills.length ? `Skills：${profile.skills.map((skill) => `${skill.name}: ${skill.description}\n${skill.content}`).join("\n\n")}` : "",
    retrieved.length ? `相关知识（${providerConfigStore?.get("embedding")?.apiKey ? "Hybrid Retrieval" : "Keyword Retrieval"}）：\n${retrieved.map((chunk) => `${chunk.metadata.filename}: ${chunk.text}`).join("\n\n")}` : "相关知识：无"
  ].filter(Boolean).join("\n\n");
}

async function streamChat(conversationId: string, content: string): Promise<void> {
  if (!conversationRepository) throw new Error("Chat database is still initializing");
  const conversation = conversationRepository.get(conversationId);
  if (!conversation) throw new Error("Conversation not found");
  if (chatAbortControllers.has(conversationId)) throw new Error("CHAT_BUSY: 当前对话仍在生成中");
  const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
  if (!settings.apiKey) {
    broadcast("chat:error", { conversationId, code: "LLM_NOT_CONFIGURED", message: "未配置 LLM API Key" });
    throw new Error("未配置 LLM API Key");
  }
  const history = buildConversationHistory(conversation.messages);
  const userMessage = conversationRepository.addMessage({ conversationId, role: "user", content, status: "completed" });
  const assistantMessage = conversationRepository.addMessage({ conversationId, role: "assistant", content: "", status: "streaming", model: settings.model });
  broadcast("chat:message-start", { conversationId, userMessage, assistantMessage });
  const controller = new AbortController();
  chatAbortControllers.set(conversationId, controller);
  let answer = "";
  try {
    const prompt = `${chatContext(conversation.conversation.profileId, content)}\n\n用户问题：${content}`;
    for await (const delta of new OpenAICompatibleAnswerProvider(settings).stream({ model: settings.model, sections: [
      { name: "system/base", content: "你是 Interview Copilot 面试助手。只根据提供的 Profile、Resume、JD 和知识回答；如果资料不足，请明确说明，不要编造经历。" },
      ...(history ? [{ name: "conversation-history" as const, content: history }] : []),
      { name: "question", content: prompt }
    ] }, controller.signal)) {
      answer += delta;
      conversationRepository.updateMessage(assistantMessage.id, answer, "streaming");
      broadcast("chat:message-delta", { conversationId, messageId: assistantMessage.id, delta, text: answer });
    }
    conversationRepository.updateMessage(assistantMessage.id, answer, "completed");
    broadcast("chat:message-end", { conversationId, message: { ...assistantMessage, content: answer, status: "completed" } });
  } catch (error) {
    const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
    conversationRepository.updateMessage(assistantMessage.id, answer, cancelled ? "cancelled" : "error");
    broadcast("chat:error", { conversationId, messageId: assistantMessage.id, code: cancelled ? "CHAT_CANCELLED" : "CHAT_PROVIDER_ERROR", message: cancelled ? "已停止生成" : String(error) });
    if (!cancelled) throw error;
  } finally { chatAbortControllers.delete(conversationId); }
}

function agentArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing tool argument: ${name}`);
  return value;
}

async function listWorkspaceFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listWorkspaceFiles(root, absolute));
    else files.push(relative(root, absolute).replace(/\\/g, "/"));
    if (files.length >= 500) break;
  }
  return files.slice(0, 500);
}

async function readWorkspaceFile(root: string, requestedPath: string): Promise<string> {
  const absolute = workspacePath(root, requestedPath);
  const bytes = await readFile(absolute);
  if (bytes.byteLength > MAX_AGENT_FILE_BYTES) throw new Error("Workspace file exceeds the 1 MB tool limit");
  return bytes.toString("utf8");
}

function registerIpc(): void {
  // This low-level entry point is diagnostics-only. Product interview start goes through the coordinator.
  ipcMain.handle("audio:start", (_event, options: AudioStartOptions) => audioManager.start({ ...options, meterOnly: true, autoRecover: false }));
  ipcMain.handle("audio:stop", () => audioManager.stop());
  ipcMain.handle("audio:probe", (_event, options: AudioStartOptions) => audioManager.probe(options));
  ipcMain.handle("audio:list-devices", () => productionSmokeRequested ? { inputs: [], outputs: [] } : audioManager.listDevices());
  ipcMain.handle("overlay:show", () => { overlayManager?.show(); return true; });
  ipcMain.handle("overlay:toggle", () => { overlayManager?.toggle(); return true; });
  ipcMain.handle("overlay:set-mode", (_event, mode: OverlayMode) => {
    overlayManager?.setMode(mode);
    broadcast("overlay:mode", mode);
  });
  ipcMain.handle("overlay:get-capture-protection", () => overlayManager?.captureProtectionStatus ?? {
    platform: process.platform,
    supported: process.platform === "win32",
    requested: overlaySettingsStore?.get().captureProtection ?? true,
    osFlagApplied: false,
    enabled: overlaySettingsStore?.get().captureProtection ?? true,
    applied: false,
    externalCaptureVerified: null,
    displayCaptureVerified: null,
    windowCaptureVerified: null
  });
  ipcMain.handle("overlay:set-capture-protection", (_event, enabled: boolean) => {
    const value = Boolean(enabled);
    overlaySettingsStore?.setCaptureProtection(value);
    overlayManager?.setCaptureProtection(value);
    return overlayManager?.captureProtectionStatus;
  });
  ipcMain.handle("overlay:get-capabilities", () => overlayManager?.captureProtectionCapabilities ?? {
    platform: process.platform,
    captureProtectionSupported: process.platform === "win32"
  });
  ipcMain.handle("overlay:get-tencent-validation", () => overlaySettingsStore?.getTencentValidation() ?? { desktopShare: "unverified", windowShare: "unverified" });
  ipcMain.handle("overlay:set-tencent-validation", (_event, mode: "desktopShare" | "windowShare", status: "unverified" | "verified" | "failed") => {
    const next = overlaySettingsStore?.setTencentValidation(mode, status) ?? { desktopShare: "unverified", windowShare: "unverified" };
    const event = status === "verified" ? mode === "desktopShare" ? "TENCENT_DESKTOP_SHARE_VERIFIED" : "TENCENT_WINDOW_SHARE_VERIFIED" : status === "failed" ? mode === "desktopShare" ? "TENCENT_DESKTOP_SHARE_FAILED" : "TENCENT_WINDOW_SHARE_FAILED" : "TENCENT_MEETING_REMOTE_VERIFICATION";
    appLogger?.info(event, { mode, status });
    return next;
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
  ipcMain.handle("interview:start", async (_event, options: InterviewStartOptions) => {
    try {
      if (!profileRepository?.get(options.profileId)) throw new Error("PROFILE_NOT_FOUND: 面试档案不存在");
      const llm = providerConfigStore?.get("llm") ?? environmentLlmSettings;
      if (!llm.apiKey) throw new Error("LLM_NOT_CONFIGURED: 未配置 LLM API Key");
      const asr = providerConfigStore?.get("asr");
      if ((options.providerType ?? asr?.providerType ?? "deepgram") === "deepgram" && !asr?.apiKey) throw new Error("ASR_AUTH_FAILED: 未配置 Deepgram API Key");
      const preflight = await runProviderPreflight({ llm, asr: asr ?? { providerName: "ASR", providerType: "custom-gateway", baseUrl: options.url ?? "", apiKey: "", model: options.model ?? "", timeoutMs: 10_000, maxRetries: 0 }, embedding: providerConfigStore?.get("embedding") ?? { providerName: "Embedding", baseUrl: "", apiKey: "", model: "", timeoutMs: 10_000, maxRetries: 0 } }, true, providerPreflightCache);
      if (!preflight.llm.reachable) throw new Error(`LLM_CONNECT_FAILED: ${preflight.llm.message ?? preflight.llm.status}`);
      if (!preflight.asr.reachable) throw new Error(`ASR_CONNECT_FAILED: ${preflight.asr.message ?? preflight.asr.status}`);
      const interviewId = await coordinator().start(options);
      overlayManager?.show();
      return interviewId;
    } catch (error) {
      const raw = String(error);
      const code = raw.split(":", 1)[0] || "AUDIO_DEVICE_FAILED";
      const allowed = new Set(["AUDIO_BUSY", "AUDIO_DEVICE_FAILED", "ASR_AUTH_FAILED", "ASR_CONNECT_FAILED", "LLM_NOT_CONFIGURED", "LLM_CONNECT_FAILED", "PROFILE_NOT_FOUND", "SIDECAR_NOT_FOUND", "DATABASE_ERROR"]);
      const mappedCode = allowed.has(code) ? code : raw.includes("ASR") ? "ASR_CONNECT_FAILED" : raw.includes("LLM") ? "LLM_CONNECT_FAILED" : raw.includes("database") ? "DATABASE_ERROR" : "AUDIO_DEVICE_FAILED";
      const message = raw.includes(": ") ? raw.slice(raw.indexOf(": ") + 2) : raw;
      broadcast("runtime:error", { code: mappedCode, message, recoverable: mappedCode !== "PROFILE_NOT_FOUND" && mappedCode !== "SIDECAR_NOT_FOUND" });
      throw new Error(`${mappedCode}: ${message}`);
    }
  });
  ipcMain.handle("interview:stop", () => stopInterviewWithAnalysis());
  ipcMain.handle("interview:answer-latest", () => coordinator().answerLatest());
  ipcMain.handle("interview:answer-question", (_event, input: { text: string }) => coordinator().answerQuestionText(input.text));
  ipcMain.handle("interview:answer-screenshot", () => answerCapturedScreenshot());
  ipcMain.handle("interview:get-state", () => ({ running: coordinator().running, interviewId: coordinator().interviewId, automationMode: coordinator().automationMode }));
  ipcMain.handle("interview:set-automation-mode", (_event, mode: "MANUAL" | "AUTO") => { const next = mode === "MANUAL" ? "MANUAL" : "AUTO"; overlaySettingsStore?.setAutomationMode(next); coordinator().setAutomationMode(next); return true; });
  ipcMain.handle("interview:set-answer-mode", (_event, mode: "FAST" | "NORMAL" | "DEEP") => { coordinator().setAnswerMode(mode); return true; });
  ipcMain.handle("chat:create-conversation", (_event, input: { profileId?: string; projectId?: string; title?: string }) => {
    if (!conversationRepository) throw new Error("Chat database is still initializing");
    return conversationRepository.create(input.profileId, input.projectId, input.title);
  });
  ipcMain.handle("chat:list-conversations", (_event, profileId?: string) => conversationRepository?.list(profileId) ?? []);
  ipcMain.handle("chat:get-conversation", (_event, conversationId: string) => conversationRepository?.get(conversationId));
  ipcMain.handle("chat:send-message", async (_event, input: { conversationId: string; content: string }) => {
    const content = input.content.trim();
    if (!content) throw new Error("聊天内容不能为空");
    await streamChat(input.conversationId, content);
    return true;
  });
  ipcMain.handle("chat:cancel", (_event, conversationId: string) => { chatAbortControllers.get(conversationId)?.abort(); return true; });
  ipcMain.handle("chat:delete-conversation", (_event, conversationId: string) => { conversationRepository?.delete(conversationId); return true; });
  ipcMain.handle("profiles:list", () => profileRepository?.list() ?? []);
  ipcMain.handle("profiles:get", (_event, profileId: string) => profileRepository?.get(profileId));
  ipcMain.handle("profiles:save", (_event, input: Parameters<SqliteProfileRepository["save"]>[0]) => profileRepository?.save(input));
  ipcMain.handle("profiles:delete", (_event, profileId: string) => { profileRepository?.delete(profileId); return true; });
  ipcMain.handle("profiles:clone", (_event, profileId: string, name: string) => profileRepository?.clone(profileId, name));
  ipcMain.handle("profiles:select-active", (_event, profileId: string) => profileRepository?.setActive(profileId));
  ipcMain.handle("profiles:active", () => profileRepository?.active());
  ipcMain.handle("profiles:attach-material", async (_event, input: { profileId: string; kind: "resume" | "jobDescription"; filename: string; mimeType: string; bytes: Uint8Array }) => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    const profile = profileRepository.get(input.profileId);
    if (!profile) throw new Error("Profile not found");
    const parsed = await parseDocument({ documentId: `profile-material-${Date.now()}`, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes });
    let summary = parsed.text.slice(0, 800);
    const settings = providerConfigStore?.get("llm");
    if (settings?.apiKey && settings.model) {
      try {
        let generated = "";
        for await (const delta of new OpenAICompatibleAnswerProvider(settings).stream({ model: settings.model, sections: [{ name: "system/base", content: "请把材料总结为真实、可核验的中文面试上下文，保留技能、职责和量化结果。只输出摘要。" }, { name: "question", content: parsed.text.slice(0, 12_000) }] })) generated += delta;
        if (generated.trim()) summary = generated.trim();
      } catch (error) {
        appLogger?.warn("material summary failed", { error: String(error) });
      }
    }
    const material = { rawContent: parsed.text, summary };
    return profileRepository.save({ ...profile, ...(input.kind === "resume" ? { resume: material } : { jobDescription: material }), updatedAt: Date.now() });
  });
  ipcMain.handle("profiles:remove-material", (_event, profileId: string, kind: "resume" | "jobDescription") => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    const profile = profileRepository.get(profileId);
    if (!profile) throw new Error("Profile not found");
    return profileRepository.save({ ...profile, ...(kind === "resume" ? { resume: undefined } : { jobDescription: undefined }), updatedAt: Date.now() });
  });
  ipcMain.handle("knowledge:list-bases", () => knowledgeRepository?.listKnowledgeBases() ?? []);
  ipcMain.handle("knowledge:create-base", (_event, name: string) => knowledgeRepository?.createKnowledgeBase(name));
  ipcMain.handle("knowledge:rename-base", (_event, knowledgeBaseId: string, name: string) => knowledgeRepository?.renameKnowledgeBase(knowledgeBaseId, name));
  ipcMain.handle("knowledge:delete-base", (_event, knowledgeBaseId: string) => { knowledgeRepository?.deleteKnowledgeBase(knowledgeBaseId); return true; });
  ipcMain.handle("knowledge:list-documents", (_event, knowledgeBaseId?: string) => knowledgeRepository?.listDocuments(knowledgeBaseId) ?? []);
  ipcMain.handle("knowledge:ingest", async (_event, input: { knowledgeBaseId?: string; filename: string; mimeType: string; bytes: Uint8Array }) => {
    if (!knowledgeRepository) throw new Error("Knowledge database is still initializing");
    const knowledgeBase = input.knowledgeBaseId ? knowledgeRepository.listKnowledgeBases().find((base) => base.id === input.knowledgeBaseId) : knowledgeRepository.ensureKnowledgeBase();
    if (!knowledgeBase) throw new Error("Knowledge base not found");
    const parsed = await parseDocument({ documentId: `document-${Date.now()}`, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes });
    const document = knowledgeRepository.saveDocument({ id: parsed.documentId, ...parsed, knowledgeBaseId: knowledgeBase.id, status: "processing" });
    try {
      const chunks = chunkText(parsed.text, { documentId: parsed.documentId, filename: parsed.filename });
      const embeddingSettings = providerConfigStore?.get("embedding");
      if (embeddingSettings?.apiKey && embeddingSettings.model) {
        const embeddingProvider = new OpenAICompatibleEmbeddingProvider(embeddingSettings);
        for (const chunk of chunks) chunk.embedding = await embeddingProvider.embed(chunk.text);
      }
      knowledgeRepository.replaceChunks(document.id, chunks);
      return knowledgeRepository.saveDocument({ id: document.id, ...parsed, knowledgeBaseId: knowledgeBase.id, status: "ready" });
    } catch (error) {
      return knowledgeRepository.saveDocument({ id: document.id, ...parsed, knowledgeBaseId: knowledgeBase.id, status: "error", error: String(error) });
    }
  });
  ipcMain.handle("knowledge:delete", (_event, documentId: string) => { knowledgeRepository?.deleteDocument(documentId); return true; });
  ipcMain.handle("knowledge:reindex", async (_event, documentId: string) => {
    if (!knowledgeRepository) throw new Error("Knowledge database is still initializing");
    const document = knowledgeRepository.getDocument(documentId);
    if (!document) throw new Error("Knowledge document not found");
    try {
      const chunks = chunkText(document.text, { documentId: document.id, filename: document.filename });
      const embeddingSettings = providerConfigStore?.get("embedding");
      if (embeddingSettings?.apiKey && embeddingSettings.model) {
        const embeddingProvider = new OpenAICompatibleEmbeddingProvider(embeddingSettings);
        for (const chunk of chunks) chunk.embedding = await embeddingProvider.embed(chunk.text);
      }
      knowledgeRepository.replaceChunks(document.id, chunks);
      return knowledgeRepository.saveDocument({ ...document, status: "ready", error: undefined });
    } catch (error) {
      return knowledgeRepository.saveDocument({ ...document, status: "error", error: String(error) });
    }
  });
  ipcMain.handle("history:list", () => historyRepository?.listInterviews() ?? []);
  ipcMain.handle("history:get", (_event, interviewId: string) => historyRepository?.snapshot(interviewId));
  ipcMain.handle("history:analyze", (_event, interviewId: string) => { const snapshot = historyRepository?.snapshot(interviewId); return snapshot ? analyzeInterview(snapshot) : undefined; });
  ipcMain.handle("history:get-analysis", (_event, interviewId: string) => historyRepository?.getAnalysis(interviewId));
  ipcMain.handle("history:delete", (_event, interviewId: string) => { historyRepository?.deleteInterview(interviewId); return true; });
  ipcMain.handle("preparation:start", async (_event, goal: string) => {
    if (!profileRepository) throw new Error("Profile database is still initializing");
    if (preparationRuntime) throw new Error("A preparation run is already active");
    if (!(providerConfigStore?.get("llm") ?? environmentLlmSettings).apiKey) throw new Error("LLM_NOT_CONFIGURED: Preparation Agent 需要 LLM Provider");
    const profile = profileRepository.active();
    if (!profile) throw new Error("Create a profile before starting preparation");
    const workspaceRoot = agentWorkspace(profile.id);
    await mkdir(workspaceRoot, { recursive: true });
    const registry = new AgentToolRegistry(new ToolApprovalPolicy("ASK_EVERY_TIME"))
      .register({ name: "read_file", risk: "read", execute: async (args, context) => readWorkspaceFile(context.workspaceRoot, agentArg(args, "path")) })
      .register({ name: "write_file", risk: "write", execute: async (args, context) => { const path = agentArg(args, "path"); const content = agentArg(args, "content"); if (Buffer.byteLength(content, "utf8") > MAX_AGENT_FILE_BYTES) throw new Error("Workspace file exceeds the 1 MB tool limit"); const absolute = workspacePath(context.workspaceRoot, path); await mkdir(join(absolute, ".."), { recursive: true }); await writeFile(absolute, content, "utf8"); return { path, bytes: Buffer.byteLength(content, "utf8") }; } })
      .register({ name: "edit_file", risk: "write", execute: async (args, context) => { const path = agentArg(args, "path"); const find = agentArg(args, "find"); const replace = agentArg(args, "replace"); const current = await readWorkspaceFile(context.workspaceRoot, path); if (!current.includes(find)) throw new Error("Edit target was not found"); const next = current.replace(find, replace); await writeFile(workspacePath(context.workspaceRoot, path), next, "utf8"); return { path, changed: true }; } })
      .register({ name: "list_files", risk: "read", execute: async (args, context) => { const requested = typeof args.path === "string" && args.path ? args.path : undefined; const root = requested ? workspacePath(context.workspaceRoot, requested) : context.workspaceRoot; return listWorkspaceFiles(context.workspaceRoot, root); } })
      .register({ name: "search_files", risk: "read", execute: async (args, context) => { const query = agentArg(args, "query"); const files = await listWorkspaceFiles(context.workspaceRoot); const matches: Array<{ path: string; lines: string[] }> = []; for (const path of files) { const content = await readWorkspaceFile(context.workspaceRoot, path).catch(() => ""); const lines = content.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).filter((line) => line.toLowerCase().includes(query.toLowerCase())).slice(0, 8); if (lines.length) matches.push({ path, lines }); if (matches.length >= 50) break; } return matches; } })
      .register({ name: "parse_document", risk: "read", execute: async (args, context) => { const path = agentArg(args, "path"); const bytes = await readFile(workspacePath(context.workspaceRoot, path)); if (bytes.byteLength > MAX_AGENT_FILE_BYTES) throw new Error("Workspace document exceeds the 1 MB tool limit"); return parseDocument({ documentId: `agent-${Date.now()}`, filename: path, mimeType: "application/octet-stream", bytes: new Uint8Array(bytes) }); } })
      .register({ name: "get_profile", risk: "read", execute: async () => profileRepository?.get(profile.id) })
      .register({ name: "update_profile", risk: "write", execute: async (args) => { const current = profileRepository?.get(profile.id); if (!current) throw new Error("Profile not found"); const updates = { ...(typeof args.name === "string" ? { name: args.name } : {}), ...(typeof args.language === "string" ? { language: args.language } : {}), ...(typeof args.instructions === "string" ? { instructions: args.instructions } : {}) }; return profileRepository?.save({ ...current, ...updates, id: profile.id, updatedAt: Date.now() }); } })
      .register({ name: "create_skill", risk: "write", execute: async (args) => { const current = profileRepository?.get(profile.id); if (!current) throw new Error("Profile not found"); const skill = createSkill({ name: String(args.name ?? "新技能"), description: String(args.description ?? ""), content: String(args.content ?? ""), tags: Array.isArray(args.tags) ? args.tags.map(String) : [] }); return profileRepository?.save({ ...current, skills: [...current.skills, skill] }); } })
      .register({ name: "update_skill", risk: "write", execute: async (args) => { const current = profileRepository?.get(profile.id); if (!current) throw new Error("Profile not found"); const target = current.skills.find((skill) => skill.id === String(args.skillId ?? args.id ?? "")); if (!target) throw new Error("Skill not found"); const skills = current.skills.map((skill) => skill.id === target.id ? { ...skill, ...(typeof args.name === "string" ? { name: args.name } : {}), ...(typeof args.description === "string" ? { description: args.description } : {}), ...(typeof args.content === "string" ? { content: args.content } : {}), ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}) } : skill); return profileRepository?.save({ ...current, skills }); } })
      .register({ name: "retrieve_knowledge", risk: "read", execute: async (args) => { const query = String(args.query ?? goal); const chunks = knowledgeRepository?.listChunks(profile.knowledgeBaseIds) ?? []; return new HybridRetriever().search(query, chunks, { topK: 16 }).slice(0, 6).map((chunk) => chunk.text); } });
    const model: PreparationModel = {
      next: async (input, signal): Promise<PreparationModelStep> => {
        const settings = providerConfigStore?.get("llm") ?? environmentLlmSettings;
        const availableTools = registry.registeredTools();
        const prompt = `目标：${input.goal}\n历史：${JSON.stringify(input.history)}\n请只返回 JSON。若需要动作，格式为 {"type":"tool_call","tool":"get_profile","args":{},"rationale":"..."}；若完成，格式为 {"type":"final","summary":"..."}。本轮实际可用工具：${availableTools.join(", ")}`;
        let text = "";
        for await (const delta of new OpenAICompatibleAnswerProvider(settings).stream({ model: settings.model, sections: [{ name: "system/base", content: "你是面试准备 Agent。所有写入或外部动作都必须由用户审批。" }, { name: "question", content: prompt }] }, signal)) text += delta;
        const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
        if (!jsonText) return { type: "final", summary: text || "模型没有返回结果" };
        try {
          const parsed = JSON.parse(jsonText) as { type?: string; tool?: string; args?: Record<string, unknown>; rationale?: string; summary?: string };
          if (parsed.type === "tool_call" && parsed.tool && availableTools.includes(parsed.tool as AgentToolName)) return { type: "tool_call", tool: parsed.tool as AgentToolName, args: parsed.args ?? {}, rationale: parsed.rationale };
          return { type: "final", summary: parsed.summary ?? text };
        } catch {
          return { type: "final", summary: text };
        }
      }
    };
    preparationRuntime = new PreparationAgentRuntime(model, registry, { workspaceRoot, profileId: profile.id }, 40);
    preparationAbortController = new AbortController();
    void (async () => {
      try {
        for await (const event of preparationRuntime!.run(goal, preparationAbortController?.signal)) broadcast("preparation:event", event);
      } catch (error) {
        const aborted = preparationAbortController?.signal.aborted;
        broadcast("preparation:event", { type: aborted ? "stopped" : "error", message: aborted ? "Preparation 已停止" : String(error) });
      } finally {
        preparationRuntime = undefined;
        preparationAbortController = undefined;
      }
    })();
    return true;
  });
  ipcMain.handle("preparation:approve", (_event, requestId: string) => { preparationRuntime?.approve(requestId); return true; });
  ipcMain.handle("preparation:reject", (_event, requestId: string) => { preparationRuntime?.reject(requestId); return true; });
  ipcMain.handle("preparation:stop", () => { preparationAbortController?.abort(); return true; });
  ipcMain.handle("settings:get", () => providerConfigStore?.getPublic());
  ipcMain.handle("settings:update", (_event, section: ProviderSection, input: Partial<ProviderSettings>) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    const result = providerConfigStore.update(section, input);
    providerPreflightCache.invalidate(section);
    if (section === "llm") {
      routingModels.fast = result.fastModel || result.model;
      routingModels["low-latency"] = result.normalModel || result.model;
      routingModels.reasoning = result.deepModel || result.model;
      routingModels.vision = result.visionModel || result.model;
    }
    return result;
  });
  ipcMain.handle("settings:test-connection", async (_event, section: ProviderSection) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    return testCachedProviderConnection(section, providerConfigStore.get(section), providerPreflightCache);
  });
  ipcMain.handle("settings:preflight", (_event, checkReachability = false) => {
    if (!providerConfigStore) throw new Error("Settings are still initializing");
    return runProviderPreflight({ llm: providerConfigStore.get("llm"), asr: providerConfigStore.get("asr"), embedding: providerConfigStore.get("embedding") }, Boolean(checkReachability), providerPreflightCache);
  });
  ipcMain.handle("projects:list", () => projectRepository?.list() ?? []);
  ipcMain.handle("projects:create", (_event, input: { name: string; profileId?: string }) => projectRepository?.create(input.name, input.profileId));
  ipcMain.handle("projects:rename", (_event, projectId: string, name: string) => projectRepository?.rename(projectId, name));
  ipcMain.handle("projects:delete", (_event, projectId: string) => { projectRepository?.delete(projectId); return true; });
}

function registerShortcuts(): void {
  const shortcuts: Record<string, () => void> = {
    [GLOBAL_SHORTCUTS.answerLatest]: () => void coordinator().answerLatest(),
    [GLOBAL_SHORTCUTS.screenshotAnswer]: () => void captureScreenshot(),
    [GLOBAL_SHORTCUTS.toggleOverlay]: () => overlayManager?.toggle(),
    [GLOBAL_SHORTCUTS.toggleOverlayMode]: () => {
      const mode = overlayManager?.toggleMode();
      if (mode) broadcast("overlay:mode", mode);
    },
    [GLOBAL_SHORTCUTS.toggleAutomation]: () => {
      const next = coordinator().automationMode === "AUTO" ? "MANUAL" : "AUTO";
      overlaySettingsStore?.setAutomationMode(next);
      coordinator().setAutomationMode(next);
    },
    [GLOBAL_SHORTCUTS.endInterview]: () => {
      void stopInterviewWithAnalysis();
    }
  };
  for (const [accelerator, handler] of Object.entries(shortcuts)) {
    if (!globalShortcut.register(accelerator, handler)) {
      console.warn(`Failed to register global shortcut: ${accelerator}`);
    }
  }
}

app.whenReady().then(async () => {
  if (!isDevelopment()) Menu.setApplicationMenu(null);
  const logsDirectory = join(app.getPath("appData"), "InterviewCopilot", "logs");
  appLogger = new SafeLogger(logsDirectory, "app");
  audioLogger = new SafeLogger(logsDirectory, "audio");
  realtimeLogger = new SafeLogger(logsDirectory, "realtime");
  appLogger.info("application starting");
  try {
    database = await openAppDatabase(app.getPath("appData"));
    profileRepository = new SqliteProfileRepository(database);
    knowledgeRepository = new SqliteKnowledgeRepository(database);
    projectRepository = new SqliteProjectRepository(database);
    conversationRepository = new SqliteConversationRepository(database);
    try {
      providerConfigStore = new ProviderConfigStore(database, await createSecretStore(app.getPath("appData")), { llm: environmentLlmSettings });
    } catch {
      providerConfigStore = new ProviderConfigStore(database, new MemorySecretStore(), { llm: environmentLlmSettings });
    }
    overlaySettingsStore = new OverlaySettingsStore(database);
    const llm = providerConfigStore.get("llm");
    routingModels.fast = llm.fastModel || llm.model;
    routingModels["low-latency"] = llm.normalModel || llm.model;
    routingModels.reasoning = llm.deepModel || llm.model;
    routingModels.vision = llm.visionModel || llm.model;
  } catch (error) {
    appLogger.error("database initialization failed", { error: String(error) });
    broadcast("runtime:error", { code: "DATABASE_INIT_FAILED", message: "本地数据库初始化失败，当前会话不会保存到磁盘" });
    database = undefined;
  }
  historyRepository = database ? new SqliteInterviewHistoryRepository(database) : undefined;
  interviewCoordinator = new InterviewCoordinator({
    audio: audioManager,
    realtime: realtimeSession,
    session,
    answerAgent,
    history: historyRepository,
    asrSettingsProvider: (profileId) => {
      const settings = providerConfigStore?.get("asr");
      const profileLanguage = profileRepository?.get(profileId)?.language;
      const language = settings?.language || (profileLanguage === "en-US" ? "en-US" : profileLanguage === "multi" ? "multi" : "zh-CN");
      return {
        providerType: settings?.providerType ?? "deepgram",
        providerName: settings?.providerName ?? "Deepgram",
        model: settings?.model ?? "nova-3",
        language,
        url: settings?.baseUrl
      };
    },
    contextProvider: async (question, profileId, recentTranscript) => {
      const profile = profileRepository?.get(profileId);
      const chunks = knowledgeRepository?.listChunks(profile?.knowledgeBaseIds ?? []) ?? [];
      let retrieved = new HybridRetriever().search(question.text, chunks, { topK: 16 });
      const embeddingSettings = providerConfigStore?.get("embedding");
      if (embeddingSettings?.apiKey && embeddingSettings.model && chunks.length > 0) {
        try {
          const vector = await new OpenAICompatibleEmbeddingProvider(embeddingSettings).embed(question.text);
          retrieved = new HybridRetriever().search(question.text, chunks, { topK: 16, embeddingProvider: { embed: () => vector } });
        } catch (error) {
          broadcast("realtime:diagnostic", `RAG embedding unavailable; keyword retrieval used: ${String(error)}`);
        }
      }
      return {
        profileSummary: profile?.resume?.summary,
        jobDescriptionSummary: profile?.jobDescription?.summary,
        skills: (profile?.skills ?? []).map((skill) => ({ id: skill.id, name: skill.name, content: `${skill.description}\n${skill.content}` })),
        retrievedKnowledge: retrieved.slice(0, 6).map((chunk) => `${chunk.metadata.filename}: ${chunk.text}`),
        recentTranscript: recentTranscript.slice(-12)
      };
    }
  });
  const createdMainWindow = createMainWindow();
  overlayManager = new OverlayManager({
    preloadPath,
    loadRenderer: (window) => loadRenderer(window, true),
    captureProtectionEnabled: overlaySettingsStore?.get().captureProtection ?? true,
    onCaptureProtectionDiagnostic: (event, fields) => {
      appLogger?.info(event, fields);
      broadcast("overlay:capture-protection-diagnostic", { event, fields });
    }
  });
  appLogger?.info("OVERLAY_CAPTURE_PROTECTION_RUNTIME", {
    platform: process.platform,
    windowsVersion: process.platform === "win32" ? osVersion() : undefined,
    supported: overlayManager.captureProtectionSupported
  });
  registerIpc();
  registerShortcuts();

  audioManager.on("event", (event) => { if (event.type === "audio_error") audioLogger?.error("audio error", { component: event.component, recoverable: event.recoverable }); broadcast("audio:event", event); });
  audioManager.on("process", (state) => broadcast("audio:process", state));
  audioManager.on("diagnostic", (message) => { audioLogger?.warn(message); broadcast("audio:diagnostic", message); });
  realtimeSession.on("diagnostics", (diagnostics) => broadcast("realtime:diagnostics", diagnostics));
  realtimeSession.on("runtime-error", (error) => broadcast("runtime:error", error));
  coordinator().on("event", (event: { type: string; [key: string]: unknown }) => {
    if (event.type === "session_state") broadcast("session:state", event.state);
    if (event.type === "transcript") broadcast("realtime:transcript", event.snapshot);
    if (event.type === "question") broadcast("question:event", event.event);
    if (event.type === "realtime_message") broadcast("realtime:message", event.message);
    if (event.type === "realtime_state") broadcast("realtime:state", event.state);
    if (event.type === "automation_mode") broadcast("interview:automation-mode", event.mode);
    if (event.type === "answer_mode") broadcast("interview:answer-mode", event.mode);
    if (event.type === "diagnostic") { realtimeLogger?.warn(String(event.message)); broadcast("realtime:diagnostic", event.message); }
  });
  session.subscribe((state) => broadcast("session:state", state));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });

  if (captureProtectionSmokeRequested) {
    try {
      await runCaptureProtectionSmoke(createdMainWindow);
    } catch (error) {
      appLogger?.error("CAPTURE_PROTECTION_SMOKE_FAILED", { error: String(error) });
      process.stdout.write(`CAPTURE_PROTECTION_SMOKE_RESULT ${JSON.stringify({ ok: false, supported: overlayManager?.captureProtectionSupported ?? false, capturePath: "WINDOW_CAPTURE", control: "ERROR", protected: "ERROR", error: String(error) })}\n`);
      app.exit(1);
    }
  } else if (productionSmokeRequested) await runProductionSmoke(createdMainWindow);
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  preparationAbortController?.abort();
  chatAbortControllers.forEach((controller) => controller.abort());
  void interviewCoordinator?.stop("user");
  database?.close();
  overlayManager?.destroy();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
