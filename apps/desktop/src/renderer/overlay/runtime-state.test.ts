import { describe, expect, it } from "vitest";
import { initialRuntimePhaseState, isCommittedQuestionGroup, isDisplayableQuestionGroup, primaryRuntimeStatus, reduceRuntimeMessage, reduceRuntimeTranscript, sessionPhaseFor } from "./runtime-state";

describe("overlay runtime phases", () => {
  it("keeps session listening while a completed answer is shown", () => {
    const state = { ...initialRuntimePhaseState, sessionPhase: "LISTENING" as const, answerPhase: "READY" as const };
    expect(primaryRuntimeStatus(state)).toBe("正在听取");
    expect(state.answerPhase).toBe("READY");
  });

  it("does not let an answer status override startup or error lifecycle", () => {
    expect(primaryRuntimeStatus({ ...initialRuntimePhaseState, sessionPhase: "STARTING", answerPhase: "READY" })).toBe("正在启动");
    expect(primaryRuntimeStatus({ ...initialRuntimePhaseState, sessionPhase: "ERROR", answerPhase: "READY" })).toBe("运行错误");
    expect(primaryRuntimeStatus({ ...initialRuntimePhaseState, sessionPhase: "LISTENING", answerPhase: "GENERATING" })).toBe("正在生成回答");
  });

  it("uses one committed group identity for question and answer surfaces", () => {
    const group = { displayable: true, hasAnswerableQuestion: true, items: [{ answerable: true }] };
    expect(isDisplayableQuestionGroup(group)).toBe(true);
    expect(isDisplayableQuestionGroup({ displayable: false, items: [{ answerable: true }] })).toBe(false);
    expect(isCommittedQuestionGroup({ ...group, status: "closed" })).toBe(false);
    expect(isCommittedQuestionGroup(group)).toBe(true);
    const next = reduceRuntimeMessage({ ...initialRuntimePhaseState, sessionPhase: "LISTENING" }, { type: "answer_start", answerId: "a1", questionId: "q1", mode: "NORMAL", model: "test" }, "group-1");
    expect(next).toMatchObject({ answerPhase: "GENERATING", activeQuestionGroupId: "group-1", activeAnswerGroupId: "group-1" });
  });

  it("returns to listening and clears stale answer state when new remote speech arrives", () => {
    const state = { ...initialRuntimePhaseState, sessionPhase: "DEGRADED" as const, answerPhase: "READY" as const };
    const next = reduceRuntimeTranscript(state, "remote", true);
    expect(next).toMatchObject({ sessionPhase: "LISTENING", questionPhase: "ASSEMBLING", answerPhase: "EMPTY" });
  });

  it("maps transport and session lifecycle states independently", () => {
    expect(sessionPhaseFor("CREATING", "STOPPED", "disconnected")).toBe("STARTING");
    expect(sessionPhaseFor("RUNNING", "STARTING", "connected")).toBe("STARTING");
    expect(sessionPhaseFor("RUNNING", "DEGRADED", "connected")).toBe("DEGRADED");
    expect(sessionPhaseFor("RUNNING", "READY", "disconnected")).toBe("DEGRADED");
    expect(sessionPhaseFor("RUNNING", "READY", "connected")).toBe("LISTENING");
    expect(sessionPhaseFor("ENDING", "READY", "connected")).toBe("STOPPING");
  });
});
