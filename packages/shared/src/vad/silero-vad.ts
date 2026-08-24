/// <reference path="../types/onnxruntime-node.d.ts" />
import * as ort from "onnxruntime-node";
import { EnergyVADProvider } from "./energy-vad";
import type {
  EnergyVADOptions,
  SileroSession,
  SileroSessionFactory,
  SileroTensor,
  SileroVADOptions,
  VADProvider,
  VADResult
} from "./types";

const WINDOW_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const STATE_SIZE = 2 * 1 * 128;
const MAX_QUEUED_INFERENCE_WINDOWS = 32;

const sessionCache = new Map<string, Promise<SileroSession>>();

function defaultSessionFactory(modelPath: string): Promise<SileroSession> {
  const cached = sessionCache.get(modelPath);
  if (cached) return cached;
  const sessionPromise = ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] }) as unknown as Promise<SileroSession>;
  sessionCache.set(modelPath, sessionPromise);
  return sessionPromise;
}

function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  if (pcm.byteLength % 2 !== 0) throw new Error("VAD expects PCM16 bytes");
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(pcm.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32_768;
  return samples;
}

function floatTensor(data: Float32Array, dims: number[]): ort.Tensor {
  return new ort.Tensor("float32", data, dims);
}

function int64Tensor(value: number): ort.Tensor {
  return new ort.Tensor("int64", BigInt64Array.from([BigInt(value)]), [1]);
}

function tensorData(tensor: SileroTensor | undefined): Float32Array {
  if (!tensor) throw new Error("Silero VAD output is missing");
  return tensor.data instanceof Float32Array ? tensor.data : Float32Array.from(Array.from(tensor.data as ArrayLike<number>).map(Number));
}

/**
 * Streaming Silero VAD backed by ONNX Runtime.
 *
 * ONNX execution is deliberately queued and asynchronous. `process()` never
 * waits on model loading or inference, so an audio packet cannot block the
 * Electron event loop. `processAsync()` is available for tests/offline users.
 */
export class SileroVADProvider implements VADProvider {
  readonly providerName = "silero" as const;
  private readonly modelPath?: string;
  private readonly threshold: number;
  private readonly negativeThreshold: number;
  private readonly sampleRate: number;
  private readonly minSpeechSamples: number;
  private readonly endSilenceSamples: number;
  private readonly onDiagnostic?: SileroVADOptions["onDiagnostic"];
  private readonly sessionFactory: SileroSessionFactory;
  private readonly fallbackOptions: EnergyVADOptions;
  private fallbackProvider?: EnergyVADProvider;
  private sessionPromise?: Promise<SileroSession>;
  private inferenceTail: Promise<VADResult>;
  private queuedInferenceWindows = 0;
  private pendingSamples = new Float32Array(0);
  private modelCursor = 0;
  private sampleCursor = 0;
  private context = new Float32Array(CONTEXT_SAMPLES);
  private state = new Float32Array(STATE_SIZE);
  private speechStart?: number;
  private lastSpeechSample = 0;
  private silenceStart?: number;
  private active = false;
  private lastResult: VADResult;
  private generation = 0;
  private fallbackValue = false;
  private diagnosticEmitted = false;

  constructor(options: SileroVADOptions = {}) {
    this.modelPath = options.modelPath;
    this.threshold = options.threshold ?? 0.5;
    this.negativeThreshold = options.negativeThreshold ?? Math.max(0.01, this.threshold - 0.15);
    this.sampleRate = options.sampleRate ?? 16_000;
    if (this.sampleRate !== 16_000) throw new Error("Silero VAD currently supports PCM16 16kHz mono only");
    this.minSpeechSamples = Math.max(1, Math.round((options.minSpeechMs ?? 250) * this.sampleRate / 1_000));
    this.endSilenceSamples = Math.max(1, Math.round((options.endSilenceMs ?? 100) * this.sampleRate / 1_000));
    this.onDiagnostic = options.onDiagnostic;
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    this.fallbackOptions = {
      sampleRate: this.sampleRate,
      threshold: options.energyThreshold ?? 0.012,
      minSpeechMs: options.minSpeechMs,
      endSilenceMs: options.endSilenceMs
    };
    this.lastResult = this.emptyResult(Boolean(!this.modelPath));
    this.inferenceTail = Promise.resolve(this.lastResult);
    if (!this.modelPath) {
      this.fallbackProvider = new EnergyVADProvider(this.fallbackOptions);
      this.activateFallback("Silero modelPath was not configured");
    }
  }

  get fallback(): boolean { return this.fallbackValue; }
  get ready(): boolean { return this.lastResult.ready ?? false; }

  process(pcm: Uint8Array): VADResult {
    if (this.fallbackProvider) return this.fallbackProvider.process(pcm);
    if (pcm.byteLength % 2 !== 0) throw new Error("VAD expects PCM16 bytes");
    const samples = pcm16ToFloat32(pcm);
    this.sampleCursor += samples.length;
    this.pendingSamples = this.concat(this.pendingSamples, samples) as Float32Array<ArrayBuffer>;
    void this.enqueueWindows();
    return this.lastResult;
  }

  async processAsync(pcm: Uint8Array): Promise<VADResult> {
    if (this.fallbackProvider) return this.fallbackProvider.processAsync(pcm);
    if (pcm.byteLength % 2 !== 0) throw new Error("VAD expects PCM16 bytes");
    const samples = pcm16ToFloat32(pcm);
    this.sampleCursor += samples.length;
    this.pendingSamples = this.concat(this.pendingSamples, samples) as Float32Array<ArrayBuffer>;
    await this.enqueueWindows();
    return this.lastResult;
  }

  reset(): void {
    this.generation += 1;
    this.pendingSamples = new Float32Array(0);
    this.modelCursor = 0;
    this.sampleCursor = 0;
    this.context = new Float32Array(CONTEXT_SAMPLES);
    this.state = new Float32Array(STATE_SIZE);
    this.speechStart = undefined;
    this.lastSpeechSample = 0;
    this.silenceStart = undefined;
    this.active = false;
    this.lastResult = this.emptyResult(false);
    this.fallbackProvider?.reset();
  }

  private async enqueueWindows(): Promise<void> {
    while (this.pendingSamples.length >= WINDOW_SAMPLES) {
      const window = this.pendingSamples.slice(0, WINDOW_SAMPLES);
      this.pendingSamples = this.pendingSamples.slice(WINDOW_SAMPLES);
      const start = this.modelCursor;
      this.modelCursor += WINDOW_SAMPLES;
      if (this.queuedInferenceWindows >= MAX_QUEUED_INFERENCE_WINDOWS) {
        // VAD is an endpoint aid, not a reason to retain unbounded audio or
        // promises. The ASR stream remains authoritative if this guard trips.
        this.lastResult = { ...this.lastResult, ready: false };
        continue;
      }
      const generation = this.generation;
      this.queuedInferenceWindows += 1;
      this.inferenceTail = this.inferenceTail
        .catch(() => this.lastResult)
        .then(() => this.infer(window, start, generation))
        .finally(() => { this.queuedInferenceWindows = Math.max(0, this.queuedInferenceWindows - 1); });
      await this.inferenceTail;
    }
  }

  private async infer(window: Float32Array, frameStart: number, generation: number): Promise<VADResult> {
    try {
      const session = await this.loadSession();
      if (generation !== this.generation) return this.lastResult;
      const input = new Float32Array(CONTEXT_SAMPLES + WINDOW_SAMPLES);
      input.set(this.context);
      input.set(window, CONTEXT_SAMPLES);
      const output = await session.run({
        input: floatTensor(input, [1, input.length]),
        state: floatTensor(this.state, [2, 1, 128]),
        sr: int64Tensor(this.sampleRate)
      });
      if (generation !== this.generation) return this.lastResult;
      const probability = Math.max(0, Math.min(1, Number(tensorData(output.output)[0] ?? 0)));
      const nextState = tensorData(output.stateN);
      if (nextState.length === STATE_SIZE) this.state = nextState as Float32Array<ArrayBuffer>;
      this.context = input.slice(input.length - CONTEXT_SAMPLES) as Float32Array<ArrayBuffer>;
      this.lastResult = this.applyProbability(probability, frameStart, frameStart + WINDOW_SAMPLES);
      return this.lastResult;
    } catch (error) {
      this.activateFallback(error instanceof Error ? error.message : String(error));
      const result = this.fallbackProvider?.process(this.toPcm16(window)) ?? this.lastResult;
      this.lastResult = { ...result, ready: true };
      return this.lastResult;
    }
  }

  private async loadSession(): Promise<SileroSession> {
    if (!this.modelPath) throw new Error("Silero modelPath was not configured");
    this.sessionPromise ??= this.sessionFactory(this.modelPath);
    return this.sessionPromise;
  }

  private applyProbability(probability: number, frameStart: number, frameEnd: number): VADResult {
    const wasActive = this.active;
    let speechStarted = false;
    let speechEnded = false;
    if (probability >= this.threshold) {
      this.speechStart ??= frameStart;
      this.lastSpeechSample = frameEnd;
      this.silenceStart = undefined;
      if (!this.active && this.lastSpeechSample - this.speechStart >= this.minSpeechSamples) {
        this.active = true;
        speechStarted = true;
      }
    } else if (probability < this.negativeThreshold) {
      if (this.active) {
        this.silenceStart ??= frameStart;
        if (frameEnd - this.silenceStart >= this.endSilenceSamples) {
          this.active = false;
          speechEnded = true;
          this.lastSpeechSample = this.silenceStart;
          this.speechStart = undefined;
          this.silenceStart = undefined;
        }
      } else if (this.speechStart !== undefined && frameEnd - this.lastSpeechSample >= this.endSilenceSamples) {
        this.speechStart = undefined;
      }
    }
    const result: VADResult = {
      speech: this.active,
      startTime: Math.round(((this.speechStart ?? frameStart) / this.sampleRate) * 1_000),
      endTime: Math.round(((this.active ? this.lastSpeechSample : this.silenceStart ?? frameEnd) / this.sampleRate) * 1_000),
      speechProbability: probability,
      speechStarted,
      speechEnded,
      ready: true,
      confidence: probability
    };
    if (speechStarted && !wasActive) result.startTime = Math.round(((this.speechStart ?? frameStart) / this.sampleRate) * 1_000);
    return result;
  }

  private activateFallback(reason: string): void {
    this.fallbackProvider ??= new EnergyVADProvider(this.fallbackOptions);
    this.fallbackValue = true;
    if (this.diagnosticEmitted) return;
    this.diagnosticEmitted = true;
    this.onDiagnostic?.({ code: "VAD_FALLBACK_TO_ENERGY", provider: "silero", modelPath: this.modelPath, reason });
  }

  private emptyResult(ready: boolean): VADResult {
    return { speech: false, startTime: 0, endTime: 0, speechProbability: 0, speechStarted: false, speechEnded: false, ready, confidence: 0 };
  }

  private concat(left: Float32Array, right: Float32Array): Float32Array {
    const output = new Float32Array(left.length + right.length);
    output.set(left);
    output.set(right, left.length);
    return output;
  }

  private toPcm16(samples: Float32Array): Uint8Array {
    const output = new Uint8Array(samples.length * 2);
    const view = new DataView(output.buffer);
    for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, Math.max(-1, Math.min(1, samples[index] ?? 0)) * 32_767, true);
    return output;
  }
}
