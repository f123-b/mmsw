import { describe, expect, it } from "vitest";
import { InterviewUnderstandingStateMachine } from "./interview-understanding-state-machine";

describe("InterviewUnderstandingStateMachine", () => {
  it("commits a recognizable complete question immediately even when ASR confidence is low", () => {
    const machine = new InterviewUnderstandingStateMachine({ mode: "ACCURATE_INTERVIEW", sessionId: "session-1" });

    const committed = machine.process({
      id: "turn-1",
      text: "DMA 的原理是什么？",
      final: true,
      speaker: "interviewer",
      asrConfidence: 0.7,
      timestamp: 100
    });

    expect(committed.type).toBe("QUESTION_COMMITTED");
    expect(committed.frame.completion).toBe("COMPLETE");
    if (committed.type === "QUESTION_COMMITTED") {
      expect(committed.frame.commitStatus).toBe("COMMITTED");
      expect(committed.gate.reason).toBe("answer-first-direct-question");
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
