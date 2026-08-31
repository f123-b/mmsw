import { describe, expect, it } from "vitest";
import { DEFAULT_OVERLAY_PREFERENCES } from "../../shared/overlay-preferences";
import { applyOverlayPreferencesDraftPatch, createOverlayPreferencesDraftState, markOverlayPreferencesPersisted, syncOverlayPreferencesFromParent, takeOverlayPreferencesPersistPatch, takeOverlayPreferencesPreviewPatch } from "./overlay-preferences-draft";

describe("overlay preferences draft lifecycle", () => {
  it("OVERLAY_DRAFT_SURVIVES_PREVIEW_FLUSH", () => {
    const state = createOverlayPreferencesDraftState(DEFAULT_OVERLAY_PREFERENCES);
    const patch = { interview: { questionWindow: { fontSize: 18, titleFontSize: 22, textColor: "#123456", textOpacity: 0.72, backgroundColor: "#112233", backgroundOpacity: 0.35, blur: 7, radius: 9, border: true, shadow: false, padding: 19, lineHeight: 1.8 } } } as const;

    applyOverlayPreferencesDraftPatch(state, patch, true);
    expect(takeOverlayPreferencesPreviewPatch(state)).toEqual(patch);
    expect(state.dirtyPersistPatch).toEqual(patch);

    const persistedPatch = takeOverlayPreferencesPersistPatch(state);
    expect(persistedPatch).toEqual(patch);
    expect(state.dirtyPersistPatch).toEqual(patch);
    markOverlayPreferencesPersisted(state);
    expect(state.dirtyPersistPatch).toEqual({});
    expect(state.draft.interview.questionWindow).toMatchObject(patch.interview.questionWindow);
  });

  it("does not let a stale parent value replace dirty draft until persistence succeeds", () => {
    const state = createOverlayPreferencesDraftState(DEFAULT_OVERLAY_PREFERENCES);
    applyOverlayPreferencesDraftPatch(state, { appearance: { mode: "text_only" }, interview: { questionWindow: { fontSize: 20 } } }, true);
    expect(syncOverlayPreferencesFromParent(state, DEFAULT_OVERLAY_PREFERENCES)).toBe(false);
    expect(state.draft.appearance.mode).toBe("text_only");
    expect(state.draft.interview.questionWindow.fontSize).toBe(20);

    takeOverlayPreferencesPersistPatch(state);
    markOverlayPreferencesPersisted(state);
    expect(syncOverlayPreferencesFromParent(state, DEFAULT_OVERLAY_PREFERENCES)).toBe(true);
    expect(state.draft).toEqual(DEFAULT_OVERLAY_PREFERENCES);
  });
});

