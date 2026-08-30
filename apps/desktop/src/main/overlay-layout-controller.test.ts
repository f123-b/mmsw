import { describe, expect, it } from "vitest";
import { clampOverlayBounds, contentDrivenHeight, resolveOverlayNativeBounds, type OverlayNativeBounds } from "./overlay-layout-controller";

const workArea: OverlayNativeBounds = { x: -1920, y: 0, width: 1920, height: 1040 };
const display = { workArea };
const defaults = {
  question: { x: -1800, y: 120, width: 760, height: 360 },
  answer: { x: -1000, y: 120, width: 860, height: 520 },
  control: { x: -1700, y: 24, width: 420, height: 48 }
};

describe("OverlayLayoutController", () => {
  it("clamps every native panel into a negative-origin work area", () => {
    const bounds = resolveOverlayNativeBounds({
      questionWindow: { x: -4000, y: -100, width: 4000, height: 2000 },
      answerWindow: { x: 1800, y: 900, width: 20, height: 20 },
      controlBar: { x: 900, y: -50, width: 1000, height: 10 }
    }, { display, defaults });

    expect(bounds.question).toEqual({ x: -1920, y: 0, width: 1920, height: 1040 });
    expect(bounds.answer).toEqual({ x: -300, y: 900, width: 300, height: 132 });
    expect(bounds.control).toEqual({ x: -1020, y: 0, width: 1000, height: 36 });
  });

  it("uses persisted work-area-relative positions without leaking display coordinates", () => {
    const bounds = resolveOverlayNativeBounds({
      questionWindow: { x: 80, y: 120, width: 760, height: 360 },
      answerWindow: { x: 960, y: 160, width: 860, height: 520 },
      controlBar: { x: 32, y: 24, width: 420, height: 48 }
    }, { display, defaults });

    expect(bounds.question.x).toBe(-1840);
    expect(bounds.question.y).toBe(120);
    expect(bounds.answer.x).toBe(-960);
    expect(bounds.control.x).toBe(-1888);
  });

  it("rounds and clamps direct native bounds to minimum panel sizes", () => {
    expect(clampOverlayBounds({ x: -500, y: 500, width: 220.4, height: 119.6 }, workArea, 220, 120)).toEqual({
      x: -500,
      y: 500,
      width: 220,
      height: 120
    });
  });

  it("clamps measured runtime content instead of preserving legacy panel heights", () => {
    expect(contentDrivenHeight("question", 62)).toBe(88);
    expect(contentDrivenHeight("question", 181)).toBe(181);
    expect(contentDrivenHeight("question", 1_000)).toBe(280);
    expect(contentDrivenHeight("answer", 90)).toBe(132);
    expect(contentDrivenHeight("answer", 800)).toBe(440);
  });
});
