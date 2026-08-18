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
    for await (const delta of provider.stream({ model: "configured-model", sections: [{ name: "question", content: "请介绍项目" }] })) deltas.push(delta);
    expect(deltas.join("")).toBe("核心回答");
    expect(JSON.parse(String(request?.body)).model).toBe("configured-model");
  });

  it("loads an OpenAI-compatible embedding vector", async () => {
    const provider = new OpenAICompatibleEmbeddingProvider({ providerName: "test", baseUrl: "https://embed.test", apiKey: "secret", model: "embed-v1", timeoutMs: 5_000, maxRetries: 0 }, async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }));
    await expect(provider.embed("实时音频")).resolves.toEqual([0.1, 0.2, 0.3]);
  });
});
