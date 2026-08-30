import { describe, expect, it, vi } from "vitest";
import { OverlayZOrderController, type OverlayZOrderWindow } from "./overlay-z-order-controller";

function fakeWindow(): OverlayZOrderWindow & { moveTop: ReturnType<typeof vi.fn>; setAlwaysOnTop: ReturnType<typeof vi.fn> } {
  return { isDestroyed: () => false, isVisible: () => true, moveTop: vi.fn(), setAlwaysOnTop: vi.fn() };
}

describe("OverlayZOrderController", () => {
  it("asserts the native group from content to emergency controls", () => {
    const question = fakeWindow();
    const answer = fakeWindow();
    const control = fakeWindow();
    const transient = fakeWindow();
    const controller = new OverlayZOrderController();
    controller.setWindows({ question, answer, control, transient });
    controller.setRuntimeActive(true);
    controller.assertOverlayZOrder("end-confirm-open");

    expect([question, answer, control, transient].flatMap((window) => window.moveTop.mock.invocationCallOrder)).toEqual(
      expect.arrayContaining([question.moveTop.mock.invocationCallOrder[0], answer.moveTop.mock.invocationCallOrder[0], control.moveTop.mock.invocationCallOrder[0], transient.moveTop.mock.invocationCallOrder[0]])
    );
    expect(question.moveTop.mock.invocationCallOrder[0]).toBeLessThan(answer.moveTop.mock.invocationCallOrder[0]);
    expect(answer.moveTop.mock.invocationCallOrder[0]).toBeLessThan(control.moveTop.mock.invocationCallOrder[0]);
    expect(control.moveTop.mock.invocationCallOrder[0]).toBeLessThan(transient.moveTop.mock.invocationCallOrder[0]);
    expect(question.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(controller.diagnostics.assertCount).toBeGreaterThan(0);
    controller.recordControlClickable();
    controller.recordEndConfirmVisible();
    controller.recordEndConfirmNativeClickPass();
    expect(controller.diagnostics.controlClickableCount).toBe(1);
    expect(controller.diagnostics.endConfirmVisibleCount).toBe(1);
    expect(controller.diagnostics.endConfirmNativeClickPassCount).toBe(1);
  });

  it("never enables the watchdog outside a running session", () => {
    const controller = new OverlayZOrderController({ watchdogIntervalMs: 300 });
    const question = fakeWindow();
    controller.setWindows({ question });
    expect(controller.diagnostics.watchdogRunning).toBe(false);
    controller.setRuntimeActive(true);
    expect(controller.diagnostics.watchdogRunning).toBe(true);
    controller.setRuntimeActive(false);
    expect(controller.diagnostics.watchdogRunning).toBe(false);
    controller.destroy();
  });

  it("reports foreign topmost windows only while runtime is active", () => {
    const diagnostics = vi.fn();
    const controller = new OverlayZOrderController({ onDiagnostic: diagnostics });
    controller.setWindows({ control: fakeWindow() });
    controller.notifyForeignTopmost();
    expect(diagnostics).not.toHaveBeenCalledWith("FOREIGN_TOPMOST_DETECTED", expect.anything());
    controller.setRuntimeActive(true);
    controller.notifyForeignTopmost("regression");
    expect(diagnostics).toHaveBeenCalledWith("FOREIGN_TOPMOST_DETECTED", expect.objectContaining({ reason: "regression" }));
    controller.destroy();
  });
});
