import type { TranscriptSource } from "@interview-copilot/protocol";

export type ASRProviderType = "deepgram" | "gateway" | "funasr-local" | "qwen";
export type ASRConnectionState = "disconnected" | "connecting" | "ready" | "error";

export interface ASRConfig {
  provider: ASRProviderType;
  model: string;
  language: string;
  sampleRate: number;
  channels: number;
  vad: boolean;
  url?: string;
  apiKey?: string;
  gatewayToken?: string;
}

export interface TranscriptSegment {
  id?: string;
  source?: TranscriptSource;
  text: string;
  startMs: number;
  endMs: number;
  final: boolean;
  endpoint?: boolean;
  speechFinal?: boolean;
  utteranceEnd?: boolean;
  endOfTurn?: boolean;
  confidence?: number;
}

export interface ASRStatus {
  state: ASRConnectionState;
  provider: ASRProviderType;
  model: string;
  language: string;
  lastError?: string;
}

export interface ASRSocket {
  waitForOpen(): Promise<void>;
  send(data: Uint8Array | string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onError(listener: (error: Error) => void): void;
  onClose(listener: (error?: Error) => void): void;
}

export type ASRSocketFactory = (options: { url: string; apiKey?: string; gatewayToken?: string }) => ASRSocket;
export type ASRTranscriptListener = (segment: TranscriptSegment) => void;
export type ASRProviderSource = "mic" | "remote";

