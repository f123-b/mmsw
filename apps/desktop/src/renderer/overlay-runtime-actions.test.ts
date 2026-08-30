import { describe, expect, it } from "vitest";
import { answerScreenshotForMode } from "./overlay-runtime-actions";

describe("mode-aware overlay screenshot action", () => {
  it("routes interview UI screenshots to the interview handler", async () => {
    const calls: string[] = [];
    await answerScreenshotForMode("INTERVIEW", {
      interview: { answerScreenshot: async () => { calls.push("interview"); } },
      writtenTest: { answerScreenshot: async () => { calls.push("written"); } }
    });
    expect(calls).toEqual(["interview"]);
  });

  it("routes written-test UI screenshots to the written-test handler", async () => {
    const calls: string[] = [];
    await answerScreenshotForMode("WRITTEN_TEST", {
      interview: { answerScreenshot: async () => { calls.push("interview"); } },
      writtenTest: { answerScreenshot: async () => { calls.push("written"); } }
    });
    expect(calls).toEqual(["written"]);
  });
});
