import { normalizeAsrSettings, usesHttpAsr } from "@interview-copilot/shared";
import { HttpAsrError, transcribePcm } from "./http-asr-provider";
import WebSocket from "ws";
import { buildLlmHttpRequest, extractLlmCompletion, abortableProviderTask } from "@interview-copilot/shared";
import { providerCapabilities, providerEndpoint, qwenAsrWebSocketUrl, QWEN_REALTIME_ASR_MODEL, usesQwenRealtimeProtocol, type ProviderSettings } from "@interview-copilot/shared";
import type { ProviderSection } from "./settings-store";

export type ProviderCheckStatus = "unconfigured" | "testing" | "ready" | "auth_failed" | "model_not_found" | "bad_request" | "rate_limited" | "server_error" | "invalid_response" | "network_failed" | "timeout";

export interface ProviderCheckResult {
  section: ProviderSection;
  configured: boolean;
  reachable: boolean;
  status: ProviderCheckStatus;
  message?: string;
}

export interface ProviderPreflightResult {
  llm: ProviderCheckResult;
  asr: ProviderCheckResult;
  embedding: ProviderCheckResult & { optional: boolean };
}

type CachedProviderCheck = { expiresAt: number; result: ProviderCheckResult };

export class ProviderPreflightCache {
  private readonly values = new Map<string, CachedProviderCheck>();
  constructor(private readonly ttlMs = 5 * 60_000) {}

  get(section: ProviderSection, settings: ProviderSettings): ProviderCheckResult | undefined {
    const value = this.values.get(this.key(section, settings));
    if (!value || value.expiresAt <= Date.now()) {
      if (value) this.values.delete(this.key(section, settings));
      return undefined;
    }
    return { ...value.result };
  }

  set(section: ProviderSection, settings: ProviderSettings, result: ProviderCheckResult): void {
    this.values.set(this.key(section, settings), { expiresAt: Date.now() + this.ttlMs, result: { ...result } });
  }

  invalidate(section?: ProviderSection): void {
    if (!section) { this.values.clear(); return; }
    for (const key of this.values.keys()) if (key.startsWith(`${section}:`)) this.values.delete(key);
  }

  private key(section: ProviderSection, settings: ProviderSettings): string {
    return `${section}:${JSON.stringify({ ...settings, apiKey: settings.apiKey ? "configured" : "" })}`;
  }
}

function configured(section: ProviderSection, settings: ProviderSettings): boolean {
  if (section === "reranker" && settings.providerName === "Disabled") return true;
  if (section === "asr" && (settings.providerType === "custom-gateway" || settings.providerType === "funasr-local")) return Boolean(settings.baseUrl && settings.model);
  const capabilities = providerCapabilities(settings);
  return Boolean(settings.baseUrl && settings.model && (!capabilities.requiresApiKey || settings.apiKey));
}

function classifyHttp(status: number): ProviderCheckStatus {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  if (status === 400 || status === 422) return "bad_request";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "network_failed";
}

function statusMessage(status: ProviderCheckStatus, settings: ProviderSettings, body?: string): string {
  if (status === "auth_failed") return "认证失败：API Key 无效或未授权";
  if (status === "model_not_found") return `模型不存在：${settings.model}`;
  if (status === "bad_request") return body ? `请求参数不兼容：${body.slice(0, 240)}` : "请求参数不兼容";
  if (status === "rate_limited") return "Provider 限流，请稍后重试";
  if (status === "server_error") return "Provider 服务端错误，请稍后重试";
  return body ? `网络连接失败：${body.slice(0, 240)}` : "网络连接失败";
}

function responseErrorText(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") return (error as Record<string, unknown>).message as string;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Keep the bounded raw body for diagnostics below.
  }
  return body.trim() || undefined;
}

async function testHttp(section: "llm" | "embedding", settings: ProviderSettings, signal: AbortSignal): Promise<ProviderCheckResult> {
  const isLlm = section === "llm";
  const capabilities = providerCapabilities(settings);
  const http = isLlm ? buildLlmHttpRequest(settings, {model:settings.model,thinking:false,maxOutputTokens:1024,sections:[{name:"question",content:"Reply with OK."}]}, false) : undefined;
  const response = await abortableProviderTask(fetch(http?.url ?? providerEndpoint(settings, capabilities.embeddingPath), {
    method: "POST",
    headers: http?.headers ?? { "content-type": "application/json", ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify(http?.body ?? { model: settings.model, input: "test" }),
    signal
  }), signal);
  if (!response.ok) {
    const status = classifyHttp(response.status);
    return { section, configured: true, reachable: false, status, message: statusMessage(status, settings, responseErrorText(await abortableProviderTask(response.text(), signal))) };
  }
  let payload: Record<string, unknown>;
  try {
    payload = await abortableProviderTask(response.json(), signal) as Record<string, unknown>;
  } catch (error) {
    if (signal.aborted) throw error;
    return { section, configured: true, reachable: false, status: "invalid_response", message: `Provider 返回格式异常：${String(error)}` };
  }
  if (isLlm) {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    const message = choice?.message as Record<string, unknown> | undefined;
    const content = [message?.content, message?.reasoning_content, choice?.text].find((value) => typeof value === "string" && value.trim()) as string | undefined;
    if (!extractLlmCompletion(payload).trim() && !content) return { section, configured: true, reachable: false, status: "invalid_response", message: "Provider 返回格式异常：缺少可读取的文本，请检查 API 协议与模型能力" };
  } else {
    const vector = (Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined)?.embedding;
    if (!Array.isArray(vector) || !vector.every((item) => typeof item === "number")) return { section, configured: true, reachable: false, status: "invalid_response", message: "Provider 返回格式异常：Embedding 返回非法向量" };
  }
  return { section, configured: true, reachable: true, status: "ready" };
}

async function testAsr(settings: ProviderSettings, signal: AbortSignal): Promise<ProviderCheckResult> {
  const section: ProviderSection = "asr";
  const isQwen = settings.providerType === "qwen";
  const isLocal = settings.providerType === "funasr-local";
  if (!configured(section, settings)) return { section, configured: false, reachable: false, status: "unconfigured", message: settings.providerType === "custom-gateway" ? "未配置 Custom Gateway" : isLocal ? "未配置本地 ASR 服务地址或模型" : isQwen ? "未配置千问 API Key" : "未配置 Deepgram API Key" };
  const qwenRealtime = isQwen && (settings.asrProtocol === "qwen-realtime" || settings.asrProtocol !== "dashscope-streaming" && usesQwenRealtimeProtocol(settings.model || QWEN_REALTIME_ASR_MODEL));
  const url = new URL(isQwen ? normalizeAsrSettings(settings).baseUrl : settings.baseUrl || "wss://api.deepgram.com/v1/listen");
  if (qwenRealtime) {
    url.searchParams.set("model", settings.model || QWEN_REALTIME_ASR_MODEL);
  } else if (settings.providerType !== "custom-gateway" && !isLocal) {
    url.searchParams.set("model", settings.model);
    url.searchParams.set("language", settings.language ?? "zh-CN");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
  }
  return await new Promise<ProviderCheckResult>((resolve) => {
    let settled = false;
    const finish = (result: ProviderCheckResult) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); socket?.close(); resolve(result); };
    const timer = setTimeout(() => finish({ section, configured: true, reachable: false, status: "timeout", message: "WebSocket 握手超时" }), Math.max(1_000, settings.timeoutMs));
    let socket: WebSocket | undefined;
    const abort = () => finish({ section, configured: true, reachable: false, status: "timeout", message: "测试已取消" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      const authorization = isQwen ? `Bearer ${settings.apiKey}` : `Token ${settings.apiKey}`;
      socket = new WebSocket(url, settings.providerType === "custom-gateway" || isLocal ? undefined : { headers: { Authorization: authorization, ...(qwenRealtime ? { "OpenAI-Beta": "realtime=v1" } : {}) } });
      socket.once("open", () => {
        if (isLocal) {
          socket?.send(JSON.stringify({ type: "config", model: settings.model, language: settings.language ?? "zh-CN", sampleRate: 16_000, channels: 1, vad: true }));
          finish({ section, configured: true, reachable: true, status: "ready" });
        } else if (isQwen && !qwenRealtime) {
          const taskId = `preflight${Date.now().toString(16)}`;
          socket?.send(JSON.stringify({ header: { action: "run-task", task_id: taskId, streaming: "duplex" }, payload: { task_group: "audio", task: "asr", function: "recognition", model: settings.model, parameters: { format: "pcm", sample_rate: /(?:^|-)8k(?:-|$)/i.test(settings.model) ? 8_000 : 16_000 }, input: {} } }));
        } else if (!isQwen) {
          finish({ section, configured: true, reachable: true, status: "ready" });
        }
      });
      if (isQwen) socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as { type?: string; code?: string; message?: string; error?: string | { code?: string; message?: string }; header?: { event?: string; error_code?: string; error_message?: string } };
          if (!qwenRealtime && message.header?.event === "task-started") {
            finish({ section, configured: true, reachable: true, status: "ready" });
            return;
          }
          if (message.type === "session.created") {
            socket?.send(JSON.stringify({
              event_id: `event_${Date.now()}_preflight`,
              type: "session.update",
              session: {
                modalities: ["text"],
                input_audio_format: "pcm",
                sample_rate: 16_000,
                input_audio_transcription: { ...(settings.language === "zh-CN" ? { language: "zh" } : settings.language === "en-US" ? { language: "en" } : {}) },
                turn_detection: { type: "server_vad", threshold: 0, silence_duration_ms: 400 }
              }
            }));
            return;
          }
          if (message.type === "session.updated") {
            finish({ section, configured: true, reachable: true, status: "ready" });
            return;
          }
          if (message.type === "error" || message.type === "conversation.item.input_audio_transcription.failed" || message.error || message.header?.event === "task-failed" || message.header?.error_code) {
            const nested = message.error && typeof message.error === "object" ? message.error : undefined;
            const detail = [message.code, message.message, typeof message.error === "string" ? message.error : undefined, nested?.code, nested?.message, message.header?.error_code, message.header?.error_message].filter(Boolean).join(": ");
            const status: ProviderCheckStatus = /invalid.*(api.?key|token)|authentication|unauthori[sz]ed|forbidden|\b(401|403)\b/i.test(detail) ? "auth_failed" : /model.*(not.*found|invalid|unsupported)|invalid.*model/i.test(detail) ? "model_not_found" : "bad_request";
            finish({ section, configured: true, reachable: false, status, message: statusMessage(status, settings, detail) });
          }
        } catch (error) {
          finish({ section, configured: true, reachable: false, status: "invalid_response", message: `千问 ASR 返回格式异常：${String(error)}` });
        }
      });
      socket.once("unexpected-response", (_request, response) => {
        const status = classifyHttp(response.statusCode ?? 0);
        finish({ section, configured: true, reachable: false, status, message: statusMessage(status, settings) });
      });
      socket.once("error", (error) => finish({ section, configured: true, reachable: false, status: "network_failed", message: `网络连接失败：${error.message}` }));
    } catch (error) {
      finish({ section, configured: true, reachable: false, status: "network_failed", message: String(error) });
    }
  });
}

export async function testProviderConnection(section: ProviderSection, settings: ProviderSettings): Promise<ProviderCheckResult> {
  if (!configured(section, settings)) {
    const needsKey = providerCapabilities(settings).requiresApiKey;
    return { section, configured: false, reachable: false, status: "unconfigured", message: needsKey ? section === "llm" ? "未配置 LLM API Key" : section === "embedding" ? "未配置 Embedding API Key" : "未配置 Provider" : "未配置 Base URL 或 Model" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, settings.timeoutMs));
  try {
    if (section === "asr" && usesHttpAsr(settings)) {
      try { await transcribePcm(settings, new Uint8Array(32000), controller.signal); return { section, configured: true, reachable: true, status: "ready", message: "语音转写接口已验证；正式识别将按停顿分段提交。" }; }
      catch (error) {
        if (!(error instanceof HttpAsrError)) throw error;
        if (settings.providerType === "baidu" && error.providerCode === "3301") return { section, configured: true, reachable: true, status: "ready", message: "语音接口已响应；静音探测未识别出语音，可在设备测试中验证说话识别。" };
        const status = classifyHttp(error.status);
        return { section, configured: true, reachable: false, status, message: error.message };
      }
    }
    if (section === "asr") return await testAsr(settings, controller.signal);
    if (section === "llm" || section === "embedding") return await testHttp(section, settings, controller.signal);
    return { section, configured: true, reachable: true, status: "ready" };
  } catch (error) {
    return { section, configured: true, reachable: false, status: controller.signal.aborted ? "timeout" : "network_failed", message: String(error) };
  } finally { clearTimeout(timer); }
}

export async function testCachedProviderConnection(section: ProviderSection, settings: ProviderSettings, cache: ProviderPreflightCache): Promise<ProviderCheckResult> {
  const cached = cache.get(section, settings);
  if (cached) return cached;
  const result = await testProviderConnection(section, settings);
  if (result.reachable || result.status === "auth_failed" || result.status === "model_not_found") cache.set(section, settings, result);
  return result;
}

export async function runProviderPreflight(settings: { llm: ProviderSettings; asr: ProviderSettings; embedding: ProviderSettings }, checkReachability = false, cache?: ProviderPreflightCache): Promise<ProviderPreflightResult> {
  if (!checkReachability) {
    const llm = configured("llm", settings.llm) ? { section: "llm" as const, configured: true, reachable: false, status: "testing" as const } : { section: "llm" as const, configured: false, reachable: false, status: "unconfigured" as const, message: "未配置 LLM API Key" };
    const asr = configured("asr", settings.asr) ? { section: "asr" as const, configured: true, reachable: false, status: "testing" as const } : { section: "asr" as const, configured: false, reachable: false, status: "unconfigured" as const, message: settings.asr.providerType === "funasr-local" ? "未配置本地 ASR 服务" : settings.asr.providerType === "qwen" ? "未配置千问 API Key" : "未配置 Deepgram API Key" };
    const embedding = configured("embedding", settings.embedding) ? { section: "embedding" as const, configured: true, reachable: false, status: "testing" as const, optional: true } : { section: "embedding" as const, configured: false, reachable: false, status: "unconfigured" as const, message: "未配置 Embedding API Key", optional: true };
    return { llm, asr, embedding };
  }
  const test = (section: ProviderSection, value: ProviderSettings) => cache ? testCachedProviderConnection(section, value, cache) : testProviderConnection(section, value);
  const [llm, asr] = await Promise.all([test("llm", settings.llm), test("asr", settings.asr)]);
  const cachedEmbedding = cache?.get("embedding", settings.embedding);
  const embedding = cachedEmbedding ?? (configured("embedding", settings.embedding)
    ? { section: "embedding" as const, configured: true, reachable: false, status: "testing" as const, message: "Embedding 将在后台探测" }
    : { section: "embedding" as const, configured: false, reachable: false, status: "unconfigured" as const, message: "未配置 Embedding API Key" });
  if (!cachedEmbedding && embedding.configured) {
    void test("embedding", settings.embedding).catch(() => undefined);
  }
  return { llm, asr, embedding: { ...embedding, optional: true } };
}
