import type { TranscriptSegment } from "@interview-copilot/protocol";

export const QWEN_REALTIME_ASR_MODEL = "qwen3-asr-flash-realtime";
export const QWEN_REALTIME_ASR_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
export const QWEN_TASK_ASR_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";

export function usesQwenRealtimeProtocol(model: string): boolean {
  return /^qwen3-asr-flash-realtime(?:-|$)/i.test(model.trim());
}

export function qwenAsrWebSocketUrl(model: string): string {
  return usesQwenRealtimeProtocol(model) ? QWEN_REALTIME_ASR_URL : QWEN_TASK_ASR_URL;
}

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

interface QwenRealtimeMessage {
  type?: string;
  item_id?: string;
  text?: string;
  stash?: string;
  transcript?: string;
  audio_start_ms?: number;
  audio_end_ms?: number;
  code?: string;
  message?: string;
  error?: string | { code?: string; message?: string };
}

interface DashScopeTaskMessage {
  header?: { event?: string; task_id?: string; error_code?: string; error_message?: string };
  payload?: { output?: { sentence?: { text?: string; begin_time?: number; end_time?: number; sentence_end?: boolean } } };
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
      this.segmentListener({ source: this.source, text, startMs, endMs, final: Boolean(message.is_final), endpoint: Boolean(message.speech_final || message.from_finalize), speechFinal: Boolean(message.speech_final), utteranceEnd: Boolean(message.from_finalize), endOfTurn: Boolean(message.speech_final || message.from_finalize), ...(alternative?.confidence === undefined ? {} : { confidence: alternative.confidence }) });
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

function qwenProviderError(error: unknown, source: "mic" | "remote", fallbackCode: AsrProviderErrorCode, fallbackMessage: string): ProviderError {
  if (error instanceof ProviderError) return new ProviderError(error.code, error.message, error.recoverable, source);
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid.*(api.?key|token)|invalidapikey|authentication/i.test(message)) {
    return new ProviderError("AUTH_FAILED", "千问 API Key 无效或未授权", false, source);
  }
  return new ProviderError(fallbackCode, message || fallbackMessage, true, source);
}

function qwenErrorMessage(message: QwenRealtimeMessage): string {
  if (typeof message.error === "string") return message.error;
  if (message.error && typeof message.error === "object") return [message.error.code, message.error.message].filter(Boolean).join(": ");
  return [message.code, message.message].filter(Boolean).join(": ") || "Qwen ASR returned an error";
}

function qwenLanguage(language?: string): string | undefined {
  if (language === "zh-CN") return "zh";
  if (language === "en-US") return "en";
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary);
}

function taskId(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 32);
}

function resample16kTo8k(pcm: Uint8Array): Uint8Array {
  const samples = Math.floor(pcm.byteLength / 2);
  const outputSamples = Math.ceil(samples / 2);
  const output = new Uint8Array(outputSamples * 2);
  for (let source = 0, target = 0; source + 1 < pcm.byteLength; source += 4, target += 2) {
    output[target] = pcm[source] ?? 0;
    output[target + 1] = pcm[source + 1] ?? 0;
  }
  return output;
}

/** DashScope task-protocol adapter used by Qwen Audio, Fun-ASR and Paraformer. */
export class DashScopeTaskStreamingAsrProvider implements StreamingAsrProvider {
  private socket: StreamingAsrSocket | undefined;
  private source: "mic" | "remote" = "remote";
  private taskId = "";
  private ready = false;
  private expectedClose = false;
  private segmentListener?: (segment: Omit<TranscriptSegment, "id">) => void;
  private errorListener?: StreamingAsrErrorListener;
  private readyWaiter?: { resolve: () => void; reject: (error: ProviderError) => void; timer: ReturnType<typeof setTimeout> };
  private finalizeWaiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    private readonly settings: { baseUrl?: string; model?: string; language?: string; apiKey: string },
    private readonly socketFactory: StreamingAsrSocketFactory
  ) {}

  async connect(source: "mic" | "remote", onSegment: (segment: Omit<TranscriptSegment, "id">) => void, onError?: StreamingAsrErrorListener): Promise<void> {
    this.close();
    this.source = source;
    this.segmentListener = onSegment;
    this.errorListener = onError;
    this.expectedClose = false;
    this.ready = false;
    this.taskId = taskId();
    if (!this.settings.apiKey.trim()) throw new ProviderError("AUTH_FAILED", "千问 API Key 未配置", false, source);
    const model = this.settings.model?.trim() || "qwen-audio-3.0-asr-flash-streaming";
    const socket = this.socketFactory({ url: qwenAsrWebSocketUrl(model), apiKey: this.settings.apiKey });
    this.socket = socket;
    socket.onError((error) => this.handleError(error));
    socket.onClose((error) => this.handleClose(error));
    socket.onMessage((data) => this.handleMessage(data));
    const initialized = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProviderError("CONNECTION_FAILED", "千问流式 ASR 会话初始化超时", true, source)), 10_000);
      this.readyWaiter = { resolve, reject, timer };
    });
    try {
      await socket.waitForOpen();
      const sampleRate = /(?:^|-)8k(?:-|$)/i.test(model) ? 8_000 : 16_000;
      socket.send(JSON.stringify({
        header: { action: "run-task", task_id: this.taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model,
          parameters: { format: "pcm", sample_rate: sampleRate },
          input: {}
        }
      }));
      await initialized;
    } catch (error) {
      const failure = qwenProviderError(error, source, "CONNECTION_FAILED", "千问流式 ASR WebSocket 连接失败");
      this.clearReadyWaiter();
      this.expectedClose = true;
      socket.close();
      this.socket = undefined;
      throw failure;
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.socket || !this.ready) throw new ProviderError("CONNECTION_FAILED", "千问流式 ASR 会话尚未 READY", true, this.source);
    const model = this.settings.model ?? "";
    this.socket.send(/(?:^|-)8k(?:-|$)/i.test(model) ? resample16kTo8k(pcm) : pcm);
  }

  finalize(timeoutMs = 1_500): Promise<void> {
    if (!this.socket || !this.ready) return Promise.resolve();
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.finishFinalize(); resolve(); }, Math.max(750, Math.min(3_000, timeoutMs)));
      this.finalizeWaiters.push({ resolve, timer });
    });
    try { this.socket.send(JSON.stringify({ header: { action: "finish-task", task_id: this.taskId, streaming: "duplex" }, payload: { input: {} } })); }
    catch (error) { this.handleError(error); this.finishFinalize(); }
    return promise;
  }

  close(): void {
    this.expectedClose = true;
    this.clearReadyWaiter();
    this.finishFinalize();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) socket.close();
    this.ready = false;
    this.segmentListener = undefined;
    this.errorListener = undefined;
  }

  private handleMessage(data: string): void {
    let message: DashScopeTaskMessage;
    try { message = JSON.parse(data) as DashScopeTaskMessage; }
    catch (error) { this.notifyError(new ProviderError("INVALID_RESPONSE", `千问流式 ASR 返回了无效消息：${String(error)}`, true, this.source)); return; }
    const event = message.header?.event;
    if (event === "task-failed" || message.header?.error_code) {
      const failure = qwenProviderError(new Error(`${message.header?.error_code ?? "task-failed"}: ${message.header?.error_message ?? "千问 ASR 任务失败"}`), this.source, "PROVIDER_ERROR", "千问 ASR 任务失败");
      this.readyWaiter?.reject(failure);
      this.notifyError(failure);
      return;
    }
    if (event === "task-started") {
      this.ready = true;
      const waiter = this.readyWaiter;
      this.readyWaiter = undefined;
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(); }
      return;
    }
    if (event === "result-generated") {
      const sentence = message.payload?.output?.sentence;
      const text = sentence?.text?.trim() ?? "";
      if (text && this.segmentListener) {
        const startMs = Math.max(0, Math.round(sentence?.begin_time ?? 0));
        const endMs = Math.max(startMs, Math.round(sentence?.end_time ?? startMs));
        // DashScope's sentence_end closes an ASR sentence. It is deliberately
        // not promoted to an interview-turn endpoint; the coordinator still
        // waits for the local semantic draft to settle.
        this.segmentListener({ source: this.source, text, startMs, endMs, final: Boolean(sentence?.sentence_end) });
      }
      return;
    }
    if (event === "task-finished") {
      this.ready = false;
      this.expectedClose = true;
      this.finishFinalize();
    }
  }

  private handleError(error: unknown): void {
    const failure = qwenProviderError(error, this.source, "PROVIDER_ERROR", "千问流式 ASR Provider 错误");
    this.readyWaiter?.reject(failure);
    this.notifyError(failure);
  }
  private handleClose(error?: Error): void {
    if (this.expectedClose) return;
    const failure = new ProviderError("PROVIDER_CLOSED", error?.message || "千问流式 ASR WebSocket 已断开", true, this.source);
    this.readyWaiter?.reject(failure);
    this.notifyError(failure);
  }
  private notifyError(error: ProviderError): void { this.errorListener?.(error); }
  private clearReadyWaiter(): void { if (this.readyWaiter) clearTimeout(this.readyWaiter.timer); this.readyWaiter = undefined; }
  private finishFinalize(): void { const waiters = this.finalizeWaiters.splice(0); for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(); } }
}

/** Alibaba Cloud Qwen realtime ASR adapter using the official JSON WebSocket event protocol. */
export class QwenRealtimeAsrProvider implements StreamingAsrProvider {
  private socket: StreamingAsrSocket | undefined;
  private source: "mic" | "remote" = "remote";
  private errorListener?: StreamingAsrErrorListener;
  private segmentListener?: (segment: Omit<TranscriptSegment, "id">) => void;
  private expectedClose = false;
  private sessionCreated = false;
  private sessionUpdateSent = false;
  private sessionUpdated = false;
  private sessionFinished = false;
  private eventSequence = 0;
  private sentAudioMs = 0;
  private lastFinalEndMs = 0;
  private activeItemId?: string;
  private readonly itemRanges = new Map<string, { startMs: number; endMs?: number; speechStopped?: boolean }>();
  private readyWaiter?: { resolve: () => void; reject: (error: ProviderError) => void; timer: ReturnType<typeof setTimeout> };
  private finalizing = false;
  private finalizeWaiters: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

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
    this.sessionCreated = false;
    this.sessionUpdateSent = false;
    this.sessionUpdated = false;
    this.sessionFinished = false;
    this.sentAudioMs = 0;
    this.lastFinalEndMs = 0;
    this.activeItemId = undefined;
    this.itemRanges.clear();
    if (!this.settings.apiKey.trim()) throw new ProviderError("AUTH_FAILED", "千问 API Key 未配置", false, source);

    let url: string;
    try {
      const parsed = new URL(this.settings.baseUrl || "wss://dashscope.aliyuncs.com/api-ws/v1/realtime");
      parsed.searchParams.set("model", this.settings.model || QWEN_REALTIME_ASR_MODEL);
      url = parsed.toString();
    } catch (error) {
      throw qwenProviderError(error, source, "CONNECTION_FAILED", "千问 ASR URL 无效");
    }

    const socket = this.socketFactory({ url, apiKey: this.settings.apiKey });
    this.socket = socket;
    socket.onError((error) => this.handleError(error));
    socket.onClose((error) => this.handleClose(error));
    socket.onMessage((data) => this.handleMessage(data));
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProviderError("CONNECTION_FAILED", "千问 ASR 会话初始化超时", true, source)), 10_000);
      this.readyWaiter = { resolve, reject, timer };
    });
    try {
      await socket.waitForOpen();
      if (this.sessionCreated) this.sendSessionUpdate();
      await ready;
    } catch (error) {
      const failure = qwenProviderError(error, source, "CONNECTION_FAILED", "千问 ASR WebSocket 连接失败");
      this.clearReadyWaiter();
      this.expectedClose = true;
      socket.close();
      this.socket = undefined;
      throw failure;
    }
  }

  sendAudio(pcm: Uint8Array): void {
    if (!this.socket || !this.sessionUpdated) throw new ProviderError("CONNECTION_FAILED", "千问 ASR 会话尚未 READY", true, this.source);
    try {
      this.socket.send(JSON.stringify({ event_id: this.nextEventId(), type: "input_audio_buffer.append", audio: bytesToBase64(pcm) }));
      this.sentAudioMs += Math.round((pcm.byteLength / 2 / 16_000) * 1_000);
    } catch (error) {
      const failure = qwenProviderError(error, this.source, "CONNECTION_FAILED", "千问 ASR 音频发送失败");
      this.notifyError(failure);
      throw failure;
    }
  }

  finalize(timeoutMs = 1_500): Promise<void> {
    if (!this.socket || this.sessionFinished) return Promise.resolve();
    this.finalizing = true;
    const promise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.finishFinalize();
        resolve();
      }, Math.max(750, Math.min(3_000, timeoutMs)));
      this.finalizeWaiters.push({ resolve, timer });
    });
    try {
      this.socket.send(JSON.stringify({ event_id: this.nextEventId(), type: "session.finish" }));
    } catch (error) {
      this.handleError(error);
      this.finishFinalize();
    }
    return promise;
  }

  close(): void {
    this.expectedClose = true;
    this.clearReadyWaiter();
    this.finishFinalize();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      if (!this.sessionFinished && !this.finalizing) {
        try { socket.send(JSON.stringify({ event_id: this.nextEventId(), type: "session.finish" })); } catch { /* socket may already be closed */ }
      }
      socket.close();
    }
    this.finalizing = false;
    this.errorListener = undefined;
    this.segmentListener = undefined;
  }

  private sendSessionUpdate(): void {
    if (this.sessionUpdateSent || !this.socket) return;
    this.sessionUpdateSent = true;
    const language = qwenLanguage(this.settings.language);
    this.socket.send(JSON.stringify({
      event_id: this.nextEventId(),
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm",
        sample_rate: 16_000,
        input_audio_transcription: { ...(language ? { language } : {}) },
        turn_detection: { type: "server_vad", threshold: 0, silence_duration_ms: 400 }
      }
    }));
  }

  private handleMessage(data: string): void {
    let message: QwenRealtimeMessage;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") throw new Error("Qwen ASR message is not an object");
      message = parsed as QwenRealtimeMessage;
    } catch (error) {
      this.notifyError(new ProviderError("INVALID_RESPONSE", `千问 ASR 返回了无效消息：${String(error)}`, true, this.source));
      return;
    }

    if (message.type === "error" || message.type === "conversation.item.input_audio_transcription.failed" || message.error) {
      const failure = qwenProviderError(new Error(qwenErrorMessage(message)), this.source, "PROVIDER_ERROR", qwenErrorMessage(message));
      this.readyWaiter?.reject(failure);
      this.notifyError(failure);
      return;
    }
    if (message.type === "session.created") {
      this.sessionCreated = true;
      try { this.sendSessionUpdate(); } catch (error) { this.handleError(error); }
      return;
    }
    if (message.type === "session.updated") {
      this.sessionUpdated = true;
      const waiter = this.readyWaiter;
      this.readyWaiter = undefined;
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
      return;
    }
    if (message.type === "input_audio_buffer.speech_started") {
      const itemId = message.item_id || `active-${this.source}`;
      this.activeItemId = itemId;
      this.itemRanges.set(itemId, { startMs: Math.max(0, Math.round(message.audio_start_ms ?? this.sentAudioMs)) });
      return;
    }
    if (message.type === "input_audio_buffer.speech_stopped") {
      const itemId = message.item_id || this.activeItemId || `active-${this.source}`;
      const current = this.itemRanges.get(itemId) ?? { startMs: this.lastFinalEndMs };
      this.itemRanges.set(itemId, { ...current, endMs: Math.max(current.startMs, Math.round(message.audio_end_ms ?? this.sentAudioMs)), speechStopped: true });
      return;
    }
    if (message.type === "conversation.item.input_audio_transcription.text") {
      this.emitTranscript(message, `${message.text ?? ""}${message.stash ?? ""}`, false);
      return;
    }
    if (message.type === "conversation.item.input_audio_transcription.completed") {
      this.emitTranscript(message, message.transcript ?? message.text ?? "", true);
      return;
    }
    if (message.type === "session.finished") {
      this.sessionFinished = true;
      this.expectedClose = true;
      this.finishFinalize();
    }
  }

  private emitTranscript(message: QwenRealtimeMessage, value: string, final: boolean): void {
    const text = value.trim();
    if (!text || !this.segmentListener) return;
    const itemId = message.item_id || this.activeItemId || `active-${this.source}`;
    const range = this.itemRanges.get(itemId) ?? { startMs: this.lastFinalEndMs };
    const startMs = Math.max(0, Math.round(range.startMs));
    const endMs = Math.max(startMs, Math.round(range.endMs ?? this.sentAudioMs));
    this.segmentListener({ source: this.source, text, startMs, endMs, final, utteranceId: itemId, ...(final && range.speechStopped ? { endpoint: true } : {}) });
    if (final) {
      this.lastFinalEndMs = endMs;
      this.itemRanges.delete(itemId);
      if (this.activeItemId === itemId) this.activeItemId = undefined;
    }
  }

  private handleError(error: unknown): void {
    const failure = qwenProviderError(error, this.source, "PROVIDER_ERROR", "千问 ASR Provider 错误");
    this.readyWaiter?.reject(failure);
    this.notifyError(failure);
  }

  private handleClose(error?: Error): void {
    if (this.expectedClose) return;
    const failure = new ProviderError("PROVIDER_CLOSED", error?.message || "千问 ASR WebSocket 已断开", true, this.source);
    this.readyWaiter?.reject(failure);
    this.notifyError(failure);
  }

  private nextEventId(): string {
    this.eventSequence += 1;
    return `event_${Date.now()}_${this.eventSequence}`;
  }

  private notifyError(error: ProviderError): void {
    this.errorListener?.(error);
  }

  private clearReadyWaiter(): void {
    if (this.readyWaiter) clearTimeout(this.readyWaiter.timer);
    this.readyWaiter = undefined;
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
