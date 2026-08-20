import { describe, expect, it } from "vitest";
import { initialHUDState, reduceHUDState } from "./hud-state";

describe("HUD state lifecycle", () => {
  it("keeps repeated start/stop cycles idempotent", () => {
    let state = { ...initialHUDState };
    for (let index = 0; index < 100; index += 1) {
      state = reduceHUDState(state, { type: "start" });
      expect(state).toMatchObject({ running: true, panelVisible: true, topBarVisible: true, shareMode: false, mode: "FULL" });
      state = reduceHUDState(state, { type: "stop" });
      expect(state).toEqual(initialHUDState);
    }
  });

  it("supports full, mini, hidden, and share mode without losing the prior visual state", () => {
    let state = reduceHUDState(initialHUDState, { type: "start" });
    state = reduceHUDState(state, { type: "toggle-panels" });
    expect(state).toMatchObject({ mode: "MINI", panelVisible: false, topBarVisible: true });
    state = reduceHUDState(state, { type: "set-share-mode", enabled: true });
    expect(state).toMatchObject({ running: true, shareMode: true, panelVisible: false, shortcutVisible: false, topBarVisible: false, mouseMode: "passthrough", mode: "HIDDEN" });
    state = reduceHUDState(state, { type: "set-share-mode", enabled: false });
    expect(state).toMatchObject({ running: true, shareMode: false, mode: "MINI", panelVisible: false, topBarVisible: true });
    state = reduceHUDState(reduceHUDState(state, { type: "set-mouse-mode", mode: "interactive" }), { type: "set-share-mode", enabled: true });
    state = reduceHUDState(state, { type: "set-share-mode", enabled: false });
    expect(state.mouseMode).toBe("interactive");
    state = reduceHUDState(state, { type: "hide-all" });
    expect(state).toMatchObject({ mode: "HIDDEN", panelVisible: false, shortcutVisible: false, topBarVisible: false });
  });
});
