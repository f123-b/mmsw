import { describe, expect, it } from "vitest";
import { redactSecrets } from "./logger";

describe("safe logging", () => {
  it("redacts keys, bearer tokens and tickets", () => {
    const output = redactSecrets("apiKey=secret authorization=Bearer abc123 ticket=short-lived");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("short-lived");
  });
});
