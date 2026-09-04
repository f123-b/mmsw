import { describe, expect, it, vi } from "vitest";
import { WrittenTestFocusGuard } from "./written-test-focus-guard";

function setup() {
  const window = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    setFocusable: vi.fn(), hide: vi.fn(), restore: vi.fn(), show: vi.fn(), focus: vi.fn()
  };
  return { window, guard: new WrittenTestFocusGuard(() => window) };
}

describe("written-test focus protection", () => {
  it("disables activation before hiding and blocks repeated app launches", () => {
    const { window, guard } = setup();
    guard.update("WRITTEN_TEST", true);
    expect(window.setFocusable).toHaveBeenCalledWith(false);
    expect(window.setFocusable.mock.invocationCallOrder[0]).toBeLessThan(window.hide.mock.invocationCallOrder[0]);
    expect(guard.revealMainWindow()).toBe(false);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("restores normal activation after ending a session or unwinding a failed start", () => {
    const { window, guard } = setup();
    guard.update("WRITTEN_TEST", true);
    guard.update("IDLE", true);
    expect(window.setFocusable).toHaveBeenLastCalledWith(true);
    expect(window.show).not.toHaveBeenCalled();
    window.isMinimized.mockReturnValue(true);
    expect(guard.revealMainWindow()).toBe(true);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("allows toggling protection mid-session without activating the main window", () => {
    const { window, guard } = setup();
    guard.update("WRITTEN_TEST", true);
    guard.update("WRITTEN_TEST", false);
    expect(window.setFocusable).toHaveBeenLastCalledWith(true);
    expect(window.focus).not.toHaveBeenCalled();
    expect(guard.revealMainWindow()).toBe(true);
    guard.update("WRITTEN_TEST", true);
    expect(guard.revealMainWindow()).toBe(false);
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("leaves interview and idle main windows usable", () => {
    for (const mode of ["INTERVIEW", "IDLE"] as const) {
      const { window, guard } = setup();
      guard.update(mode, true);
      expect(window.setFocusable).toHaveBeenCalledWith(true);
      expect(window.hide).not.toHaveBeenCalled();
      expect(guard.revealMainWindow()).toBe(true);
    }
  });

  it("tolerates missing or destroyed windows during shutdown", () => {
    const missing = new WrittenTestFocusGuard(() => undefined);
    expect(() => missing.update("WRITTEN_TEST", true)).not.toThrow();
    missing.update("IDLE", true);
    expect(missing.revealMainWindow()).toBe(false);
    const { window, guard } = setup();
    window.isDestroyed.mockReturnValue(true);
    guard.update("IDLE", true);
    expect(guard.revealMainWindow()).toBe(false);
    expect(window.setFocusable).not.toHaveBeenCalled();
  });
});
