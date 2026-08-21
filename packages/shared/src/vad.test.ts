import { describe, expect, it } from "vitest";
import { SileroVADProvider } from "./vad";

function pcm16(value: number, samples = 640): Uint8Array {
  const output = new Uint8Array(samples * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, value, true);
  return output;
}

describe("VAD providers", () => {
  it("rejects silence", () => {
    const vad = new SileroVADProvider({ sampleRate: 16_000, minSpeechMs: 20, endSilenceMs: 20 });
    expect(vad.process(pcm16(0)).speech).toBe(false);
  });

  it("detects continuous speech and exposes the audio range", () => {
    const vad = new SileroVADProvider({ sampleRate: 16_000, minSpeechMs: 20, endSilenceMs: 20 });
    const result = vad.process(pcm16(5_000));
    expect(result.speech).toBe(true);
    expect(result.startTime).toBe(0);
    expect(result.endTime).toBe(40);
  });
});

