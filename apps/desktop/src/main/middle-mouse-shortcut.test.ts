import { describe, expect, it, vi } from "vitest";
import { normalizeNativeWheelDelta, routeGlobalMouseEvent, shouldHandleMiddleMouseShortcut } from "./middle-mouse-shortcut";

describe("middle mouse screenshot shortcut", () => {
  it("runs in manual interview and written-test modes, but never in auto interview", () => {
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: true, automationMode: "MANUAL", writtenTestRunning: false })).toBe(true);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: true, automationMode: "AUTO", writtenTestRunning: false })).toBe(false);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: false, automationMode: "MANUAL", writtenTestRunning: false })).toBe(false);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: true, automationMode: "MANUAL", writtenTestRunning: true })).toBe(true);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: false, automationMode: "AUTO", writtenTestRunning: true })).toBe(true);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: true, automationMode: "MANUAL", writtenTestRunning: false, middleMouseEnabled: false })).toBe(false);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: false, automationMode: "AUTO", writtenTestRunning: true, enabledInExamMode: false })).toBe(false);
  });

  it("keeps middle-click screenshot and wheel routing as separate events", () => {
    const middleClick = vi.fn();
    const wheel = vi.fn();
    routeGlobalMouseEvent({ event: "middle-click" }, middleClick, wheel);
    routeGlobalMouseEvent({ event: "mouse-wheel", x: 12, y: 34, deltaY: -120 }, middleClick, wheel);
    expect(middleClick).toHaveBeenCalledTimes(1);
    expect(wheel).toHaveBeenCalledWith({ event: "mouse-wheel", x: 12, y: 34, deltaY: 120 });
  });

  it("maps native Windows wheel polarity to DOM scroll polarity", () => {
    expect(normalizeNativeWheelDelta(120)).toBe(-120);
    expect(normalizeNativeWheelDelta(-120)).toBe(120);
  });
});
