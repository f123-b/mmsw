export interface VADResult {
  speech: boolean;
  startTime: number;
  endTime: number;
  speechProbability: number;
  speechStarted: boolean;
  speechEnded: boolean;
  /** False while an asynchronous model is warming up. */
  ready?: boolean;
  confidence?: number;
}

export interface VADProvider {
  process(pcm: Uint8Array): VADResult;
  /** Optional async form used by deterministic tests and offline callers. */
  processAsync?(pcm: Uint8Array): Promise<VADResult>;
  reset(): void;
  readonly providerName: "energy" | "silero";
  readonly fallback: boolean;
}

export interface EnergyVADOptions {
  sampleRate?: number;
  threshold?: number;
  minSpeechMs?: number;
  endSilenceMs?: number;
}

export interface VADDiagnostic {
  code: "VAD_FALLBACK_TO_ENERGY";
  provider: "silero";
  modelPath?: string;
  reason: string;
}

export interface SileroVADOptions extends EnergyVADOptions {
  modelPath?: string;
  energyThreshold?: number;
  threshold?: number;
  negativeThreshold?: number;
  onDiagnostic?: (diagnostic: VADDiagnostic) => void;
  /** Injected in tests; production uses onnxruntime-node. */
  sessionFactory?: SileroSessionFactory;
}

export type SileroTensor = {
  data: Float32Array | Int32Array | BigInt64Array | number[];
  dims: readonly number[];
};

export interface SileroSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, SileroTensor>>;
}

export type SileroSessionFactory = (modelPath: string) => Promise<SileroSession>;

export interface VADProviderConfig extends SileroVADOptions {
  provider?: "energy" | "silero";
}

