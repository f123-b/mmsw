import { describe, expect, it } from "vitest";
import {
  AUDIO_PACKET_BYTES,
  audioDevicesSchema,
  parseAudioSidecarEvent
} from "./index";

describe("audio protocol", () => {
  it("defines the 40ms stereo PCM packet size", () => {
    expect(AUDIO_PACKET_BYTES).toBe(2_560);
  });

  it("validates device lists and sidecar events", () => {
    expect(audioDevicesSchema.parse({
      inputs: [{ id: "mic-1", name: "Microphone", kind: "microphone", default: true }],
      outputs: [{ id: "speaker-1", name: "Speakers", kind: "loopback", default: true }]
    }).inputs[0].kind).toBe("microphone");

    expect(parseAudioSidecarEvent(JSON.stringify({
      type: "meter",
      mic: 0.2,
      system: 0.8,
      timestamp: 123
    }))).toMatchObject({ type: "meter", system: 0.8 });
  });

  it("rejects invalid meter values", () => {
    expect(() => parseAudioSidecarEvent(JSON.stringify({
      type: "meter",
      mic: 2,
      system: 0.1,
      timestamp: 1
    }))).toThrow();
  });

  it("validates probe and buffer statistics", () => {
    expect(parseAudioSidecarEvent(JSON.stringify({
      type: "probe_result",
      mic: { ok: true, sampleRate: 48_000, channels: 1, peak: 0.43, callbackCount: 50, sampleCount: 2_400_000 },
      system: { ok: true, sampleRate: 48_000, channels: 2, peak: 0.61, callbackCount: 50, sampleCount: 4_800_000 },
      durationMs: 2_000,
      timestamp: 123
    }))).toMatchObject({ type: "probe_result", mic: { callbackCount: 50 } });

    expect(parseAudioSidecarEvent(JSON.stringify({
      type: "audio_buffer",
      queuedFrames: 1_024,
      droppedFrames: 64,
      bufferDurationMs: 64,
      timestamp: 123
    }))).toMatchObject({ type: "audio_buffer", droppedFrames: 64 });
  });

  it("validates audio drift statistics", () => {
    expect(parseAudioSidecarEvent(JSON.stringify({
      type: "audio_drift",
      micAvailableFrames: 1_280,
      systemAvailableFrames: 640,
      driftFrames: 640,
      driftMs: 40,
      status: "warning",
      timestamp: 123
    }))).toMatchObject({ type: "audio_drift", driftMs: 40 });
  });
});
