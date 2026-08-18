import { describe, expect, it } from "vitest";
import { reconnectDelayMs, RecoveryBackoff } from "./audio-manager";

describe("AudioManager recovery backoff", () => {
  it("uses the documented capped exponential retry sequence", () => {
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });

  it("resets to the first delay after a stable READY period", () => {
    const backoff = new RecoveryBackoff();
    expect(backoff.nextDelayMs()).toBe(1_000);
    expect(backoff.nextDelayMs()).toBe(2_000);
    expect(backoff.nextDelayMs()).toBe(4_000);
    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(1_000);
  });
});
