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
  component: z.enum(["mic", "loopback", "resampler", "device", "process", "permission"]),
  code: z.string().min(1).optional(),
  reason: z.string().min(1),
  recoverable: z.boolean().default(true),
  timestamp: z.number().int().nonnegative().optional()
});

export const audioChannelStateSchema = z.enum([
  "READY",
  "SILENT",
  "UNAVAILABLE",
  "PERMISSION_DENIED",
  "DEVICE_GONE",
  "OPEN_FAILED",
  "TIMEOUT"
]);

export const audioCaptureModeSchema = z.enum(["dual", "system_only", "mic_only"]);

export const audioChannelCapabilitySchema = z.object({
  state: audioChannelStateSchema,
  available: z.boolean(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  sampleRate: z.number().int().nonnegative().optional(),
  channels: z.number().int().nonnegative().optional(),
  signalDetected: z.boolean().default(false),
  error: z.string().optional(),
  code: z.string().optional(),
  firstCallbackMs: z.number().int().nonnegative().optional()
});

export const audioCapabilitySchema = z.object({
  type: z.literal("audio_capability"),
  captureMode: audioCaptureModeSchema,
  mic: audioChannelCapabilitySchema,
  system: audioChannelCapabilitySchema,
  timestamp: z.number().int().nonnegative(),
  source: z.enum(["probe", "capture", "recovery"]).optional()
});

export const audioProbeTraceSchema = z.object({
  type: z.literal("audio_probe_trace"),
  stage: z.enum(["sidecar_spawned", "device_enumerated", "config_resolved", "stream_built", "stream_started", "first_callback", "result_emitted", "process_exited"]),
  channel: z.enum(["mic", "system"]).optional(),
  elapsedMs: z.number().int().nonnegative(),
  details: z.string().optional(),
  timestamp: z.number().int().nonnegative()
});

export const audioStateSchema = z.object({
  type: z.literal("audio_state"),
  state: z.enum(["STARTING", "READY", "DEGRADED", "RECOVERING", "FAILED"]),
  captureMode: audioCaptureModeSchema.optional(),
  timestamp: z.number().int().nonnegative()
});

export const probeChannelResultSchema = z.object({
  ok: z.boolean(),
  streamOk: z.boolean(),
  signalDetected: z.boolean(),
  sampleRate: z.number().int().nonnegative(),
  channels: z.number().int().nonnegative(),
  peak: z.number().min(0).max(1),
  callbackCount: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  state: audioChannelStateSchema.optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  firstCallbackMs: z.number().int().nonnegative().optional()
});

export const probeResultSchema = z.object({
  type: z.literal("probe_result"),
  mic: probeChannelResultSchema,
  system: probeChannelResultSchema,
  captureMode: audioCaptureModeSchema.optional(),
  trace: z.array(audioProbeTraceSchema).optional(),
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
  audioCapabilitySchema,
  audioProbeTraceSchema,
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
  /** Provider-side speech item. Partial and final events for one utterance share it. */
  utteranceId: z.string().min(1).optional(),
  /** Optional provider/VAD end-of-turn marker. */
  endpoint: z.boolean().optional(),
  speechFinal: z.boolean().optional(),
  utteranceEnd: z.boolean().optional(),
  endOfTurn: z.boolean().optional(),
  confidence: z.number().min(0).max(1).optional()
});

export const asrStatusSchema = z.object({
  type: z.literal("asr_status"),
  source: transcriptSourceSchema,
  state: z.enum(["connecting", "listening", "stopped", "error"]),
  message: z.string().optional()
});

export const asrProviderTypeSchema = z.enum(["deepgram", "qwen", "openai", "groq", "siliconflow", "openai-compatible", "elevenlabs", "azure", "google", "assemblyai", "volcengine", "baidu", "tencent", "custom-gateway", "funasr-local"]);
export const asrLanguageSchema = z.enum(["zh-CN", "en-US", "multi"]);

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
  mode: z.enum(["FAST", "NORMAL", "DEEP"]),
  model: z.string().min(1),
  groupId: z.string().min(1).optional(),
  relation: z.enum(["PRIMARY", "AUGMENTATION", "FOLLOW_UP", "PARALLEL_SUBQUESTION"]).optional()
});

export const answerDeltaSchema = z.object({
  type: z.literal("answer_delta"),
  answerId: z.string().min(1),
  delta: z.string()
});

export const answerQualitySchema = z.object({
  score: z.number().min(0).max(1),
  issues: z.array(z.string()),
  suggestions: z.array(z.string())
});

export const answerEndSchema = z.object({
  type: z.literal("answer_end"),
  answerId: z.string().min(1),
  text: z.string(),
  quality: answerQualitySchema.optional()
});

export const answerCancelledSchema = z.object({
  type: z.literal("answer_cancelled"),
  answerId: z.string().min(1),
  reason: z.enum(["user", "superseded", "timeout"])
});

export const answerResetSchema = z.object({
  type: z.literal("answer_reset"),
  questionId: z.string().min(1)
});

const questionGroupItemSchema = z.object({
  id: z.string().min(1),
  questionId: z.string().min(1),
  text: z.string(),
  type: z.enum(["TOPIC_FRAGMENT", "QUESTION_NUCLEUS", "ANSWER_CONSTRAINT", "EXAMPLE", "SAME_QUESTION_AUGMENTATION", "PARALLEL_SUBQUESTION", "FOLLOW_UP", "NEW_TOPIC", "ASR_REVISION"]),
  answerable: z.boolean(),
  state: z.enum(["pending", "queued", "answering", "answered", "cancelled", "ignored"])
});

const questionGroupSlotSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  status: z.enum(["pending", "covered", "answered", "merged", "skipped"])
});

export const questionGroupUpdatedSchema = z.object({
  type: z.literal("question_group_updated"),
  groupId: z.string().min(1),
  title: z.string(),
  // Context-only fragments never reach this wire event. Keep the field
  // optional for backwards-compatible clients, while new emitters always
  // provide the committed primary question and display flags.
  primaryQuestion: z.string().min(1).optional(),
  displayable: z.boolean().optional(),
  hasAnswerableQuestion: z.boolean().optional(),
  status: z.enum(["collecting", "answering", "active", "closed"]).optional(),
  items: z.array(questionGroupItemSchema),
  slots: z.array(questionGroupSlotSchema),
  updatedAt: z.number()
});

export const runtimeErrorSchema = z.object({
  type: z.literal("runtime_error"),
  questionId: z.string().min(1).optional(),
  code: z.enum([
    "AUDIO_DEVICE_NOT_FOUND",
    "AUDIO_DEVICE_INVALIDATED",
    "AUDIO_CAPTURE_FAILED",
    "WS_CONNECT_FAILED",
    "WS_AUTH_FAILED",
    "ASR_FAILED",
    "QUESTION_EXTRACTOR_FAILED",
    "QUESTION_FAILED",
    "PROJECT_CONTEXT_MISMATCH",
    "PROJECT_EVIDENCE_REQUIRED",
    "LLM_FAILED",
    "RAG_FAILED",
    "DB_FAILED",
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
  answerResetSchema,
  questionGroupUpdatedSchema,
  runtimeErrorSchema
]);

export const clientControlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("client_ready"), providerName: z.string().optional(), model: z.string().optional(), language: asrLanguageSchema.optional() }).strict(),
  z.object({ type: z.literal("heartbeat"), timestamp: z.number().int().nonnegative() }),
  z.object({ type: z.literal("answer_request"), mode: z.enum(["manual_text", "latest_remote_transcript", "screenshot"]), text: z.string().optional(), attachmentId: z.string().optional() }),
  z.object({ type: z.literal("answer_cancel"), answerId: z.string(), reason: z.enum(["user", "superseded", "timeout"]).optional() })
]);

export type AudioDevice = z.infer<typeof audioDeviceSchema>;
export type AudioDevices = z.infer<typeof audioDevicesSchema>;
export type AudioHealth = z.infer<typeof audioHealthSchema>;
export type AudioMeter = z.infer<typeof audioMeterSchema>;
export type AudioError = z.infer<typeof audioErrorSchema>;
export type AudioChannelState = z.infer<typeof audioChannelStateSchema>;
export type AudioCaptureMode = z.infer<typeof audioCaptureModeSchema>;
export type AudioChannelCapability = z.infer<typeof audioChannelCapabilitySchema>;
export type AudioCapability = z.infer<typeof audioCapabilitySchema>;
export type AudioProbeTrace = z.infer<typeof audioProbeTraceSchema>;
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
export type AsrProviderType = z.infer<typeof asrProviderTypeSchema>;
export type AsrLanguage = z.infer<typeof asrLanguageSchema>;
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;

export function parseAudioSidecarEvent(line: string): AudioSidecarEvent {
  return audioSidecarEventSchema.parse(JSON.parse(line));
}

export function parseRealtimeServerMessage(value: string): RealtimeServerMessage {
  return realtimeServerMessageSchema.parse(JSON.parse(value));
}
