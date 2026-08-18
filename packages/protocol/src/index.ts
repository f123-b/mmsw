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

export const transcriptSourceSchema = z.enum(["mic", "remote"]);

export const transcriptSegmentSchema = z.object({
  id: z.string().min(1),
  source: transcriptSourceSchema,
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  final: z.boolean(),
  confidence: z.number().min(0).max(1).optional()
});

export const asrStatusSchema = z.object({
  type: z.literal("asr_status"),
  source: transcriptSourceSchema,
  state: z.enum(["connecting", "listening", "stopped", "error"]),
  message: z.string().optional()
});

export const connectionReadySchema = z.object({
  type: z.literal("connection_ready"),
  sessionId: z.string().min(1),
  serverTime: z.number().int().nonnegative().optional()
});

export const heartbeatAckSchema = z.object({
  type: z.literal("heartbeat_ack"),
  timestamp: z.number().int().nonnegative()
});

export const asrPartialSchema = z.object({
  type: z.literal("asr_partial"),
  segment: transcriptSegmentSchema.extend({ final: z.literal(false) })
});

export const asrFinalSchema = z.object({
  type: z.literal("asr_final"),
  segment: transcriptSegmentSchema.extend({ final: z.literal(true) })
});

export const questionCandidateSchema = z.object({
  type: z.literal("question_candidate"),
  questionId: z.string().min(1),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  complete: z.boolean().default(false)
});

export const questionConfirmedSchema = questionCandidateSchema.extend({
  type: z.literal("question_confirmed"),
  source: z.enum(["rules", "extractor"])
});

export const answerStartSchema = z.object({
  type: z.literal("answer_start"),
  answerId: z.string().min(1),
  questionId: z.string().min(1),
  mode: z.enum(["FAST", "NORMAL", "DEEP"])
});

export const answerDeltaSchema = z.object({
  type: z.literal("answer_delta"),
  answerId: z.string().min(1),
  delta: z.string()
});

export const answerEndSchema = z.object({
  type: z.literal("answer_end"),
  answerId: z.string().min(1),
  text: z.string()
});

export const answerCancelledSchema = z.object({
  type: z.literal("answer_cancelled"),
  answerId: z.string().min(1),
  reason: z.enum(["user", "superseded", "timeout"])
});

export const runtimeErrorSchema = z.object({
  type: z.literal("runtime_error"),
  code: z.enum([
    "AUDIO_DEVICE_NOT_FOUND",
    "AUDIO_DEVICE_INVALIDATED",
    "AUDIO_CAPTURE_FAILED",
    "WS_CONNECT_FAILED",
    "WS_AUTH_FAILED",
    "ASR_FAILED",
    "QUESTION_EXTRACTOR_FAILED",
    "LLM_FAILED",
    "RAG_FAILED",
    "SCREENSHOT_FAILED"
  ]),
  message: z.string().min(1),
  recoverable: z.boolean().default(true)
});

export const realtimeServerMessageSchema = z.discriminatedUnion("type", [
  connectionReadySchema,
  heartbeatAckSchema,
  asrStatusSchema,
  asrPartialSchema,
  asrFinalSchema,
  questionCandidateSchema,
  questionConfirmedSchema,
  answerStartSchema,
  answerDeltaSchema,
  answerEndSchema,
  answerCancelledSchema,
  runtimeErrorSchema
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
export type TranscriptSource = z.infer<typeof transcriptSourceSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type AsrStatus = z.infer<typeof asrStatusSchema>;
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;

export function parseAudioSidecarEvent(line: string): AudioSidecarEvent {
  return audioSidecarEventSchema.parse(JSON.parse(line));
}

export function parseRealtimeServerMessage(value: string): RealtimeServerMessage {
  return realtimeServerMessageSchema.parse(JSON.parse(value));
}
