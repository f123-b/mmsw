import { ASR_PRESETS, usesHttpAsr } from "@interview-copilot/shared";
import { HttpStreamingAsrProvider } from "./http-asr-provider";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";
import {
  clientControlMessageSchema,
  parseRealtimeServerMessage,
  type ClientControlMessage,
  type RealtimeServerMessage
} from "@interview-copilot/protocol";
import {
  DeepgramStreamingAsrProvider,
  PcmBackpressureQueue,
  ProviderError,
  QwenRealtimeAsrProvider,
  DashScopeTaskStreamingAsrProvider,
  usesQwenRealtimeProtocol,
  QWEN_REALTIME_ASR_MODEL,
  LocalFunASRProvider,
  StereoAsrChannelRouter,
  TranscriptStabilizer,
  type AsrLanguage,
  type AsrProviderType,
  type ProviderSettings,
  type StreamingAsrSocket,
  type TranscriptSnapshot,
  splitStereoPcm
} from "@interview-copilot/shared";
import { createVADProvider, type VADDiagnostic, type VADProvider, type VADResult, type VADStatus } from "@interview-copilot/shared/vad";
import type { LocalAsrServiceManager } from "./local-asr-service-manager";

export type RealtimeConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export interface RealtimeConnectOptions {
  url?: string;
  gatewayToken?: string;
  providerType?: AsrProviderType;
  providerName?: string;
  model?: string;
  language?: AsrLanguage;
  autoReconnect?: boolean;
}

export interface RealtimeSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((error?: Error) => void) | null;
  onclose: ((error?: Error) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export type RealtimeSocketFactory = (url: string) => RealtimeSocket;

export interface AsrRuntimeDiagnostics {
  provider: string;
  model: string;
  language: string;
  micState: "connecting" | "listening" | "error" | "stopped";
  remoteState: "connecting" | "listening" | "error" | "stopped";
  lastPartialObservedLatencyMs?: number;
  lastFinalObservedLatencyMs?: number;
  reconnectCount: number;
  droppedPcmPackets: number;
  vadProvider: "silero" | "energy" | "unknown";
  speechProbability: { mic: number; remote: number };
  micSpeech: boolean;
  remoteSpeech: boolean;
  fallback: boolean;
  vadReady: boolean;
  vadReason: string;
  lastSpeechStart: { mic?: number; remote?: number };
  lastSpeechEnd: { mic?: number; remote?: number };
}

export type RealtimeVADProviderFactory = (source: "mic" | "remote", onDiagnostic: (diagnostic: VADDiagnostic) => void) => VADProvider;

const OPEN = 1;
const MAX_SOCKET_BUFFER_BYTES = 192_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export function realtimeReconnectDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, Math.floor(attempt)), RETRY_DELAYS_MS.length - 1)];
}

function withGatewayToken(url: string, gatewayToken?: string): string {
  if (!gatewayToken) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("ticket", gatewayToken);
  return parsed.toString();
}

function messageCode(error: ProviderError | Error | unknown): "WS_AUTH_FAILED" | "ASR_FAILED" {
  return error instanceof ProviderError && error.code === "AUTH_FAILED" ? "WS_AUTH_FAILED" : "ASR_FAILED";
}

function messageText(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function defaultSileroModelPath(): string | undefined {
  const candidates = [
    process.env.INTERVIEW_COPILOT_VAD_MODEL,
    process.resourcesPath ? join(process.resourcesPath, "vad", "silero_vad_16k_op15.onnx") : undefined,
    join(process.cwd(), "models", "vad", "silero_vad_16k_op15.onnx"),
    join(process.cwd(), "apps", "desktop", "models", "vad", "silero_vad_16k_op15.onnx"),
    join(__dirname, "..", "..", "models", "vad", "silero_vad_16k_op15.onnx")
  ];
  return candidates.find((candidate) => Boolean(candidate && existsSync(candidate)));
}

function defaultVADProviderFactory(source: "mic" | "remote", onDiagnostic: (diagnostic: VADDiagnostic) => void): VADProvider {
  return createVADProvider({
    provider: "silero",
    modelPath: defaultSileroModelPath(),
    onDiagnostic,
    sampleRate: 16_000,
    minSpeechMs: 80,
    endSilenceMs: 320
  });
}

function vadStatus(provider: VADProvider, result?: VADResult): VADStatus {
  return provider.getStatus?.() ?? {
    provider: provider.providerName,
    fallback: provider.fallback,
    ready: result?.ready ?? false,
    reason: provider.fallback ? "fallback-to-energy" : provider.providerName === "silero" ? "model-status-unavailable" : "energy-threshold"
  };
}

class WsStreamingAsrSocket implements StreamingAsrSocket {
  constructor(private readonly socket: WebSocket, private readonly providerName: string) {}

  waitForOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socket.readyState === WebSocket.CLOSING || this.socket.readyState === WebSocket.CLOSED) return Promise.reject(new Error(`${this.providerName} WebSocket is closed`));
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error(`${this.providerName} WebSocket closed before OPEN`)); };
      const cleanup = () => {
        this.socket.off("open", onOpen);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      this.socket.once("open", onOpen);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }

  send(data: Uint8Array | string): void { this.socket.send(data); }
  close(): void { if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close(); }
  onMessage(listener: (data: string) => void): void { this.socket.on("message", (data: RawData) => listener(data.toString())); }
  onError(listener: (error: Error) => void): void { this.socket.on("error", listener); }
  onClose(listener: (error?: Error) => void): void { this.socket.on("close", () => listener()); }
}

function createDeepgramSocket(options: { url: string; apiKey: string }): StreamingAsrSocket {
  return new WsStreamingAsrSocket(new WebSocket(options.url, { headers: { Authorization: `Token ${options.apiKey}` } }), "Deepgram");
}

function createQwenSocket(options: { url: string; apiKey: string }): StreamingAsrSocket {
  return new WsStreamingAsrSocket(new WebSocket(options.url, { headers: { Authorization: `Bearer ${options.apiKey}`, "OpenAI-Beta": "realtime=v1" } }), "Qwen ASR");
}

function createLocalAsrSocket(options: { url: string; apiKey?: string }): StreamingAsrSocket {
  return new WsStreamingAsrSocket(new WebSocket(options.url), "Local Fun-ASR-Nano");
}

export class RealtimeSession extends EventEmitter {
  private socket: RealtimeSocket | undefined;
  private options: RealtimeConnectOptions | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private manualStop = true;
  private state: RealtimeConnectionState = "disconnected";
  private readonly audioQueue = new PcmBackpressureQueue(192_000);
  private readonly stabilizer = new TranscriptStabilizer();
  private readonly micVad: VADProvider;
  private readonly remoteVad: VADProvider;
  private directRouter: StereoAsrChannelRouter | undefined;
  private directGeneration = 0;
  private handledDirectFailureGeneration = 0;
  private lastBackpressureDiagnosticAt = 0;
  private lastVadDiagnosticAt = 0;
  private audioTimelineOriginAt = 0;
  private diagnostics: AsrRuntimeDiagnostics = {
    provider: "unknown",
    model: "",
    language: "",
    micState: "stopped",
    remoteState: "stopped",
    reconnectCount: 0,
    droppedPcmPackets: 0,
    vadProvider: "unknown",
    speechProbability: { mic: 0, remote: 0 },
    micSpeech: false,
    remoteSpeech: false,
    fallback: false,
    vadReady: false,
    vadReason: "not-initialized",
    lastSpeechStart: {},
    lastSpeechEnd: {}
  };

  constructor(
    private readonly socketFactory: RealtimeSocketFactory = (url) => new WebSocket(url) as unknown as RealtimeSocket,
    private readonly directAsrSettingsProvider?: () => ProviderSettings | undefined,
    private readonly directSocketFactory = createDeepgramSocket,
    private readonly qwenSocketFactory = createQwenSocket,
    private readonly localSocketFactory = createLocalAsrSocket,
    private readonly localAsrServiceManager?: LocalAsrServiceManager,
    vadProviderFactory: RealtimeVADProviderFactory = defaultVADProviderFactory
  ) {
    super();
    const onVadDiagnostic = (diagnostic: VADDiagnostic) => this.handleVADDiagnostic(diagnostic);
    this.micVad = vadProviderFactory("mic", onVadDiagnostic);
    this.remoteVad = vadProviderFactory("remote", onVadDiagnostic);
    this.diagnostics = {
      ...this.diagnostics,
      vadProvider: this.micVad.providerName,
      fallback: this.micVad.fallback || this.remoteVad.fallback,
      vadReady: vadStatus(this.micVad).ready && vadStatus(this.remoteVad).ready,
      vadReason: vadStatus(this.micVad).reason
    };
  }

  get connectionState(): RealtimeConnectionState { return this.state; }
  get pendingAudioStats(): { queuedBytes: number; queuedPackets: number; droppedPackets: number } { return this.audioQueue.stats; }
  get asrDiagnostics(): AsrRuntimeDiagnostics { return { ...this.diagnostics }; }

  connect(options: RealtimeConnectOptions): void {
    this.disconnect(false);
    this.options = { ...options, autoReconnect: options.autoReconnect ?? true };
    this.manualStop = false;
    this.reconnectAttempt = 0;
    this.diagnostics = {
      ...this.diagnostics,
      provider: options.providerType === "qwen" ? "Qwen Direct" : options.providerType === "deepgram" ? "Deepgram Direct" : options.providerType === "funasr-local" ? "Local Fun-ASR-Nano" : options.providerType === "custom-gateway" ? "Custom Gateway" : options.providerType ? ASR_PRESETS[options.providerType].name : "unknown",
      model: options.model ?? "",
      language: options.language ?? "",
      micState: "connecting",
      remoteState: "connecting",
      reconnectCount: 0,
      droppedPcmPackets: this.audioQueue.stats.droppedPackets
    };
    this.audioTimelineOriginAt = 0;
    this.micVad.reset();
    this.remoteVad.reset();
    this.resetVadDiagnostics();
    this.emitDiagnostics();
    this.openSocket();
  }

  async finalize(timeoutMs = 1_000): Promise<void> {
    if (this.directRouter) await this.directRouter.finalize(timeoutMs);
  }

  disconnect(clearOptions = true): void {
    this.manualStop = true;
    this.clearReconnectTimer();
    this.directGeneration += 1;
    this.directRouter?.close();
    this.directRouter = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.audioQueue.clear();
    this.lastBackpressureDiagnosticAt = 0;
    this.lastVadDiagnosticAt = 0;
    this.audioTimelineOriginAt = 0;
    this.micVad.reset();
    this.remoteVad.reset();
    this.resetVadDiagnostics();
    this.stabilizer.clear();
    if (clearOptions) this.options = undefined;
    this.diagnostics = { ...this.diagnostics, micState: "stopped", remoteState: "stopped" };
    this.emitDiagnostics();
    this.setState("disconnected");
  }

  sendAudio(packet: Uint8Array): void {
    if (this.manualStop || this.state === "disconnected" || this.state === "reconnecting" || this.state === "error") return;
    // VAD is diagnostic/endpoint metadata only. Every PCM packet must reach
    // the ASR stream so model warm-up, low-volume onset, and silence context
    // cannot cause the beginning of a spoken turn to disappear.
    this.processVAD(packet);
    this.audioTimelineOriginAt ||= Date.now();
    if (this.directRouter && this.state === "connected" && this.directRouter.isReady) {
      try {
        this.directRouter.sendStereo(packet);
        return;
      } catch (error) {
        this.handleDirectFailure(error, this.directGeneration);
      }
    } else if (this.isSocketWritable()) {
      const bufferedAmount = this.socket?.bufferedAmount ?? 0;
      if (bufferedAmount <= MAX_SOCKET_BUFFER_BYTES) {
        try {
          this.socket?.send(packet);
          return;
        } catch (error) {
          this.emit("diagnostic", `Realtime audio send failed: ${String(error)}`);
        }
      }
    }
    const stats = this.audioQueue.push(packet);
    if (stats.droppedPackets !== this.diagnostics.droppedPcmPackets) {
      this.diagnostics = { ...this.diagnostics, droppedPcmPackets: stats.droppedPackets };
      this.emitDiagnostics();
      const now = Date.now();
      if (stats.droppedPackets > 0 && now - this.lastBackpressureDiagnosticAt >= 1_000) {
        this.lastBackpressureDiagnosticAt = now;
        this.emit("diagnostic", `Realtime audio backpressure dropped ${stats.droppedPackets} packet(s)`);
      }
    }
  }

  private processVAD(packet: Uint8Array): void {
    // The sidecar emits interleaved stereo PCM16. Tiny packets are still sent
    // to ASR, but are too short to produce useful channel-level VAD metadata.
    if (packet.byteLength < 160 || packet.byteLength % 4 !== 0) return;
    const channels = splitStereoPcm(packet);
    const mic = this.micVad.process(channels.mic);
    const remote = this.remoteVad.process(channels.system);
    this.updateVADDiagnostics("mic", mic, this.micVad);
    this.updateVADDiagnostics("remote", remote, this.remoteVad);
  }

  sendControl(message: ClientControlMessage): void {
    const validated = clientControlMessageSchema.parse(message);
    if (!this.isSocketWritable()) return;
    this.socket?.send(JSON.stringify(validated));
  }

  sendHeartbeat(timestamp = Date.now()): void { this.sendControl({ type: "heartbeat", timestamp }); }

  private openSocket(): void {
    if (this.manualStop || !this.options) return;
    if (this.options.providerType && this.options.providerType !== "custom-gateway") {
      void this.openDirectAsr();
      return;
    }
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    try {
      if (!this.options.url) throw new Error("Custom ASR Gateway URL is required");
      const socket = this.socketFactory(withGatewayToken(this.options.url, this.options.gatewayToken));
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => this.handleOpen(socket);
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = (error) => this.handleSocketFailure(socket, error, "Realtime WebSocket error");
      socket.onclose = (error) => this.handleSocketFailure(socket, error, "Realtime WebSocket closed");
    } catch (error) {
      this.handleSocketFailure(undefined, error instanceof Error ? error : undefined, `Realtime WebSocket connect failed: ${String(error)}`);
    }
  }

  private async openDirectAsr(): Promise<void> {
    const options = this.options;
    if (!options || this.manualStop) return;
    const generation = ++this.directGeneration;
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    const settings = this.directAsrSettingsProvider?.();
    const providerType = options.providerType ?? settings?.providerType ?? "deepgram";
    if (providerType !== "funasr-local" && !settings?.apiKey && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(settings?.baseUrl ?? "")) {
      this.handleDirectFailure(new ProviderError("AUTH_FAILED", `${ASR_PRESETS[providerType].name} API Key 未配置，请先在设置中保存 API Key`, false), generation);
      return;
    }
    const model = options.model || settings?.model || (providerType === "qwen" ? QWEN_REALTIME_ASR_MODEL : providerType === "funasr-local" ? "funasr-nano:q8" : "nova-3");
    const language = options.language || settings?.language || "zh-CN";
    const httpSettings: ProviderSettings = { ...settings!, providerType, model, language, baseUrl: options.url || settings?.baseUrl || ASR_PRESETS[providerType].baseUrl };
    const createProvider = () => usesHttpAsr(httpSettings) ? new HttpStreamingAsrProvider(httpSettings) : providerType === "funasr-local"
      ? new LocalFunASRProvider(this.localSocketFactory, "remote", { url: options.url || settings?.baseUrl, model, language, sampleRate: 16_000, channels: 1, vad: true })
      : providerType === "qwen"
      ? (settings?.asrProtocol === "qwen-realtime" || settings?.asrProtocol !== "dashscope-streaming" && usesQwenRealtimeProtocol(model))
        ? new QwenRealtimeAsrProvider({ baseUrl: options.url || settings?.baseUrl, model, language, apiKey: settings?.apiKey ?? "" }, this.qwenSocketFactory)
        : new DashScopeTaskStreamingAsrProvider({ baseUrl: options.url || settings?.baseUrl, model, language, apiKey: settings?.apiKey ?? "" }, this.qwenSocketFactory)
      : new DeepgramStreamingAsrProvider({ baseUrl: options.url || settings?.baseUrl, model, language, apiKey: settings?.apiKey ?? "" }, this.directSocketFactory);
    const router = new StereoAsrChannelRouter(createProvider(), createProvider());
    this.directRouter = router;
    this.emitAsrStatus("mic", "connecting");
    this.emitAsrStatus("remote", "connecting");
    try {
      if (providerType === "funasr-local") {
        await this.localAsrServiceManager?.ensureRunning({
          webSocketUrl: options.url || settings?.baseUrl,
          model
        });
      }
      await router.connect((segment) => this.handleDirectSegment(segment), (error) => this.handleDirectProviderError(error, generation));
      if (this.manualStop || generation !== this.directGeneration || this.directRouter !== router) {
        router.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.emit("message", { type: "connection_ready", sessionId: randomUUID(), serverTime: Date.now() } satisfies RealtimeServerMessage);
      this.emitAsrStatus("mic", "listening");
      this.emitAsrStatus("remote", "listening");
      this.flushAudio();
      this.emit("connected");
    } catch (error) {
      this.handleDirectFailure(error, generation);
    }
  }

  private handleOpen(socket: RealtimeSocket): void {
    if (this.socket !== socket || this.manualStop) return;
    this.reconnectAttempt = 0;
    this.setState("connected");
    this.sendControl({ type: "client_ready", providerName: this.options?.providerName, model: this.options?.model, language: this.options?.language });
    this.flushAudio();
    this.emit("connected");
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    try {
      const message = parseRealtimeServerMessage(data);
      this.handleServerMessage(message);
    } catch (error) {
      this.emit("diagnostic", `Invalid realtime message: ${String(error)}`);
    }
  }

  private handleServerMessage(message: RealtimeServerMessage): void {
    this.emit("message", message);
    if (message.type === "asr_status") {
      this.updateChannelDiagnostic(message.source, message.state === "listening" ? "listening" : message.state === "error" ? "error" : message.state === "connecting" ? "connecting" : "stopped");
    }
    if (message.type === "asr_partial" || message.type === "asr_final") {
      this.recordAsrLatency(message.type === "asr_final", message.segment.endMs);
      const update = this.stabilizer.upsert(message.segment);
      this.emit("transcript", update.snapshot, update.segment);
    }
    if (message.type === "runtime_error") this.emit("runtime-error", message);
  }

  private handleDirectSegment(segment: { source: "mic" | "remote"; text: string; startMs: number; endMs: number; final: boolean; confidence?: number; utteranceId?: string; endpoint?: boolean; speechFinal?: boolean; utteranceEnd?: boolean; endOfTurn?: boolean }): void {
    // Keep partial/final events for one provider speech item addressable by a
    // stable id. Building the id from text made every ASR revision look like a
    // new utterance and caused duplicate questions and answer cancellations.
    const utteranceId = segment.utteranceId ?? `${segment.source}-${segment.startMs}`;
    const id = `${segment.source}-${utteranceId}-${segment.final ? "final" : "partial"}`;
    const message: RealtimeServerMessage = segment.final
      ? { type: "asr_final", segment: { ...segment, id, final: true } }
      : { type: "asr_partial", segment: { ...segment, id, final: false } };
    this.handleServerMessage(message);
  }

  private flushAudio(): void {
    if (this.directRouter?.isReady) {
      while (this.audioQueue.length > 0) {
        const packet = this.audioQueue.shift();
        if (!packet) break;
        try { this.directRouter.sendStereo(packet); } catch { this.audioQueue.push(packet); break; }
      }
      this.diagnostics = { ...this.diagnostics, droppedPcmPackets: this.audioQueue.stats.droppedPackets };
      this.emitDiagnostics();
      return;
    }
    if (!this.isSocketWritable()) return;
    while (this.audioQueue.length > 0 && (this.socket?.bufferedAmount ?? 0) <= MAX_SOCKET_BUFFER_BYTES) {
      const packet = this.audioQueue.shift();
      if (!packet) break;
      try { this.socket?.send(packet); } catch { this.audioQueue.push(packet); break; }
    }
  }

  private handleDirectProviderError(error: ProviderError, generation: number): void {
    this.updateChannelDiagnostic(error.source, "error");
    this.handleDirectFailure(error, generation);
  }

  private handleDirectFailure(error: unknown, generation: number): void {
    if (generation !== this.directGeneration || this.manualStop) return;
    if (this.handledDirectFailureGeneration === generation) return;
    this.handledDirectFailureGeneration = generation;
    this.directRouter?.close();
    this.directRouter = undefined;
    this.audioQueue.clear();
    const code = messageCode(error);
    const recoverable = error instanceof ProviderError ? error.recoverable : true;
    const message = { type: "runtime_error", code, message: messageText(error), recoverable } satisfies RealtimeServerMessage;
    this.emit("message", message);
    this.emit("runtime-error", message);
    this.emit("diagnostic", message.message);
    this.emitAsrStatus("mic", "error", message.message);
    this.emitAsrStatus("remote", "error", message.message);
    if (!recoverable || !this.options?.autoReconnect) {
      this.setState("error");
      return;
    }
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private handleSocketFailure(socket: RealtimeSocket | undefined, error: Error | undefined, reason: string): void {
    if (socket && this.socket !== socket) return;
    this.socket = undefined;
    this.audioQueue.clear();
    const actualReason = error?.message ? `${reason}: ${error.message}` : reason;
    this.emit("diagnostic", actualReason);
    const authFailed = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*(key|token)/i.test(actualReason);
    if (!this.manualStop) {
      const message = { type: "runtime_error", code: authFailed ? "WS_AUTH_FAILED" : "WS_CONNECT_FAILED", message: authFailed ? "Gateway token 无效" : actualReason, recoverable: !authFailed } satisfies RealtimeServerMessage;
      this.emit("message", message);
      this.emit("runtime-error", message);
    }
    if (this.manualStop || !this.options?.autoReconnect || authFailed) {
      this.setState("error");
      return;
    }
    this.setState("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.manualStop) return;
    const delay = realtimeReconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.diagnostics = { ...this.diagnostics, reconnectCount: this.diagnostics.reconnectCount + 1 };
    this.emitDiagnostics();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private isSocketWritable(): boolean { return Boolean(this.socket && this.socket.readyState === OPEN && this.state === "connected"); }

  private setState(state: RealtimeConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  private emitAsrStatus(source: "mic" | "remote", state: "connecting" | "listening" | "stopped" | "error", message?: string): void {
    const status: RealtimeServerMessage = { type: "asr_status", source, state, ...(message ? { message } : {}) };
    this.emit("message", status);
    this.updateChannelDiagnostic(source, state === "stopped" ? "stopped" : state);
  }

  private updateChannelDiagnostic(source: "mic" | "remote" | undefined, state: AsrRuntimeDiagnostics["micState"]): void {
    if (source === "mic") this.diagnostics = { ...this.diagnostics, micState: state };
    else if (source === "remote") this.diagnostics = { ...this.diagnostics, remoteState: state };
    else this.diagnostics = { ...this.diagnostics, micState: state, remoteState: state };
    this.emitDiagnostics();
  }

  private updateVADDiagnostics(source: "mic" | "remote", result: VADResult, provider: VADProvider): void {
    const previous = this.diagnostics;
    const lastSpeechStart = { ...previous.lastSpeechStart };
    const lastSpeechEnd = { ...previous.lastSpeechEnd };
    if (result.speechStarted) lastSpeechStart[source] = result.startTime;
    if (result.speechEnded) lastSpeechEnd[source] = result.endTime;
    this.diagnostics = {
      ...previous,
      vadProvider: provider.providerName,
      speechProbability: { ...previous.speechProbability, [source]: result.speechProbability },
      micSpeech: source === "mic" ? result.speech : previous.micSpeech,
      remoteSpeech: source === "remote" ? result.speech : previous.remoteSpeech,
      fallback: provider.fallback || this.micVad.fallback || this.remoteVad.fallback,
      vadReady: vadStatus(this.micVad, source === "mic" ? result : undefined).ready && vadStatus(this.remoteVad, source === "remote" ? result : undefined).ready,
      vadReason: vadStatus(provider, result).reason,
      lastSpeechStart,
      lastSpeechEnd
    };
    const shouldEmit = result.speechStarted
      || result.speechEnded
      || previous.fallback !== this.diagnostics.fallback
      || (result.ready && previous.speechProbability[source] === 0);
    if (shouldEmit || Date.now() - this.lastVadDiagnosticAt >= 250) {
      this.lastVadDiagnosticAt = Date.now();
      this.emitDiagnostics();
    }
  }

  private handleVADDiagnostic(diagnostic: VADDiagnostic): void {
    this.diagnostics = { ...this.diagnostics, vadProvider: diagnostic.provider, fallback: true, vadReady: true, vadReason: diagnostic.reason };
    this.emit("diagnostic", diagnostic.code);
    this.emitDiagnostics();
  }

  private resetVadDiagnostics(): void {
    this.diagnostics = {
      ...this.diagnostics,
      vadProvider: this.micVad.providerName,
      speechProbability: { mic: 0, remote: 0 },
      micSpeech: false,
      remoteSpeech: false,
      fallback: this.micVad.fallback || this.remoteVad.fallback,
      vadReady: vadStatus(this.micVad).ready && vadStatus(this.remoteVad).ready,
      vadReason: vadStatus(this.micVad).reason,
      lastSpeechStart: {},
      lastSpeechEnd: {}
    };
  }

  private recordAsrLatency(final: boolean, segmentEndMs: number): void {
    if (!this.audioTimelineOriginAt) return;
    const expectedAt = this.audioTimelineOriginAt + Math.max(0, segmentEndMs);
    const latency = Math.max(0, Date.now() - expectedAt);
    this.diagnostics = { ...this.diagnostics, ...(final ? { lastFinalObservedLatencyMs: latency } : { lastPartialObservedLatencyMs: latency }) };
    this.emitDiagnostics();
  }

  private emitDiagnostics(): void { this.emit("diagnostics", this.asrDiagnostics); }
}

export type RealtimeTranscriptListener = (snapshot: TranscriptSnapshot) => void;
