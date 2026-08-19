import { describe, expect, it } from "vitest";
import { isScreenshotExpired, SCREENSHOT_TTL_MS } from "./screenshot-cleanup";

describe("screenshot cleanup TTL", () => {
  it("expires temporary captures after the configured TTL", () => {
    expect(isScreenshotExpired(1_000, 1_000 + SCREENSHOT_TTL_MS)).toBe(true);
    expect(isScreenshotExpired(1_000, 1_000 + SCREENSHOT_TTL_MS - 1)).toBe(false);
  });
});
