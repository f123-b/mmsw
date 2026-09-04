import { describe, expect, it, vi } from "vitest";
import { applyOverlayMode, nextOverlayMode, type OverlayWindowLike } from "./overlay-mode";

describe("applyOverlayMode", () => {
  function makeWindow(): OverlayWindowLike {
    return {
      isDestroyed: () => false,
      isFocusable: () => true,
      setFocusable: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      webContents: { send: vi.fn() }
    };
  }

  it("sets the real BrowserWindow controls for passive mode", () => {
    const window = makeWindow();
    applyOverlayMode(window, "passive");
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  });

  it("makes a bounded native panel interactive in interactive mode", () => {
    const window = makeWindow();
    applyOverlayMode(window, "interactive");
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: true });
  });

  it("keeps a passive native panel click-through", () => {
    const window = makeWindow();
    applyOverlayMode(window, "passive");
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  });

  it("toggles mode for the passive recovery shortcut", () => {
    expect(nextOverlayMode("interactive")).toBe("passive");
    expect(nextOverlayMode("passive")).toBe("interactive");
  });
});
