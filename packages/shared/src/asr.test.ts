import { describe, expect, it } from "vitest";
import { DeepgramStreamingAsrProvider, splitStereoPcm, StereoAsrChannelRouter, type StreamingAsrSocket } from "./asr";

class FakeSocket implements StreamingAsrSocket {
  sent: Uint8Array[] = [];
  private message?: (data: string) => void;
  send(data: Uint8Array): void { this.sent.push(data); }
  close(): void {}
  onMessage(listener: (data: string) => void): void { this.message = listener; }
  onError(): void {}
  emit(data: string): void { this.message?.(data); }
}

describe("stereo ASR routing", () => {
  it("splits left MIC and right SYSTEM PCM without swapping samples", () => {
    const packet = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(splitStereoPcm(packet)).toEqual({ mic: new Uint8Array([1, 2, 5, 6]), system: new Uint8Array([3, 4, 7, 8]) });
  });

  it("routes two mono streams and normalizes Deepgram final output", async () => {
    const sockets: FakeSocket[] = [];
    const factory = () => { const socket = new FakeSocket(); sockets.push(socket); return socket; };
    const mic = new DeepgramStreamingAsrProvider({ model: "nova-3", apiKey: "secret" }, factory);
    const remote = new DeepgramStreamingAsrProvider({ model: "nova-3", apiKey: "secret" }, factory);
    const router = new StereoAsrChannelRouter(mic, remote);
    const segments: Array<{ source: string; text: string; final: boolean }> = [];
    await router.connect((segment) => segments.push({ source: segment.source, text: segment.text, final: segment.final }));
    router.sendStereo(new Uint8Array([1, 2, 3, 4]));
    expect(sockets[0]?.sent[0]).toEqual(new Uint8Array([1, 2]));
    expect(sockets[1]?.sent[0]).toEqual(new Uint8Array([3, 4]));
    sockets[1]?.emit(JSON.stringify({ is_final: true, start: 0, duration: 0.4, channel: { alternatives: [{ transcript: "为什么要快进快出？", confidence: 0.95 }] } }));
    expect(segments).toEqual([{ source: "remote", text: "为什么要快进快出？", final: true }]);
  });
});
