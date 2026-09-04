import { describe, expect, it } from "vitest";
import { nativeGestureBounds } from "./native-window-gesture";
describe("teleprompter native geometry", () => {
  const origin = { x: -1000, y: 120, width: 360, height: 420 };
  it("moves using absolute screen deltas (including negative monitor coordinates)", () => expect(nativeGestureBounds(origin, "move", 150, 35)).toEqual({ ...origin, x: -850, y: 155 }));
  it("resizes without being clamped to its own renderer viewport", () => expect(nativeGestureBounds(origin, "se", 180, 140)).toEqual({ ...origin, width: 540, height: 560 }));
  it("keeps the far edge fixed at minimum size", () => expect(nativeGestureBounds(origin, "nw", 500, 500)).toEqual({ x: -920, y: 360, width: 280, height: 180 }));
});
