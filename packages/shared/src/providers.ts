import type { AnswerProvider, AnswerProviderRequest, PromptSection } from "./answer";

export interface ProviderSettings {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel?: string;
  normalModel?: string;
  deepModel?: string;
  visionModel?: string;
  timeoutMs: number;
  maxRetries: number;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function buildMessages(sections: PromptSection[], attachments: Array<{ mimeType: string; dataUrl: string }> = []): Array<{ role: "system" | "user"; content: string | Array<Record<string, unknown>> }> {
  const system = sections.filter((section) => section.name !== "question").map((section) => `[${section.name}]\n${section.content}`).join("\n\n");
  const question = sections.find((section) => section.name === "question")?.content ?? "";
  const userContent: string | Array<Record<string, unknown>> = attachments.length === 0
    ? question
    : [{ type: "text", text: question }, ...attachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.dataUrl, detail: "auto", mimeType: attachment.mimeType } }))];
  return [
    { role: "system", content: system },
    { role: "user", content: userContent }
  ];
}

function extractDelta(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  if (typeof delta?.content === "string") return delta.content;
  if (typeof choice?.text === "string") return choice.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.delta === "string") return record.delta;
  return "";
}

function abortError(): Error {
  const error = new Error("Provider request aborted");
  error.name = "AbortError";
  return error;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, 500);
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function* parseSse(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider response has no streaming body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const value = line.trim();
        if (!value.startsWith("data:")) continue;
        const payload = value.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const delta = extractDelta(JSON.parse(payload));
          if (delta) yield delta;
        } catch {
          // Ignore keep-alive/non-JSON SSE frames; the provider contract is still streamed.
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) {
      const payload = buffer.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        const delta = extractDelta(JSON.parse(payload));
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleAnswerProvider implements AnswerProvider {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly settings: ProviderSettings, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async *stream(request: AnswerProviderRequest, signal?: AbortSignal): AsyncIterable<string> {
    const externalSignal = signal ?? new AbortController().signal;
    let lastError: unknown;
    const retries = Math.max(0, Math.min(5, this.settings.maxRetries));
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (externalSignal.aborted) throw abortError();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1_000, this.settings.timeoutMs));
      const abort = () => controller.abort();
      externalSignal.addEventListener("abort", abort, { once: true });
      try {
        const response = await this.fetchImpl(endpoint(this.settings.baseUrl, "v1/chat/completions"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.settings.apiKey ? { authorization: `Bearer ${this.settings.apiKey}` } : {})
          },
          body: JSON.stringify({ model: request.model || this.settings.model, messages: buildMessages(request.sections, request.attachments), stream: true }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Answer provider HTTP ${response.status}: ${await readError(response)}`);
        let yielded = false;
        for await (const delta of parseSse(response, controller.signal)) {
          yielded = true;
          yield delta;
        }
        return;
      } catch (error) {
        if (externalSignal.aborted) throw abortError();
        lastError = error;
        if (attempt >= retries) break;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250 * (attempt + 1));
          externalSignal.addEventListener("abort", () => { clearTimeout(timer); reject(abortError()); }, { once: true });
        });
      } finally {
        clearTimeout(timeout);
        externalSignal.removeEventListener("abort", abort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Answer provider request failed");
  }
}

export class OpenAICompatibleEmbeddingProvider {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly settings: ProviderSettings, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, this.settings.timeoutMs));
    try {
      const response = await this.fetchImpl(endpoint(this.settings.baseUrl, "v1/embeddings"), {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.settings.apiKey ? { authorization: `Bearer ${this.settings.apiKey}` } : {}) },
        body: JSON.stringify({ model: this.settings.model, input: text }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Embedding provider HTTP ${response.status}: ${await readError(response)}`);
      const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
      const embedding = payload.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) throw new Error("Embedding provider returned an invalid vector");
      return embedding as number[];
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface AsrEvent {
  type: "partial" | "final" | "status";
  source: "mic" | "remote";
  id?: string;
  text?: string;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  state?: "connecting" | "listening" | "stopped" | "error";
}

/** Contract for a real ASR gateway. The desktop sends raw 16-bit stereo PCM packets. */
