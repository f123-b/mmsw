import { describe, expect, it } from "vitest";
import { InterviewStartupTiming } from "./interview-startup-timing";

describe("InterviewStartupTiming", () => {
  it("produces the startup budget fields from monotonic marks", () => {
    let now = 1000;
    const trace = new InterviewStartupTiming(() => now, now);
    now = 1010;
    trace.mark("PREFLIGHT_BEGIN");
    now = 1060;
    trace.mark("PREFLIGHT_END");
    trace.mark("OVERLAY_PREPARE_BEGIN");
    now = 1080;
    trace.mark("QUESTION_RENDERER_READY");
    now = 1100;
    const snapshot = trace.complete();
    expect(snapshot.durations.preflightMs).toBe(50);
    expect(snapshot.durations.questionRendererMs).toBe(20);
    expect(snapshot.durations.totalMs).toBe(100);
    expect(snapshot.marks.INTERVIEW_READY).toBe(1100);
  });
});
