import { describe, expect, it } from "vitest";
import { ANSWER_DESIGNER_BOUNDS, applyLayoutPreset, clampDesignerRect, controlBarPosition, interactionModeAllowsOverlayInput, mapPreviewPointToCanvas, modifierPressed, overlayHitRegionAllowsInput, resizeDesignerRect, resizeDesignerRectFromPointer, snapDesignerRect, wheelTargetAtPoint, type DesignerLayout } from "./overlay-designer";

const canvas = { width: 1920, height: 1080 };
const layout: DesignerLayout = {
  question: { x: 120, y: 180, width: 430, height: 500 },
  answer: { x: 570, y: 180, width: 680, height: 500 },
  controlBar: { x: 620, y: 24, width: 680, height: 58 }
};

describe("overlay designer geometry", () => {
  it("keeps both requested panel ranges and a visible safe area", () => {
    expect(clampDesignerRect({ x: -900, y: -900, width: 1, height: 1 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ x: -440, y: -92, width: 480, height: 132 });
    expect(clampDesignerRect({ x: 9_999, y: 9_999, width: 3_000, height: 3_000 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ x: 1_880, y: 1_040, width: 1_000, height: 440 });
  });

  it("snaps to the screen and neighboring windows, with Alt as an escape hatch", () => {
    expect(snapDesignerRect("answer", { ...layout.answer, x: 1_235, y: 186 }, layout, canvas, 12)).toMatchObject({ x: 1_240, y: 180 });
    expect(snapDesignerRect("answer", { ...layout.answer, x: 1_235, y: 186 }, layout, canvas, 12, true)).toMatchObject({ x: 1_235, y: 186 });
  });

  it("resizes from all edges without violating limits", () => {
    expect(resizeDesignerRect(layout.answer, "nw", { x: -200, y: -200 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ width: 880, height: 440, x: 370, y: 240 });
    expect(resizeDesignerRect(layout.answer, "se", { x: -900, y: -900 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ width: 480, height: 132 });
  });

  it("always applies preview resize delta to the pointer-down rectangle", () => {
    const start = layout.answer;
    const first = resizeDesignerRectFromPointer(start, "se", { x: 100, y: 100 }, { x: 110, y: 120 }, { width: 500, height: 250 }, canvas, ANSWER_DESIGNER_BOUNDS);
    const second = resizeDesignerRectFromPointer(start, "se", { x: 100, y: 100 }, { x: 120, y: 140 }, { width: 500, height: 250 }, canvas, ANSWER_DESIGNER_BOUNDS);
    expect(first.width).toBeCloseTo(start.width + 38.4);
    expect(second.width).toBeCloseTo(start.width + 76.8);
    expect(second.width).toBeLessThan(first.width + 76.8);
  });

  it("maps preview pixels and control bar presets to logical display coordinates", () => {
    expect(mapPreviewPointToCanvas({ x: 360, y: 202.5 }, { width: 720, height: 405 }, canvas)).toEqual({ x: 960, y: 540 });
    expect(controlBarPosition("bottom_center", "horizontal", canvas, { width: 680, height: 58 })).toEqual({ x: 620, y: 998 });
    expect(controlBarPosition("top_center", "vertical", canvas, { width: 50, height: 260 })).toEqual({ x: 18, y: 410 });
  });

  it("routes wheel and protects the full passthrough escape path", () => {
    expect(wheelTargetAtPoint({ x: 200, y: 200 }, layout, "overlay_under_cursor")).toBe("question");
    expect(wheelTargetAtPoint({ x: 700, y: 200 }, layout, "overlay_under_cursor")).toBe("answer");
    expect(wheelTargetAtPoint({ x: 20, y: 20 }, layout, "dual")).toBe("underlying_app");
    expect(interactionModeAllowsOverlayInput("full_passthrough", false, false)).toBe(false);
    expect(interactionModeAllowsOverlayInput("full_passthrough", true, false)).toBe(true);
    expect(interactionModeAllowsOverlayInput("click_through", false, true)).toBe(true);
    expect(interactionModeAllowsOverlayInput("interactive", false, true, false)).toBe(false);
    expect(modifierPressed("ctrl_shift", { ctrlKey: true, altKey: false, shiftKey: true })).toBe(true);
  });

  it("resolves visibly different geometry for named presets", () => {
    const display = { id: 1, workArea: canvas, scaleFactor: 1 };
    const compact = applyLayoutPreset("compact", display);
    const standard = applyLayoutPreset("standard", display);
    const wide = applyLayoutPreset("wide", display);
    expect(compact.questionWindow).not.toEqual(standard.questionWindow);
    expect(standard.answerWindow).not.toEqual(wide.answerWindow);
    expect(compact.controlBar).not.toEqual(standard.controlBar);
  });

  it("retains per-monitor scale metadata for a 125% display", () => {
    const layout = applyLayoutPreset("standard", { id: 2, workArea: { width: 2560, height: 1440 }, scaleFactor: 1.25 });
    expect(layout.scaleFactor).toBe(1.25);
    expect(layout.controlBar.width).toBe(440);
    expect(layout.controlBar.height).toBe(44);
  });

  it("keeps control-bar hit testing independent from content passthrough", () => {
    expect(overlayHitRegionAllowsInput("control_bar", "full_passthrough", false)).toBe(true);
    expect(overlayHitRegionAllowsInput("content", "full_passthrough", true)).toBe(false);
    expect(overlayHitRegionAllowsInput("background", "interactive", true)).toBe(false);
  });
});
