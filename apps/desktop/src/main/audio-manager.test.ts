import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "./audio-manager";

describe("AudioManager recovery backoff", () => {
  it("uses the documented capped exponential retry sequence", () => {
    expect([0, 1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  });
});
