import { describe, expect, it } from "vitest";
import { calculateHUDLayout } from "./hud-layout";

describe("HUD layout", () => {
  it("keeps the toolbar centered and panels inside a work area", () => {
    const layout = calculateHUDLayout({ x: 100, y: 40, width: 1920, height: 1040 });
    expect(layout.toolbar).toEqual({ x: 810, y: 20, width: 300, height: 42 });
    expect(layout.shortcuts).toEqual({ x: 24, y: 656, width: 320, height: 360 });
    expect(layout.transcript.width).toBe(538);
    expect(layout.answer.width).toBe(806);
    expect(layout.transcript.height).toBe(676);
    expect(layout.transcript.x).toBe(96);
    expect(layout.answer.x).toBe(674);
  });

  it("scales for a smaller display without negative positions", () => {
    const layout = calculateHUDLayout({ x: 0, y: 0, width: 1280, height: 720 });
    expect(layout.toolbar.x).toBe(490);
    expect(layout.toolbar.y).toBe(20);
    expect(layout.shortcuts.x).toBe(24);
    expect(layout.shortcuts.y).toBe(336);
    expect(layout.transcript.height).toBe(468);
    expect(layout.answer.x).toBeGreaterThan(layout.transcript.x + layout.transcript.width);
  });
});
