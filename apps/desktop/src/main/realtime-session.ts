import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
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
  StereoAsrChannelRouter,
  TranscriptStabilizer,
  type AsrLanguage,
  type AsrProviderType,
  type ProviderSettings,
  type StreamingAsrSocket,
  type TranscriptSnapshot
} from "@interview-copilot/shared";

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
  provider: "Deepgram Direct" | "Custom Gateway" | "unknown";
  model: string;
  language: string;
  micState: "connecting" | "listening" | "error" | "stopped";
  remoteState: "connecting" | "listening" | "error" | "stopped";
  lastPartialObservedLatencyMs?: number;
  lastFinalObservedLatencyMs?: number;
  reconnectCount: number;
  droppedPcmPackets: number;
}

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

class WsDeepgramSocket implements StreamingAsrSocket {
  constructor(private readonly socket: WebSocket) {}

  waitForOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socket.readyState === WebSocket.CLOSING || this.socket.readyState === WebSocket.CLOSED) return Promise.reject(new Error("Deepgram WebSocket is closed"));
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("Deepgram WebSocket closed before OPEN")); };
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
  return new WsDeepgramSocket(new WebSocket(options.url, { headers: { Authorization: `Token ${options.apiKey}` } }));
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
  private directRouter: StereoAsrChannelRouter | undefined;
  private directGeneration = 0;
  private handledDirectFailureGeneration = 0;
  private audioTimelineOriginAt = 0;
  private diagnostics: AsrRuntimeDiagnostics = {
    provider: "unknown",
    model: "",
    language: "",
    micState: "stopped",
    remoteState: "stopped",
    reconnectCount: 0,
    droppedPcmPackets: 0
  };

  constructor(
    private readonly socketFactory: RealtimeSocketFactory = (url) => new WebSocket(url) as unknown as RealtimeSocket,
    private readonly directAsrSettingsProvider?: () => ProviderSettings | undefined,
    private readonly directSocketFactory = createDeepgramSocket
  ) {
    super();
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
      provider: options.providerType === "deepgram" ? "Deepgram Direct" : options.providerType === "custom-gateway" ? "Custom Gateway" : "unknown",
      model: options.model ?? "",
      language: options.language ?? "",
      micState: "connecting",
      remoteState: "connecting",
      reconnectCount: 0,
      droppedPcmPackets: this.audioQueue.stats.droppedPackets
    };
    this.audioTimelineOriginAt = 0;
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
    this.audioTimelineOriginAt = 0;
    this.stabilizer.clear();
    if (clearOptions) this.options = undefined;
    this.diagnostics = { ...this.diagnostics, micState: "stopped", remoteState: "stopped" };
    this.emitDiagnostics();
    this.setState("disconnected");
  }

  sendAudio(packet: Uint8Array): void {
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
    this.diagnostics = { ...this.diagnostics, droppedPcmPackets: stats.droppedPackets };
    this.emitDiagnostics();
    if (stats.droppedPackets > 0) this.emit("diagnostic", `Realtime audio backpressure dropped ${stats.droppedPackets} packet(s)`);
  }

  sendControl(message: ClientControlMessage): void {
    const validated = clientControlMessageSchema.parse(message);
    if (!this.isSocketWritable()) return;
    this.socket?.send(JSON.stringify(validated));
  }

  sendHeartbeat(timestamp = Date.now()): void { this.sendControl({ type: "heartbeat", timestamp }); }

  private openSocket(): void {
    if (this.manualStop || !this.options) return;
    if (this.options.providerType === "deepgram") {
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
    if (!settings?.apiKey) {
      this.handleDirectFailure(new ProviderError("AUTH_FAILED", "Deepgram API Key 未配置，请先在设置中保存 API Key", false), generation);
      return;
    }
    const model = options.model || settings.model || "nova-3";
    const language = options.language || settings.language || "zh-CN";
    const createProvider = () => new DeepgramStreamingAsrProvider({ baseUrl: options.url || settings.baseUrl, model, language, apiKey: settings.apiKey }, this.directSocketFactory);
    const router = new StereoAsrChannelRouter(createProvider(), createProvider());
    this.directRouter = router;
    this.emitAsrStatus("mic", "connecting");
    this.emitAsrStatus("remote", "connecting");
    try {
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

  private handleDirectSegment(segment: { source: "mic" | "remote"; text: string; startMs: number; endMs: number; final: boolean; confidence?: number }): void {
    const id = `${segment.source}-${segment.startMs}-${segment.endMs}-${segment.final ? "final" : "partial"}-${segment.text}`;
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
