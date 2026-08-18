import { describe, expect, it } from "vitest";
import { InvalidSessionTransitionError, SessionStateMachine, normalizeMeter } from "./index";

describe("SessionStateMachine", () => {
  it("allows the documented happy path", () => {
    const machine = new SessionStateMachine();
    ["CREATING", "CONNECTING", "READY", "RUNNING", "ENDING", "ENDED"]
      .forEach((state) => machine.transition(state as never));
    expect(machine.state).toBe("ENDED");
  });

  it("rejects boolean-like invalid jumps", () => {
    const machine = new SessionStateMachine();
    expect(() => machine.transition("RUNNING")).toThrow(InvalidSessionTransitionError);
  });

  it("notifies listeners and unsubscribes", () => {
    const machine = new SessionStateMachine();
    const states: string[] = [];
    const unsubscribe = machine.subscribe((state) => states.push(state));
    machine.transition("CREATING");
    unsubscribe();
    machine.transition("CONNECTING");
    expect(states).toEqual(["CREATING"]);
  });
});

describe("normalizeMeter", () => {
  it("keeps values within the renderer range", () => {
    expect(normalizeMeter(-1)).toBe(0);
    expect(normalizeMeter(Number.NaN)).toBe(0);
    expect(normalizeMeter(0.4)).toBe(0.4);
    expect(normalizeMeter(2)).toBe(1);
  });
});
