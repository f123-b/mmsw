export type CaptureProtectionPlatform = NodeJS.Platform;

export interface CaptureProtectionCapabilities {
  platform: CaptureProtectionPlatform;
  captureProtectionSupported: boolean;
}

export interface CaptureProtectionWindowLike {
  isDestroyed(): boolean;
  setContentProtection(enabled: boolean): void;
  isContentProtected?: () => boolean;
}

export type CaptureProtectionDiagnostic =
  | "CAPTURE_PROTECTION_REQUESTED"
  | "CAPTURE_PROTECTION_OS_FLAG_ON"
  | "CAPTURE_PROTECTION_OS_FLAG_OFF"
  | "CAPTURE_PROTECTION_OS_FLAG_FAILED"
  | "CAPTURE_PROTECTION_UNSUPPORTED"
  | "CAPTURE_PROTECTION_FAILED"
  | "OVERLAY_CAPTURE_PROTECTION_ENABLED"
  | "OVERLAY_CAPTURE_PROTECTION_DISABLED"
  | "OVERLAY_CAPTURE_PROTECTION_UNSUPPORTED"
  | "OVERLAY_CAPTURE_PROTECTION_FAILED";

export interface CaptureProtectionState {
  platform: CaptureProtectionPlatform;
  supported: boolean;
  requested: boolean;
  osFlagApplied: boolean;
  /** @deprecated renderer compatibility; use requested. */
  enabled: boolean;
  /** @deprecated renderer compatibility; use osFlagApplied. */
  applied: boolean;
  externalCaptureVerified: boolean | null;
  displayCaptureVerified: boolean | null;
  windowCaptureVerified: boolean | null;
  lastError?: string;
}

export function getCaptureProtectionCapabilities(platform: CaptureProtectionPlatform = process.platform): CaptureProtectionCapabilities {
  return { platform, captureProtectionSupported: platform === "win32" };
}

export function applyCaptureProtection(
  window: CaptureProtectionWindowLike | undefined,
  requested: boolean,
  capabilities: CaptureProtectionCapabilities = getCaptureProtectionCapabilities(),
  onDiagnostic?: (event: CaptureProtectionDiagnostic, fields: Record<string, unknown>) => void
): CaptureProtectionState {
  const base: CaptureProtectionState = {
    platform: capabilities.platform,
    supported: capabilities.captureProtectionSupported,
    requested,
    osFlagApplied: false,
    enabled: requested,
    applied: false,
    externalCaptureVerified: null,
    displayCaptureVerified: null,
    windowCaptureVerified: null
  };
  onDiagnostic?.("CAPTURE_PROTECTION_REQUESTED", { platform: capabilities.platform, requested });
  if (!capabilities.captureProtectionSupported) {
    onDiagnostic?.("CAPTURE_PROTECTION_UNSUPPORTED", { platform: capabilities.platform, requested });
    onDiagnostic?.("OVERLAY_CAPTURE_PROTECTION_UNSUPPORTED", { platform: capabilities.platform, enabled: requested });
    return base;
  }
  if (!window || window.isDestroyed()) return base;
  try {
    window.setContentProtection(requested);
    const osFlagApplied = typeof window.isContentProtected === "function" ? window.isContentProtected() : true;
    if (requested && !osFlagApplied) {
      const lastError = "OS_FLAG_FAILED: BrowserWindow.isContentProtected() returned false";
      onDiagnostic?.("CAPTURE_PROTECTION_OS_FLAG_FAILED", { platform: capabilities.platform, requested, isContentProtected: false });
      onDiagnostic?.("OVERLAY_CAPTURE_PROTECTION_FAILED", { platform: capabilities.platform, enabled: requested, error: lastError });
      return { ...base, lastError };
    }
    onDiagnostic?.(requested ? "CAPTURE_PROTECTION_OS_FLAG_ON" : "CAPTURE_PROTECTION_OS_FLAG_OFF", { platform: capabilities.platform, requested, isContentProtected: osFlagApplied });
    onDiagnostic?.(requested ? "OVERLAY_CAPTURE_PROTECTION_ENABLED" : "OVERLAY_CAPTURE_PROTECTION_DISABLED", { platform: capabilities.platform, enabled: requested, isContentProtected: osFlagApplied });
    return { ...base, osFlagApplied, applied: osFlagApplied };
  } catch (error) {
    const lastError = String(error);
    onDiagnostic?.("CAPTURE_PROTECTION_FAILED", { platform: capabilities.platform, requested, error: lastError });
    onDiagnostic?.("OVERLAY_CAPTURE_PROTECTION_FAILED", { platform: capabilities.platform, enabled: requested, error: lastError });
    return { ...base, lastError };
  }
}
