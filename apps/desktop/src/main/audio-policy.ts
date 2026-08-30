import type {
  AudioCaptureMode,
  AudioChannelCapability,
  AudioChannelState,
  ProbeChannelResult
} from "@interview-copilot/protocol";

export type AudioChannelName = "mic" | "system";

export interface AudioCapabilityInput {
  state?: AudioChannelState;
  streamOk?: boolean;
  signalDetected?: boolean;
  deviceId?: string;
  deviceName?: string;
  error?: string;
  code?: string;
  firstCallbackMs?: number;
}
export interface AudioCapturePolicy {
  captureMode: AudioCaptureMode;
  micAvailable: boolean;
  systemAvailable: boolean;
}

export const AUDIO_CHANNEL_STATES: readonly AudioChannelState[] = [
  "READY",
  "SILENT",
  "UNAVAILABLE",
  "PERMISSION_DENIED",
  "DEVICE_GONE",
  "OPEN_FAILED",
  "TIMEOUT"
];

export function isAudioChannelAvailable(channel: AudioCapabilityInput | undefined): boolean {
  if (!channel) return false;
  if (channel.state === "READY" || channel.state === "SILENT") return true;
  return channel.state === undefined && channel.streamOk === true;
}

export function resolveAudioCapturePolicy(
  mic: AudioCapabilityInput | undefined,
  system: AudioCapabilityInput | undefined
): AudioCapturePolicy {
  const micAvailable = isAudioChannelAvailable(mic);
  const systemAvailable = isAudioChannelAvailable(system);
  if (micAvailable && systemAvailable) return { captureMode: "dual", micAvailable, systemAvailable };
  if (systemAvailable) return { captureMode: "system_only", micAvailable, systemAvailable };
  if (micAvailable) return { captureMode: "mic_only", micAvailable, systemAvailable };
  throw new Error("NO_AUDIO_CHANNEL_AVAILABLE: 麦克风和系统音频都不可用，请检查权限或重新选择设备");
}

export function stateForProbe(channel: ProbeChannelResult): AudioChannelState {
  if (channel.state) return channel.state;
  if (channel.streamOk) return channel.signalDetected ? "READY" : "SILENT";
  return "OPEN_FAILED";
}

export function capabilityFromProbe(channel: ProbeChannelResult): AudioChannelCapability {
  const state = stateForProbe(channel);
  return {
    state,
    available: isAudioChannelAvailable({ state }),
    ...(channel.deviceId ? { deviceId: channel.deviceId } : {}),
    ...(channel.deviceName ? { deviceName: channel.deviceName } : {}),
    signalDetected: channel.signalDetected,
    ...(channel.error ? { error: channel.error } : {}),
    ...(channel.code ? { code: channel.code } : {}),
    ...(channel.firstCallbackMs !== undefined ? { firstCallbackMs: channel.firstCallbackMs } : {})
  };
}

export function capabilityForUnavailable(
  state: AudioChannelState,
  error?: string,
  code?: string
): AudioChannelCapability {
  return {
    state,
    available: false,
    signalDetected: false,
    ...(error ? { error } : {}),
    ...(code ? { code } : {})
  };
}
