import { describe, expect, it } from "vitest";
import { GLOBAL_SHORTCUTS } from "./shortcuts";

describe("global shortcuts", () => {
  it("registers the Phase 1 actions without collisions", () => {
    const accelerators = Object.values(GLOBAL_SHORTCUTS);

    expect(new Set(accelerators).size).toBe(accelerators.length);
    expect(GLOBAL_SHORTCUTS.answerLatest).toContain("A");
    expect(GLOBAL_SHORTCUTS.screenshotAnswer).toContain("S");
    expect(GLOBAL_SHORTCUTS.toggleOverlayMode).toContain("P");
    expect(GLOBAL_SHORTCUTS.toggleAutomation).toContain("X");
    expect(GLOBAL_SHORTCUTS.endInterview).toContain("Q");
  });
});
