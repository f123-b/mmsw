import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from "electron";
import { join } from "node:path";
import { applyOverlayMode, nextOverlayMode, type OverlayMode } from "./overlay-mode";
import { applyCaptureProtection, getCaptureProtectionCapabilities, type CaptureProtectionCapabilities, type CaptureProtectionState } from "./overlay-capture-protection";
import { initialHUDState, reduceHUDState, type HUDAction, type HUDState, type OverlayTransientLayer } from "./hud-state";
import { calculateHUDLayout, type HUDLayout, type HUDWorkArea } from "./hud-layout";
import { DEFAULT_OVERLAY_PREFERENCES, type MouseInteractionMode, type OverlayBehaviorPreferences, type OverlayPreferences, type WheelRoutingMode } from "../shared/overlay-preferences";
import { initialOverlayLifecycleState, isOverlayLayoutEditing, reduceOverlayLifecycle, type OverlayLifecycleState } from "./overlay-lifecycle";
import { clampOverlayPanelBounds, contentDrivenHeight, resolveOverlayNativeBounds, type OverlayContentPanel, type OverlayNativeBounds, type OverlayNativePanel, type OverlayRuntimeLayoutMode } from "./overlay-layout-controller";
import type { InterviewStartupEvent } from "./interview-startup-timing";

export { applyOverlayMode, nextOverlayMode } from "./overlay-mode";
export type { OverlayMode, OverlayWindowLike } from "./overlay-mode";
export { contentDrivenHeight } from "./overlay-layout-controller";
export type { OverlayContentPanel, OverlayNativeBounds, OverlayNativePanel } from "./overlay-layout-controller";
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

export type OverlayWindowSurface = "question" | "answer" | "control" | "transient";

export interface OverlayManagerOptions {
  preloadPath?: string;
  loadRenderer: (window: BrowserWindow, surface?: OverlayWindowSurface) => Promise<void>;
  getMainWindow?: () => BrowserWindow | undefined;
  captureProtectionEnabled?: boolean;
  onCaptureProtectionDiagnostic?: (event: string, fields: Record<string, unknown>) => void;
  onNativeBoundsChanged?: (panel: OverlayNativePanel, bounds: OverlayNativeBounds, display: OverlayDisplayInfo) => void;
  onHUDStateChange?: (state: HUDState) => void;
  onStartupTiming?: (event: InterviewStartupEvent) => void;
}

export interface ConfirmWindowConfiguration {
  frame: false;
  transparent: true;
  skipTaskbar: true;
  alwaysOnTop: true;
  hasShadow: false;
  focusable: false;
}

export type OverlayPanelCommand = "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end";
type OverlayWindowMap = Record<OverlayNativePanel, BrowserWindow | undefined>;

/** Owns the native overlay windows and their lifecycle. Renderers only render their panel. */
export class OverlayManager {
  private windows: OverlayWindowMap = { question: undefined, answer: undefined, control: undefined };
  private transientWindowValue: BrowserWindow | undefined;
  private readonly rendererLoads = new Map<OverlayWindowSurface, Promise<void>>();
  private readonly rendererReady = new Set<OverlayWindowSurface>();
  private mode: OverlayMode = "passive";
  private alwaysOnTop = true;
  private interactionMode: MouseInteractionMode = "click_through";
  private wheelRouting: WheelRoutingMode = "overlay_under_cursor";
  private temporaryInteractionModifier: "ctrl" | "alt" | "shift" | "ctrl_shift" = "ctrl";
  private temporaryInteraction = false;
  private lifecycleState: OverlayLifecycleState = initialOverlayLifecycleState;
  private runtimeLayoutMode: OverlayRuntimeLayoutMode = "interview";
  private hudStateValue: HUDState = { ...initialHUDState };
  private hudLayoutValue: HUDLayout = calculateHUDLayout({ x: 0, y: 0, width: 1440, height: 900 });
  private captureProtectionEnabled: boolean;
  private captureProtectionState: CaptureProtectionState;
  private readonly capabilities: CaptureProtectionCapabilities;
  private layoutPreferences: OverlayPreferences = DEFAULT_OVERLAY_PREFERENCES;

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
  get currentTransientWindow(): BrowserWindow | undefined { const window = this.transientWindowValue; return window && !window.isDestroyed() ? window : undefined; }
  /** Compatibility alias for callers that only know the old confirm surface. */
  get currentConfirmWindow(): BrowserWindow | undefined { return this.currentTransientWindow; }
  get confirmWindowConfiguration(): ConfirmWindowConfiguration { return { frame: false, transparent: true, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, focusable: false }; }
  get endInterviewConfirmOpen(): boolean { return this.hudStateValue.transientLayer === "end_confirm"; }
  get currentWindows(): BrowserWindow[] { return (["question", "answer", "control"] as const).map((panel) => this.getWindow(panel)).filter((window): window is BrowserWindow => Boolean(window)); }
  get captureProtection(): boolean { return this.captureProtectionEnabled; }
  get captureProtectionSupported(): boolean { return this.capabilities.captureProtectionSupported; }
  get captureProtectionStatus(): CaptureProtectionState { return this.captureProtectionState; }
  get captureProtectionCapabilities(): CaptureProtectionCapabilities { return this.capabilities; }

  enterInterviewMode(): BrowserWindow { this.runtimeLayoutMode = "interview"; return this.enterHUDMode(); }
  enterWrittenTestMode(): BrowserWindow { this.runtimeLayoutMode = "written_test"; return this.enterHUDMode(); }

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
    // A transient popup is session-scoped. Recreate it on the next HUD
    // session so a hidden Chromium renderer cannot retain stale operation
    // state after switching between interview and written-test modes.
    const transient = this.currentTransientWindow;
    if (transient) transient.destroy();
    this.transientWindowValue = undefined;
    this.runtimeLayoutMode = "interview";
  }

  showAll(): void { this.transition({ type: "show-all" }); }
  hideAll(): void { this.transition({ type: "hide-all" }); }
  toggleAll(): void { this.transition({ type: "toggle-panels" }); }
  toggleTranscript(): void { this.transition({ type: "toggle-transcript" }); }
  toggleAnswer(): void { this.transition({ type: "toggle-answer" }); }
  toggleShortcuts(): void {
    const layer: OverlayTransientLayer = this.hudStateValue.transientLayer === "shortcut" ? "none" : "shortcut";
    this.setTransientLayer(layer);
  }
  /** The confirmation dialog has its own native interactive owner. */
  requestEndInterviewConfirmation(): void {
    this.setTransientLayer("end_confirm");
  }

  cancelEndInterviewConfirmation(): void { this.setTransientLayer("none"); }
  confirmEndInterviewConfirmation(): void { this.setTransientLayer("none"); }

  async prepare(): Promise<void> {
    this.options.onStartupTiming?.("OVERLAY_PREPARE_BEGIN");
    this.ensureWindow("question");
    this.ensureWindow("answer");
    this.ensureWindow("control");
    this.ensureTransientWindow();
    await Promise.all([...this.rendererLoads.values()]);
    this.applyNativeBounds();
    this.applyMode();
    this.applyCaptureProtection();
    this.hide();
    this.setTransientLayer("none");
  }

  resetLayout(): void { this.applyNativeBounds(); }

  applyLayoutPreferences(preferences: OverlayPreferences): void {
    this.layoutPreferences = preferences;
    this.applyNativeBounds();
    this.refreshLayout(this.targetMonitorBounds());
    this.syncPanelVisibility();
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
    // Layout edit is constrained to the mode's target display. A drag whose
    // pointer crosses another monitor must not create per-panel display state.
    const display = this.targetDisplay();
    const modePreferences = this.runtimeLayoutMode === "written_test" ? this.layoutPreferences.writtenTest : this.layoutPreferences.interview;
    const next = clampOverlayPanelBounds(panel, bounds, display.workArea, this.runtimeLayoutMode, modePreferences.layoutPreset);
    window.setBounds(next, false);
    this.options.onNativeBoundsChanged?.(panel, next, display);
    this.refreshLayout(display.workArea);
  }

  setContentSize(panel: OverlayContentPanel, measuredHeight: number): boolean {
    if (!Number.isFinite(measuredHeight)) return false;
    if (this.runtimeLayoutMode !== "interview" || this.layoutPreferences.interview.layoutPreset !== "minimal") return true;
    const window = this.getWindow(panel);
    if (!window || this.isLayoutEditMode) return false;
    const current = window.getBounds();
    const nextHeight = contentDrivenHeight(panel, measuredHeight);
    if (current.height === nextHeight) return true;
    window.setBounds({ ...current, height: nextHeight }, false);
    return true;
  }


  applyPreferences(preferences: Pick<OverlayBehaviorPreferences, "alwaysOnTop" | "interactionMode" | "mousePassthrough" | "wheelRouting" | "temporaryInteractionModifier">): void {
    this.alwaysOnTop = Boolean(preferences.alwaysOnTop);
    this.interactionMode = preferences.interactionMode ?? (preferences.mousePassthrough ? "click_through" : "interactive");
    this.wheelRouting = preferences.wheelRouting ?? "overlay_under_cursor";
    this.temporaryInteractionModifier = preferences.temporaryInteractionModifier ?? "ctrl";
    for (const window of this.currentWindows) window.setAlwaysOnTop(this.alwaysOnTop, this.alwaysOnTop ? "screen-saver" : undefined);
    this.currentTransientWindow?.setAlwaysOnTop(this.alwaysOnTop, this.alwaysOnTop ? "screen-saver" : undefined);
    if (!this.isLayoutEditMode) this.mode = this.interactionMode === "interactive" ? "interactive" : "passive";
    this.applyMode();
    this.syncPanelVisibility();
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
  getWindowBounds(panel: OverlayNativePanel): OverlayNativeBounds | undefined { return this.getWindow(panel)?.getBounds(); }
  getTransientBounds(): OverlayNativeBounds | undefined { return this.currentTransientWindow?.getBounds(); }

  setLayoutEditMode(enabled: boolean): void {
    const nextEnabled = Boolean(enabled);
    if (nextEnabled === this.isLayoutEditMode) { this.sendLayoutEditMode(); return; }
    if (nextEnabled) {
      const nextLifecycleState = reduceOverlayLifecycle(this.lifecycleState, { type: "enter-layout-edit" });
      // Runtime overlays are native windows that must remain passive during
      // an interview. The settings canvas is the preview; entering real
      // window editing is an explicit settings action only.
      if (nextLifecycleState === this.lifecycleState) { this.sendLayoutEditMode(); return; }
      this.lifecycleState = nextLifecycleState;
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
    this.options.onStartupTiming?.("OVERLAY_PREPARE_BEGIN");
    this.options.onStartupTiming?.("OVERLAY_SHOW_REQUEST");
    const questionWindow = this.ensureWindow("question");
    this.ensureWindow("answer");
    this.ensureWindow("control");
    this.ensureTransientWindow();
    for (const panel of ["question", "answer", "control"] as const) {
      if (this.rendererReady.has(panel)) this.options.onStartupTiming?.(panel === "question" ? "QUESTION_RENDERER_READY" : panel === "answer" ? "ANSWER_RENDERER_READY" : "CONTROL_RENDERER_READY");
    }
    this.applyNativeBounds();
    this.applyMode();
    this.applyCaptureProtection();
    this.syncPanelVisibility();
    this.syncTransientWindow();
    return questionWindow;
  }

  hide(): void { for (const window of this.currentWindows) window.hide(); this.currentTransientWindow?.hide(); }
  toggle(): void { if (this.currentWindows.some((window) => window.isVisible())) this.hide(); else this.show(); }

  private syncPanelVisibility(): void {
    const visible = new Set<OverlayNativePanel>();
    const layoutEditing = this.isLayoutEditMode;
    if (!this.hudStateValue.shareMode && (layoutEditing || (this.hudStateValue.running && this.hudStateValue.panelVisible))) {
      const leftPanel = this.runtimeLayoutMode === "interview" ? this.layoutPreferences.interview.leftPanel : "question";
      if (leftPanel !== "hidden") visible.add("question");
      if (this.runtimeLayoutMode === "interview" ? (layoutEditing || this.hudStateValue.answerVisible) && this.layoutPreferences.interview.showAnswer : (layoutEditing || this.hudStateValue.answerVisible) && this.layoutPreferences.writtenTest.showAnswer && this.layoutPreferences.writtenTest.layoutPreset === "split") visible.add("answer");
    }
    if (!this.hudStateValue.shareMode && (layoutEditing || (this.hudStateValue.running && this.hudStateValue.topBarVisible)) && this.layoutPreferences.showToolbar) visible.add("control");
    for (const panel of ["question", "answer", "control"] as const) {
      const window = this.getWindow(panel);
      if (!window) continue;
      if (visible.has(panel)) {
        window.showInactive();
        this.options.onStartupTiming?.(panel === "question" ? "QUESTION_VISIBLE" : panel === "answer" ? "ANSWER_VISIBLE" : "CONTROL_VISIBLE");
      } else window.hide();
    }
  }
  setMode(mode: OverlayMode): void {
    this.mode = this.hudStateValue.shareMode ? "passive" : mode;
    this.transition({ type: "set-mouse-mode", mode: this.mode === "interactive" ? "interactive" : "passthrough" });
    this.applyMode();
  }
  toggleMode(): OverlayMode { this.setMode(nextOverlayMode(this.mode)); return this.mode; }

  setCaptureProtection(enabled: boolean): void { this.captureProtectionEnabled = enabled; this.applyCaptureProtection(); }
  applyCaptureProtection(): void {
    let state = this.captureProtectionState;
    for (const window of this.allWindows()) state = applyCaptureProtection(window, this.captureProtectionEnabled, this.capabilities, this.options.onCaptureProtectionDiagnostic);
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
    this.currentTransientWindow?.destroy();
    this.transientWindowValue = undefined;
    this.rendererLoads.clear();
    this.rendererReady.clear();
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
    const transientWindow = this.currentTransientWindow;
    if (transientWindow) {
      applyOverlayMode(transientWindow, this.hudStateValue.transientLayer === "none" ? "passive" : "interactive");
      transientWindow.setResizable(false);
      transientWindow.webContents.send("overlay:mode", this.hudStateValue.transientLayer === "none" ? "passive" : "interactive");
    }
    this.sendHudState();
  }

  private transition(action: HUDAction): void {
    this.hudStateValue = reduceHUDState(this.hudStateValue, action);
    this.options.onHUDStateChange?.(this.hudStateValue);
    this.sendHudState();
    this.syncPanelVisibility();
    // A lifecycle action such as hide-all, stop, or share-mode can close a
    // transient without going through setTransientLayer(). Keep the native
    // owner in lockstep with the reducer so a stale clickable window cannot
    // remain on screen.
    this.syncTransientWindow();
  }
  private sendHudState(): void { this.sendToWindows("overlay:state", this.hudStateValue); }

  private refreshLayout(_bounds: Electron.Rectangle): void {
    const workArea = this.targetMonitorBounds();
    const display = this.targetDisplay();
    this.hudLayoutValue = { ...calculateHUDLayout(workArea), displayId: display.id, scaleFactor: display.scaleFactor };
    this.currentQuestionWindow?.webContents.send("overlay:layout", this.hudLayoutValue);
    this.currentAnswerWindow?.webContents.send("overlay:layout", this.hudLayoutValue);
    const controlWindow = this.currentControlWindow;
    if (controlWindow) controlWindow.webContents.send("overlay:layout", { ...this.hudLayoutValue, toolbar: { x: 0, y: 0, width: controlWindow.getBounds().width, height: controlWindow.getBounds().height }, shortcuts: { x: 0, y: 0, width: 0, height: 0 } });
    this.syncTransientWindow();
  }
  private sendPanelCommand(command: OverlayPanelCommand): void { this.sendToWindows("overlay:command", command); }
  private sendLayoutEditMode(): void { this.sendToWindows("overlay:layout-edit-mode", this.isLayoutEditMode); }
  private sendToWindows(channel: string, payload: unknown): void { for (const window of this.allWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload); }

  private ensureWindow(panel: OverlayNativePanel): BrowserWindow {
    const existing = this.getWindow(panel);
    if (existing) return existing;
    const bounds = this.nativeBounds(panel);
    const window = new BrowserWindow({ ...bounds, title: panel === "control" ? "Interview Copilot Overlay Controls" : `Interview Copilot ${panel} Overlay`, frame: false, transparent: true, backgroundColor: "#00000000", resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, focusable: false, webPreferences: { preload: this.options.preloadPath ?? join(__dirname, "../preload/index.mjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    this.windows[panel] = window;
    window.setAlwaysOnTop(this.alwaysOnTop, this.alwaysOnTop ? "screen-saver" : undefined);
    const load = Promise.resolve(this.options.loadRenderer(window, panel)).then(() => {
      this.rendererReady.add(panel);
      this.options.onStartupTiming?.(panel === "question" ? "QUESTION_RENDERER_READY" : panel === "answer" ? "ANSWER_RENDERER_READY" : "CONTROL_RENDERER_READY");
    }).catch(() => undefined);
    this.rendererLoads.set(panel, load);
    window.once("ready-to-show", () => { this.applyMode(); this.applyCaptureProtection(); this.sendHudState(); this.sendLayoutEditMode(); this.refreshLayout(window.getBounds()); });
    window.on("closed", () => { if (this.windows[panel] === window) this.windows[panel] = undefined; this.rendererLoads.delete(panel); this.rendererReady.delete(panel); });
    return window;
  }

  private ensureTransientWindow(): BrowserWindow {
    const existing = this.currentTransientWindow;
    if (existing) return existing;
    const owner = this.currentControlWindow ?? this.ensureWindow("control");
    const configuration: BrowserWindowConstructorOptions = { ...this.transientBounds("shortcut"), title: "Interview Copilot Transient", parent: owner, modal: false, frame: false, transparent: true, backgroundColor: "#00000000", resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, focusable: false, acceptFirstMouse: true, webPreferences: { preload: this.options.preloadPath ?? join(__dirname, "../preload/index.mjs"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } };
    const window = new BrowserWindow(configuration);
    this.transientWindowValue = window;
    window.setAlwaysOnTop(this.alwaysOnTop, this.alwaysOnTop ? "screen-saver" : undefined);
    const load = Promise.resolve(this.options.loadRenderer(window, "transient")).then(() => { this.rendererReady.add("transient"); }).catch(() => undefined);
    this.rendererLoads.set("transient", load);
    window.once("ready-to-show", () => { this.syncTransientWindow(); this.applyCaptureProtection(); this.sendHudState(); });
    window.on("closed", () => { if (this.transientWindowValue === window) this.transientWindowValue = undefined; this.rendererLoads.delete("transient"); this.rendererReady.delete("transient"); });
    return window;
  }

  private setTransientLayer(layer: OverlayTransientLayer): void {
    if (layer !== "none") this.ensureTransientWindow();
    this.transition({ type: "set-transient-layer", layer });
    this.syncTransientWindow();
  }

  private syncTransientWindow(): void {
    const window = this.currentTransientWindow;
    if (!window) return;
    const layer = this.hudStateValue.transientLayer;
    if (layer === "none" || this.hudStateValue.shareMode || !this.hudStateValue.running) {
      window.hide();
      return;
    }
    window.setBounds(this.transientBounds(layer), false);
    // The owner relationship keeps the popup out of the app's independent
    // window identity; disabling focus prevents shortcut/confirm from
    // stealing the foreground window underneath it.
    window.setFocusable(false);
    window.setIgnoreMouseEvents(false);
    window.webContents.send("overlay:transient-layer", layer);
    window.showInactive();
  }

  private transientBounds(layer: Exclude<OverlayTransientLayer, "none">): Electron.Rectangle {
    const workArea = this.targetDisplay().workArea;
    if (layer === "end_confirm") {
      const width = 420;
      const height = 170;
      return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height };
    }
    const control = this.currentControlWindow?.getBounds() ?? this.nativeBounds("control");
    const width = 292;
    const height = 250;
    return {
      x: Math.max(workArea.x + 8, Math.min(control.x + control.width - width, workArea.x + workArea.width - width - 8)),
      y: Math.max(workArea.y + 8, Math.min(control.y + control.height + 8, workArea.y + workArea.height - height - 8)),
      width,
      height
    };
  }

  private getWindow(panel: OverlayNativePanel): BrowserWindow | undefined { const window = this.windows[panel]; return window && !window.isDestroyed() ? window : undefined; }
  private allWindows(): BrowserWindow[] { return [...this.currentWindows, ...(this.currentTransientWindow ? [this.currentTransientWindow] : [])]; }

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
    const resolved = resolveOverlayNativeBounds(this.layoutPreferences, { display, defaults: { question: defaults.transcript, answer: defaults.answer, control: defaults.toolbar } }, this.runtimeLayoutMode);
    return panel ? resolved[panel] : resolved;
  }

  private targetDisplay(): OverlayDisplayInfo {
    const activeLeft = this.runtimeLayoutMode === "written_test" ? this.layoutPreferences.writtenTest.questionWindow : this.layoutPreferences.interview.questionWindow;
    const preferredId = activeLeft.displayId;
    const preferred = preferredId === undefined ? undefined : screen.getAllDisplays().find((display) => display.id === preferredId);
    if (preferred) return { id: preferred.id, bounds: { ...preferred.bounds }, workArea: { ...preferred.workArea }, scaleFactor: preferred.scaleFactor };
    const main = this.options.getMainWindow?.();
    const bounds = main && !main.isDestroyed() ? main.getBounds() : undefined;
    const display = bounds ? screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) }) : screen.getPrimaryDisplay();
    return { id: display.id, bounds: { ...display.bounds }, workArea: { ...display.workArea }, scaleFactor: display.scaleFactor };
  }
  private targetMonitorBounds(): Electron.Rectangle { return this.targetDisplay().workArea; }
}

export { OverlayManager as HUDWindowManager };
