import { describe, expect, it } from "vitest";
import { GLOBAL_SHORTCUTS } from "./shortcuts";

describe("global shortcuts", () => {
  it("registers the global actions without collisions", () => {
    const accelerators = Object.values(GLOBAL_SHORTCUTS);

    expect(new Set(accelerators).size).toBe(accelerators.length);
    expect(GLOBAL_SHORTCUTS.answerLatest).toContain("A");
    expect(GLOBAL_SHORTCUTS.screenshotAnswer).toContain("S");
    expect(GLOBAL_SHORTCUTS.toggleOverlay).toContain("D");
    expect(GLOBAL_SHORTCUTS.toggleShortcuts).toContain("K");
    expect(GLOBAL_SHORTCUTS.toggleOverlayMode).toContain("P");
    expect(GLOBAL_SHORTCUTS.toggleAutomation).toContain("X");
    expect(GLOBAL_SHORTCUTS.endInterview).toContain("Q");
  });
});
