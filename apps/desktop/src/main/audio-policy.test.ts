import { describe, expect, it } from "vitest";
import { resolveAudioCapturePolicy } from "./audio-policy";

const ready = { state: "READY" as const };
const silent = { state: "SILENT" as const };
const failed = { state: "OPEN_FAILED" as const };

describe("audio capture policy", () => {
  it("selects dual mode when both channels are usable", () => {
    expect(resolveAudioCapturePolicy(ready, silent).captureMode).toBe("dual");
  });

  it("keeps system audio in system_only mode when the microphone fails", () => {
    expect(resolveAudioCapturePolicy(failed, ready).captureMode).toBe("system_only");
  });

  it("keeps microphone audio in mic_only mode when loopback fails", () => {
    expect(resolveAudioCapturePolicy(ready, failed).captureMode).toBe("mic_only");
  });

  it("only blocks when both channels are unavailable", () => {
    expect(() => resolveAudioCapturePolicy(failed, failed)).toThrow("NO_AUDIO_CHANNEL_AVAILABLE");
  });
});
