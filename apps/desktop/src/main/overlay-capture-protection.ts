import { release as osRelease } from "node:os";

export type CaptureProtectionPlatform = NodeJS.Platform;
export type CaptureProtectionHealth = "DISABLED" | "PROTECTED" | "PARTIALLY_PROTECTED" | "FAILED" | "UNSUPPORTED";
export type CaptureProtectionPanel = "main" | "question" | "answer" | "script" | "control" | "transient";
export type CaptureProtectionScope = "overlays" | "application";
export type CaptureProtectionOsMode = "exclude_from_capture" | "monitor_blackout" | "unsupported";
export type DisplayAffinityName = "WDA_NONE" | "WDA_MONITOR" | "WDA_EXCLUDEFROMCAPTURE" | "UNKNOWN";

export interface CaptureProtectionCapabilities {
  platform: CaptureProtectionPlatform;
  captureProtectionSupported: boolean;
  windowsBuild: number | null;
  requestedAffinity: Exclude<DisplayAffinityName, "UNKNOWN">;
  osMode: CaptureProtectionOsMode;
  windowsVersion?: string;
  reason?: string;
}
export interface NativeAffinityResult { ok: boolean; affinity: number | null; affinityName: DisplayAffinityName; lastError?: number; error?: string; }
export interface CaptureProtectionWindowLike {
  isDestroyed(): boolean;
  setContentProtection(enabled: boolean): void;
  isContentProtected?: () => boolean;
  getNativeWindowHandle?: () => Buffer;
  hide?: () => void;
}
export interface CaptureProtectionWindowState {
  panel: CaptureProtectionPanel;
  registered: boolean;
  requested: boolean;
  apiCallSucceeded: boolean;
  osFlagApplied: boolean;
  affinity: number | null;
  affinityName: DisplayAffinityName;
  active: boolean;
  protectionActive: boolean;
  electronReportedProtected: boolean;
  lastError?: string;
  updatedAt: string;
}
export interface CaptureProtectionState {
  platform: CaptureProtectionPlatform;
  supported: boolean;
  requested: boolean;
  scope: CaptureProtectionScope;
  health: CaptureProtectionHealth;
  windows: CaptureProtectionWindowState[];
  fullyProtected: boolean;
  partiallyProtected: boolean;
  apiApplied: boolean;
  failClosed: boolean;
  osFlagApplied: boolean;
  enabled: boolean;
  applied: boolean;
  externalCaptureVerified: boolean | null;
  displayCaptureVerified: boolean | null;
  windowCaptureVerified: boolean | null;
  lastError?: string;
}
export type CaptureProtectionDiagnostic = string;

function windowsBuildNumber(value: string): number | null {
  const build = Number(value.split(".")[2]);
  return Number.isInteger(build) ? build : null;
}
export function affinityName(value: number | null): DisplayAffinityName {
  if (value === 0) return "WDA_NONE";
  if (value === 1) return "WDA_MONITOR";
  if (value === 0x11) return "WDA_EXCLUDEFROMCAPTURE";
  return "UNKNOWN";
}
export function getCaptureProtectionCapabilities(platform: CaptureProtectionPlatform = process.platform, release = platform === process.platform ? osRelease() : "10.0.19045"): CaptureProtectionCapabilities {
  if (platform !== "win32") return { platform, captureProtectionSupported: false, windowsBuild: null, requestedAffinity: "WDA_NONE", osMode: "unsupported", reason: "Capture exclusion is Windows-only" };
  const build = windowsBuildNumber(release);
  if (build === null) return { platform, captureProtectionSupported: false, windowsBuild: null, requestedAffinity: "WDA_NONE", osMode: "unsupported", windowsVersion: release, reason: `Unable to determine Windows build from ${release}` };
  if (build < 17763) return { platform, captureProtectionSupported: false, windowsBuild: build, requestedAffinity: "WDA_NONE", osMode: "unsupported", windowsVersion: release, reason: "Windows build predates supported display affinity" };
  return { platform, captureProtectionSupported: true, windowsBuild: build, requestedAffinity: build >= 19041 ? "WDA_EXCLUDEFROMCAPTURE" : "WDA_MONITOR", osMode: build >= 19041 ? "exclude_from_capture" : "monitor_blackout", windowsVersion: release };
}

export interface CaptureProtectionManagerOptions {
  requested?: boolean;
  scope?: CaptureProtectionScope;
  capabilities?: CaptureProtectionCapabilities;
  verifyNativeAffinity?: (window: CaptureProtectionWindowLike) => NativeAffinityResult;
  onDiagnostic?: (event: CaptureProtectionDiagnostic, fields: Record<string, unknown>) => void;
  onFailClosed?: (state: CaptureProtectionState) => void;
}

export class CaptureProtectionManager {
  private readonly entries = new Map<CaptureProtectionPanel, CaptureProtectionWindowLike>();
  private readonly windowStates = new Map<CaptureProtectionPanel, CaptureProtectionWindowState>();
  private requested: boolean;
  private scope: CaptureProtectionScope;
  private displayCaptureVerified: boolean | null = null;
  private windowCaptureVerified: boolean | null = null;
  readonly capabilities: CaptureProtectionCapabilities;

  constructor(private readonly options: CaptureProtectionManagerOptions = {}) {
    this.requested = options.requested ?? true;
    this.scope = options.scope ?? "application";
    this.capabilities = options.capabilities ?? getCaptureProtectionCapabilities();
  }
  register(panel: CaptureProtectionPanel, window: CaptureProtectionWindowLike): CaptureProtectionState { this.entries.set(panel, window); return this.protectWindow(panel); }
  unregister(panel: CaptureProtectionPanel): CaptureProtectionState { this.entries.delete(panel); this.windowStates.delete(panel); return this.evaluate(); }
  setRequested(requested: boolean): CaptureProtectionState { this.requested = Boolean(requested); return this.protectAll(); }
  setScope(scope: CaptureProtectionScope): CaptureProtectionState { this.scope = scope; return this.protectAll(); }
  protectAll(): CaptureProtectionState { for (const panel of this.entries.keys()) this.apply(panel); return this.evaluateAndClose(); }
  protectWindow(panel: CaptureProtectionPanel): CaptureProtectionState { this.apply(panel); return this.evaluateAndClose(); }
  canShow(panel: CaptureProtectionPanel): boolean { return !this.requested || this.protectWindow(panel).health === "PROTECTED"; }
  recordExternalVerification(mode: "window" | "display", verified: boolean): CaptureProtectionState {
    if (mode === "window") this.windowCaptureVerified = verified; else this.displayCaptureVerified = verified;
    return this.evaluate();
  }
  get state(): CaptureProtectionState { return this.evaluate(); }
  private required(panel: CaptureProtectionPanel): boolean { return this.scope === "application" || panel !== "main"; }
  private apply(panel: CaptureProtectionPanel): void {
    const window = this.entries.get(panel);
    const updatedAt = new Date().toISOString();
    const base: CaptureProtectionWindowState = { panel, registered: Boolean(window), requested: this.requested && this.required(panel), apiCallSucceeded: false, osFlagApplied: false, affinity: null, affinityName: "UNKNOWN", active: false, protectionActive: false, electronReportedProtected: false, updatedAt };
    if (!window || window.isDestroyed()) { this.windowStates.set(panel, { ...base, lastError: "Window is unavailable" }); return; }
    if (!base.requested) {
      try { window.setContentProtection(false); this.windowStates.set(panel, { ...base, apiCallSucceeded: true, affinity: 0, affinityName: "WDA_NONE" }); }
      catch (error) { this.windowStates.set(panel, { ...base, lastError: String(error) }); }
      return;
    }
    if (!this.capabilities.captureProtectionSupported) { this.windowStates.set(panel, { ...base, lastError: this.capabilities.reason ?? "Unsupported platform" }); return; }
    try {
      window.setContentProtection(true);
      const osFlagApplied = window.isContentProtected?.() ?? true;
      if (!osFlagApplied) { this.windowStates.set(panel, { ...base, apiCallSucceeded: true, lastError: "BrowserWindow.isContentProtected() returned false" }); return; }
      const native = this.options.verifyNativeAffinity?.(window);
      if (!native) { this.windowStates.set(panel, { ...base, apiCallSucceeded: true, osFlagApplied: true, lastError: "Native display affinity was not verified" }); return; }
      const active = native.ok && native.affinityName === this.capabilities.requestedAffinity;
      this.windowStates.set(panel, { ...base, apiCallSucceeded: true, osFlagApplied: true, electronReportedProtected: true, affinity: native.affinity, affinityName: native.affinityName, active, protectionActive: active, ...(active ? {} : { lastError: native.error ?? `Expected ${this.capabilities.requestedAffinity}, received ${native.affinityName}` }) });
    } catch (error) { this.windowStates.set(panel, { ...base, lastError: String(error) }); }
  }
  private evaluateAndClose(): CaptureProtectionState {
    const state = this.evaluate();
    if (state.failClosed) {
      for (const [panel, window] of this.entries) if (this.required(panel) && !window.isDestroyed()) window.hide?.();
      this.options.onDiagnostic?.("CAPTURE_PROTECTION_FAIL_CLOSED", { health: state.health, failedPanels: state.windows.filter((entry) => entry.requested && !entry.active).map((entry) => entry.panel) });
      this.options.onFailClosed?.(state);
    }
    return state;
  }
  private evaluate(): CaptureProtectionState {
    const windows = [...this.windowStates.values()];
    const required = windows.filter((entry) => entry.requested);
    const protectedCount = required.filter((entry) => entry.active).length;
    const fullyProtected = this.requested && required.length > 0 && protectedCount === required.length;
    const partiallyProtected = this.requested && required.length > 0 && protectedCount > 0 && !fullyProtected;
    const health: CaptureProtectionHealth = !this.requested ? "DISABLED" : !this.capabilities.captureProtectionSupported ? "UNSUPPORTED" : fullyProtected ? "PROTECTED" : partiallyProtected ? "PARTIALLY_PROTECTED" : "FAILED";
    const failClosed = this.requested && health !== "PROTECTED";
    const lastError = windows.find((entry) => entry.requested && !entry.active)?.lastError;
    return { platform: this.capabilities.platform, supported: this.capabilities.captureProtectionSupported, requested: this.requested, scope: this.scope, health, windows, fullyProtected, partiallyProtected, apiApplied: required.length > 0 && required.every((entry) => entry.apiCallSucceeded), failClosed, osFlagApplied: fullyProtected, enabled: this.requested, applied: fullyProtected, externalCaptureVerified: this.windowCaptureVerified === null || this.displayCaptureVerified === null ? null : this.windowCaptureVerified && this.displayCaptureVerified, displayCaptureVerified: this.displayCaptureVerified, windowCaptureVerified: this.windowCaptureVerified, ...(lastError ? { lastError } : {}) };
  }
}

/** Single-window compatibility helper. Prefer CaptureProtectionManager for production windows. */
export function applyCaptureProtection(window: CaptureProtectionWindowLike | undefined, requested: boolean, capabilities = getCaptureProtectionCapabilities(), onDiagnostic?: (event: CaptureProtectionDiagnostic, fields: Record<string, unknown>) => void): CaptureProtectionState {
  const manager = new CaptureProtectionManager({ requested, scope: "overlays", capabilities, verifyNativeAffinity: () => ({ ok: true, affinity: capabilities.requestedAffinity === "WDA_EXCLUDEFROMCAPTURE" ? 0x11 : capabilities.requestedAffinity === "WDA_MONITOR" ? 1 : 0, affinityName: capabilities.requestedAffinity }), onDiagnostic });
  if (window) manager.register("question", window);
  return manager.state;
}
