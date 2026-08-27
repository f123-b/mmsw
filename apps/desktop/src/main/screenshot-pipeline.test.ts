import { describe, expect, it } from "vitest";
import { ScreenshotOperationRegistry, ScreenshotTraceBuffer, withScreenshotTimeout } from "./screenshot-pipeline";

describe("ScreenshotOperationRegistry", () => {
  it("enforces one active operation and releases it on completion", () => {
    const registry = new ScreenshotOperationRegistry(() => 100);
    const operation = registry.begin("screenshot-1", "session-1");
    expect(registry.diagnostics()).toMatchObject({ activeScreenshotOperations: 1, activeAbortControllers: 1, lastScreenshotState: "capturing" });
    expect(() => registry.begin("screenshot-2")).toThrow("SCREENSHOT_BUSY");
    registry.transition("screenshot-1", "provider_pending", "provider-1");
    registry.finish("screenshot-1", "completed");
    expect(operation.controller.signal.aborted).toBe(false);
    expect(registry.diagnostics()).toMatchObject({ activeScreenshotOperations: 0, activeAbortControllers: 0, lastScreenshotState: "completed", lastScreenshotRequestId: "screenshot-1" });
    expect(registry.elapsedMs("screenshot-1")).toBe(0);
  });

  it("aborts every active operation", () => {
    const registry = new ScreenshotOperationRegistry();
    const operation = registry.begin("screenshot-1");
    registry.abortAll();
    expect(operation.controller.signal.aborted).toBe(true);
    registry.finish("screenshot-1", "cancelled", "aborted");
    expect(registry.diagnostics().activeScreenshotOperations).toBe(0);
  });

  it("bounds a hanging vision task and leaves abort ownership explicit", async () => {
    const registry = new ScreenshotOperationRegistry();
    const operation = registry.begin("screenshot-hang");
    await expect(withScreenshotTimeout(new Promise<void>(() => undefined), 10, () => operation.controller.abort())).rejects.toThrow("timed out");
    expect(operation.controller.signal.aborted).toBe(true);
    registry.finish("screenshot-hang", "cancelled", "timeout");
    expect(registry.diagnostics()).toMatchObject({ activeScreenshotOperations: 0, activeAbortControllers: 0, lastScreenshotState: "cancelled" });
  });
});

describe("ScreenshotTraceBuffer", () => {
  it("keeps a bounded recent trace", () => {
    const buffer = new ScreenshotTraceBuffer(2);
    const base = { timestamp: 1, elapsedMs: 0, screenshotRequestId: "screenshot-1" } as const;
    buffer.push({ ...base, name: "SCREENSHOT_ACTION_REQUESTED" });
    buffer.push({ ...base, name: "SCREENSHOT_CAPTURE_STARTED" });
    buffer.push({ ...base, name: "SCREENSHOT_PIPELINE_COMPLETED" });
    expect(buffer.snapshot(10).map((event) => event.name)).toEqual(["SCREENSHOT_CAPTURE_STARTED", "SCREENSHOT_PIPELINE_COMPLETED"]);
  });
});
