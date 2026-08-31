import { describe, expect, it } from "vitest";
import { clampMainWindowBounds, resolveMainWindowBounds } from "./main-window-bounds";

describe("main window bounds", () => {
  it("uses a compact default and preserves a valid user position", () => {
    expect(resolveMainWindowBounds(undefined, { x: 0, y: 0, width: 1920, height: 1080 })).toMatchObject({ width: 1200, height: 780 });
    expect(resolveMainWindowBounds({ x: 300, y: 120, width: 1100, height: 700 }, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({ x: 300, y: 120, width: 1100, height: 700 });
  });

  it("keeps an off-screen saved window recoverable", () => {
    expect(clampMainWindowBounds({ x: -2400, y: 1800, width: 1600, height: 900 }, { x: -1920, y: 0, width: 1920, height: 1080 })).toEqual({ x: -2400, y: 1000, width: 1600, height: 900 });
  });
});
