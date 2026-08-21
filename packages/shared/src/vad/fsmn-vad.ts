import { EnergyVADProvider } from "./energy-vad";
import type { EnergyVADOptions } from "./types";

/** Interface-compatible slot for a future native FSMN-VAD binding. */
export class FSMNVADProvider extends EnergyVADProvider {
  constructor(options: EnergyVADOptions = {}) { super({ threshold: 0.01, ...options }); }
}

