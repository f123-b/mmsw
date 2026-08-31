import { describe, expect, it } from "vitest";
import { LocalFunASRProvider, type ASRSocket } from "./asr/index";

class FakeSocket implements ASRSocket {
  readonly sent: Array<string | Uint8Array> = [];
  private listener?: (data: string) => void;
  waitForOpen(): Promise<void> { return Promise.resolve(); }
  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(): void {}
  onMessage(listener: (data: string) => void): void { this.listener = listener; }
  onError(): void {}
  onClose(): void {}
  emit(data: unknown): void { this.listener?.(JSON.stringify(data)); }
}

describe("LocalFunASRProvider", () => {
  it("uses the local PCM WebSocket protocol", async () => {
    const socket = new FakeSocket();
    const provider = new LocalFunASRProvider(() => socket, "remote");
    const segments: Array<{ text: string; final: boolean; endpoint?: boolean; endOfTurn?: boolean }> = [];
    provider.onTranscript((segment) => segments.push({ text: segment.text, final: segment.final, ...(segment.endpoint === undefined ? {} : { endpoint: segment.endpoint }), ...(segment.endOfTurn === undefined ? {} : { endOfTurn: segment.endOfTurn }) }));
    await provider.connect({ provider: "funasr-local", model: "funasr-nano:q8", language: "zh-CN", sampleRate: 16_000, channels: 1, vad: true });
    expect(JSON.parse(String(socket.sent[0]))).toMatchObject({ type: "config", model: "funasr-nano:q8", sampleRate: 16_000, channels: 1 });
    provider.sendAudio(new Uint8Array([1, 2]));
    expect(socket.sent[1]).toEqual(new Uint8Array([1, 2]));
    socket.emit({ type: "asr_final", text: "请介绍一下你的项目", startMs: 1000, endMs: 2300, confidence: 0.95 });
    expect(segments).toEqual([{ text: "请介绍一下你的项目", final: true }]);
  });
});
