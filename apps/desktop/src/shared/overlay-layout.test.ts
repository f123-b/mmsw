import { describe, expect, it } from "vitest";
import { DEFAULT_OVERLAY_PREFERENCES } from "./overlay-preferences";
import { resolveOverlayGeometryConstraints, resolveOverlayPersistedGeometry, resolveOverlayPresetGeometry, resolveWrittenTestCameraBounds } from "./overlay-layout";

const controlBar = DEFAULT_OVERLAY_PREFERENCES.interview.controlBar;

describe("shared overlay geometry resolver", () => {
  it("exposes one preset-aware constraint policy", () => {
    expect(resolveOverlayGeometryConstraints({ mode: "interview", preset: "classic_split", panel: "question" })).toEqual({ minWidth: 320, maxWidth: 900, minHeight: 220, maxHeight: 840 });
    expect(resolveOverlayGeometryConstraints({ mode: "interview", preset: "minimal", panel: "question" })).toEqual({ minWidth: 320, maxWidth: 760, minHeight: 88, maxHeight: 280 });
    expect(resolveOverlayGeometryConstraints({ mode: "interview", preset: "minimal", panel: "answer" })).toEqual({ minWidth: 480, maxWidth: 1000, minHeight: 132, maxHeight: 440 });
    expect(resolveOverlayGeometryConstraints({ mode: "written_test", preset: "split", panel: "answer" })).toEqual({ minWidth: 480, maxWidth: 1200, minHeight: 320, maxHeight: 840 });
    expect(resolveOverlayGeometryConstraints({ mode: "interview", preset: "classic_split", panel: "control" })).toEqual({ minWidth: 240, maxWidth: 1200, minHeight: 36, maxHeight: 100 });
  });

  it("uses the same classic template for a 1080p work area", () => {
    const geometry = resolveOverlayPresetGeometry({ mode: "interview", preset: "classic_split", workArea: { x: 0, y: 0, width: 1920, height: 1040 }, controlBar: controlBar });
    expect(geometry.question).toMatchObject({ width: 420, height: 500 });
    expect(geometry.answer).toMatchObject({ width: 680, height: 500 });
    expect(geometry.control).toMatchObject({ width: 440, height: 44 });
  });

  it("keeps customized dimensions even before a position has been stored", () => {
    const preferences = {
      ...DEFAULT_OVERLAY_PREFERENCES.interview.questionWindow,
      width: 510,
      height: 530,
      x: undefined,
      y: undefined
    };
    const geometry = resolveOverlayPersistedGeometry({ mode: "interview", preset: "classic_split", workArea: { x: 0, y: 0, width: 1920, height: 1040 }, questionWindow: preferences, answerWindow: DEFAULT_OVERLAY_PREFERENCES.interview.answerWindow, controlBar });
    expect(geometry.question).toMatchObject({ width: 510, height: 530 });
    expect(geometry.question.x).toBe(398);
    expect(geometry.question.y).toBe(104);
  });

  it.each([-1920, 0, 1920])("converts relative x=120 to the correct display origin (%s)", (displayX) => {
    const geometry = resolveOverlayPersistedGeometry({
      mode: "interview",
      preset: "classic_split",
      workArea: { x: displayX, y: 0, width: 1920, height: 1040 },
      questionWindow: { ...DEFAULT_OVERLAY_PREFERENCES.interview.questionWindow, x: 120, y: 80 },
      answerWindow: DEFAULT_OVERLAY_PREFERENCES.interview.answerWindow,
      controlBar
    });
    expect(geometry.question.x).toBe(displayX + 120);
    expect(geometry.question.y).toBe(80);
  });

  it("keeps interview and written-test preset geometry independent", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const interview = resolveOverlayPresetGeometry({ mode: "interview", preset: "answer_focus", workArea, controlBar });
    const written = resolveOverlayPresetGeometry({ mode: "written_test", preset: "split", workArea, controlBar: DEFAULT_OVERLAY_PREFERENCES.writtenTest.controlBar });
    expect(interview.question.width).toBe(380);
    expect(written.question.width).toBe(520);
    expect(interview.answer.width).toBe(720);
    expect(written.answer.width).toBe(700);
  });

  it.each([1, 1.25, 1.5])("keeps relative geometry stable for DPI scale factor %s", (scaleFactor) => {
    const geometry = resolveOverlayPersistedGeometry({
      mode: "interview",
      preset: "classic_split",
      workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
      questionWindow: { ...DEFAULT_OVERLAY_PREFERENCES.interview.questionWindow, x: 120, y: 80, displayId: 7, scaleFactor },
      answerWindow: { ...DEFAULT_OVERLAY_PREFERENCES.interview.answerWindow, x: 620, y: 80, displayId: 7, scaleFactor },
      controlBar: { ...controlBar, x: 740, y: 20, displayId: 7, scaleFactor }
    });
    expect(geometry.question).toMatchObject({ x: -1800, y: 80, width: 420, height: 500 });
    expect(geometry.answer).toMatchObject({ x: -1300, y: 80, width: 680, height: 500 });
  });

  it("anchors the written-test camera to the answer upper-right corner", () => {
    const camera = resolveWrittenTestCameraBounds({ x: 900, y: 120, width: 700, height: 520 }, { x: 0, y: 0, width: 1920, height: 1040 });
    expect(camera).toEqual({ x: 1548, y: 128, width: 44, height: 44 });
  });

  it("keeps the camera inside a secondary monitor work area", () => {
    const camera = resolveWrittenTestCameraBounds({ x: 3100, y: -200, width: 400, height: 300 }, { x: 1920, y: -100, width: 1280, height: 900 });
    expect(camera).toEqual({ x: 3156, y: -100, width: 44, height: 44 });
  });
});
