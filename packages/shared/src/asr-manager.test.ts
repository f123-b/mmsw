import { describe, expect, it } from "vitest";
import { ASRManager, type ASRProvider } from "./asr/index";
import type { ASRConfig, ASRStatus, ASRTranscriptListener } from "./asr/index";

class FakeProvider implements ASRProvider {
  readonly sent: Uint8Array[] = [];
  private listener?: ASRTranscriptListener;
  private status: ASRStatus = { state: "disconnected", provider: "funasr-local", model: "", language: "" };
  async connect(config: ASRConfig): Promise<void> { this.status = { state: "ready", provider: config.provider, model: config.model, language: config.language }; }
  sendAudio(pcm: Uint8Array): void { this.sent.push(pcm); }
  onTranscript(listener: ASRTranscriptListener): void { this.listener = listener; }
  async disconnect(): Promise<void> { this.status = { ...this.status, state: "disconnected" }; }
  getStatus(): ASRStatus { return this.status; }
  emit(text: string): void { this.listener?.({ text, startMs: 0, endMs: 100, final: true }); }
}

const config: ASRConfig = { provider: "funasr-local", model: "funasr-nano:q8", language: "zh-CN", sampleRate: 16_000, channels: 2, vad: true };

describe("ASRManager", () => {
  it("switches providers without changing the audio contract", async () => {
    const providers: FakeProvider[] = [];
    const manager = new ASRManager({ providerFactory: () => { const provider = new FakeProvider(); providers.push(provider); return provider; } });
    await manager.connect(config);
    expect(manager.getStatus()).toMatchObject({ state: "ready", provider: "funasr-local", model: "funasr-nano:q8" });
    manager.sendAudio(new Uint8Array(400));
    expect(providers).toHaveLength(2);
    expect(providers.every((provider) => provider.sent[0]?.byteLength === 200)).toBe(true);
    await manager.disconnect();
    await manager.connect({ ...config, provider: "deepgram", model: "nova-3" });
    expect(manager.getStatus().provider).toBe("deepgram");
    expect(providers).toHaveLength(4);
  });

  it("forwards transcripts from the provider channel", async () => {
    const provider = new FakeProvider();
    const manager = new ASRManager({ providerFactory: () => provider });
    const texts: string[] = [];
    manager.onTranscript((segment) => texts.push(segment.text));
    await manager.connect({ ...config, channels: 1 });
    provider.emit("介绍一下你的项目");
    expect(texts).toEqual(["介绍一下你的项目"]);
  });
});
