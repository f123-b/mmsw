export interface VADResult {
  speech: boolean;
  startTime: number;
  endTime: number;
  confidence?: number;
}

export interface VADProvider {
  process(pcm: Uint8Array): VADResult;
  reset(): void;
}

export interface EnergyVADOptions {
  sampleRate?: number;
  threshold?: number;
  minSpeechMs?: number;
  endSilenceMs?: number;
}

