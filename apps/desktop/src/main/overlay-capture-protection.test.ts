import { describe, expect, it, vi } from "vitest";
import { applyCaptureProtection, getCaptureProtectionCapabilities, type CaptureProtectionWindowLike } from "./overlay-capture-protection";

function makeWindow(): CaptureProtectionWindowLike & { setContentProtection: ReturnType<typeof vi.fn>; isContentProtected: ReturnType<typeof vi.fn> } {
  return { isDestroyed: () => false, setContentProtection: vi.fn(), isContentProtected: vi.fn(() => true) };
}

describe("capture protection", () => {
  it("applies the Windows API for both on and off without changing mode concerns", () => {
    const window = makeWindow();
    expect(applyCaptureProtection(window, false, getCaptureProtectionCapabilities("win32")).osFlagApplied).toBe(true);
    expect(applyCaptureProtection(window, true, getCaptureProtectionCapabilities("win32")).osFlagApplied).toBe(true);
    expect(window.setContentProtection).toHaveBeenNthCalledWith(1, false);
    expect(window.setContentProtection).toHaveBeenNthCalledWith(2, true);
  });

  it("does not call Electron on unsupported platforms", () => {
    const window = makeWindow();
    const result = applyCaptureProtection(window, true, getCaptureProtectionCapabilities("linux"));
    expect(result).toMatchObject({ supported: false, requested: true, osFlagApplied: false, externalCaptureVerified: null, displayCaptureVerified: null, windowCaptureVerified: null });
    expect(window.setContentProtection).not.toHaveBeenCalled();
  });

  it("does not call Electron after the window is destroyed", () => {
    const window = makeWindow();
    window.isDestroyed = () => true;
    applyCaptureProtection(window, true, getCaptureProtectionCapabilities("win32"));
    expect(window.setContentProtection).not.toHaveBeenCalled();
  });

  it("contains API failures and reports them as diagnostics", () => {
    const window = makeWindow();
    window.setContentProtection.mockImplementation(() => { throw new Error("unsupported capture backend"); });
    const diagnostic = vi.fn();
    const result = applyCaptureProtection(window, true, getCaptureProtectionCapabilities("win32"), diagnostic);
    expect(result).toMatchObject({ supported: true, requested: true, osFlagApplied: false, lastError: "Error: unsupported capture backend" });
    expect(diagnostic).toHaveBeenCalledWith("OVERLAY_CAPTURE_PROTECTION_FAILED", expect.objectContaining({ platform: "win32", enabled: true }));
  });

  it("fails closed when Electron reports that the OS flag did not stick", () => {
    const window = makeWindow();
    window.isContentProtected.mockReturnValue(false);
    const diagnostic = vi.fn();
    const result = applyCaptureProtection(window, true, getCaptureProtectionCapabilities("win32"), diagnostic);
    expect(result.osFlagApplied).toBe(false);
    expect(result.lastError).toContain("OS_FLAG_FAILED");
    expect(diagnostic).toHaveBeenCalledWith("CAPTURE_PROTECTION_OS_FLAG_FAILED", expect.objectContaining({ isContentProtected: false }));
  });
});
