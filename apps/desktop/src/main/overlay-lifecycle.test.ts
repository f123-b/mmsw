import { describe, expect, it } from "vitest";
import { initialOverlayLifecycleState, reduceOverlayLifecycle } from "./overlay-lifecycle";

describe("overlay lifecycle", () => {
  it("starts in a hidden state and enters layout editing without runtime state", () => {
    const state = reduceOverlayLifecycle(initialOverlayLifecycleState, { type: "enter-layout-edit" });
    expect(state).toBe("LAYOUT_EDIT");
    expect(reduceOverlayLifecycle(state, { type: "start-interview" })).toBe("INTERVIEW_PASSIVE");
  });

  it("keeps normal interview passive and makes temporary interaction explicit", () => {
    let state = reduceOverlayLifecycle(initialOverlayLifecycleState, { type: "start-interview" });
    expect(state).toBe("INTERVIEW_PASSIVE");
    state = reduceOverlayLifecycle(state, { type: "claim-interaction" });
    expect(state).toBe("INTERVIEW_TEMP_INTERACTIVE");
    expect(reduceOverlayLifecycle(state, { type: "release-interaction" })).toBe("INTERVIEW_PASSIVE");
  });

  it("cannot re-enter layout editing while the interview is running", () => {
    const state = reduceOverlayLifecycle(initialOverlayLifecycleState, { type: "start-interview" });
    expect(reduceOverlayLifecycle(state, { type: "enter-layout-edit" })).toBe("INTERVIEW_PASSIVE");
  });

  it("isolates share-hidden and ending states", () => {
    let state = reduceOverlayLifecycle(initialOverlayLifecycleState, { type: "start-interview" });
    state = reduceOverlayLifecycle(state, { type: "share", enabled: true });
    expect(state).toBe("SHARE_HIDDEN");
    state = reduceOverlayLifecycle(state, { type: "share", enabled: false });
    expect(state).toBe("INTERVIEW_PASSIVE");
    expect(reduceOverlayLifecycle(state, { type: "begin-ending" })).toBe("ENDING");
  });
});
