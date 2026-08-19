import type { TranscriptSegment } from "@interview-copilot/protocol";

export interface SplitStereoPcmResult {
  mic: Uint8Array;
  system: Uint8Array;
}

/** Split interleaved 16-bit little-endian stereo PCM without changing samples. */
export function splitStereoPcm(packet: Uint8Array): SplitStereoPcmResult {
  if (packet.byteLength % 4 !== 0) throw new Error("Stereo PCM packet must contain complete 16-bit frames");
  const frames = packet.byteLength / 4;
  const mic = new Uint8Array(frames * 2);
  const system = new Uint8Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    mic[frame * 2] = packet[frame * 4];
    mic[frame * 2 + 1] = packet[frame * 4 + 1];
    system[frame * 2] = packet[frame * 4 + 2];
    system[frame * 2 + 1] = packet[frame * 4 + 3];
  }
  return { mic, system };
}

export type AsrProviderErrorCode =
  | "AUTH_FAILED"
  | "CONNECTION_FAILED"
  | "PROVIDER_ERROR"
  | "PROVIDER_CLOSED"
  | "INVALID_RESPONSE";

export class ProviderError extends Error {
  readonly name = "ProviderError";

  constructor(
    readonly code: AsrProviderErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly source?: "mic" | "remote"
  ) {
    super(message);
  }
}

export interface StreamingAsrSocket {
  waitForOpen(): Promise<void>;
  send(data: Uint8Array | string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onError(listener: (error: Error) => void): void;
  onClose(listener: (error?: Error) => void): void;
}

export type StreamingAsrSocketFactory = (options: { url: string; apiKey: string }) => StreamingAsrSocket;
export type StreamingAsrErrorListener = (error: ProviderError) => void;

export interface StreamingAsrProvider {
  connect(source: "mic" | "remote", onSegment: (segment: Omit<TranscriptSegment, "id">) => void, onError?: StreamingAsrErrorListener): Promise<void>;
  sendAudio(pcm: Uint8Array): void;
  finalize(timeoutMs?: number): Promise<void>;
  close(): void;
}

interface DeepgramResultMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  error?: string;
  message?: string;
  channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
  start?: number;
  duration?: number;
}

function providerError(error: unknown, source: "mic" | "remote", fallbackCode: AsrProviderErrorCode, fallbackMessage: string): ProviderError {
  if (error instanceof ProviderError) return new ProviderError(error.code, error.message, error.recoverable, source);
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*(key|token)|api key/i.test(message)) {
    return new ProviderError("AUTH_FAILED", "Deepgram API Key 无效或未授权", false, source);
  }
  return new ProviderError(fallbackCode, message || fallbackMessage, true, source);
}

function errorMessage(value: DeepgramResultMessage): string {
  return value.error || value.message || "Deepgram returned an error";
}

/** Deepgram Listen WebSocket adapter. The socket factory owns transport/auth headers. */
export class DeepgramStreamingAsrProvider implements StreamingAsrProvider {
  private socket: StreamingAsrSocket | undefined;
  private source: "mic" | "remote" = "remote";
  private errorListener?: StreamingAsrErrorListener;
  private segmentListener?: (segment: Omit<TranscriptSegment, "id">) => void;
  private keepAliveTimer: NodeJS.Timeout | undefined;
  private lastAudioAt = Date.now();
  private finalizing = false;
  private finalizeWaiters: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];
  private expectedClose = false;

  constructor(
    private readonly settings: { baseUrl?: string; model?: string; language?: string; apiKey: string },
    private readonly socketFactory: StreamingAsrSocketFactory
  ) {}

  async connect(source: "mic" | "remote", onSegment: (segment: Omit<TranscriptSegment, "id">) => void, onError?: StreamingAsrErrorListener): Promise<void> {
    this.close();
    this.source = source;
    this.errorListener = onError;
    this.segmentListener = onSegment;
    this.expectedClose = false;
    if (!this.settings.apiKey.trim()) throw new ProviderError("AUTH_FAILED", "Deepgram API Key 未配置", false, source);

    let url: string;
    try {
      const parsed = new URL(this.settings.baseUrl || "wss://api.deepgram.com/v1/listen");
      parsed.searchParams.set("encoding", "linear16");
      parsed.searchParams.set("sample_rate", "16000");
      parsed.searchParams.set("channels", "1");
      parsed.searchParams.set("interim_results", "true");
      parsed.searchParams.set("punctuate", "true");
      parsed.searchParams.set("smart_format", "true");
      parsed.searchParams.set("endpointing", "300");
      parsed.searchParams.set("model", this.settings.model || "nova-3");
      parsed.searchParams.set("language", this.settings.language || "zh-CN");
      url = parsed.toString();
    } catch (error) {
      throw providerError(error, source, "CONNECTION_FAILED", "Deepgram URL 无效");
    }

    const socket = this.socketFactory({ url, apiKey: this.settings.apiKey });
    this.socket = socket;
    socket.onError((error) => this.handleError(error));
    socket.onClose((error) => this.handleClose(error));
    socket.onMessage((data) => this.handleMessage(data));
    try {
      await socket.waitForOpen();
    } catch (error) {
      const failure = providerError(error, source, "CONNECTION_FAILED", "Deepgram WebSocket 连接失败");
      this.expectedClose = true;
      socket.close();
      this.socket = undefined;
      throw failure;
    }
    this.lastAudioAt = Date.now();
    this.keepAliveTimer = setInterval(() => {
      if (this.socket && Date.now() - this.lastAudioAt >= 3_000) {
        try { this.socket.send(JSON.stringify({ type: "KeepAlive" })); } catch (error) { this.handleError(error); }
      }
    }, 4_000);
    this.keepAliveTimer.unref?.();
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.socket) throw new ProviderError("CONNECTION_FAILED", "Deepgram WebSocket 尚未 OPEN", true, this.source);
    try {
      this.socket.send(pcm);
      this.lastAudioAt = Date.now();
    } catch (error) {
      const failure = providerError(error, this.source, "CONNECTION_FAILED", "Deepgram 音频发送失败");
      this.notifyError(failure);
      throw failure;
    }
  }

  finalize(timeoutMs = 1_000): Promise<void> {
    if (!this.socket) return Promise.resolve();
    this.finalizing = true;
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.finishFinalize();
        resolve();
      }, Math.max(500, Math.min(1_500, timeoutMs)));
      timer.unref?.();
      this.finalizeWaiters.push({ resolve, timer });
    });
    try {
      this.socket.send(JSON.stringify({ type: "Finalize" }));
    } catch (error) {
      this.handleError(error);
      this.finishFinalize();
      return promise;
    }
    return promise;
  }

  close(): void {
    this.expectedClose = true;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
    this.finishFinalize();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try { socket.send(JSON.stringify({ type: "CloseStream" })); } catch { /* socket may already be closed */ }
      socket.close();
    }
    this.finalizing = false;
    this.errorListener = undefined;
    this.segmentListener = undefined;
  }

  private handleMessage(data: string): void {
    let message: DeepgramResultMessage;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") throw new Error("Deepgram message is not an object");
      message = parsed as DeepgramResultMessage;
    } catch (error) {
      this.notifyError(new ProviderError("INVALID_RESPONSE", `Deepgram 返回了无效消息：${String(error)}`, true, this.source));
      return;
    }
    if (message.type === "Metadata" || message.type === "KeepAlive" || message.type === "Welcome") return;
    if (message.type === "Error" || message.error) {
      this.notifyError(providerError(new Error(errorMessage(message)), this.source, "PROVIDER_ERROR", errorMessage(message)));
      return;
    }
    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim() ?? "";
    if (text && this.segmentListener) {
      const startMs = Math.max(0, Math.round((message.start ?? 0) * 1_000));
      const endMs = Math.max(startMs, Math.round(((message.start ?? 0) + (message.duration ?? 0)) * 1_000));
      this.segmentListener({ source: this.source, text, startMs, endMs, final: Boolean(message.is_final), ...(alternative?.confidence === undefined ? {} : { confidence: alternative.confidence }) });
    }
    if (this.finalizing && (message.speech_final === true || message.from_finalize === true)) this.finishFinalize();
  }

  private handleError(error: unknown): void {
    this.notifyError(providerError(error, this.source, "PROVIDER_ERROR", "Deepgram Provider 错误"));
  }

  private handleClose(error?: Error): void {
    if (this.expectedClose) return;
    this.notifyError(new ProviderError("PROVIDER_CLOSED", error?.message || "Deepgram WebSocket 已断开", true, this.source));
  }

  private notifyError(error: ProviderError): void {
    this.errorListener?.(error);
  }

  private finishFinalize(): void {
    this.finalizing = false;
    const waiters = this.finalizeWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
}

export class StereoAsrChannelRouter {
  private ready = false;

  constructor(private readonly mic: StreamingAsrProvider, private readonly remote: StreamingAsrProvider) {}

  get isReady(): boolean { return this.ready; }

  async connect(onSegment: (segment: Omit<TranscriptSegment, "id">) => void, onError?: StreamingAsrErrorListener): Promise<void> {
    this.ready = false;
    try {
      await Promise.all([
        this.mic.connect("mic", onSegment, onError),
        this.remote.connect("remote", onSegment, onError)
      ]);
      this.ready = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  sendStereo(packet: Uint8Array): void {
    if (!this.ready) throw new ProviderError("CONNECTION_FAILED", "两个 ASR 通道尚未 READY", true);
    const channels = splitStereoPcm(packet);
    this.mic.sendAudio(channels.mic);
    this.remote.sendAudio(channels.system);
  }

  async finalize(timeoutMs = 1_000): Promise<void> {
    await Promise.all([this.mic.finalize(timeoutMs), this.remote.finalize(timeoutMs)]);
  }

  close(): void {
    this.ready = false;
    this.mic.close();
    this.remote.close();
  }
}
