import { describe, expect, it } from "vitest";
import { initialHUDState, reduceHUDState } from "./hud-state";

describe("HUD state lifecycle", () => {
  it("keeps repeated start/stop cycles idempotent", () => {
    let state = { ...initialHUDState };
    for (let index = 0; index < 100; index += 1) {
      state = reduceHUDState(state, { type: "start" });
      expect(state).toMatchObject({ running: true, panelVisible: true, transcriptVisible: true, answerVisible: true, topBarVisible: true, shareMode: false, mode: "FULL" });
      state = reduceHUDState(state, { type: "stop" });
      expect(state).toEqual(initialHUDState);
    }
  });

  it("supports full, mini, hidden, and share mode without losing the prior visual state", () => {
    let state = reduceHUDState(initialHUDState, { type: "start" });
    state = reduceHUDState(state, { type: "toggle-panels" });
    expect(state).toMatchObject({ mode: "MINI", panelVisible: false, topBarVisible: true });
    state = reduceHUDState(state, { type: "set-share-mode", enabled: true });
    expect(state).toMatchObject({ running: true, shareMode: true, panelVisible: false, transcriptVisible: false, answerVisible: false, transientLayer: "none", topBarVisible: false, mouseMode: "passthrough", mode: "HIDDEN" });
    state = reduceHUDState(state, { type: "set-share-mode", enabled: false });
    expect(state).toMatchObject({ running: true, shareMode: false, mode: "MINI", panelVisible: false, topBarVisible: true });
    state = reduceHUDState(reduceHUDState(state, { type: "set-mouse-mode", mode: "interactive" }), { type: "set-share-mode", enabled: true });
    state = reduceHUDState(state, { type: "set-share-mode", enabled: false });
    expect(state.mouseMode).toBe("interactive");
    state = reduceHUDState(state, { type: "hide-all" });
    expect(state).toMatchObject({ mode: "HIDDEN", panelVisible: false, transientLayer: "none", topBarVisible: false });
  });

  it("toggles the transcript and answer panels independently", () => {
    let state = reduceHUDState(initialHUDState, { type: "start" });
    state = reduceHUDState(state, { type: "toggle-transcript" });
    expect(state).toMatchObject({ panelVisible: true, transcriptVisible: false, answerVisible: true, topBarVisible: true, mode: "FULL" });
    state = reduceHUDState(state, { type: "toggle-answer" });
    expect(state).toMatchObject({ panelVisible: false, transcriptVisible: false, answerVisible: false, topBarVisible: true, mode: "MINI" });
    state = reduceHUDState(state, { type: "toggle-transcript" });
    expect(state).toMatchObject({ panelVisible: true, transcriptVisible: true, answerVisible: false, mode: "FULL" });
  });

  it("owns exactly one transient layer and lets end confirmation replace shortcuts", () => {
    let state = reduceHUDState(reduceHUDState(initialHUDState, { type: "start" }), { type: "toggle-shortcuts" });
    expect(state.transientLayer).toBe("shortcut");
    state = reduceHUDState(state, { type: "set-transient-layer", layer: "end_confirm" });
    expect(state.transientLayer).toBe("end_confirm");
    state = reduceHUDState(state, { type: "toggle-shortcuts" });
    expect(state.transientLayer).toBe("end_confirm");
    expect(reduceHUDState(state, { type: "set-transient-layer", layer: "none" }).transientLayer).toBe("none");
  });
});
