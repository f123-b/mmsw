import { describe, expect, it, vi } from "vitest";
import type { ProviderSettings } from "@interview-copilot/shared";
import { discoverProviderModels, modelCatalogInternals } from "./model-catalog";

const settings = (providerName: string, baseUrl: string): ProviderSettings => ({ providerName, baseUrl, apiKey: "test-key", model: "test", timeoutMs: 5_000, maxRetries: 0 });

describe("model catalog", () => {
  it("uses DeepSeek's official /models route and classifies returned models", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }), { status: 200 }));
    const result = await discoverProviderModels("llm", settings("DeepSeek", "https://api.deepseek.com/v1"), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({ method: "GET" }));
    expect(result.models.find((model) => model.id === "deepseek-v4-flash")?.categories).toEqual(expect.arrayContaining(["fast", "general", "reasoning"]));
  });

  it("parses and filters the Qwen catalog by capability", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: { models: [
      { model: "qwen-flash", name: "千问 Flash", capabilities: ["TG"] },
      { model: "qwen3-vl-plus", capabilities: ["TG", "VU"] },
      { model: "text-embedding-v4", capabilities: ["TR"] },
      { model: "qwen3-asr-flash-realtime", capabilities: ["Realtime-ASR"] }
    ] } }), { status: 200 }));
    const result = await discoverProviderModels("llm", settings("千问", "https://dashscope.aliyuncs.com/compatible-mode/v1"), fetchImpl);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("https://dashscope.aliyuncs.com/api/v1/models?");
    expect(result.models.map((model) => model.id)).toEqual(["qwen-flash", "qwen3-vl-plus"]);
  });

  it("merges the complete official Qwen streaming ASR compatibility catalog", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output: { models: [] } }), { status: 200 }));
    const result = await discoverProviderModels("asr", { ...settings("Qwen Realtime ASR", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"), providerType: "qwen" }, fetchImpl);
    expect(result.models.length).toBeGreaterThanOrEqual(14);
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "qwen3-asr-flash-realtime", categories: ["realtime-asr"] }),
      expect.objectContaining({ id: "qwen-audio-3.0-asr-flash-streaming" }),
      expect.objectContaining({ id: "fun-asr-realtime" }),
      expect.objectContaining({ id: "paraformer-realtime-v2" })
    ]));
    expect(result.warning).toBeTruthy();
  });

  it("recognizes embeddings without leaking request credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "text-embedding-3-small" }, { id: "chat-model" }] }), { status: 200 }));
    const result = await discoverProviderModels("embedding", settings("Compatible", "https://models.test/v1"), fetchImpl);
    expect(result.models.map((model) => model.id)).toEqual(["text-embedding-3-small"]);
    expect(JSON.stringify(result)).not.toContain("test-key");
  });

  it("builds the native Qwen catalog endpoint from websocket and compatible URLs", () => {
    expect(modelCatalogInternals.qwenModelsEndpoint(settings("Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"))).toContain("https://dashscope.aliyuncs.com/api/v1/models");
    expect(modelCatalogInternals.qwenModelsEndpoint({ ...settings("Qwen", "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"), providerType: "qwen" })).toContain("https://dashscope.aliyuncs.com/api/v1/models");
  });
});
