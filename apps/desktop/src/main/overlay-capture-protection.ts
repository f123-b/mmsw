export type CaptureProtectionPlatform = NodeJS.Platform;

export interface CaptureProtectionCapabilities {
  platform: CaptureProtectionPlatform;
  captureProtectionSupported: boolean;
}

export interface CaptureProtectionWindowLike {
  isDestroyed(): boolean;
  setContentProtection(enabled: boolean): void;
}

export type CaptureProtectionDiagnostic =
  | "OVERLAY_CAPTURE_PROTECTION_ENABLED"
  | "OVERLAY_CAPTURE_PROTECTION_DISABLED"
  | "OVERLAY_CAPTURE_PROTECTION_UNSUPPORTED"
  | "OVERLAY_CAPTURE_PROTECTION_FAILED";

export interface CaptureProtectionState {
  platform: CaptureProtectionPlatform;
  supported: boolean;
  enabled: boolean;
  applied: boolean;
  error?: string;
}

export function getCaptureProtectionCapabilities(platform: CaptureProtectionPlatform = process.platform): CaptureProtectionCapabilities {
  return { platform, captureProtectionSupported: platform === "win32" };
}

export function applyCaptureProtection(
  window: CaptureProtectionWindowLike | undefined,
  enabled: boolean,
  capabilities: CaptureProtectionCapabilities = getCaptureProtectionCapabilities(),
  onDiagnostic?: (event: CaptureProtectionDiagnostic, fields: Record<string, unknown>) => void
): CaptureProtectionState {
  const base = { platform: capabilities.platform, supported: capabilities.captureProtectionSupported, enabled, applied: false };
  if (!capabilities.captureProtectionSupported) {
    onDiagnostic?.("OVERLAY_CAPTURE_PROTECTION_UNSUPPORTED", { platform: capabilities.platform, enabled });
    return base;
  }
  if (!window || window.isDestroyed()) return base;
  try {
    window.setContentProtection(enabled);
    onDiagnostic?.(enabled ? "OVERLAY_CAPTURE_PROTECTION_ENABLED" : "OVERLAY_CAPTURE_PROTECTION_DISABLED", { platform: capabilities.platform, enabled });
    return { ...base, applied: true };
  } catch (error) {
    const message = String(error);
    onDiagnostic?.("OVERLAY_CAPTURE_PROTECTION_FAILED", { platform: capabilities.platform, enabled, error: message });
    return { ...base, error: message };
  }
}
