import { describe, expect, it, vi } from "vitest";
import { ASR_PRESETS, normalizeAsrSettings, usesHttpAsr, type AsrProviderType, type ProviderSettings } from "@interview-copilot/shared";
import { HttpStreamingAsrProvider, pcmToWav, transcribePcm } from "./http-asr-provider";

function settings(providerType: AsrProviderType, patch: Partial<ProviderSettings> = {}): ProviderSettings {
  const p = ASR_PRESETS[providerType]; return { providerType, providerName: p.name, model: p.models[0], baseUrl: p.baseUrl, apiKey: "test-key", timeoutMs: 15000, maxRetries: 0, language: "zh-CN", ...patch };
}
describe("ASR protocol requests", () => {
  it("migrates the reported Qwen Flash config from the wrong WebSocket while retaining region", async () => {
    const config = settings("qwen", { model: "qwen-audio-3.0-asr-flash", baseUrl: "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference" });
    expect(usesHttpAsr(config)).toBe(true);
    expect(normalizeAsrSettings(config).baseUrl).toBe("https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    let body: any;
    const fetcher = vi.fn(async (_url, init) => { body = JSON.parse(init.body as string); return Response.json({ output: { text: "你的优点是什么？", sentence: { text: "优点是什么？" } } }); });
    expect(await transcribePcm(config, new Uint8Array(3200), AbortSignal.timeout(3000), fetcher)).toBe("你的优点是什么？");
    expect(body.model).toBe("qwen-audio-3.0-asr-flash");
    expect(body.parameters).toEqual({ format: "wav", sample_rate: "16000", language_hints: ["zh"] });
    expect(body.input.messages[0].content[0].input_audio.data).toMatch(/^data:audio\/wav;base64,UklGR/);
  });
  it.each([{ output: { sentence: { text: "项目介绍" } } }, { output: { output: { sentence: { text: "项目介绍" } } } }])("parses Qwen Flash sentence response variants", async response => {
    expect(await transcribePcm(settings("qwen", { model: "qwen-audio-3.0-asr-flash" }), new Uint8Array(3200), AbortSignal.timeout(3000), async () => Response.json(response))).toBe("项目介绍");
  });
  it("preserves workspace-specific Qwen hosts and legacy qwen3 audio schema", async () => {
    let body: any;
    const fetcher = vi.fn(async (_url, init) => { body = JSON.parse(init.body as string); return Response.json({ output: { choices: [{ message: { content: [{ text: "你好" }] } }] } }); });
    const config = settings("qwen", { model: "qwen3-asr-flash", baseUrl: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" });
    await transcribePcm(config, new Uint8Array(3200), AbortSignal.timeout(3000), fetcher);
    expect(fetcher.mock.calls[0][0]).toContain("workspace.cn-beijing.maas.aliyuncs.com/api/v1/");
    expect(body.input.messages[0].content[0].audio).toMatch(/^data:audio\/wav/);
  });
  it.each(["openai", "groq", "siliconflow", "openai-compatible"] as const)("uploads WAV using %s's multipart endpoint without constraining model IDs", async provider => {
    const fetcher = vi.fn(async (_url, init) => { const form = init.body as FormData; expect(form.get("model")).toBe("future-asr-2027"); expect(form.get("language")).toBe("zh"); const wav = Buffer.from(await (form.get("file") as Blob).arrayBuffer()); expect(wav.readUInt32LE(24)).toBe(16000); expect(wav.readUInt16LE(22)).toBe(1); return Response.json({ text: "测试转写" }); });
    expect(await transcribePcm(settings(provider, { model: "future-asr-2027" }), new Uint8Array(1600), AbortSignal.timeout(3000), fetcher)).toBe("测试转写");
    expect(fetcher.mock.calls[0][0]).toMatch(/\/audio\/transcriptions$/);
    expect(fetcher.mock.calls[0][0]).not.toMatch(/\/v1\/v1\//);
  });
  it.each([
    ["elevenlabs", { text: "你好" }, "xi-api-key"],
    ["azure", { RecognitionStatus: "Success", DisplayText: "你好" }, "Ocp-Apim-Subscription-Key"],
    ["google", { results: [{ alternatives: [{ transcript: "你好" }] }] }, "Authorization"],
    ["volcengine", { result: { text: "你好" } }, "X-Api-Key"],
    ["baidu", { err_no: 0, result: ["你好"] }, "Authorization"],
    ["tencent", { Response: { Result: "你好" } }, "Authorization"]
  ] as const)("uses %s authentication and parses its response", async (provider, response, header) => {
    const config = settings(provider, { apiKey: provider === "baidu" ? "bce-v3/test-key" : "test-key", asrAppId: provider === "tencent" ? "test-id" : "" });
    const fetcher = vi.fn(async (_url, init) => { expect((init.headers as Record<string, string>)[header]).toBeTruthy(); return Response.json(response); });
    expect(await transcribePcm(config, new Uint8Array(3200), AbortSignal.timeout(3000), fetcher)).toBe("你好");
  });
  it("uploads then polls AssemblyAI using a bounded abort signal", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ upload_url: "https://cdn.assemblyai.test/audio" })).mockResolvedValueOnce(Response.json({ id: "task-1", status: "completed", text: "你好" }));
    expect(await transcribePcm(settings("assemblyai"), new Uint8Array(3200), AbortSignal.timeout(3000), fetcher)).toBe("你好");
    expect(fetcher.mock.calls[0][0]).toBe("https://api.assemblyai.com/v2/upload");
    expect(JSON.parse(fetcher.mock.calls[1][1].body).speech_models).toEqual(["universal-2"]);
  });
  it("surfaces provider errors instead of accepting an empty object as connected", async () => {
    await expect(transcribePcm(settings("openai"), new Uint8Array(3200), AbortSignal.timeout(3000), async () => Response.json({}))).rejects.toThrow("缺少转写文本");
    await expect(transcribePcm(settings("volcengine"), new Uint8Array(3200), AbortSignal.timeout(3000), async () => Response.json({}, { headers: { "X-Api-Status-Code": "45000000", "X-Api-Message": "model not available" } }))).rejects.toThrow("model not available");
  });
  it("encodes an exact PCM16 mono WAV payload", () => { const pcm = new Uint8Array([1, 0, 2, 0]); const wav = pcmToWav(pcm); expect(wav.length).toBe(48); expect(wav.readUInt32LE(40)).toBe(4); expect([...wav.subarray(44)]).toEqual([...pcm]); });
});
describe("HTTP ASR live segmentation", () => {
  const voice = () => { const pcm = Buffer.alloc(1280); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1800, i); return pcm; };
  it("does not upload silence and preserves ordering, timestamps and source across utterances", async () => {
    const fetcher = vi.fn(async () => Response.json({ text: `问题${fetcher.mock.calls.length}` }));
    const segments: any[] = [];
    const provider = new HttpStreamingAsrProvider(settings("openai"), fetcher);
    await provider.connect("remote", s => segments.push(s));
    for (let i = 0; i < 50; i++) provider.sendAudio(new Uint8Array(1280));
    expect(fetcher).not.toHaveBeenCalled();
    for (let j = 0; j < 2; j++) { for (let i = 0; i < 20; i++) provider.sendAudio(voice()); for (let i = 0; i < 17; i++) provider.sendAudio(new Uint8Array(1280)); }
    await provider.finalize();
    expect(segments.map(s => s.text)).toEqual(["问题1", "问题2"]);
    expect(segments[0]).toMatchObject({ source: "remote", final: true, endpoint: true });
    expect(segments[1].startMs).toBeGreaterThanOrEqual(segments[0].endMs);
    provider.close();
  });
  it("cancels pending requests on close and suppresses stale transcripts", async () => {
    let release: (response: Response) => void = () => {};
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const listener = vi.fn();
    const provider = new HttpStreamingAsrProvider(settings("openai"), fetcher);
    await provider.connect("mic", listener);
    provider.sendAudio(voice()); const pending = provider.finalize(); await Promise.resolve();
    provider.close(); release(Response.json({ text: "旧会话" })); await pending;
    expect(listener).not.toHaveBeenCalled();
  });
});
