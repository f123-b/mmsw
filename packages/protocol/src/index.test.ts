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
});
