import { describe, expect, it } from "vitest";
import { RealtimeSession, type RealtimeSocket } from "./realtime-session";
import type { ProviderSettings, StreamingAsrSocket } from "@interview-copilot/shared";

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

describe("RealtimeSession", () => {
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

  it("does not grow the audio queue beyond its bounded budget", () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 300_000;
    const session = new RealtimeSession(() => socket);
    for (let index = 0; index < 100; index += 1) session.sendAudio(new Uint8Array(2_560));
    expect(session.pendingAudioStats.queuedBytes).toBeLessThanOrEqual(192_000);
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
