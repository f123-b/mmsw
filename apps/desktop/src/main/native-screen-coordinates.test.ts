import { describe, expect, it } from "vitest";
import { isInsideOverlayContent, normalizeNativeScreenPoint } from "./native-screen-coordinates";

describe("native screen coordinate normalization", () => {
  it("supports display scale factors and negative virtual-screen origins", () => {
    expect(normalizeNativeScreenPoint({ x: -1500, y: 300 }, { scaleFactor: 1.5 })).toEqual({ x: -1000, y: 200 });
    expect(normalizeNativeScreenPoint({ x: 1500, y: 750 }, { screenToDipPoint: (point) => ({ x: point.x / 1.25, y: point.y / 1.25 }) })).toEqual({ x: 1200, y: 600 });
  });

  it("does not route transparent overlay edges", () => {
    const bounds = { x: 100, y: 80, width: 400, height: 300 };
    expect(isInsideOverlayContent({ x: 300, y: 200 }, bounds)).toBe(true);
    expect(isInsideOverlayContent({ x: 101, y: 200 }, bounds)).toBe(false);
  });
});

