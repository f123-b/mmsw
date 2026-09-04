import type { AnswerProvider, AnswerProviderRequest, PromptSection } from "./answer";

export type AsrProviderType = "deepgram" | "qwen" | "openai" | "groq" | "siliconflow" | "openai-compatible" | "elevenlabs" | "azure" | "google" | "assemblyai" | "volcengine" | "baidu" | "tencent" | "custom-gateway" | "funasr-local";
export type AsrLanguage = "zh-CN" | "en-US" | "multi";
export type LlmApiProtocol = "openai-chat" | "openai-responses" | "anthropic-messages";

export interface ProviderSettings {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiProtocol?: LlmApiProtocol;
  providerType?: AsrProviderType;
  asrProtocol?: "auto" | "qwen-http" | "qwen-realtime" | "dashscope-streaming" | "openai-transcription";
  /** Public application identifier (Volcengine App ID or Tencent SecretId). */
  asrAppId?: string;
  language?: AsrLanguage;
  fastModel?: string;
  normalModel?: string;
  deepModel?: string;
  visionModel?: string;
  fallbackModel?: string;
  questionRecognitionModel?: string;
  profileBuilderModel?: string;
  projectAnalyzerModel?: string;
  questionBankModel?: string;
  chatModel?: string;
  postInterviewModel?: string;
  preparationModel?: string;
  timeoutMs: number;
  maxRetries: number;
  /** Explicit vision capability override for providers/models that are text-only. */
  supportsVision?: boolean;
  /** Explicitly override whether this provider requires an API key. */
  requiresApiKey?: boolean;
}

export interface ProviderCapabilities {
  requiresApiKey: boolean;
  supportsThinking: boolean;
  supportsVision: boolean;
  chatPath: string;
  embeddingPath: string;
}

export interface ModelConfigurationIssue {
  field: keyof ProviderSettings;
  message: string;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function llmApiProtocol(settings: ProviderSettings): LlmApiProtocol {
  if (settings.apiProtocol) return settings.apiProtocol;
  if (/\/responses\/?$/i.test(settings.baseUrl)) return "openai-responses";
  if (/^https:\/\/api\.anthropic\.com(?:\/|$)/i.test(settings.baseUrl) || /\/messages\/?$/i.test(settings.baseUrl)) return "anthropic-messages";
  return "openai-chat";
}

export function llmRequestHeaders(settings: ProviderSettings): Record<string, string> {
  return { "content-type": "application/json", ...(llmApiProtocol(settings) === "anthropic-messages"
    ? { "anthropic-version": "2023-06-01", ...(settings.apiKey ? { "x-api-key": settings.apiKey } : {}) }
    : settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) };
}

function isDeepSeek(settings: ProviderSettings): boolean {
  try {
    return settings.providerName.toLowerCase().includes("deepseek") || new URL(settings.baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return settings.providerName.toLowerCase().includes("deepseek");
  }
}

function isLocalProvider(settings: ProviderSettings): boolean {
  try {
    const hostname = new URL(settings.baseUrl).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";
  } catch {
    return false;
  }
}

export function providerCapabilities(settings: ProviderSettings): ProviderCapabilities {
  const deepSeek = isDeepSeek(settings);
  const local = isLocalProvider(settings) || /ollama|lm\s*studio|vllm|local/i.test(settings.providerName);
  return {
    requiresApiKey: settings.requiresApiKey ?? (!local),
    supportsThinking: deepSeek,
    supportsVision: settings.supportsVision ?? true,
    chatPath: llmApiProtocol(settings) === "anthropic-messages" ? "v1/messages" : llmApiProtocol(settings) === "openai-responses" ? "v1/responses" : deepSeek ? "chat/completions" : "v1/chat/completions",
    embeddingPath: "v1/embeddings"
  };
}

export function providerSupportsVision(settings: ProviderSettings): boolean {
  return providerCapabilities(settings).supportsVision;
}

function cleanBaseUrl(baseUrl: string, settings: ProviderSettings): string {
  let base = baseUrl.trim().replace(/\/+$/, "");
  base = base.replace(/\/(?:chat\/completions|embeddings|responses|messages)$/i, "");
  if (isDeepSeek(settings)) base = base.replace(/\/v1$/i, "");
  return base;
}

export function providerEndpoint(settings: ProviderSettings, path: string): string {
  let normalized = path.replace(/^\/+/, "");
  const base = cleanBaseUrl(settings.baseUrl, settings);
  // A supplied path is the API prefix, including Gemini's /v1beta/openai,
  // Doubao's /api/v3 and arbitrary OpenAI-compatible gateways.
  if (new URL(base).pathname.replace(/\/+$/, "") && /^v1\//i.test(normalized)) normalized = normalized.slice(3);
  return `${base}/${normalized}`;
}

const CHAT_MODEL_FIELDS: Array<keyof ProviderSettings> = [
  "model", "fastModel", "normalModel", "deepModel", "visionModel", "fallbackModel",
  "questionRecognitionModel", "profileBuilderModel", "projectAnalyzerModel", "questionBankModel",
  "chatModel", "postInterviewModel", "preparationModel"
];

export function validateLlmModelConfiguration(settings: Partial<ProviderSettings>): ModelConfigurationIssue[] {
  const issues: ModelConfigurationIssue[] = [];
  if (!settings.baseUrl?.trim()) issues.push({ field: "baseUrl", message: "Base URL 不能为空" });
  else {
    try {
      const url = new URL(settings.baseUrl);
      if (!/^https?:$/.test(url.protocol)) issues.push({ field: "baseUrl", message: "LLM Base URL 必须使用 http 或 https" });
    } catch {
      issues.push({ field: "baseUrl", message: "LLM Base URL 格式无效" });
    }
  }
  if (!settings.model?.trim()) issues.push({ field: "model", message: "默认对话模型不能为空" });
  if (settings.apiProtocol && !["openai-chat", "openai-responses", "anthropic-messages"].includes(settings.apiProtocol)) issues.push({ field: "apiProtocol", message: "不支持的 LLM API 协议" });
  for (const field of CHAT_MODEL_FIELDS) {
    const model = settings[field];
    if (typeof model !== "string" || !model.trim()) continue;
    if (/(?:^|[-_/])(embedding|embed)(?:$|[-_/\d])|text-embedding|bge[-_/]|(?:^|[-_/])e5(?:$|[-_/])/i.test(model)) {
      issues.push({ field, message: `${String(field)} 需要对话/生成模型，不能使用向量模型 ${model}` });
    }
  }
  return issues;
}

function buildMessages(sections: PromptSection[], attachments: Array<{ mimeType: string; dataUrl: string }> = []): Array<{ role: "system" | "user"; content: string | Array<Record<string, unknown>> }> {
  const system = sections.filter((section) => section.name !== "question").map((section) => `[${section.name}]\n${section.content}`).join("\n\n");
  const question = sections.find((section) => section.name === "question")?.content ?? "";
  const userContent: string | Array<Record<string, unknown>> = attachments.length === 0
    ? question
    : [{ type: "text", text: question }, ...attachments.map((attachment) => ({ type: "image_url", image_url: { url: attachment.dataUrl, detail: "auto" } }))];
  return [
    { role: "system", content: system },
    { role: "user", content: userContent }
  ];
}

function thinkingForRequest(settings: ProviderSettings, request: AnswerProviderRequest): { type: "enabled" | "disabled" } | undefined {
  const capabilities = providerCapabilities(settings);
  if (!capabilities.supportsThinking || request.thinking === undefined) return undefined;
  return { type: request.thinking ? "enabled" : "disabled" };
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const item = part as Record<string, unknown>;
    return typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
  }).join("");
}

export function buildLlmHttpRequest(settings: ProviderSettings, request: AnswerProviderRequest, stream: boolean): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const model = request.model || settings.model;
  const protocol = llmApiProtocol(settings);
  const messages = buildMessages(request.sections, request.attachments);
  const system = messages[0].content;
  const question = request.sections.find(section => section.name === "question")?.content ?? "";
  const attachments = request.attachments ?? [];
  let body: Record<string, unknown>;
  if (protocol === "anthropic-messages") {
    body = { model, system, stream, max_tokens: request.maxOutputTokens ?? 4096, messages: [{ role: "user", content: [{type:"text",text:question}, ...attachments.map(image => {
      const data = /^data:([^;,]+);base64,(.+)$/s.exec(image.dataUrl);
      return {type:"image",source:data ? {type:"base64",media_type:data[1],data:data[2]} : {type:"url",url:image.dataUrl}};
    })] }] };
  } else if (protocol === "openai-responses") {
    body = { model, instructions: system, input: [{ role: "user", content: [{type:"input_text",text:question}, ...attachments.map(image => ({type:"input_image",image_url:image.dataUrl,detail:"auto"}))] }], store: false, stream, ...(request.maxOutputTokens ? {max_output_tokens:request.maxOutputTokens} : {}) };
  } else {
    const thinking = thinkingForRequest(settings, request);
    const tokenKey = /^(?:gpt-5|o[134](?:-|$))/i.test(model) ? "max_completion_tokens" : "max_tokens";
    body = {model,messages,stream,...(thinking ? {thinking} : {}), ...(request.maxOutputTokens ? {[tokenKey]:request.maxOutputTokens} : {})};
  }
  return {url:providerEndpoint(settings,providerCapabilities(settings).chatPath),headers:llmRequestHeaders(settings),body};
}

function extractDelta(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.type === "content_block_delta") return (record.delta as {type?:string;text?:string})?.type === "text_delta" ? (record.delta as {text:string}).text : "";
  if (record.type === "response.output_text.delta" || record.type === "response.refusal.delta") return String(record.delta ?? "");
  if (typeof record.type === "string" && record.type.startsWith("response.")) return "";
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  const deltaContent = textFromContent(delta?.content);
  if (deltaContent) return deltaContent;
  const messageContent = textFromContent((choice?.message as Record<string, unknown> | undefined)?.content);
  if (messageContent) return messageContent;
  if (typeof choice?.text === "string") return choice.text;
  if (typeof record.content === "string") return record.content;
  if (typeof record.output_text === "string") return record.output_text;
  if (typeof record.delta === "string") return record.delta;
  return "";
}

function streamFinished(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "message_stop" || record.type === "response.completed") return true;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0];
  if (!choice || typeof choice !== "object") return false;
  const finishReason = (choice as Record<string, unknown>).finish_reason;
  return typeof finishReason === "string" && finishReason.length > 0;
}

export function extractLlmCompletion(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.output)) return record.output.filter(item => item?.type === "message").map(item => textFromContent(item.content)).join("");
  if (Array.isArray(record.content)) return textFromContent(record.content.filter(item => item?.type === "text"));
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as Record<string, unknown>;
      return typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
    }).join("");
  }
  if (typeof record.output_text === "string") return record.output_text;
  return extractDelta(value);
}

function abortError(): Error {
  const error = new Error("Provider request aborted");
  error.name = "AbortError";
  return error;
}

/** Bound even a non-compliant gateway which ignores abort. */
export function abortableProviderTask<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void task.catch(() => undefined); return Promise.reject(abortError()); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, {once:true});
    task.then(value => {signal.removeEventListener('abort',abort);resolve(value);}, error => {signal.removeEventListener('abort',abort);reject(error);});
  });
}

function retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {clearTimeout(timer);signal.removeEventListener('abort',abort);reject(abortError());};
    const timer = setTimeout(() => {signal.removeEventListener('abort',abort);resolve();},250*(attempt+1));
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) abort();
  });
}

function assertLlmPayload(value: unknown): void {
  const payload = value as {error?: {message?:string}|string; type?:string; response?:{error?:{message?:string};incomplete_details?:{reason?:string}}};
  if (payload?.error || payload?.type === 'response.failed' || payload?.type === 'response.incomplete') throw new Error(`Provider response failed: ${typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.response?.error?.message ?? payload.response?.incomplete_details?.reason ?? payload.type}`);
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.slice(0, 500);
  } catch {
    return `HTTP ${response.status}`;
  }
}

async function* parseSse(response: Response, signal: AbortSignal, onFinish: (reason: string) => void): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider response has no streaming body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const next = await abortableProviderTask(reader.read(), signal);
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (buffer.length > 2_000_000) throw new Error("Provider SSE frame exceeds size limit");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const value = line.trim();
        if (!value.startsWith("data:")) continue;
        const payload = value.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          finished = true;
          onFinish("stop");
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          assertLlmPayload(parsed);
          const delta = extractDelta(parsed);
          if (delta) yield delta;
          if (streamFinished(parsed)) {
            finished = true;
            const choices = (parsed as Record<string, unknown>).choices;
            const choice = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined;
            onFinish(String(choice?.finish_reason ?? "stop"));
            return;
          }
        } catch (error) {
          throw new Error(`Invalid SSE payload: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) {
      const payload = buffer.slice(5).trim();
      if (payload === "[DONE]") {
        finished = true;
        onFinish("stop");
        return;
      }
      if (payload) {
        const parsed = JSON.parse(payload);
        assertLlmPayload(parsed);
        const delta = extractDelta(parsed);
        if (delta) yield delta;
        if (streamFinished(parsed)) {
          finished = true;
          const choices = (parsed as Record<string, unknown>).choices;
          const choice = Array.isArray(choices) ? choices[0] as Record<string, unknown> | undefined : undefined;
          onFinish(String(choice?.finish_reason ?? "stop"));
          return;
        }
      }
    }
    if (!finished) throw new Error("Provider stream closed before completion");
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class OpenAICompatibleAnswerProvider implements AnswerProvider {
  private readonly fetchImpl: FetchLike;
  lastStreamMetadata: { startedAt?: number; firstTokenAt?: number; finishedAt?: number; finishReason?: string } | undefined;

  constructor(private readonly settings: ProviderSettings, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async *stream(request: AnswerProviderRequest, signal?: AbortSignal): AsyncIterable<string> {
    if (request.attachments?.length && !providerSupportsVision(this.settings)) throw new Error("VISION_NOT_SUPPORTED");
    const externalSignal = signal ?? new AbortController().signal;
    const startedAt = Date.now();
    this.lastStreamMetadata = { startedAt };
    let lastError: unknown;
    const retries = Math.max(0, Math.min(5, request.maxRetries ?? this.settings.maxRetries));
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (externalSignal.aborted) throw abortError();
      const controller = new AbortController();
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1_000, this.settings.timeoutMs));
      const abort = () => controller.abort();
      externalSignal.addEventListener("abort", abort, { once: true });
      let yielded = false;
      try {
        const http = buildLlmHttpRequest(this.settings, request, true);
        const response = await abortableProviderTask(this.fetchImpl(http.url, {
          method: "POST",
          headers: http.headers,
          body: JSON.stringify(http.body),
          signal: controller.signal
        }), controller.signal);
        if (!response.ok) throw new Error(`Answer provider HTTP ${response.status}: ${await abortableProviderTask(readError(response), controller.signal)}`);
        if (response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
          const payload = await abortableProviderTask(response.json(), controller.signal);
          assertLlmPayload(payload);
          const completion = extractLlmCompletion(payload);
          if (!completion.trim()) throw new Error("Answer provider returned an empty completion");
          this.lastStreamMetadata = { ...this.lastStreamMetadata, firstTokenAt: Date.now(), finishedAt: Date.now(), finishReason: "stop" };
          yielded = true;
          yield completion;
          return;
        }
        for await (const delta of parseSse(response, controller.signal, (reason) => { this.lastStreamMetadata = { ...this.lastStreamMetadata, finishReason: reason }; })) {
          if (!this.lastStreamMetadata?.firstTokenAt) this.lastStreamMetadata = { ...this.lastStreamMetadata, firstTokenAt: Date.now() };
          yielded = true;
          yield delta;
        }
        this.lastStreamMetadata = { ...this.lastStreamMetadata, finishedAt: Date.now() };
        return;
      } catch (error) {
        if (externalSignal.aborted) throw abortError();
        if (timedOut) {
          const timeoutError = new Error("Answer provider request timed out");
          timeoutError.name = "TimeoutError";
          (timeoutError as Error & { code?: string }).code = "CHAT_TIMEOUT";
          throw timeoutError;
        }
        lastError = error;
        if (yielded || /HTTP (?:400|401|403|404|422)\b/.test(String(error))) break;
        if (attempt >= retries) break;
        await retryDelay(attempt, externalSignal);
      } finally {
        clearTimeout(timeout);
        externalSignal.removeEventListener("abort", abort);
      }
    }
    this.lastStreamMetadata = { ...this.lastStreamMetadata, finishedAt: Date.now() };
    throw lastError instanceof Error ? lastError : new Error("Answer provider request failed");
  }

  async complete(request: AnswerProviderRequest, signal?: AbortSignal): Promise<string> {
    if (request.attachments?.length && !providerSupportsVision(this.settings)) throw new Error("VISION_NOT_SUPPORTED");
    const externalSignal = signal ?? new AbortController().signal;
    let lastError: unknown;
    const retries = Math.max(0, Math.min(5, request.maxRetries ?? this.settings.maxRetries));
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (externalSignal.aborted) throw abortError();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1_000, this.settings.timeoutMs));
      const abort = () => controller.abort();
      externalSignal.addEventListener("abort", abort, { once: true });
      try {
        const http = buildLlmHttpRequest(this.settings, request, false);
        const response = await abortableProviderTask(this.fetchImpl(http.url, {
          method: "POST",
          headers: http.headers,
          body: JSON.stringify(http.body),
          signal: controller.signal
        }), controller.signal);
        if (!response.ok) throw new Error(`Answer provider HTTP ${response.status}: ${await abortableProviderTask(readError(response), controller.signal)}`);
        const payload = await abortableProviderTask(response.json(), controller.signal);
        assertLlmPayload(payload);
        const completion = extractLlmCompletion(payload);
        if (!completion.trim()) throw new Error("Answer provider returned an empty completion");
        return completion;
      } catch (error) {
        if (externalSignal.aborted) throw abortError();
        lastError = error;
        if (controller.signal.aborted || /HTTP (?:400|401|403|404|422)\b/.test(String(error))) break;
        if (attempt >= retries) break;
        await retryDelay(attempt, externalSignal);
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

  async embed(text: string, externalSignal?: AbortSignal): Promise<number[]> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, this.settings.timeoutMs));
    try {
      const response = await this.fetchImpl(providerEndpoint(this.settings, providerCapabilities(this.settings).embeddingPath), {
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
      externalSignal?.removeEventListener("abort", abort);
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
