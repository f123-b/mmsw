import { describe, expect, it } from "vitest";
import { DeepgramStreamingAsrProvider, ProviderError, splitStereoPcm, StereoAsrChannelRouter, type StreamingAsrSocket } from "./asr";

class FakeSocket implements StreamingAsrSocket {
  sent: Uint8Array[] = [];
  sentText: string[] = [];
  private message?: (data: string) => void;
  private error?: (error: Error) => void;
  private closeListener?: (error?: Error) => void;
  open = false;
  closed = false;
  waitForOpen(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => { this.openWaiter = { resolve, reject }; });
  }
  private openWaiter?: { resolve: () => void; reject: (error: Error) => void };
  send(data: Uint8Array | string): void { if (typeof data === "string") this.sentText.push(data); else this.sent.push(data); }
  close(): void { this.closed = true; this.closeListener?.(); }
  onMessage(listener: (data: string) => void): void { this.message = listener; }
  onError(listener: (error: Error) => void): void { this.error = listener; }
  onClose(listener: (error?: Error) => void): void { this.closeListener = listener; }
  openSocket(): void { this.open = true; this.openWaiter?.resolve(); this.openWaiter = undefined; }
  fail(error: Error): void { this.error?.(error); this.openWaiter?.reject(error); this.openWaiter = undefined; }
  emit(data: string): void { this.message?.(data); }
}

describe("stereo ASR routing", () => {
  it("splits left MIC and right SYSTEM PCM without swapping samples", () => {
    const packet = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(splitStereoPcm(packet)).toEqual({ mic: new Uint8Array([1, 2, 5, 6]), system: new Uint8Array([3, 4, 7, 8]) });
  });

  it("routes two mono streams and normalizes Deepgram final output", async () => {
    const sockets: FakeSocket[] = [];
    const requests: Array<{ url: string; apiKey: string }> = [];
    const factory = (options: { url: string; apiKey: string }) => { requests.push(options); const socket = new FakeSocket(); sockets.push(socket); socket.openSocket(); return socket; };
    const mic = new DeepgramStreamingAsrProvider({ model: "nova-3", language: "zh-CN", apiKey: "secret" }, factory);
    const remote = new DeepgramStreamingAsrProvider({ model: "nova-3", language: "zh-CN", apiKey: "secret" }, factory);
    const router = new StereoAsrChannelRouter(mic, remote);
    const segments: Array<{ source: string; text: string; final: boolean }> = [];
    await router.connect((segment) => segments.push({ source: segment.source, text: segment.text, final: segment.final }));
    expect(new URL(requests[0]?.url ?? "wss://invalid").searchParams.get("model")).toBe("nova-3");
    expect(new URL(requests[0]?.url ?? "wss://invalid").searchParams.get("language")).toBe("zh-CN");
    router.sendStereo(new Uint8Array([1, 2, 3, 4]));
    expect(sockets[0]?.sent[0]).toEqual(new Uint8Array([1, 2]));
    expect(sockets[1]?.sent[0]).toEqual(new Uint8Array([3, 4]));
    sockets[1]?.emit(JSON.stringify({ is_final: true, start: 0, duration: 0.4, channel: { alternatives: [{ transcript: "为什么要快进快出？", confidence: 0.95 }] } }));
    expect(segments).toEqual([{ source: "remote", text: "为什么要快进快出？", final: true }]);
  });

  it("waits for both sockets to open before sending PCM", async () => {
    const sockets: FakeSocket[] = [];
    const factory = () => { const socket = new FakeSocket(); sockets.push(socket); return socket; };
    const router = new StereoAsrChannelRouter(
      new DeepgramStreamingAsrProvider({ model: "nova-3", language: "zh-CN", apiKey: "secret" }, factory),
      new DeepgramStreamingAsrProvider({ model: "nova-3", language: "zh-CN", apiKey: "secret" }, factory)
    );
    const connecting = router.connect(() => undefined);
    await Promise.resolve();
    expect(router.isReady).toBe(false);
    expect(() => router.sendStereo(new Uint8Array([1, 2, 3, 4]))).toThrow(ProviderError);
    sockets[0]?.openSocket();
    expect(router.isReady).toBe(false);
    sockets[1]?.openSocket();
    await connecting;
    expect(router.isReady).toBe(true);
    router.sendStereo(new Uint8Array([1, 2, 3, 4]));
    expect(sockets[0]?.sent[0]).toEqual(new Uint8Array([1, 2]));
    expect(sockets[1]?.sent[0]).toEqual(new Uint8Array([3, 4]));
    router.close();
  });

  it("propagates auth failures and emits Finalize before CloseStream", async () => {
    const socket = new FakeSocket();
    const provider = new DeepgramStreamingAsrProvider({ model: "nova-3", language: "zh-CN", apiKey: "secret" }, () => socket);
    const errors: ProviderError[] = [];
    const connecting = provider.connect("remote", () => undefined, (error) => errors.push(error));
    socket.fail(new Error("401 Unauthorized"));
    await expect(connecting).rejects.toMatchObject({ code: "AUTH_FAILED", recoverable: false });
    expect(errors).toHaveLength(1);

    socket.openSocket();
    await provider.connect("remote", () => undefined, (error) => errors.push(error));
    const finalizing = provider.finalize(500);
    expect(socket.sentText).toContain(JSON.stringify({ type: "Finalize" }));
    socket.emit(JSON.stringify({ from_finalize: true }));
    await finalizing;
    provider.close();
    expect(socket.sentText).toContain(JSON.stringify({ type: "CloseStream" }));
  });

  it("emits a final transcript before completing Finalize when the response carries from_finalize", async () => {
    const socket = new FakeSocket();
    const provider = new DeepgramStreamingAsrProvider({ model: "nova-3", language: "zh-CN", apiKey: "secret" }, () => socket);
    const segments: string[] = [];
    const connecting = provider.connect("remote", (segment) => segments.push(segment.text));
    socket.openSocket();
    await connecting;
    const finalizing = provider.finalize(500);
    socket.emit(JSON.stringify({ from_finalize: true, is_final: true, start: 1, duration: 0.6, channel: { alternatives: [{ transcript: "最后一句问题" }] } }));
    await finalizing;
    expect(segments).toEqual(["最后一句问题"]);
    provider.close();
  });

  it("does not drop a transcript-bearing speech_final response during Finalize", async () => {
    const socket = new FakeSocket();
    const provider = new DeepgramStreamingAsrProvider({ model: "nova-3", language: "zh-CN", apiKey: "secret" }, () => socket);
    const segments: string[] = [];
    const connecting = provider.connect("remote", (segment) => segments.push(segment.text));
    socket.openSocket();
    await connecting;
    const finalizing = provider.finalize(500);
    socket.emit(JSON.stringify({ speech_final: true, is_final: true, start: 2, duration: 0.3, channel: { alternatives: [{ transcript: "收尾问题" }] } }));
    await finalizing;
    expect(segments).toEqual(["收尾问题"]);
    provider.close();
  });
});
