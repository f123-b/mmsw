import type { EnergyVADOptions, VADProvider, VADResult } from "./types";

/** Dependency-free fallback VAD. It is deliberately conservative and PCM16-only. */
export class EnergyVADProvider implements VADProvider {
  readonly providerName = "energy" as const;
  readonly fallback = false;
  private readonly sampleRate: number;
  private readonly threshold: number;
  private readonly minSpeechSamples: number;
  private readonly endSilenceSamples: number;
  private sampleCursor = 0;
  private speechStart?: number;
  private lastSpeechSample = 0;
  private active = false;

  constructor(options: EnergyVADOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16_000;
    this.threshold = options.threshold ?? 0.012;
    this.minSpeechSamples = Math.max(1, Math.round((options.minSpeechMs ?? 80) * this.sampleRate / 1_000));
    this.endSilenceSamples = Math.max(1, Math.round((options.endSilenceMs ?? 320) * this.sampleRate / 1_000));
  }

  process(pcm: Uint8Array): VADResult {
    if (pcm.byteLength % 2 !== 0) throw new Error("VAD expects PCM16 bytes");
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    let sum = 0;
    for (const sample of samples) { const normalized = sample / 32_768; sum += normalized * normalized; }
    const rms = samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
    const frameStart = this.sampleCursor;
    const frameEnd = frameStart + samples.length;
    this.sampleCursor = frameEnd;
    const wasActive = this.active;
    if (rms >= this.threshold) {
      this.speechStart ??= frameStart;
      this.lastSpeechSample = frameEnd;
    } else if (this.speechStart !== undefined && frameEnd - this.lastSpeechSample >= this.endSilenceSamples) {
      this.speechStart = undefined;
    }
    this.active = this.speechStart !== undefined && this.lastSpeechSample - this.speechStart >= this.minSpeechSamples;
    const speechEnded = wasActive && !this.active;
    return {
      speech: this.active,
      startTime: Math.round(((this.speechStart ?? frameStart) / this.sampleRate) * 1_000),
      endTime: Math.round(((this.active ? this.lastSpeechSample : frameEnd) / this.sampleRate) * 1_000),
      speechProbability: Math.min(1, rms / Math.max(this.threshold * 4, 0.001)),
      speechStarted: !wasActive && this.active,
      speechEnded,
      ready: true,
      confidence: Math.min(1, rms / Math.max(this.threshold * 4, 0.001))
    };
  }

  processAsync(pcm: Uint8Array): Promise<VADResult> { return Promise.resolve(this.process(pcm)); }

  reset(): void {
    this.sampleCursor = 0;
    this.speechStart = undefined;
    this.lastSpeechSample = 0;
    this.active = false;
  }
}

