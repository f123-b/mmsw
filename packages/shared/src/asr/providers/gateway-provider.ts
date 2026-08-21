import { ProviderError } from "../../asr";
import type { ASRProvider } from "../asr-provider";
import type { ASRConfig, ASRProviderSource, ASRSocket, ASRSocketFactory, ASRStatus, ASRTranscriptListener, TranscriptSegment } from "../types";

interface GatewayMessage {
  type?: string;
  segment?: Partial<TranscriptSegment>;
  text?: string;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  error?: string;
  message?: string;
}

/** WebSocket adapter for the existing Custom Gateway protocol. */
export class GatewayProvider implements ASRProvider {
  private socket?: ASRSocket;
  private listener?: ASRTranscriptListener;
  private config?: ASRConfig;
  private status: ASRStatus = { state: "disconnected", provider: "gateway", model: "", language: "" };

  constructor(private readonly socketFactory: ASRSocketFactory, private readonly source: ASRProviderSource = "remote") {}

  async connect(config: ASRConfig): Promise<void> {
    if (!config.url) throw new ProviderError("CONNECTION_FAILED", "Custom ASR Gateway URL is required", true, this.source);
    this.config = config;
    this.status = { state: "connecting", provider: "gateway", model: config.model, language: config.language };
    const socket = this.socketFactory({ url: this.withTicket(config.url, config.gatewayToken), apiKey: config.apiKey, gatewayToken: config.gatewayToken });
    this.socket = socket;
    socket.onMessage((data) => this.handleMessage(data));
    socket.onError((error) => this.setError(error));
    socket.onClose((error) => { if (this.status.state !== "disconnected") this.setError(error ?? new Error("ASR Gateway WebSocket closed")); });
    try {
      await socket.waitForOpen();
      socket.send(JSON.stringify({ type: "client_ready", providerName: "Custom Gateway", model: config.model, language: config.language }));
      this.status = { ...this.status, state: "ready", lastError: undefined };
    } catch (error) {
      this.setError(error);
      socket.close();
      throw error;
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.socket || this.status.state !== "ready") throw new ProviderError("CONNECTION_FAILED", "ASR Gateway is not ready", true, this.source);
    this.socket.send(pcm);
  }

  onTranscript(callback: ASRTranscriptListener): void { this.listener = callback; }

  async disconnect(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.status = { ...this.status, state: "disconnected" };
  }

  getStatus(): ASRStatus { return { ...this.status }; }

  private handleMessage(data: string): void {
    let message: GatewayMessage;
    try { message = JSON.parse(data) as GatewayMessage; }
    catch (error) { this.setError(new Error(`Invalid ASR Gateway message: ${String(error)}`)); return; }
    if (message.type === "runtime_error" || message.error) { this.setError(new Error(message.error ?? message.message ?? "ASR Gateway error")); return; }
    if (message.type !== "asr_partial" && message.type !== "asr_final") return;
    const raw: Partial<TranscriptSegment> = message.segment ?? {
      text: message.text,
      startMs: message.startMs,
      endMs: message.endMs,
      confidence: message.confidence
    };
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) return;
    this.listener?.({
      id: typeof raw.id === "string" ? raw.id : undefined,
      source: this.source,
      text,
      startMs: Math.max(0, Number(raw.startMs ?? 0)),
      endMs: Math.max(0, Number(raw.endMs ?? raw.startMs ?? 0)),
      final: message.type === "asr_final",
      ...(raw.confidence === undefined ? {} : { confidence: Number(raw.confidence) })
    });
  }

  private withTicket(url: string, ticket?: string): string {
    if (!ticket) return url;
    const parsed = new URL(url);
    parsed.searchParams.set("ticket", ticket);
    return parsed.toString();
  }

  private setError(error: unknown): void {
    this.status = { ...this.status, state: "error", lastError: error instanceof Error ? error.message : String(error) };
  }
}
