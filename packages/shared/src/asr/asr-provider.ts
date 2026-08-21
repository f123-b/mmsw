import type { ASRConfig, ASRStatus, ASRTranscriptListener } from "./types";

export interface ASRProvider {
  connect(config: ASRConfig): Promise<void>;
  sendAudio(pcm: Uint8Array): void;
  onTranscript(callback: ASRTranscriptListener): void;
  disconnect(): Promise<void>;
  getStatus(): ASRStatus;
}

export type ASRProviderFactory = (config: ASRConfig, source: "mic" | "remote") => ASRProvider;

