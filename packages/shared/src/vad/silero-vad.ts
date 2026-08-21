import { EnergyVADProvider } from "./energy-vad";
import type { EnergyVADOptions } from "./types";

/** Silero-compatible fallback used when no native VAD model is available. */
export class SileroVADProvider extends EnergyVADProvider {
  constructor(options: EnergyVADOptions = {}) { super({ threshold: 0.012, ...options }); }
}

