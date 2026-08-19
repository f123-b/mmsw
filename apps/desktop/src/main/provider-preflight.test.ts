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
    await expect(testProviderConnection("llm", settings("llm"))).resolves.toMatchObject({ reachable: false, status: "invalid_response" });
  });

  it("accepts an LLM response only when message content is a non-empty string", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(testProviderConnection("llm", settings("llm"))).resolves.toMatchObject({ reachable: true, status: "ready" });
  });

  it("accepts a DeepSeek reasoning response as a valid reachable response", async () => {
    const deepSeek: ProviderSettings = { ...settings("llm"), providerName: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK", reasoning_content: "reasoning" } }] }), { status: 200 });
    }));
    await expect(testProviderConnection("llm", deepSeek)).resolves.toMatchObject({ reachable: true, status: "ready" });
    expect(requestUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(requestBody?.thinking).toEqual({ type: "disabled" });
  });

  it("does not reject a reasoning-only response as network failure", async () => {
    const deepSeek: ProviderSettings = { ...settings("llm"), providerName: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: "provider completed a reasoning pass" } }] }), { status: 200 })));
    await expect(testProviderConnection("llm", deepSeek)).resolves.toMatchObject({ configured: true, reachable: true, status: "ready" });
  });

  it("classifies provider HTTP failures instead of collapsing them into network_failed", async () => {
    for (const [status, expected] of [[401, "auth_failed"], [404, "model_not_found"], [422, "bad_request"], [429, "rate_limited"], [500, "server_error"]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "provider error" } }), { status })));
      await expect(testProviderConnection("llm", settings("llm"))).resolves.toMatchObject({ reachable: false, status: expected });
    }
  });

  it("allows a local OpenAI-compatible provider without an API key", async () => {
    const local: ProviderSettings = { ...settings("llm"), providerName: "Ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "", model: "llama3" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 })));
    await expect(testProviderConnection("llm", local)).resolves.toMatchObject({ configured: true, reachable: true, status: "ready" });
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
