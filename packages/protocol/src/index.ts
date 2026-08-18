import { z } from "zod";

export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHANNELS = 2;
export const AUDIO_FRAME_DURATION_MS = 40;
export const AUDIO_FRAMES_PER_PACKET = AUDIO_SAMPLE_RATE * AUDIO_FRAME_DURATION_MS / 1_000;
export const AUDIO_BYTES_PER_FRAME = AUDIO_CHANNELS * 2;
export const AUDIO_PACKET_BYTES = AUDIO_FRAMES_PER_PACKET * AUDIO_BYTES_PER_FRAME;

export const audioDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["microphone", "loopback"]),
  default: z.boolean().default(false)
});

export const audioDevicesSchema = z.object({
  inputs: z.array(audioDeviceSchema),
  outputs: z.array(audioDeviceSchema)
});

export const audioHealthSchema = z.object({
  type: z.literal("audio_health"),
  mic: z.enum(["ok", "degraded", "failed"]),
  loopback: z.enum(["ok", "degraded", "failed"]),
  timestamp: z.number().int().nonnegative()
});

export const audioMeterSchema = z.object({
  type: z.literal("meter"),
  mic: z.number().min(0).max(1),
  system: z.number().min(0).max(1),
  timestamp: z.number().int().nonnegative()
});

export const audioErrorSchema = z.object({
  type: z.literal("audio_error"),
  component: z.enum(["mic", "loopback", "resampler", "device", "process"]),
  reason: z.string().min(1),
  recoverable: z.boolean().default(true),
  timestamp: z.number().int().nonnegative().optional()
});

export const audioStateSchema = z.object({
  type: z.literal("audio_state"),
  state: z.enum(["STARTING", "READY", "DEGRADED", "RECOVERING", "FAILED"]),
  timestamp: z.number().int().nonnegative()
});

export const probeChannelResultSchema = z.object({
  ok: z.boolean(),
  sampleRate: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative(),
  peak: z.number().min(0).max(1),
  callbackCount: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative()
});

export const probeResultSchema = z.object({
  type: z.literal("probe_result"),
  mic: probeChannelResultSchema,
  system: probeChannelResultSchema,
  durationMs: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative()
});

export const audioBufferSchema = z.object({
  type: z.literal("audio_buffer"),
  queuedFrames: z.number().int().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  bufferDurationMs: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative()
});

export const audioDriftSchema = z.object({
  type: z.literal("audio_drift"),
  micAvailableFrames: z.number().int().nonnegative(),
  systemAvailableFrames: z.number().int().nonnegative(),
  driftFrames: z.number().int(),
  driftMs: z.number().int(),
  status: z.enum(["normal", "warning", "degraded"]),
  timestamp: z.number().int().nonnegative()
});

export const audioSidecarEventSchema = z.discriminatedUnion("type", [
  audioHealthSchema,
  audioMeterSchema,
  audioErrorSchema,
  audioStateSchema,
  probeResultSchema,
  audioBufferSchema,
  audioDriftSchema
]);

export const clientControlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("client_ready") }),
  z.object({ type: z.literal("heartbeat"), timestamp: z.number().int().nonnegative() }),
  z.object({ type: z.literal("answer_request"), mode: z.enum(["manual_text", "latest_remote_transcript", "screenshot"]), text: z.string().optional(), attachmentId: z.string().optional() }),
  z.object({ type: z.literal("answer_cancel"), answerId: z.string(), reason: z.enum(["user", "superseded", "timeout"]).optional() })
]);

export type AudioDevice = z.infer<typeof audioDeviceSchema>;
export type AudioDevices = z.infer<typeof audioDevicesSchema>;
export type AudioHealth = z.infer<typeof audioHealthSchema>;
export type AudioMeter = z.infer<typeof audioMeterSchema>;
export type AudioError = z.infer<typeof audioErrorSchema>;
export type AudioStateEvent = z.infer<typeof audioStateSchema>;
export type ProbeChannelResult = z.infer<typeof probeChannelResultSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;
export type AudioBufferStats = z.infer<typeof audioBufferSchema>;
export type AudioDrift = z.infer<typeof audioDriftSchema>;
export type AudioSidecarEvent = z.infer<typeof audioSidecarEventSchema>;
export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

export function parseAudioSidecarEvent(line: string): AudioSidecarEvent {
  return audioSidecarEventSchema.parse(JSON.parse(line));
}
