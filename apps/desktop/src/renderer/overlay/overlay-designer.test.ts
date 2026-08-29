import { describe, expect, it } from "vitest";
import { ANSWER_DESIGNER_BOUNDS, clampDesignerRect, controlBarPosition, interactionModeAllowsOverlayInput, mapPreviewPointToCanvas, modifierPressed, resizeDesignerRect, snapDesignerRect, wheelTargetAtPoint, type DesignerLayout } from "./overlay-designer";

const canvas = { width: 1920, height: 1080 };
const layout: DesignerLayout = {
  question: { x: 120, y: 180, width: 430, height: 500 },
  answer: { x: 570, y: 180, width: 680, height: 500 },
  controlBar: { x: 620, y: 24, width: 680, height: 50 }
};

describe("overlay designer geometry", () => {
  it("keeps both requested panel ranges and a visible safe area", () => {
    expect(clampDesignerRect({ x: -900, y: -900, width: 1, height: 1 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ x: -260, y: -110, width: 300, height: 150 });
    expect(clampDesignerRect({ x: 9_999, y: 9_999, width: 3_000, height: 3_000 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ x: 1_880, y: 1_040, width: 1_600, height: 1_080 });
  });

  it("snaps to the screen and neighboring windows, with Alt as an escape hatch", () => {
    expect(snapDesignerRect("answer", { ...layout.answer, x: 1_235, y: 186 }, layout, canvas, 12)).toMatchObject({ x: 1_240, y: 180 });
    expect(snapDesignerRect("answer", { ...layout.answer, x: 1_235, y: 186 }, layout, canvas, 12, true)).toMatchObject({ x: 1_235, y: 186 });
  });

  it("resizes from all edges without violating limits", () => {
    expect(resizeDesignerRect(layout.answer, "nw", { x: -200, y: -200 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ width: 880, height: 700, x: 370, y: -20 });
    expect(resizeDesignerRect(layout.answer, "se", { x: -900, y: -900 }, canvas, ANSWER_DESIGNER_BOUNDS)).toMatchObject({ width: 300, height: 150 });
  });

  it("maps preview pixels and control bar presets to logical display coordinates", () => {
    expect(mapPreviewPointToCanvas({ x: 360, y: 202.5 }, { width: 720, height: 405 }, canvas)).toEqual({ x: 960, y: 540 });
    expect(controlBarPosition("bottom_center", "horizontal", canvas, { width: 680, height: 50 })).toEqual({ x: 620, y: 1006 });
    expect(controlBarPosition("top_center", "vertical", canvas, { width: 50, height: 260 })).toEqual({ x: 18, y: 410 });
  });

  it("routes wheel and protects the full passthrough escape path", () => {
    expect(wheelTargetAtPoint({ x: 200, y: 200 }, layout, "overlay_under_cursor")).toBe("question");
    expect(wheelTargetAtPoint({ x: 700, y: 200 }, layout, "overlay_under_cursor")).toBe("answer");
    expect(wheelTargetAtPoint({ x: 20, y: 20 }, layout, "dual")).toBe("underlying_app");
    expect(interactionModeAllowsOverlayInput("full_passthrough", false, false)).toBe(false);
    expect(interactionModeAllowsOverlayInput("full_passthrough", true, false)).toBe(true);
    expect(interactionModeAllowsOverlayInput("click_through", false, true)).toBe(true);
    expect(modifierPressed("ctrl_shift", { ctrlKey: true, altKey: false, shiftKey: true })).toBe(true);
  });
});
