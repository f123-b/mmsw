import { BrowserWindow, screen } from "electron";
import { join } from "node:path";
import { applyOverlayMode, nextOverlayMode, type OverlayMode } from "./overlay-mode";
import { applyCaptureProtection, getCaptureProtectionCapabilities, type CaptureProtectionCapabilities, type CaptureProtectionState } from "./overlay-capture-protection";
import { initialHUDState, reduceHUDState, type HUDAction, type HUDState } from "./hud-state";
import { calculateHUDLayout, type HUDLayout, type HUDWorkArea } from "./hud-layout";
import { DEFAULT_OVERLAY_PREFERENCES, type MouseInteractionMode, type OverlayBehaviorPreferences, type OverlayPreferences, type WheelRoutingMode } from "../shared/overlay-preferences";
import { initialOverlayLifecycleState, isOverlayLayoutEditing, reduceOverlayLifecycle, type OverlayLifecycleState } from "./overlay-lifecycle";
import { clampOverlayPanelBounds, resolveOverlayNativeBounds, type OverlayNativeBounds, type OverlayNativePanel } from "./overlay-layout-controller";

export { applyOverlayMode, nextOverlayMode } from "./overlay-mode";
export type { OverlayMode, OverlayWindowLike } from "./overlay-mode";
export type { OverlayNativeBounds, OverlayNativePanel } from "./overlay-layout-controller";
export { getCaptureProtectionCapabilities } from "./overlay-capture-protection";
export type { CaptureProtectionCapabilities, CaptureProtectionState } from "./overlay-capture-protection";
export { initialHUDState, reduceHUDState } from "./hud-state";
export type { HUDAction, HUDMode, HUDMouseMode, HUDState } from "./hud-state";
export { calculateHUDLayout } from "./hud-layout";
export type { HUDLayout, HUDPanelLayout, HUDWorkArea } from "./hud-layout";
export { initialOverlayLifecycleState, isOverlayLayoutEditing, isOverlayRuntime, reduceOverlayLifecycle } from "./overlay-lifecycle";
export type { OverlayLifecycleAction, OverlayLifecycleState } from "./overlay-lifecycle";

export interface OverlayDisplayInfo {
  id: number;
  bounds: HUDWorkArea;
  workArea: HUDWorkArea;
  scaleFactor: number;
}

export type OverlayWindowSurface = "question" | "answer" | "control";

export interface OverlayManagerOptions {
  preloadPath?: string;
  loadRenderer: (window: BrowserWindow, surface?: OverlayWindowSurface) => Promise<void>;
  getMainWindow?: () => BrowserWindow | undefined;
  captureProtectionEnabled?: boolean;
  onCaptureProtectionDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
  onNativeBoundsChanged?: (panel: OverlayNativePanel, bounds: OverlayNativeBounds, display: OverlayDisplayInfo) => void;
  onHUDStateChange?: (state: HUDState) => void;
}

export type OverlayPanelCommand = "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end";
type OverlayWindowMap = Record<OverlayNativePanel, BrowserWindow | undefined>;

/** Owns the native overlay windows and their lifecycle. Renderers only render their panel. */
export class OverlayManager {
  private windows: OverlayWindowMap = { question: undefined, answer: undefined, control: undefined };
  private mode: OverlayMode = "passive";
  private alwaysOnTop = true;
  private interactionMode: MouseInteractionMode = "click_through";
  private wheelRouting: WheelRoutingMode = "overlay_under_cursor";
  private temporaryInteractionModifier: "ctrl" | "alt" | "shift" | "ctrl_shift" = "ctrl";
  private temporaryInteraction = false;
  private lifecycleState: OverlayLifecycleState = initialOverlayLifecycleState;
  private hudStateValue: HUDState = { ...initialHUDState };
  private hudLayoutValue: HUDLayout = calculateHUDLayout({ x: 0, y: 0, width: 1440, height: 900 });
  private captureProtectionEnabled: boolean;
  private captureProtectionState: CaptureProtectionState;
  private readonly capabilities: CaptureProtectionCapabilities;
  private layoutPreferences: Pick<OverlayPreferences, "questionWindow" | "answerWindow" | "controlBar"> = {
    questionWindow: { ...DEFAULT_OVERLAY_PREFERENCES.questionWindow },
    answerWindow: { ...DEFAULT_OVERLAY_PREFERENCES.answerWindow },
    controlBar: { ...DEFAULT_OVERLAY_PREFERENCES.controlBar }
  };

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

  get currentMode(): OverlayMode { return this.mode; }
  get hudState(): HUDState { return this.hudStateValue; }
  get hudLayout(): HUDLayout { return this.hudLayoutValue; }
  /** Compatibility alias: the question window is the primary capture target. */
  get currentWindow(): BrowserWindow | undefined { return this.currentQuestionWindow; }
  get currentQuestionWindow(): BrowserWindow | undefined { return this.getWindow("question"); }
  get currentAnswerWindow(): BrowserWindow | undefined { return this.getWindow("answer"); }
  get currentControlWindow(): BrowserWindow | undefined { return this.getWindow("control"); }
  get currentWindows(): BrowserWindow[] { return (["question", "answer", "control"] as const).map((panel) => this.getWindow(panel)).filter((window): window is BrowserWindow => Boolean(window)); }
  get captureProtection(): boolean { return this.captureProtectionEnabled; }
  get captureProtectionSupported(): boolean { return this.capabilities.captureProtectionSupported; }
  get captureProtectionStatus(): CaptureProtectionState { return this.captureProtectionState; }
  get captureProtectionCapabilities(): CaptureProtectionCapabilities { return this.capabilities; }

  enterInterviewMode(): BrowserWindow { return this.enterHUDMode(); }
  enterWrittenTestMode(): BrowserWindow { return this.enterHUDMode(); }

  private enterHUDMode(): BrowserWindow {
    this.lifecycleState = reduceOverlayLifecycle(this.lifecycleState, { type: "start-interview" });
    this.transition({ type: "start" });
    this.mode = this.interactionMode === "interactive" ? "interactive" : "passive";
    return this.show();
  }

  exitInterviewMode(): void { this.exitHUDMode(); }
  exitWrittenTestMode(): void { this.exitHUDMode(); }
  private exitHUDMode(): void {
    this.transition({ type: "stop" });
    this.lifecycleState = reduceOverlayLifecycle(this.lifecycleState, { type: "finish" });
    this.mode = "interactive";
    this.applyMode();
    this.hide();
  }

  showAll(): void { this.transition({ type: "show-all" }); }
  hideAll(): void { this.transition({ type: "hide-all" }); }
  toggleAll(): void { this.transition({ type: "toggle-panels" }); }
  toggleTranscript(): void { this.transition({ type: "toggle-transcript" }); }
  toggleAnswer(): void { this.transition({ type: "toggle-answer" }); }
  toggleShortcuts(): void { this.transition({ type: "toggle-shortcuts" }); }
  /** End confirmation is intentionally delivered to the question/content owner only. */
  requestEndInterviewConfirmation(): void { this.currentQuestionWindow?.webContents.send("overlay:command", "confirm-end"); }

  resetLayout(): void { this.applyNativeBounds(); }

  applyLayoutPreferences(preferences: Pick<OverlayPreferences, "questionWindow" | "answerWindow" | "controlBar">): void {
    this.layoutPreferences = { questionWindow: { ...preferences.questionWindow }, answerWindow: { ...preferences.answerWindow }, controlBar: { ...preferences.controlBar } };
    this.applyNativeBounds();
    this.refreshLayout(this.targetMonitorBounds());
  }

  setShareMode(enabled: boolean): void {
    this.transition({ type: "set-share-mode", enabled });
    if (this.hudState.shareMode) { this.mode = "passive"; this.applyMode(); this.hide(); }
    else if (this.hudState.running) { this.mode = this.hudState.mouseMode === "interactive" ? "interactive" : "passive"; this.show(); }
  }
  toggleShareMode(): void { this.setShareMode(!this.hudStateValue.shareMode); }
  setClickThrough(enabled: boolean): void { this.setMode(enabled ? "passive" : "interactive"); }

  setNativeWindowBounds(panel: OverlayNativePanel, bounds: OverlayNativeBounds): void {
    if (!this.isLayoutEditMode) return;
    const window = this.getWindow(panel);
    if (!window) return;
    const display = this.displayForBounds(bounds);
    const next = clampOverlayPanelBounds(panel, bounds, display.workArea);
    window.setBounds(next, false);
    this.options.onNativeBoundsChanged?.(panel, next, display);
    this.refreshLayout(display.workArea);
  }


  applyPreferences(preferences: Pick<OverlayBehaviorPreferences, "alwaysOnTop" | "interactionMode" | "mousePassthrough" | "wheelRouting" | "temporaryInteractionModifier">): void {
    this.alwaysOnTop = Boolean(preferences.alwaysOnTop);
    this.interactionMode = preferences.interactionMode ?? (preferences.mousePassthrough ? "click_through" : "interactive");
    this.wheelRouting = preferences.wheelRouting ?? "overlay_under_cursor";
    this.temporaryInteractionModifier = preferences.temporaryInteractionModifier ?? "ctrl";
    for (const window of this.currentWindows) window.setAlwaysOnTop(this.alwaysOnTop, this.alwaysOnTop ? "screen-saver" : undefined);
    if (!this.isLayoutEditMode) this.mode = this.interactionMode === "interactive" ? "interactive" : "passive";
    this.applyMode();
  }

  get currentInteractionMode(): MouseInteractionMode { return this.interactionMode; }
  get currentWheelRouting(): WheelRoutingMode { return this.wheelRouting; }
  get isLayoutEditMode(): boolean { return isOverlayLayoutEditing(this.lifecycleState); }
  setTemporaryInteraction(modifier: "ctrl" | "alt" | "shift", pressed: boolean): void {
    const matches = this.temporaryInteractionModifier === modifier || (this.temporaryInteractionModifier === "ctrl_shift" && (modifier === "ctrl" || modifier === "shift"));
    if (!matches || this.hudStateValue.shareMode || this.isLayoutEditMode) return;
    this.temporaryInteraction = pressed;
    this.applyMode();
  }

  getDisplays(): OverlayDisplayInfo[] { return screen.getAllDisplays().map((display) => ({ id: display.id, bounds: { ...display.bounds }, workArea: { ...display.workArea }, scaleFactor: display.scaleFactor })); }

  setLayoutEditMode(enabled: boolean): void {
    const nextEnabled = Boolean(enabled);
    if (nextEnabled === this.isLayoutEditMode) { this.sendLayoutEditMode(); return; }
    if (nextEnabled) {
      this.lifecycleState = reduceOverlayLifecycle(this.lifecycleState, { type: "enter-layout-edit" });
      this.mode = "interactive";
      this.show();
    } else {
      this.lifecycleState = this.hudStateValue.running ? reduceOverlayLifecycle(this.lifecycleState, { type: "start-interview" }) : reduceOverlayLifecycle(this.lifecycleState, { type: "finish" });
      this.mode = this.hudStateValue.running && this.interactionMode === "interactive" ? "interactive" : "passive";
      this.applyMode();
      if (this.hudStateValue.running && !this.hudStateValue.shareMode) this.show(); else this.hide();
    }
    this.sendLayoutEditMode();
  }
  finishLayoutEditMode(): void { this.setLayoutEditMode(false); }

  handleGlobalWheel(x: number, y: number, deltaY: number): void {
    if (this.wheelRouting === "underlying_app" || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(deltaY)) return;
    for (const panel of ["question", "answer"] as const) {
      const window = this.getWindow(panel);
      if (!window) continue;
      const bounds = window.getBounds();
      if (x < bounds.x || y < bounds.y || x > bounds.x + bounds.width || y > bounds.y + bounds.height) continue;
      window.webContents.send("overlay:global-wheel", { x: x - bounds.x, y: y - bounds.y, deltaY, dual: this.wheelRouting === "dual" });
      break;
    }
  }

  coverCurrentMonitor(): void { this.applyNativeBounds(); }

  show(): BrowserWindow {
    const questionWindow = this.ensureWindow("question");
    this.ensureWindow("answer");
    this.ensureWindow("control");
    this.applyNativeBounds();
    this.applyMode();
    this.applyCaptureProtection();
    if (!this.hudStateValue.shareMode) for (const window of this.currentWindows) window.showInactive();
    return questionWindow;
  }

  hide(): void { for (const window of this.currentWindows) window.hide(); }
  toggle(): void { if (this.currentWindows.some((window) => window.isVisible())) this.hide(); else this.show(); }
  setMode(mode: OverlayMode): void {
    this.mode = this.hudStateValue.shareMode ? "passive" : mode;
    this.transition({ type: "set-mouse-mode", mode: this.mode === "interactive" ? "interactive" : "passthrough" });
    this.applyMode();
  }
  toggleMode(): OverlayMode { this.setMode(nextOverlayMode(this.mode)); return this.mode; }

  setCaptureProtection(enabled: boolean): void { this.captureProtectionEnabled = enabled; this.applyCaptureProtection(); }
  applyCaptureProtection(): void {
    let state = this.captureProtectionState;
    for (const window of this.currentWindows) state = applyCaptureProtection(window, this.captureProtectionEnabled, this.capabilities, this.options.onCaptureProtectionDiagnostic);
    this.captureProtectionState = state;
    this.sendToWindows("overlay:capture-protection", state);
  }
  recordExternalCaptureVerification(mode: "window" | "display", verified: boolean, fields: Record<string, unknown> = {}): void {
    this.captureProtectionState = { ...this.captureProtectionState, externalCaptureVerified: verified, ...(mode === "window" ? { windowCaptureVerified: verified } : { displayCaptureVerified: verified }) };
    this.options.onCaptureProtectionDiagnostic?.(verified ? `CAPTURE_PROTECTION_EXTERNAL_${mode === "window" ? "WINDOW" : "DISPLAY"}_PASS` : `CAPTURE_PROTECTION_EXTERNAL_${mode === "window" ? "WINDOW" : "DISPLAY"}_FAIL`, { mode, verified, ...fields });
    this.sendToWindows("overlay:capture-protection", this.captureProtectionState);
  }

  destroy(): void {
    this.lifecycleState = initialOverlayLifecycleState;
    for (const panel of ["question", "answer", "control"] as const) this.getWindow(panel)?.destroy();
    this.windows = { question: undefined, answer: undefined, control: undefined };
    this.hudStateValue = { ...initialHUDState };
  }

  private applyMode(): void {
    const interactiveContent = this.isLayoutEditMode || this.mode === "interactive" || this.temporaryInteraction;
    const questionWindow = this.currentQuestionWindow;
    const answerWindow = this.currentAnswerWindow;
    const controlWindow = this.currentControlWindow;
    if (questionWindow) { applyOverlayMode(questionWindow, interactiveContent ? "interactive" : "passive"); questionWindow.setResizable(this.isLayoutEditMode); questionWindow.webContents.send("overlay:mode", interactiveContent ? "interactive" : "passive"); }
    if (answerWindow) { applyOverlayMode(answerWindow, interactiveContent ? "interactive" : "passive"); answerWindow.setResizable(this.isLayoutEditMode); answerWindow.webContents.send("overlay:mode", interactiveContent ? "interactive" : "passive"); }
    if (controlWindow) { applyOverlayMode(controlWindow, "interactive"); controlWindow.setResizable(this.isLayoutEditMode); controlWindow.webContents.send("overlay:mode", "interactive"); }
    this.sendHudState();
  }

  private transition(action: HUDAction): void { this.hudStateValue = reduceHUDState(this.hudStateValue, action); this.options.onHUDStateChange?.(this.hudStateValue); this.sendHudState(); }
  private sendHudState(): void { this.sendToWindows("overlay:state", this.hudStateValue); }

  private refreshLayout(_bounds: Electron.Rectangle): void {
    const workArea = this.targetMonitorBounds();
    const display = this.targetDisplay();
    this.hudLayoutValue = { ...calculateHUDLayout(workArea), displayId: display.id, scaleFactor: display.scaleFactor };
    this.currentQuestionWindow?.webContents.send("overlay:layout", this.hudLayoutValue);
    this.currentAnswerWindow?.webContents.send("overlay:layout", this.hudLayoutValue);
    const controlWindow = this.currentControlWindow;
    if (controlWindow) controlWindow.webContents.send("overlay:layout", { ...this.hudLayoutValue, toolbar: { x: 0, y: 0, width: controlWindow.getBounds().width, height: controlWindow.getBounds().height }, shortcuts: { x: 0, y: 0, width: 0, height: 0 } });
  }
  private sendPanelCommand(command: OverlayPanelCommand): void { this.sendToWindows("overlay:command", command); }
  private sendLayoutEditMode(): void { this.sendToWindows("overlay:layout-edit-mode", this.isLayoutEditMode); }
  private sendToWindows(channel: string, payload: unknown): void { for (const window of this.currentWindows) if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload); }

  private ensureWindow(panel: OverlayNativePanel): BrowserWindow {
    const existing = this.getWindow(panel);
    if (existing) return existing;
    const bounds = this.nativeBounds(panel);
    const window = new BrowserWindow({ ...bounds, title: panel === "control" ? "Interview Copilot Overlay Controls" : `Interview Copilot ${panel} Overlay`, frame: false, transparent: true, backgroundColor: "#00000000", resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, focusable: false, webPreferences: { preload: this.options.preloadPath ?? join(__dirname, "../preload/index.mjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    this.windows[panel] = window;
    window.setAlwaysOnTop(this.alwaysOnTop, this.alwaysOnTop ? "screen-saver" : undefined);
    void this.options.loadRenderer(window, panel);
    window.once("ready-to-show", () => { this.applyMode(); this.applyCaptureProtection(); this.sendHudState(); this.sendLayoutEditMode(); this.refreshLayout(window.getBounds()); if (!this.hudStateValue.shareMode) window.showInactive(); });
    window.on("closed", () => { if (this.windows[panel] === window) this.windows[panel] = undefined; });
    return window;
  }

  private getWindow(panel: OverlayNativePanel): BrowserWindow | undefined { const window = this.windows[panel]; return window && !window.isDestroyed() ? window : undefined; }

  private applyNativeBounds(): void {
    const bounds = this.nativeBounds();
    for (const panel of ["question", "answer", "control"] as const) this.getWindow(panel)?.setBounds(bounds[panel], false);
    this.refreshLayout(this.targetMonitorBounds());
  }

  private nativeBounds(): Record<OverlayNativePanel, OverlayNativeBounds>;
  private nativeBounds(panel: OverlayNativePanel): OverlayNativeBounds;
  private nativeBounds(panel?: OverlayNativePanel): Record<OverlayNativePanel, OverlayNativeBounds> | OverlayNativeBounds {
    const display = this.targetDisplay();
    const workArea = display.workArea;
    const defaults = calculateHUDLayout(workArea);
    const resolved = resolveOverlayNativeBounds(this.layoutPreferences, { display, defaults: { question: defaults.transcript, answer: defaults.answer, control: defaults.toolbar } });
    const controlPreference = this.layoutPreferences.controlBar;
    if (controlPreference.positionMode !== "custom") {
      const gap = 24;
      const control = resolved.control;
      const x = controlPreference.positionMode.endsWith("right") ? workArea.x + workArea.width - control.width - gap : controlPreference.positionMode.endsWith("left") ? workArea.x + gap : workArea.x + Math.round((workArea.width - control.width) / 2);
      const y = controlPreference.positionMode.startsWith("bottom") ? workArea.y + workArea.height - control.height - gap : workArea.y + gap;
      resolved.control = { ...control, x, y };
    }
    return panel ? resolved[panel] : resolved;
  }

  private targetDisplay(): OverlayDisplayInfo {
    const preferredId = this.layoutPreferences.questionWindow.displayId;
    const preferred = preferredId === undefined ? undefined : screen.getAllDisplays().find((display) => display.id === preferredId);
    if (preferred) return { id: preferred.id, bounds: { ...preferred.bounds }, workArea: { ...preferred.workArea }, scaleFactor: preferred.scaleFactor };
    const main = this.options.getMainWindow?.();
    const bounds = main && !main.isDestroyed() ? main.getBounds() : undefined;
    const display = bounds ? screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) }) : screen.getPrimaryDisplay();
    return { id: display.id, bounds: { ...display.bounds }, workArea: { ...display.workArea }, scaleFactor: display.scaleFactor };
  }
  private displayForBounds(bounds: OverlayNativeBounds): OverlayDisplayInfo {
    const display = screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) });
    return { id: display.id, bounds: { ...display.bounds }, workArea: { ...display.workArea }, scaleFactor: display.scaleFactor };
  }
  private targetMonitorBounds(): Electron.Rectangle { return this.targetDisplay().workArea; }
}

export { OverlayManager as HUDWindowManager };
