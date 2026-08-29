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
  it("makes a bounded native panel interactive in interactive mode", () => {
    const window = fakeWindow();
    applyOverlayMode(window, "interactive");
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(false, { forward: true });
  });

  it("keeps a passive native panel click-through", () => {
    const window = fakeWindow();
    applyOverlayMode(window, "passive");
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
  });
});
