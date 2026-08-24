import { EnergyVADProvider } from "./energy-vad";
import { SileroVADProvider } from "./silero-vad";
import type { VADProvider, VADProviderConfig } from "./types";

export function createVADProvider(config: VADProviderConfig = {}): VADProvider {
  if (config.provider === "energy") return new EnergyVADProvider(config);
  return new SileroVADProvider(config);
}
