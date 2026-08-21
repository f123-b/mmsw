import {
  DeepgramStreamingAsrProvider,
  type StreamingAsrErrorListener,
  type StreamingAsrSocket,
  type StreamingAsrSocketFactory
} from "../../asr";
import type { TranscriptSegment as ProtocolTranscriptSegment } from "@interview-copilot/protocol";
import type { ASRProvider } from "../asr-provider";
import type { ASRConfig, ASRProviderSource, ASRStatus, ASRTranscriptListener, TranscriptSegment } from "../types";

type LegacySegment = Omit<ProtocolTranscriptSegment, "id">;

/** New ASRProvider facade over the existing, production-tested Deepgram adapter. */
export class DeepgramProvider implements ASRProvider {
  private provider?: DeepgramStreamingAsrProvider;
  private config?: ASRConfig;
  private listener?: ASRTranscriptListener;
  private status: ASRStatus = { state: "disconnected", provider: "deepgram", model: "", language: "" };

  constructor(
    private readonly socketFactory: StreamingAsrSocketFactory,
    private readonly source: ASRProviderSource = "remote"
  ) {}

  async connect(config: ASRConfig): Promise<void> {
    this.config = config;
    this.status = { state: "connecting", provider: "deepgram", model: config.model, language: config.language };
    this.provider = new DeepgramStreamingAsrProvider(
      { baseUrl: config.url, model: config.model, language: config.language, apiKey: config.apiKey ?? "" },
      this.socketFactory
    );
    try {
      await this.provider.connect(this.source, (segment) => this.emit(segment), (error) => this.setError(error));
      this.status = { ...this.status, state: "ready", lastError: undefined };
    } catch (error) {
      this.setError(error);
      throw error;
    }
  }

  sendAudio(pcm: Uint8Array): void {
    this.provider?.sendAudio(pcm);
  }

  onTranscript(callback: ASRTranscriptListener): void {
    this.listener = callback;
  }

  async disconnect(): Promise<void> {
    this.provider?.close();
    this.provider = undefined;
    this.status = { ...this.status, state: "disconnected" };
  }

  getStatus(): ASRStatus { return { ...this.status }; }

  async finalize(timeoutMs = 1_000): Promise<void> {
    await this.provider?.finalize(timeoutMs);
  }

  close(): void { void this.disconnect(); }

  private emit(segment: LegacySegment): void {
    const value: TranscriptSegment = { ...segment, source: this.source };
    this.listener?.(value);
  }

  private setError(error: unknown): void {
    this.status = { ...this.status, state: "error", lastError: error instanceof Error ? error.message : String(error) };
  }
}

export type { StreamingAsrSocket };
export type DeepgramSocketFactory = (options: { url: string; apiKey: string }) => StreamingAsrSocket;
