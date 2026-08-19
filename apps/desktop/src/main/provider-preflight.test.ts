import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderPreflightCache, runProviderPreflight, testProviderConnection } from "./provider-preflight";
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
  afterEach(() => vi.unstubAllGlobals());

  it("blocks unconfigured providers before a request", async () => {
    const result = await runProviderPreflight({ ...Object.fromEntries(["llm", "asr", "embedding"].map((key) => [key, { ...settings(key as "llm" | "asr" | "embedding"), apiKey: "" }])) } as { llm: ProviderSettings; asr: ProviderSettings; embedding: ProviderSettings });
    expect(result.llm).toMatchObject({ configured: false, status: "unconfigured" });
    expect(result.embedding).toMatchObject({ configured: false, optional: true });
  });

  it("validates an OpenAI-compatible embedding response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(testProviderConnection("embedding", settings("embedding"))).resolves.toMatchObject({ reachable: true, status: "ready" });
  });

  it.each([
    {},
    { choices: [] },
    { choices: [{}] },
    { choices: [{ message: {} }] }
  ])("rejects malformed LLM response %j", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(testProviderConnection("llm", settings("llm"))).resolves.toMatchObject({ reachable: false, status: "network_failed" });
  });

  it("accepts an LLM response only when message content is a non-empty string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(testProviderConnection("llm", settings("llm"))).resolves.toMatchObject({ reachable: true, status: "ready" });
  });

  it("does not block required preflight on optional embedding reachability", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL) => {
      if (String(input).includes("embeddings")) return new Promise(() => undefined);
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    const result = await runProviderPreflight({ llm: settings("llm"), asr: { ...settings("asr"), apiKey: "" }, embedding: settings("embedding") }, true, new ProviderPreflightCache());
    expect(result.llm).toMatchObject({ reachable: true, status: "ready" });
    expect(result.embedding).toMatchObject({ configured: true, reachable: false, status: "testing", optional: true });
  });
});
