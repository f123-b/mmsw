import WebSocket from "ws";
import type { ProviderSettings } from "@interview-copilot/shared";
import type { ProviderSection } from "./settings-store";

export type ProviderCheckStatus = "unconfigured" | "testing" | "ready" | "auth_failed" | "network_failed" | "model_not_found" | "timeout";

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

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function configured(section: ProviderSection, settings: ProviderSettings): boolean {
  if (section === "reranker" && settings.providerName === "Disabled") return true;
  if (!settings.apiKey && section !== "asr") return false;
  if (section === "asr" && settings.providerType === "custom-gateway") return Boolean(settings.baseUrl && settings.model);
  return Boolean(settings.baseUrl && settings.model && settings.apiKey);
}

function classifyHttp(status: number): ProviderCheckStatus {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  return "network_failed";
}

async function testHttp(section: "llm" | "embedding", settings: ProviderSettings, signal: AbortSignal): Promise<ProviderCheckResult> {
  const isLlm = section === "llm";
  const response = await fetch(endpoint(settings.baseUrl, isLlm ? "v1/chat/completions" : "v1/embeddings"), {
    method: "POST",
    headers: { "content-type": "application/json", ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify(isLlm ? {
      model: settings.model,
      messages: [{ role: "system", content: "Return exactly OK." }, { role: "user", content: "ping" }],
      stream: false,
      max_tokens: 4
    } : { model: settings.model, input: "test" }),
    signal
  });
  if (!response.ok) {
    const status = classifyHttp(response.status);
    return { section, configured: true, reachable: false, status, message: `${status === "auth_failed" ? "认证失败" : status === "model_not_found" ? "模型不存在" : `HTTP ${response.status}`}` };
  }
  const payload = await response.json() as Record<string, unknown>;
  if (isLlm) {
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const content = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
    if (typeof content?.content !== "string" && choices.length === 0) return { section, configured: true, reachable: false, status: "network_failed", message: "LLM 返回缺少 choices" };
  } else {
    const vector = (Array.isArray(payload.data) ? payload.data[0] as Record<string, unknown> | undefined : undefined)?.embedding;
    if (!Array.isArray(vector) || !vector.every((item) => typeof item === "number")) return { section, configured: true, reachable: false, status: "network_failed", message: "Embedding 返回非法向量" };
  }
  return { section, configured: true, reachable: true, status: "ready" };
}

async function testAsr(settings: ProviderSettings, signal: AbortSignal): Promise<ProviderCheckResult> {
  const section: ProviderSection = "asr";
  if (settings.providerType === "custom-gateway") {
    return { section, configured: Boolean(settings.baseUrl && settings.model), reachable: false, status: "network_failed", message: "Custom Gateway 需要通过实际会话验证" };
  }
  if (!configured(section, settings)) return { section, configured: false, reachable: false, status: "unconfigured", message: "未配置 Deepgram API Key" };
  const url = new URL(settings.baseUrl || "wss://api.deepgram.com/v1/listen");
  url.searchParams.set("model", settings.model);
  url.searchParams.set("language", settings.language ?? "zh-CN");
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", "16000");
  return await new Promise<ProviderCheckResult>((resolve) => {
    let settled = false;
    const finish = (result: ProviderCheckResult) => { if (settled) return; settled = true; clearTimeout(timer); socket?.close(); resolve(result); };
    const timer = setTimeout(() => finish({ section, configured: true, reachable: false, status: "timeout", message: "WebSocket 握手超时" }), Math.max(1_000, settings.timeoutMs));
    let socket: WebSocket | undefined;
    const abort = () => finish({ section, configured: true, reachable: false, status: "timeout", message: "测试已取消" });
    signal.addEventListener("abort", abort, { once: true });
    try {
      socket = new WebSocket(url, { headers: { Authorization: `Token ${settings.apiKey}` } });
      socket.once("open", () => finish({ section, configured: true, reachable: true, status: "ready" }));
      socket.once("unexpected-response", (_request, response) => finish({ section, configured: true, reachable: false, status: classifyHttp(response.statusCode ?? 0), message: `HTTP ${response.statusCode ?? "unknown"}` }));
      socket.once("error", () => finish({ section, configured: true, reachable: false, status: "network_failed", message: "Deepgram WebSocket 连接失败" }));
    } catch (error) {
      finish({ section, configured: true, reachable: false, status: "network_failed", message: String(error) });
    }
  });
}

export async function testProviderConnection(section: ProviderSection, settings: ProviderSettings): Promise<ProviderCheckResult> {
  if (!configured(section, settings)) return { section, configured: false, reachable: false, status: "unconfigured", message: section === "llm" ? "未配置 LLM API Key" : section === "embedding" ? "未配置 Embedding API Key" : "未配置 Provider" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, settings.timeoutMs));
  try {
    if (section === "asr") return await testAsr(settings, controller.signal);
    if (section === "llm" || section === "embedding") return await testHttp(section, settings, controller.signal);
    return { section, configured: true, reachable: true, status: "ready" };
  } catch (error) {
    return { section, configured: true, reachable: false, status: controller.signal.aborted ? "timeout" : "network_failed", message: String(error) };
  } finally { clearTimeout(timer); }
}

export async function runProviderPreflight(settings: { llm: ProviderSettings; asr: ProviderSettings; embedding: ProviderSettings }, checkReachability = false): Promise<ProviderPreflightResult> {
  if (!checkReachability) {
    const llm = configured("llm", settings.llm) ? { section: "llm" as const, configured: true, reachable: false, status: "testing" as const } : { section: "llm" as const, configured: false, reachable: false, status: "unconfigured" as const, message: "未配置 LLM API Key" };
    const asr = configured("asr", settings.asr) ? { section: "asr" as const, configured: true, reachable: false, status: "testing" as const } : { section: "asr" as const, configured: false, reachable: false, status: "unconfigured" as const, message: "未配置 Deepgram API Key" };
    const embedding = configured("embedding", settings.embedding) ? { section: "embedding" as const, configured: true, reachable: false, status: "testing" as const, optional: true } : { section: "embedding" as const, configured: false, reachable: false, status: "unconfigured" as const, message: "未配置 Embedding API Key", optional: true };
    return { llm, asr, embedding };
  }
  const [llm, asr, embedding] = await Promise.all([testProviderConnection("llm", settings.llm), testProviderConnection("asr", settings.asr), testProviderConnection("embedding", settings.embedding)]);
  return { llm, asr, embedding: { ...embedding, optional: true } };
}
