import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EnergyVADProvider, SileroVADProvider } from "./vad";

function pcm16(value: number, samples = 640): Uint8Array {
  const output = new Uint8Array(samples * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, value, true);
  return output;
}

function pcm16Sequence(values: number[], samples = 512): Uint8Array {
  const output = new Uint8Array(values.length * samples * 2);
  const view = new DataView(output.buffer);
  values.forEach((value, frame) => {
    for (let index = 0; index < samples; index += 1) view.setInt16((frame * samples + index) * 2, value, true);
  });
  return output;
}

function fakeSession(probabilities: number[]) {
  let call = 0;
  return {
    calls: () => call,
    run: async () => ({
      output: { data: Float32Array.of(probabilities[Math.min(call++, probabilities.length - 1)] ?? 0), dims: [1, 1] },
      stateN: { data: new Float32Array(2 * 1 * 128), dims: [2, 1, 128] }
    })
  };
}

describe("VAD providers", () => {
  it("rejects silence", () => {
    const vad = new SileroVADProvider({ sampleRate: 16_000, minSpeechMs: 20, endSilenceMs: 20 });
    expect(vad.process(pcm16(0)).speech).toBe(false);
    expect(vad.getStatus()).toMatchObject({ provider: "energy", fallback: true, ready: true });
  });

  it("detects continuous speech and exposes the audio range", () => {
    const vad = new SileroVADProvider({ sampleRate: 16_000, minSpeechMs: 20, endSilenceMs: 20 });
    const result = vad.process(pcm16(5_000));
    expect(result.speech).toBe(true);
    expect(result.startTime).toBe(0);
    expect(result.endTime).toBe(40);
  });

  it("reports a speech end after the configured silence", () => {
    const vad = new EnergyVADProvider({ sampleRate: 16_000, minSpeechMs: 20, endSilenceMs: 20 });
    expect(vad.process(pcm16(5_000, 640)).speech).toBe(true);
    const result = vad.process(pcm16(0, 640));
    expect(result.speech).toBe(false);
    expect(result.speechEnded).toBe(true);
  });

  it("keeps MIC and SYSTEM VAD state independent", () => {
    const mic = new EnergyVADProvider({ sampleRate: 16_000, minSpeechMs: 20, endSilenceMs: 20 });
    const system = new EnergyVADProvider({ sampleRate: 16_000, minSpeechMs: 20, endSilenceMs: 20 });
    expect(mic.process(pcm16(5_000)).speech).toBe(true);
    expect(system.process(pcm16(0)).speech).toBe(false);
    expect(mic.process(pcm16(0)).speech).toBe(false);
    expect(system.process(pcm16(5_000)).speech).toBe(true);
  });

  it("runs ONNX-style streaming inference without inheriting EnergyVAD", async () => {
    const session = fakeSession([0.9, 0.01]);
    const vad = new SileroVADProvider({
      modelPath: "fake-silero.onnx",
      minSpeechMs: 20,
      endSilenceMs: 20,
      sessionFactory: async () => session
    });
    const speech = await vad.processAsync(pcm16Sequence([5_000]));
    expect(session.calls()).toBe(1);
    expect(speech.speech).toBe(true);
    expect(speech.speechProbability).toBeCloseTo(0.9, 5);
    const ended = await vad.processAsync(pcm16Sequence([0]));
    expect(ended.speech).toBe(false);
    expect(ended.speechEnded).toBe(true);
    expect(vad.providerName).toBe("silero");
    expect(vad.fallback).toBe(false);
    expect(vad.getStatus()).toMatchObject({ provider: "silero", fallback: false, ready: true, reason: "silero-model-ready" });
  });

  it("falls back to EnergyVAD and emits an explicit diagnostic when model load fails", async () => {
    const diagnostic = vi.fn();
    const vad = new SileroVADProvider({
      modelPath: "missing-silero.onnx",
      minSpeechMs: 20,
      onDiagnostic: diagnostic,
      sessionFactory: async () => { throw new Error("model missing"); }
    });
    const result = await vad.processAsync(pcm16(5_000));
    expect(vad.fallback).toBe(true);
    expect(result.ready).toBe(true);
    expect(vad.getStatus()).toMatchObject({ provider: "energy", fallback: true, ready: true });
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "VAD_FALLBACK_TO_ENERGY" }));
  });

  it("resets model state and starts a new inference timeline", async () => {
    const session = fakeSession([0.9, 0.01]);
    const vad = new SileroVADProvider({ modelPath: "fake-silero.onnx", minSpeechMs: 20, sessionFactory: async () => session });
    expect((await vad.processAsync(pcm16(5_000))).speech).toBe(true);
    vad.reset();
    const result = await vad.processAsync(pcm16(0));
    expect(result.speech).toBe(false);
    expect(result.startTime).toBe(0);
  });

  it("can execute the checked-in Silero ONNX model when the desktop asset is present", async () => {
    const modelPath = [
      join(process.cwd(), "apps", "desktop", "models", "vad", "silero_vad_16k_op15.onnx"),
      join(process.cwd(), "..", "..", "apps", "desktop", "models", "vad", "silero_vad_16k_op15.onnx")
    ].find(existsSync);
    if (!modelPath) return;
    const vad = new SileroVADProvider({ modelPath, minSpeechMs: 20, endSilenceMs: 20 });
    const result = await vad.processAsync(pcm16(0, 512));
    expect(vad.fallback).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.speechProbability).toBeGreaterThanOrEqual(0);
  });
});

