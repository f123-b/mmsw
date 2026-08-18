import { describe, expect, it } from "vitest";
import { RealtimeSession, type RealtimeSocket } from "./realtime-session";

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
});
