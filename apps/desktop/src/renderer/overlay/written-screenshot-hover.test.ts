import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WrittenScreenshotHoverTrigger } from "./written-screenshot-hover";

describe.each([800, 1500])("written action dwell (%d ms)", delayMs => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function createHover() {
    const trigger = vi.fn();
    const onPhase = vi.fn();
    const hover = new WrittenScreenshotHoverTrigger(trigger, onPhase, delayMs);
    hover.setEnabled(true);
    return { hover, trigger, onPhase };
  }

  it("waits the full dwell, fires once per visit and rearms after leaving", () => {
    const { hover, trigger } = createHover();
    hover.enter();
    vi.advanceTimersByTime(delayMs / 2);
    hover.enter();
    vi.advanceTimersByTime(delayMs / 2 - 1);
    expect(trigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    hover.setEnabled(false);
    hover.setEnabled(true);
    hover.enter();
    vi.advanceTimersByTime(5_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    hover.leave();
    hover.enter();
    vi.advanceTimersByTime(delayMs);
    expect(trigger).toHaveBeenCalledTimes(2);
    hover.dispose();
  });

  it("cancels on leave and requires a fresh full dwell on return", () => {
    const { hover, trigger, onPhase } = createHover();
    hover.enter();
    vi.advanceTimersByTime(delayMs - 200);
    hover.leave();
    vi.advanceTimersByTime(delayMs);
    expect(trigger).not.toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith("idle");
    hover.enter();
    vi.advanceTimersByTime(delayMs - 1);
    expect(trigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(trigger).toHaveBeenCalledOnce();
    hover.dispose();
  });

  it("cancels when busy/hidden/stopped and does not arm under a stationary pointer when enabled", () => {
    const { hover, trigger } = createHover();
    hover.enter();
    vi.advanceTimersByTime(delayMs - 200);
    hover.setEnabled(false);
    vi.advanceTimersByTime(delayMs);
    hover.setEnabled(true);
    hover.enter();
    vi.advanceTimersByTime(delayMs);
    expect(trigger).not.toHaveBeenCalled();
    hover.leave();
    hover.setEnabled(false);
    hover.enter();
    hover.setEnabled(true);
    vi.advanceTimersByTime(delayMs);
    expect(trigger).not.toHaveBeenCalled();
    hover.leave();
    hover.enter();
    vi.advanceTimersByTime(delayMs);
    expect(trigger).toHaveBeenCalledOnce();
    hover.dispose();
  });

  it("disposes the pending action when the written control is unmounted", () => {
    const { hover, trigger } = createHover();
    hover.enter();
    vi.advanceTimersByTime(delayMs - 1);
    hover.dispose();
    hover.setEnabled(true);
    hover.enter();
    vi.advanceTimersByTime(2_000);
    expect(trigger).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
