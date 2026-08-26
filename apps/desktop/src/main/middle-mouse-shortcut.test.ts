import { describe, expect, it } from "vitest";
import { shouldHandleMiddleMouseShortcut } from "./middle-mouse-shortcut";

describe("middle mouse screenshot shortcut", () => {
  it("only runs in an active manual interview", () => {
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: true, automationMode: "MANUAL", writtenTestRunning: false })).toBe(true);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: true, automationMode: "AUTO", writtenTestRunning: false })).toBe(false);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: false, automationMode: "MANUAL", writtenTestRunning: false })).toBe(false);
    expect(shouldHandleMiddleMouseShortcut({ interviewRunning: true, automationMode: "MANUAL", writtenTestRunning: true })).toBe(false);
  });
});
