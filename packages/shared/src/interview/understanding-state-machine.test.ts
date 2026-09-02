import { describe, expect, it } from "vitest";
import { InterviewUnderstandingStateMachine } from "./interview-understanding-state-machine";

describe("InterviewUnderstandingStateMachine", () => {
  it("commits a complete low-confidence question after the stability window", () => {
    const machine = new InterviewUnderstandingStateMachine({ mode: "ACCURATE_INTERVIEW", sessionId: "session-1" });

    const waiting = machine.process({
      id: "turn-1",
      text: "DMA 的原理是什么？",
      final: true,
      speaker: "interviewer",
      asrConfidence: 0.7,
      timestamp: 100
    });

    expect(waiting.type).toBe("QUESTION_WAITING");
    expect(waiting.frame.completion).toBe("COMPLETE");

    const committed = machine.commitPending("FAST_PRACTICE");

    expect(committed?.type).toBe("QUESTION_COMMITTED");
    if (committed?.type === "QUESTION_COMMITTED") {
      expect(committed.frame.commitStatus).toBe("COMMITTED");
      expect(committed.gate.reason).toContain("stability-timeout");
    }
    expect(machine.state.pendingQuestion).toBeUndefined();
  });

  it("does not force an incomplete or unresolved follow-up", () => {
    const machine = new InterviewUnderstandingStateMachine({ mode: "ACCURATE_INTERVIEW", sessionId: "session-2" });

    const waiting = machine.process({ id: "turn-2", text: "那这个呢？", final: true, speaker: "interviewer", asrConfidence: 0.96, timestamp: 200 });

    expect(waiting.type).toBe("QUESTION_WAITING");
    expect(machine.commitPending("FAST_PRACTICE")).toBeUndefined();
    expect(machine.state.pendingQuestion).toBeDefined();
  });
});
