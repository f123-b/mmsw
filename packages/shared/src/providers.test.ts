import { describe, expect, it } from "vitest";
import { OpenAICompatibleAnswerProvider, OpenAICompatibleEmbeddingProvider } from "./index";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  return new Response(body, { status: 200 });
}

describe("OpenAICompatibleAnswerProvider", () => {
  it("parses OpenAI-compatible SSE deltas and uses configured model", async () => {
    let request: RequestInit | undefined;
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "test", baseUrl: "https://llm.test/", apiKey: "secret", model: "qwen-max", timeoutMs: 5_000, maxRetries: 0 }, async (_input, init) => {
      request = init;
      return streamResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":\"核心\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"回答\"}}]}\n\n",
        "data: [DONE]\n\n"
      ]);
    });
    const deltas: string[] = [];
    for await (const delta of provider.stream({ model: "configured-model", maxOutputTokens: 1_024, sections: [{ name: "question", content: "请介绍项目" }] })) deltas.push(delta);
    expect(deltas.join("")).toBe("核心回答");
    expect(JSON.parse(String(request?.body)).model).toBe("configured-model");
    expect(JSON.parse(String(request?.body)).max_tokens).toBe(1_024);
  });

  it("stops when the provider sends finish_reason even without a DONE frame", async () => {
    const encoder = new TextEncoder();
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "test", baseUrl: "https://llm.test", apiKey: "secret", model: "test-model", timeoutMs: 5_000, maxRetries: 0 }, async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"完成\"},\"finish_reason\":\"stop\"}]}\n\n"));
        // Some gateways leave the connection open after the terminal frame.
      }
    })));
    const deltas: string[] = [];
    for await (const delta of provider.stream({ model: "test-model", sections: [{ name: "question", content: "问题" }] })) deltas.push(delta);
    expect(deltas).toEqual(["完成"]);
  });

  it("fails closed when an SSE gateway closes without a terminal frame", async () => {
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "test", baseUrl: "https://llm.test", apiKey: "secret", model: "test-model", timeoutMs: 5_000, maxRetries: 0 }, async () => streamResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"半截\"}}]}\n\n"]));
    const deltas: string[] = [];
    await expect((async () => { for await (const delta of provider.stream({ model: "test-model", sections: [{ name: "question", content: "问题" }] })) deltas.push(delta); })()).rejects.toThrow("closed before completion");
    expect(deltas).toEqual(["半截"]);
  });

  it("extracts content arrays used by newer OpenAI-compatible gateways", async () => {
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "test", baseUrl: "https://llm.test", apiKey: "secret", model: "test-model", timeoutMs: 5_000, maxRetries: 0 }, async () => streamResponse(["data: {\"choices\":[{\"delta\":{\"content\":[{\"type\":\"text\",\"text\":\"数组\"}]}}]}\n\ndata: [DONE]\n\n"]));
    const deltas: string[] = [];
    for await (const delta of provider.stream({ model: "test-model", sections: [{ name: "question", content: "问题" }] })) deltas.push(delta);
    expect(deltas).toEqual(["数组"]);
  });

  it("uses the DeepSeek chat endpoint and disables thinking for low-latency modes", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "secret", model: "deepseek-v4-flash", timeoutMs: 5_000, maxRetries: 0 }, async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamResponse(["data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n", "data: [DONE]\n\n"]);
    });
    const deltas: string[] = [];
    for await (const delta of provider.stream({ model: "deepseek-v4-flash", thinking: false, sections: [{ name: "question", content: "ping" }] })) deltas.push(delta);
    expect(requestUrl).toBe("https://api.deepseek.com/chat/completions");
    expect(requestBody?.thinking).toEqual({ type: "disabled" });
    expect(deltas.join("")).toBe("OK");
  });

  it("supports a non-streaming completion for direct-display answers", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "test", baseUrl: "https://llm.test", apiKey: "secret", model: "test-model", timeoutMs: 5_000, maxRetries: 2 }, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "一次性回答" } }] }), { status: 200 });
    });
    await expect(provider.complete({ model: "test-model", sections: [{ name: "question", content: "问题" }], maxRetries: 0 })).resolves.toBe("一次性回答");
    expect(requestBody?.stream).toBe(false);
  });

  it("ignores reasoning-only SSE deltas instead of exposing chain of thought", async () => {
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "secret", model: "deepseek-v4-flash", timeoutMs: 5_000, maxRetries: 0 }, async () => streamResponse([
      "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"内部推理\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"最终回答\"}}]}\n\n",
      "data: [DONE]\n\n"
    ]));
    const deltas: string[] = [];
    for await (const delta of provider.stream({ model: "deepseek-v4-flash", thinking: true, sections: [{ name: "question", content: "ping" }] })) deltas.push(delta);
    expect(deltas).toEqual(["最终回答"]);
  });

  it("loads an OpenAI-compatible embedding vector", async () => {
    const provider = new OpenAICompatibleEmbeddingProvider({ providerName: "test", baseUrl: "https://embed.test", apiKey: "secret", model: "embed-v1", timeoutMs: 5_000, maxRetries: 0 }, async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }));
    await expect(provider.embed("实时音频")).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});
