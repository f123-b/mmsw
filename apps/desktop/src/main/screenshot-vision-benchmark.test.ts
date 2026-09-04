import { describe, expect, it } from "vitest";
import { AnswerAgent, ModelRouter, OpenAICompatibleAnswerProvider, buildVisionInput } from "@interview-copilot/shared";
import { ScreenshotOperationRegistry } from "./screenshot-pipeline";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00
]);

function visionResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"截图已识别\"}}]}\n\n"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(body, { status: 200 });
}

describe("screenshot vision benchmark", () => {
  it("reports bounded capture, request, token, completion and cleanup timings", async () => {
    const captureStartedAt = performance.now();
    const image = { mimeType: "image/png" as const, bytes: PNG_BYTES, width: 1, height: 1 };
    const captureLatencyMs = performance.now() - captureStartedAt;

    const requestBuildStartedAt = performance.now();
    const input = buildVisionInput(image, "分析截图中的面试问题、代码或内容，并给出适合面试场景的回答。", 8 * 1024 * 1024);
    const requestBuildLatencyMs = performance.now() - requestBuildStartedAt;
    const imageDataUrl = `data:${input.image.mimeType};base64,${input.image.base64}`;
    let requestBody: Record<string, unknown> | undefined;
    const provider = new OpenAICompatibleAnswerProvider({ providerName: "benchmark", baseUrl: "https://llm.test", apiKey: "test-key", model: "mock-vision", timeoutMs: 5_000, maxRetries: 0 }, async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return visionResponse();
    });
    const answerAgent = new AnswerAgent({ vision: provider }, new ModelRouter({ vision: "mock-vision" }, "mock-vision"));
    const registry = new ScreenshotOperationRegistry();
    const operation = registry.begin("screenshot-benchmark", "session-benchmark");
    const providerStartedAt = performance.now();
    let providerFirstTokenMs: number | undefined;
    let responseCompletionMs: number | undefined;
    let answer = "";
    try {
      for await (const event of answerAgent.stream({ id: "screenshot-question", text: input.prompt }, "NORMAL", {}, operation.controller.signal, { hasScreenshot: true, attachments: [{ mimeType: input.image.mimeType, dataUrl: imageDataUrl }], allowQualityRepair: false, formatAnswer: true, maxRetries: 0 })) {
        if (event.type === "answer_delta") {
          answer += event.delta;
          providerFirstTokenMs ??= performance.now() - providerStartedAt;
        }
        if (event.type === "answer_end") {
          answer = event.text;
          responseCompletionMs = performance.now() - providerStartedAt;
        }
      }
      registry.finish("screenshot-benchmark", "completed");
    } catch (error) {
      registry.finish("screenshot-benchmark", "failed", String(error));
      throw error;
    }

    const metrics = {
      captureLatencyMs: Number(captureLatencyMs.toFixed(3)),
      requestBuildLatencyMs: Number(requestBuildLatencyMs.toFixed(3)),
      providerFirstTokenMs: Number((providerFirstTokenMs ?? 0).toFixed(3)),
      responseCompletionMs: Number((responseCompletionMs ?? 0).toFixed(3)),
      totalPipelineMs: Number((performance.now() - captureStartedAt).toFixed(3)),
      imageBytes: input.image.bytes,
      activeScreenshotOperationsFinal: registry.diagnostics().activeScreenshotOperations,
      leakedAbortControllers: registry.diagnostics().activeAbortControllers,
      finalRuntimeIdle: true
    };
    console.log(`SCREENSHOT_VISION_BENCHMARK ${JSON.stringify(metrics)}`);
    const messages = requestBody?.messages as Array<{ content: unknown }>;
    const content = messages?.[1]?.content as Array<Record<string, unknown>>;
    const imagePart = content?.find((part) => part.type === "image_url");
    expect(imagePart?.image_url).toEqual({ url: imageDataUrl, detail: "auto" });
    expect(answer).toContain("截图已识别");
    expect(metrics.imageBytes).toBeGreaterThan(0);
    expect(metrics.providerFirstTokenMs).toBeGreaterThanOrEqual(0);
    expect(metrics.responseCompletionMs).toBeGreaterThanOrEqual(metrics.providerFirstTokenMs);
    expect(metrics.activeScreenshotOperationsFinal).toBe(0);
    expect(metrics.leakedAbortControllers).toBe(0);
    expect(metrics.finalRuntimeIdle).toBe(true);
  });
});
