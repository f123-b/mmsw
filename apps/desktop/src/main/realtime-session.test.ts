import { describe, expect, it, vi } from "vitest";
import { RealtimeSession, type RealtimeSocket } from "./realtime-session";
import type { ProviderSettings, StreamingAsrSocket } from "@interview-copilot/shared";
import type { VADProvider } from "@interview-copilot/shared/vad";

class FakeSocket implements RealtimeSocket {
  readonly sent: Array<string | Uint8Array> = [];
  readonly readyState = 1;
  bufferedAmount = 0;
  binaryType?: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(): void { this.onclose?.(); }
}

class FakeDeepgramSocket implements StreamingAsrSocket {
  sent: Array<string | Uint8Array> = [];
  private openListener?: () => void;
  private errorListener?: (error: Error) => void;
  private waitErrorListener?: (error: Error) => void;
  private messageListener?: (data: string) => void;
  private closeListener?: (error?: Error) => void;
  private opened = false;
  waitForOpen(): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.openListener = () => { this.opened = true; resolve(); };
      this.waitErrorListener = reject;
    });
  }
  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(): void { this.closeListener?.(); }
  onMessage(listener: (data: string) => void): void { this.messageListener = listener; }
  onError(listener: (error: Error) => void): void { this.errorListener = listener; }
  onClose(listener: (error?: Error) => void): void { this.closeListener = listener; }
  open(): void { this.opened = true; this.openListener?.(); }
  fail(error: Error): void { this.errorListener?.(error); this.waitErrorListener?.(error); }
  emit(data: string): void { this.messageListener?.(data); }
}

const directSettings: ProviderSettings = { providerName: "Deepgram", providerType: "deepgram", baseUrl: "wss://api.deepgram.com/v1/listen", apiKey: "secret", model: "nova-3", language: "zh-CN", timeoutMs: 15_000, maxRetries: 2 };
const qwenSettings: ProviderSettings = { providerName: "Qwen Realtime ASR", providerType: "qwen", baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", apiKey: "secret", model: "qwen3-asr-flash-realtime", language: "zh-CN", timeoutMs: 15_000, maxRetries: 2 };

function fakeVAD(ready: boolean): VADProvider {
  return {
    providerName: "silero",
    fallback: false,
    process: () => ({ speech: false, startTime: 0, endTime: 0, speechProbability: 0, speechStarted: false, speechEnded: false, ready }),
    reset: () => undefined
  };
}

describe("RealtimeSession", () => {
  it("routes live stereo audio to Qwen Flash HTTP and returns a final interviewer transcript", async () => {
    const http = vi.fn(async () => Response.json({ output: { text: "你的优点是什么？" } }));
    vi.stubGlobal("fetch", http);
    const config: ProviderSettings = { ...qwenSettings, model: "qwen-audio-3.0-asr-flash", baseUrl: "wss://dashscope.aliyuncs.com/api-ws/v1/inference" };
    const socketFactory = vi.fn(() => new FakeSocket());
    const session = new RealtimeSession(socketFactory, () => config, undefined, undefined, undefined, undefined, () => fakeVAD(true));
    const transcripts: Array<{ text: string; source: string; final: boolean }> = [];
    session.on("transcript", (_snapshot, segment) => { if (segment) transcripts.push(segment); });
    try {
      session.connect({ providerType: "qwen", model: config.model, autoReconnect: false });
      await vi.waitFor(() => expect(session.connectionState).toBe("connected"));
      const stereo = Buffer.alloc(2560);
      for (let i = 2; i < stereo.length; i += 4) stereo.writeInt16LE(1800, i);
      for (let i = 0; i < 20; i++) session.sendAudio(stereo);
      for (let i = 0; i < 17; i++) session.sendAudio(new Uint8Array(2560));
      await vi.waitFor(() => expect(transcripts).toContainEqual(expect.objectContaining({ text: "你的优点是什么？", source: "remote", final: true })));
      expect(http).toHaveBeenCalledTimes(1);
      expect(socketFactory).not.toHaveBeenCalled();
    } finally { session.disconnect(); vi.unstubAllGlobals(); }
  });
  it("sends client_ready and keeps ASR partials out of final history", () => {
    const socket = new FakeSocket();
    const session = new RealtimeSession(() => socket);
    const snapshots: Array<{ final: unknown[]; partial?: unknown }> = [];
    session.on("transcript", (snapshot) => snapshots.push(snapshot));
    session.connect({ url: "wss://example.test/realtime", autoReconnect: false });
    socket.onopen?.();
    expect(socket.sent[0]).toBe(JSON.stringify({ type: "client_ready" }));
    socket.onmessage?.({ data: JSON.stringify({ type: "asr_partial", segment: { id: "r1", source: "remote", text: "你能不能", startMs: 0, endMs: 300, final: false } }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "asr_final", segment: { id: "r1", source: "remote", text: "你能不能解释采样同步？", startMs: 0, endMs: 900, final: true } }) });
    expect(snapshots[0]?.final).toHaveLength(0);
    expect(snapshots[1]?.final).toHaveLength(1);
    session.disconnect();
  });

  it("forwards silent PCM to ASR while VAD only updates diagnostics", () => {
    const socket = new FakeSocket();
    const session = new RealtimeSession(
      () => socket,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => fakeVAD(true)
    );
    session.connect({ url: "wss://example.test/realtime", autoReconnect: false });
    socket.onopen?.();
    session.sendAudio(new Uint8Array(2_560));
    expect(socket.sent).toContainEqual(expect.any(Uint8Array));
    expect(session.asrDiagnostics.micSpeech).toBe(false);
    session.disconnect();
  });

  it("forwards PCM while Silero providers are still warming up", () => {
    const socket = new FakeSocket();
    const session = new RealtimeSession(
      () => socket,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => fakeVAD(false)
    );
    session.connect({ url: "wss://example.test/realtime", autoReconnect: false });
    socket.onopen?.();
    session.sendAudio(new Uint8Array(2_560));
    expect(socket.sent).toContainEqual(expect.any(Uint8Array));
    session.disconnect();
  });

  it("does not grow the audio queue beyond its bounded budget", () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 300_000;
    const session = new RealtimeSession(() => socket);
    session.connect({ url: "wss://example.test/realtime", autoReconnect: false });
    for (let index = 0; index < 100; index += 1) session.sendAudio(new Uint8Array(2_560));
    expect(session.pendingAudioStats.queuedBytes).toBeLessThanOrEqual(192_000);
    session.disconnect();
  });

  it("does not queue audio while reconnecting or after an error", () => {
    const socket = new FakeSocket();
    const session = new RealtimeSession(() => socket);
    session.connect({ url: "wss://example.test/realtime", autoReconnect: false });
    socket.onopen?.();
    socket.onerror?.();
    session.sendAudio(new Uint8Array(2_560));
    expect(session.pendingAudioStats.queuedPackets).toBe(0);
    session.disconnect();
  });

  it("uses Deepgram Direct only after both channel sockets are OPEN", async () => {
    const sockets: FakeDeepgramSocket[] = [];
    const session = new RealtimeSession(undefined, () => directSettings, () => { const socket = new FakeDeepgramSocket(); sockets.push(socket); return socket; });
    session.connect({ providerType: "deepgram", model: "nova-3", language: "zh-CN", autoReconnect: false });
    await Promise.resolve();
    expect(session.connectionState).toBe("connecting");
    expect(sockets).toHaveLength(2);
    sockets[0]?.open();
    await Promise.resolve();
    expect(session.connectionState).toBe("connecting");
    sockets[1]?.open();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(session.connectionState).toBe("connected");
    session.sendAudio(new Uint8Array([1, 2, 3, 4]));
    expect(sockets[0]?.sent).toContainEqual(new Uint8Array([1, 2]));
    expect(sockets[1]?.sent).toContainEqual(new Uint8Array([3, 4]));
    sockets[1]?.emit(JSON.stringify({ is_final: true, speech_final: true, start: 0, duration: 0.3, channel: { alternatives: [{ transcript: "为什么使用 DMA", confidence: 0.9 }] } }));
    expect(session.asrDiagnostics.lastFinalObservedLatencyMs).toBeDefined();
    session.disconnect();
  });

  it("propagates a direct provider failure as ASR_FAILED without reconnect when disabled", async () => {
    const sockets: FakeDeepgramSocket[] = [];
    const messages: Array<{ type: string; code?: string }> = [];
    const session = new RealtimeSession(undefined, () => directSettings, () => { const socket = new FakeDeepgramSocket(); sockets.push(socket); return socket; });
    session.on("message", (message: { type: string; code?: string }) => messages.push(message));
    session.connect({ providerType: "deepgram", language: "zh-CN", autoReconnect: false });
    await Promise.resolve();
    sockets[0]?.fail(new Error("Deepgram model rejected"));
    await Promise.resolve();
    expect(messages.some((message) => message.type === "runtime_error" && message.code === "ASR_FAILED")).toBe(true);
    expect(session.connectionState).toBe("error");
    session.disconnect();
  });

  it("uses the existing stereo router for Qwen Direct", async () => {
    const sockets: FakeDeepgramSocket[] = [];
    const session = new RealtimeSession(undefined, () => qwenSettings, undefined, () => { const socket = new FakeDeepgramSocket(); sockets.push(socket); return socket; });
    session.connect({ providerType: "qwen", model: "qwen3-asr-flash-realtime", language: "zh-CN", autoReconnect: false });
    await Promise.resolve();
    expect(session.asrDiagnostics.provider).toBe("Qwen Direct");
    expect(sockets).toHaveLength(2);
    sockets[0]?.open();
    sockets[1]?.open();
    await Promise.resolve();
    for (const socket of sockets) {
      socket.emit(JSON.stringify({ type: "session.created" }));
      socket.emit(JSON.stringify({ type: "session.updated" }));
    }
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(session.connectionState).toBe("connected");
    session.sendAudio(new Uint8Array([1, 2, 3, 4]));
    const micAudio = sockets[0]?.sent.map((value) => typeof value === "string" ? JSON.parse(value) as { type?: string; audio?: string } : {}).find((value) => value.type === "input_audio_buffer.append");
    const remoteAudio = sockets[1]?.sent.map((value) => typeof value === "string" ? JSON.parse(value) as { type?: string; audio?: string } : {}).find((value) => value.type === "input_audio_buffer.append");
    expect(micAudio?.audio).toBe("AQI=");
    expect(remoteAudio?.audio).toBe("AwQ=");
    session.disconnect();
  });

  it("puts the custom gateway token only in the URL ticket", () => {
    const socket = new FakeSocket();
    let connectedUrl = "";
    const session = new RealtimeSession((url) => { connectedUrl = url; return socket; });
    session.connect({ providerType: "custom-gateway", url: "ws://127.0.0.1:8787/realtime", gatewayToken: "short-lived", model: "nova-3", language: "zh-CN", autoReconnect: false });
    socket.onopen?.();
    expect(new URL(connectedUrl).searchParams.get("ticket")).toBe("short-lived");
    expect(socket.sent[0]).toBe(JSON.stringify({ type: "client_ready", model: "nova-3", language: "zh-CN" }));
    session.disconnect();
  });
});
