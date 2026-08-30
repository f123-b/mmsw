import { describe, expect, it } from "vitest";
import { clampOverlayBounds, contentDrivenHeight, resolveOverlayNativeBounds, type OverlayNativeBounds } from "./overlay-layout-controller";
import { DEFAULT_OVERLAY_PREFERENCES } from "../shared/overlay-preferences";

const workArea: OverlayNativeBounds = { x: -1920, y: 0, width: 1920, height: 1040 };
const display = { workArea };
const defaults = {
  question: { x: -1800, y: 120, width: 760, height: 360 },
  answer: { x: -1000, y: 120, width: 860, height: 520 },
  control: { x: -1700, y: 24, width: 420, height: 48 }
};

describe("OverlayLayoutController", () => {
  it("keeps the default classic interview layout fixed and inside a negative-origin work area", () => {
    const bounds = resolveOverlayNativeBounds(DEFAULT_OVERLAY_PREFERENCES, { display, defaults });

    expect(bounds.question).toEqual({ x: -1522, y: 104, width: 420, height: 720 });
    expect(bounds.answer).toEqual({ x: -1078, y: 104, width: 680, height: 720 });
    expect(bounds.control).toEqual({ x: -1180, y: 28, width: 440, height: 44 });
  });

  it("uses independent interview presets and does not reuse persisted geometry", () => {
    const preferences = {
      ...DEFAULT_OVERLAY_PREFERENCES,
      interview: {
        ...DEFAULT_OVERLAY_PREFERENCES.interview,
        layoutPreset: "compact_split" as const,
        questionWindow: { ...DEFAULT_OVERLAY_PREFERENCES.interview.questionWindow, x: 80, y: 120, width: 760, height: 360 },
        answerWindow: { ...DEFAULT_OVERLAY_PREFERENCES.interview.answerWindow, x: 960, y: 160, width: 860, height: 520 }
      }
    };
    const bounds = resolveOverlayNativeBounds(preferences, { display, defaults });

    expect(bounds.question).toMatchObject({ x: -1407, y: 104, width: 340, height: 520 });
    expect(bounds.answer).toMatchObject({ x: -1053, y: 104, width: 540, height: 520 });
  });

  it("resolves written-test single-reader and split layouts independently", () => {
    const single = resolveOverlayNativeBounds(DEFAULT_OVERLAY_PREFERENCES, { display, defaults }, "written_test");
    expect(single.question).toMatchObject({ x: -1440, y: 104, width: 960, height: 720 });
    expect(single.answer).toMatchObject({ x: -680, y: 104, width: 680, height: 720 });

    const splitPreferences = {
      ...DEFAULT_OVERLAY_PREFERENCES,
      writtenTest: { ...DEFAULT_OVERLAY_PREFERENCES.writtenTest, layoutPreset: "split" as const }
    };
    const split = resolveOverlayNativeBounds(splitPreferences, { display, defaults }, "written_test");
    expect(split.question).toMatchObject({ x: -1582, y: 104, width: 520, height: 720 });
    expect(split.answer).toMatchObject({ x: -1038, y: 104, width: 700, height: 720 });
  });

  it("allows minimal interview mode to use persisted work-area-relative positions", () => {
    const preferences = {
      ...DEFAULT_OVERLAY_PREFERENCES,
      interview: {
        ...DEFAULT_OVERLAY_PREFERENCES.interview,
        layoutPreset: "minimal" as const,
        questionWindow: { ...DEFAULT_OVERLAY_PREFERENCES.interview.questionWindow, x: 80, y: 120, width: 760, height: 360 },
        answerWindow: { ...DEFAULT_OVERLAY_PREFERENCES.interview.answerWindow, x: 960, y: 160, width: 860, height: 520 },
        controlBar: { ...DEFAULT_OVERLAY_PREFERENCES.interview.controlBar, x: 32, y: 24, positionMode: "custom" as const }
      }
    };
    const bounds = resolveOverlayNativeBounds(preferences, { display, defaults });
    expect(bounds.question).toMatchObject({ x: -1840, y: 120, width: 760, height: 360 });
    expect(bounds.answer).toMatchObject({ x: -960, y: 160, width: 860, height: 520 });
    expect(bounds.control).toMatchObject({ x: -1888, y: 24, width: 440, height: 44 });
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
