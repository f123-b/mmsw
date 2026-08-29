import { describe, expect, it } from "vitest";
import { selectPrimaryScreenSource } from "./screen-source-selection";
import { createScreenshotFixtureResult, mapScreenshotRegion, ScreenshotManager } from "./screenshot-manager";

describe("selectPrimaryScreenSource", () => {
  const sources = [
    { id: "screen-2", display_id: "2" },
    { id: "screen-1", display_id: "1" },
    { id: "screen-3", display_id: "3" }
  ];

  it("matches the primary display regardless of source order", () => {
    expect(selectPrimaryScreenSource(sources, 1)?.id).toBe("screen-1");
  });

  it("falls back to the first source when no primary source matches", () => {
    expect(selectPrimaryScreenSource(sources, 9)?.id).toBe("screen-2");
  });
});

describe("screenshot fixture", () => {
  it("maps a configured display region onto the captured thumbnail", () => {
    expect(mapScreenshotRegion({ x: 100, y: 50, width: 800, height: 500 }, { width: 1_280, height: 720 }, { width: 1_920, height: 1_080 })).toEqual({ x: 66, y: 33, width: 533, height: 333 });
  });

  it("is a non-empty valid PNG image for deterministic pipeline tests", () => {
    const result = createScreenshotFixtureResult();
    expect(result.mimeType).toBe("image/png");
    expect(result.bytes.byteLength).toBeGreaterThan(8);
    expect([...result.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  });

  it("propagates capture errors instead of returning an empty image", async () => {
    const manager = new ScreenshotManager({ captureFixture: async () => { throw new Error("CAPTURE_FAILED"); } });
    await expect(manager.capturePrimaryDisplay()).rejects.toThrow("CAPTURE_FAILED");
  });
});
