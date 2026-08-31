import { ProviderError } from "../../asr";
import type { StreamingAsrErrorListener, StreamingAsrProvider } from "../../asr";
import type { TranscriptSegment as ProtocolTranscriptSegment } from "@interview-copilot/protocol";
import type { ASRProvider } from "../asr-provider";
import type { ASRConfig, ASRProviderSource, ASRSocket, ASRSocketFactory, ASRStatus, ASRTranscriptListener, TranscriptSegment } from "../types";

interface LocalMessage {
  type?: string;
  text?: string;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  endpoint?: boolean;
  speechFinal?: boolean;
  utteranceEnd?: boolean;
  endOfTurn?: boolean;
  speech_final?: boolean;
  utterance_end?: boolean;
  end_of_turn?: boolean;
  error?: string;
  message?: string;
}

/** WebSocket client for apps/local-asr-service. The model remains outside Electron. */
export class LocalFunASRProvider implements ASRProvider, StreamingAsrProvider {
  private socket?: ASRSocket;
  private listener?: ASRTranscriptListener;
  private status: ASRStatus = { state: "disconnected", provider: "funasr-local", model: "", language: "" };
  private legacyListener?: (segment: Omit<ProtocolTranscriptSegment, "id">) => void;
  private legacyErrorListener?: StreamingAsrErrorListener;
  private activeSource: ASRProviderSource;

  constructor(private readonly socketFactory: ASRSocketFactory, private readonly source: ASRProviderSource = "remote", private readonly defaults: Partial<ASRConfig> = {}) { this.activeSource = source; }

  async connect(config: ASRConfig): Promise<void>;
  async connect(source: ASRProviderSource, onSegment: (segment: Omit<ProtocolTranscriptSegment, "id">) => void, onError?: StreamingAsrErrorListener): Promise<void>;
  async connect(configOrSource: ASRConfig | ASRProviderSource, onSegment?: (segment: Omit<ProtocolTranscriptSegment, "id">) => void, onError?: StreamingAsrErrorListener): Promise<void> {
    const config: ASRConfig = typeof configOrSource === "string"
      ? { provider: "funasr-local", model: "funasr-nano:q8", language: "zh-CN", sampleRate: 16_000, channels: 1, vad: true, ...this.defaults }
      : configOrSource;
    if (typeof configOrSource === "string") {
      this.activeSource = configOrSource;
      this.legacyListener = onSegment;
      this.legacyErrorListener = onError;
    }
    const url = config.url || "ws://127.0.0.1:8765";
    this.status = { state: "connecting", provider: "funasr-local", model: config.model || "funasr-nano:q8", language: config.language || "zh-CN" };
    const socket = this.socketFactory({ url, apiKey: config.apiKey });
    this.socket = socket;
    socket.onMessage((data) => this.handleMessage(data));
    socket.onError((error) => this.notifyError(error));
    socket.onClose((error) => { if (this.status.state !== "disconnected") this.notifyError(error ?? new Error("Local ASR WebSocket closed")); });
    try {
      await socket.waitForOpen();
      socket.send(JSON.stringify({ type: "config", model: this.status.model, language: this.status.language, sampleRate: config.sampleRate, channels: 1, vad: config.vad, source: this.source }));
      this.status = { ...this.status, state: "ready", lastError: undefined };
    } catch (error) {
      this.setError(error);
      socket.close();
      throw error;
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.socket || this.status.state !== "ready") throw new ProviderError("CONNECTION_FAILED", "Local Fun-ASR service is not ready", true, this.source);
    this.socket.send(pcm);
  }

  onTranscript(callback: ASRTranscriptListener): void { this.listener = callback; }

  async disconnect(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.status = { ...this.status, state: "disconnected" };
  }

  getStatus(): ASRStatus { return { ...this.status }; }

  async finalize(): Promise<void> { return Promise.resolve(); }

  close(): void { void this.disconnect(); }

  private handleMessage(data: string): void {
    let message: LocalMessage;
    try { message = JSON.parse(data) as LocalMessage; }
    catch (error) { this.setError(new Error(`Invalid local ASR message: ${String(error)}`)); return; }
    if (message.type === "error") { this.setError(new Error(message.error ?? message.message ?? "Local ASR error")); return; }
    if (message.type !== "asr_partial" && message.type !== "asr_final") return;
    const text = message.text?.trim() ?? "";
    if (!text) return;
    const startMs = Math.max(0, Math.round(message.startMs ?? 0));
    const endMs = Math.max(startMs, Math.round(message.endMs ?? startMs));
    const segment: TranscriptSegment = { source: this.activeSource, text, startMs, endMs, final: message.type === "asr_final", ...(message.endpoint === undefined ? {} : { endpoint: Boolean(message.endpoint) }), ...(message.speechFinal === undefined && message.speech_final === undefined ? {} : { speechFinal: Boolean(message.speechFinal ?? message.speech_final) }), ...(message.utteranceEnd === undefined && message.utterance_end === undefined ? {} : { utteranceEnd: Boolean(message.utteranceEnd ?? message.utterance_end) }), ...(message.endOfTurn === undefined && message.end_of_turn === undefined ? {} : { endOfTurn: Boolean(message.endOfTurn ?? message.end_of_turn) }), ...(message.confidence === undefined ? {} : { confidence: message.confidence }) };
    this.listener?.(segment);
    this.legacyListener?.({ source: this.activeSource, text, startMs, endMs, final: segment.final, endpoint: segment.endpoint, speechFinal: segment.speechFinal, utteranceEnd: segment.utteranceEnd, endOfTurn: segment.endOfTurn, ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }) });
  }

  private notifyError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setError(error);
    this.legacyErrorListener?.(new ProviderError("PROVIDER_ERROR", message, true, this.activeSource));
  }

  private setError(error: unknown): void {
    this.status = { ...this.status, state: "error", lastError: error instanceof Error ? error.message : String(error) };
  }
}
