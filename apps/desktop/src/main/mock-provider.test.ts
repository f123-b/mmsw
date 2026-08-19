import { createServer, type Server } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { OpenAICompatibleAnswerProvider, OpenAICompatibleEmbeddingProvider, type ProviderSettings } from "@interview-copilot/shared";

let server: Server | undefined;

function providerSettings(baseUrl: string): ProviderSettings {
  return { providerName: "Mock OpenAI", baseUrl, apiKey: "mock-key", model: "mock-model", timeoutMs: 3_000, maxRetries: 0 };
}

afterEach(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); server = undefined; });

describe("MockOpenAIProviderServer integration", () => {
  it("streams chat deltas and returns embeddings", async () => {
    server = createServer((request, response) => {
      if (request.url?.endsWith("/v1/embeddings")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ embedding: [0.25, 0.5, 0.75] }] }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Mock " } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    }).listen(0);
    await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not bind");
    const settings = providerSettings(`http://127.0.0.1:${address.port}`);
    let text = "";
    for await (const delta of new OpenAICompatibleAnswerProvider(settings).stream({ model: settings.model, sections: [{ name: "question", content: "ping" }] })) text += delta;
    expect(text).toBe("Mock answer");
    await expect(new OpenAICompatibleEmbeddingProvider({ ...settings, model: "text-embedding-3-small" }).embed("test")).resolves.toEqual([0.25, 0.5, 0.75]);
  });
});
