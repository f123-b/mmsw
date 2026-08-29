import { describe, expect, it } from "vitest";
import { followModeAfterScroll, interactionLockAfterEvent, isNearBottom, newContentBadgeLabel, shouldAutoFollowLatest } from "./overlay-interaction";

describe("overlay scroll interaction policy", () => {
  it("detects the native scroll boundary without intercepting wheel events", () => {
    expect(isNearBottom({ scrollHeight: 1_000, scrollTop: 700, clientHeight: 280 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1_000, scrollTop: 400, clientHeight: 280 })).toBe(false);
  });

  it("retains manual position when the user scrolls away from the tail", () => {
    expect(followModeAfterScroll({ scrollHeight: 1_000, scrollTop: 720, clientHeight: 280 })).toBe("following");
    expect(followModeAfterScroll({ scrollHeight: 1_000, scrollTop: 300, clientHeight: 280 })).toBe("manual");
    expect(shouldAutoFollowLatest("manual")).toBe(false);
    expect(shouldAutoFollowLatest("following")).toBe(true);
  });

  it("shows a compact new-content count instead of jumping the reader", () => {
    expect(newContentBadgeLabel(1)).toBe("1 条新内容");
    expect(newContentBadgeLabel(4)).toBe("4 条新内容");
    expect(newContentBadgeLabel(0)).toBe("");
  });

  it("keeps drag and resize locked until pointerup or cancellation", () => {
    let active = interactionLockAfterEvent(false, "pointerdown");
    active = interactionLockAfterEvent(active, "pointermove");
    expect(active).toBe(true);
    expect(interactionLockAfterEvent(active, "pointerup")).toBe(false);
    expect(interactionLockAfterEvent(active, "pointercancel")).toBe(false);
    expect(interactionLockAfterEvent(active, "blur")).toBe(false);
    expect(interactionLockAfterEvent(active, "unmount")).toBe(false);
  });
});
