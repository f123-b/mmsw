import { describe, expect, it } from "vitest";
import { calculateHUDLayout } from "./hud-layout";

describe("HUD layout", () => {
  it("keeps the toolbar centered and panels inside a work area", () => {
    const layout = calculateHUDLayout({ x: 100, y: 40, width: 1920, height: 1040 });
    expect(layout.toolbar).toEqual({ x: 620, y: 83, width: 680, height: 58 });
    expect(layout.shortcuts).toEqual({ x: 24, y: 656, width: 320, height: 360 });
    expect(layout.transcript.width).toBe(456);
    expect(layout.answer.width).toBe(872);
    expect(layout.transcript.height).toBe(645);
    expect(layout.transcript.x).toBe(290);
    expect(layout.answer.x).toBe(758);
  });

  it("scales for a smaller display without negative positions", () => {
    const layout = calculateHUDLayout({ x: 0, y: 0, width: 1280, height: 720 });
    expect(layout.toolbar.x).toBe(371);
    expect(layout.toolbar.y).toBe(58);
    expect(layout.shortcuts.x).toBe(24);
    expect(layout.shortcuts.y).toBe(336);
    expect(layout.transcript.height).toBe(446);
    expect(layout.answer.x).toBeGreaterThan(layout.transcript.x + layout.transcript.width);
  });

  it("never lets the toolbar exceed a narrow work area", () => {
    const layout = calculateHUDLayout({ x: 0, y: 0, width: 300, height: 600 });
    expect(layout.toolbar.width).toBe(260);
    expect(layout.toolbar.x).toBe(20);
    expect(layout.toolbar.x + layout.toolbar.width).toBeLessThanOrEqual(300);
  });
});
