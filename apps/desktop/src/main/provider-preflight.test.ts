import { describe, expect, it, vi } from "vitest";
import { runProviderPreflight, testProviderConnection } from "./provider-preflight";
import type { ProviderSettings } from "@interview-copilot/shared";

const settings = (section: "llm" | "asr" | "embedding"): ProviderSettings => ({
  providerName: section === "asr" ? "Deepgram" : "Mock OpenAI",
  providerType: section === "asr" ? "deepgram" : undefined,
  baseUrl: section === "asr" ? "wss://example.test/listen" : "https://example.test",
  apiKey: "test-key",
  model: section === "embedding" ? "text-embedding-3-small" : "mock-model",
  language: section === "asr" ? "zh-CN" : undefined,
  timeoutMs: 1_000,
  maxRetries: 0
});

describe("Provider preflight", () => {
  it("blocks unconfigured providers before a request", async () => {
    const result = await runProviderPreflight({ ...Object.fromEntries(["llm", "asr", "embedding"].map((key) => [key, { ...settings(key as "llm" | "asr" | "embedding"), apiKey: "" }])) } as { llm: ProviderSettings; asr: ProviderSettings; embedding: ProviderSettings });
    expect(result.llm).toMatchObject({ configured: false, status: "unconfigured" });
    expect(result.embedding).toMatchObject({ configured: false, optional: true });
  });

  it("validates an OpenAI-compatible embedding response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(testProviderConnection("embedding", settings("embedding"))).resolves.toMatchObject({ reachable: true, status: "ready" });
    vi.unstubAllGlobals();
  });
});
