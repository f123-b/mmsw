import { describe, expect, it, vi } from "vitest";
import { applyOverlayMode, type OverlayWindowLike } from "./overlay-mode";

function fakeWindow(): OverlayWindowLike & { setFocusable: ReturnType<typeof vi.fn>; setIgnoreMouseEvents: ReturnType<typeof vi.fn> } {
  return {
    isDestroyed: () => false,
    setFocusable: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    webContents: { send: vi.fn() }
  };
}

describe("applyOverlayMode", () => {
  it("keeps the transparent fullscreen background click-through even in interactive mode", () => {
    const window = fakeWindow();
    applyOverlayMode(window, "interactive", false);
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  });

  it("claims mouse input only while the renderer reports a concrete HUD hit region", () => {
    const window = fakeWindow();
    applyOverlayMode(window, "passive", true);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: true });
  });
});
