import { EventEmitter } from "node:events";
import {
  clientControlMessageSchema,
  parseRealtimeServerMessage,
  type ClientControlMessage,
  type RealtimeServerMessage
} from "@interview-copilot/protocol";
import {
  PcmBackpressureQueue,
  TranscriptStabilizer,
  type TranscriptSnapshot
} from "@interview-copilot/shared";

export type RealtimeConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export interface RealtimeConnectOptions {
  url: string;
  ticket?: string;
  autoReconnect?: boolean;
}

export interface RealtimeSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export type RealtimeSocketFactory = (url: string) => RealtimeSocket;

const OPEN = 1;
const MAX_SOCKET_BUFFER_BYTES = 192_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export function realtimeReconnectDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, Math.floor(attempt)), RETRY_DELAYS_MS.length - 1)];
}

function withTicket(url: string, ticket?: string): string {
  if (!ticket) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("ticket", ticket);
  return parsed.toString();
}

export class RealtimeSession extends EventEmitter {
  private socket: RealtimeSocket | undefined;
  private options: RealtimeConnectOptions | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private manualStop = true;
  private state: RealtimeConnectionState = "disconnected";
  private readonly audioQueue = new PcmBackpressureQueue();
  private readonly stabilizer = new TranscriptStabilizer();

  constructor(
    private readonly socketFactory: RealtimeSocketFactory = (url) => new WebSocket(url) as unknown as RealtimeSocket
  ) {
    super();
  }

  get connectionState(): RealtimeConnectionState { return this.state; }

  get pendingAudioStats(): { queuedBytes: number; queuedPackets: number; droppedPackets: number } {
    return this.audioQueue.stats;
  }

  connect(options: RealtimeConnectOptions): void {
    this.disconnect(false);
    this.options = { ...options, autoReconnect: options.autoReconnect ?? true };
    this.manualStop = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  disconnect(clearOptions = true): void {
    this.manualStop = true;
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = undefined;
    this.audioQueue.clear();
    this.stabilizer.clear();
    if (clearOptions) this.options = undefined;
    this.setState("disconnected");
  }

  sendAudio(packet: Uint8Array): void {
    if (this.isSocketWritable()) {
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
    if (stats.droppedPackets > 0) this.emit("diagnostic", `Realtime audio backpressure dropped ${stats.droppedPackets} packet(s)`);
  }

  sendControl(message: ClientControlMessage): void {
    const validated = clientControlMessageSchema.parse(message);
    if (!this.isSocketWritable()) return;
    this.socket?.send(JSON.stringify(validated));
  }

  sendHeartbeat(timestamp = Date.now()): void {
    this.sendControl({ type: "heartbeat", timestamp });
  }

  private openSocket(): void {
    if (this.manualStop || !this.options) return;
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");
    try {
      const socket = this.socketFactory(withTicket(this.options.url, this.options.ticket));
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => this.handleOpen(socket);
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => this.handleSocketFailure(socket, "Realtime WebSocket error");
      socket.onclose = () => this.handleSocketFailure(socket, "Realtime WebSocket closed");
    } catch (error) {
      this.handleSocketFailure(undefined, `Realtime WebSocket connect failed: ${String(error)}`);
    }
  }

  private handleOpen(socket: RealtimeSocket): void {
    if (this.socket !== socket || this.manualStop) return;
    this.reconnectAttempt = 0;
    this.setState("connected");
    this.sendControl({ type: "client_ready" });
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
    if (message.type === "asr_partial" || message.type === "asr_final") {
      const update = this.stabilizer.upsert(message.segment);
      this.emit("transcript", update.snapshot, update.segment);
    }
    if (message.type === "runtime_error") this.emit("runtime-error", message);
  }

  private flushAudio(): void {
    if (!this.isSocketWritable()) return;
    while (this.audioQueue.length > 0 && (this.socket?.bufferedAmount ?? 0) <= MAX_SOCKET_BUFFER_BYTES) {
      const packet = this.audioQueue.shift();
      if (!packet) break;
      try {
        this.socket?.send(packet);
      } catch {
        this.audioQueue.push(packet);
        break;
      }
    }
  }

  private handleSocketFailure(socket: RealtimeSocket | undefined, reason: string): void {
    if (socket && this.socket !== socket) return;
    this.socket = undefined;
    this.emit("diagnostic", reason);
    if (this.manualStop || !this.options?.autoReconnect) {
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private isSocketWritable(): boolean {
    return Boolean(this.socket && this.socket.readyState === OPEN && this.state === "connected");
  }

  private setState(state: RealtimeConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

export type RealtimeTranscriptListener = (snapshot: TranscriptSnapshot) => void;
