import { providerEndpoint, QWEN_REALTIME_ASR_MODEL, type ProviderSettings } from "@interview-copilot/shared";
import type { ProviderSection } from "./settings-store";

export type ModelCategory = "fast" | "general" | "reasoning" | "vision" | "embedding" | "realtime-asr";

export interface DiscoveredModel {
  id: string;
  name: string;
  description?: string;
  categories: ModelCategory[];
  contextWindow?: number;
}

/**
 * DashScope's generic model-list endpoint is intentionally not a complete
 * capability registry.  Keep the officially documented streaming ASR models
 * locally and merge them with the live response so the settings page never
 * mistakes a partial catalog for the complete list.
 */
const QWEN_STREAMING_ASR_MODELS: DiscoveredModel[] = [
  { id: "qwen-audio-3.0-asr-flash-streaming", name: "Qwen Audio 3.0 ASR Flash Streaming", description: "推荐 · 流式识别 · 支持上下文与热词", categories: ["realtime-asr"] },
  { id: "qwen3-asr-flash-realtime", name: "Qwen3 ASR Flash Realtime", description: "低延迟 Realtime 协议 · 稳定版", categories: ["realtime-asr"] },
  { id: "qwen3-asr-flash-realtime-2026-02-10", name: "Qwen3 ASR Flash Realtime 2026-02-10", description: "低延迟 Realtime 协议 · 快照版", categories: ["realtime-asr"] },
  { id: "qwen3-asr-flash-realtime-2025-10-27", name: "Qwen3 ASR Flash Realtime 2025-10-27", description: "低延迟 Realtime 协议 · 快照版", categories: ["realtime-asr"] },
  { id: "fun-asr-realtime", name: "Fun-ASR Realtime", description: "通用实时识别 · 稳定版", categories: ["realtime-asr"] },
  { id: "fun-asr-realtime-2026-02-28", name: "Fun-ASR Realtime 2026-02-28", description: "通用实时识别 · 快照版", categories: ["realtime-asr"] },
  { id: "fun-asr-realtime-2025-11-07", name: "Fun-ASR Realtime 2025-11-07", description: "通用实时识别 · 快照版", categories: ["realtime-asr"] },
  { id: "fun-asr-realtime-2025-09-15", name: "Fun-ASR Realtime 2025-09-15", description: "通用实时识别 · 快照版", categories: ["realtime-asr"] },
  { id: "fun-asr-flash-8k-realtime", name: "Fun-ASR Flash 8K Realtime", description: "8 kHz 电话音频 · 稳定版", categories: ["realtime-asr"] },
  { id: "fun-asr-flash-8k-realtime-2026-01-28", name: "Fun-ASR Flash 8K Realtime 2026-01-28", description: "8 kHz 电话音频 · 快照版", categories: ["realtime-asr"] },
  { id: "paraformer-realtime-v2", name: "Paraformer Realtime V2", description: "中文实时识别 · 16 kHz", categories: ["realtime-asr"] },
  { id: "paraformer-realtime-v1", name: "Paraformer Realtime V1", description: "中文实时识别 · 16 kHz", categories: ["realtime-asr"] },
  { id: "paraformer-realtime-8k-v2", name: "Paraformer Realtime 8K V2", description: "中文实时识别 · 8 kHz", categories: ["realtime-asr"] },
  { id: "paraformer-realtime-8k-v1", name: "Paraformer Realtime 8K V1", description: "中文实时识别 · 8 kHz", categories: ["realtime-asr"] }
];

export interface ModelCatalogResult {
  section: ProviderSection;
  provider: string;
  source: "provider-api" | "provider-api-with-fallback";
  models: DiscoveredModel[];
  fetchedAt: number;
  warning?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function qwenProvider(settings: ProviderSettings): boolean {
  return settings.providerType === "qwen" || /qwen|dashscope|千问|百炼/i.test(`${settings.providerName} ${settings.baseUrl}`);
}

function deepSeekProvider(settings: ProviderSettings): boolean {
  return /deepseek/i.test(`${settings.providerName} ${settings.baseUrl}`);
}

function qwenModelsEndpoint(settings: ProviderSettings): string {
  const parsed = new URL(settings.baseUrl.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"));
  return `${parsed.origin}/api/v1/models?providers=qwen&supports=inference&page_no=1&page_size=100&language=zh-CN`;
}

function categoriesFor(id: string, capabilities: string[] = [], description = ""): ModelCategory[] {
  const haystack = `${id} ${description}`.toLowerCase();
  const caps = new Set(capabilities.map((item) => item.toLowerCase()));
  const categories = new Set<ModelCategory>();
  if (caps.has("realtime-asr") || caps.has("asr") || /(?:^|[-_])asr(?:$|[-_])|speech.?recognition/.test(haystack)) categories.add("realtime-asr");
  if (caps.has("tr") || caps.has("me") || /embed|embedding|text-embedding|bge-|multimodal-embedding/.test(haystack)) categories.add("embedding");
  if (caps.has("vu") || /vision|[-_]vl(?:$|[-_])|visual|image understanding/.test(haystack)) categories.add("vision");
  if (caps.has("reasoning") || /reason|thinking|deepseek-r\d|qwq|coder.*plus/.test(haystack)) categories.add("reasoning");
  const specializedOnly = categories.has("realtime-asr") || categories.has("embedding");
  if (caps.has("tg") || categories.size === 0 || (!specializedOnly && /chat|instruct|qwen|deepseek|mimo|glm|kimi/.test(haystack))) categories.add("general");
  if (!specializedOnly && /flash|turbo|lite|mini|small|instant|speed|air/.test(haystack)) categories.add("fast");
  if (/deepseek-v4-(?:flash|pro)/.test(haystack)) categories.add("reasoning");
  return [...categories];
}

function parseOpenAiModels(payload: unknown): DiscoveredModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item) => {
    const value = item as { id?: unknown; name?: unknown; description?: unknown };
    if (typeof value.id !== "string" || !value.id.trim()) return [];
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : value.id;
    const description = typeof value.description === "string" ? value.description.trim() : undefined;
    return [{ id: value.id.trim(), name, description, categories: categoriesFor(value.id, [], description) }];
  });
}

function parseQwenModels(payload: unknown): DiscoveredModel[] {
  const models = (payload as { output?: { models?: unknown } })?.output?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((item) => {
    const value = item as { model?: unknown; name?: unknown; description?: unknown; capabilities?: unknown; model_info?: { context_window?: unknown } };
    if (typeof value.model !== "string" || !value.model.trim()) return [];
    const capabilities = Array.isArray(value.capabilities) ? value.capabilities.filter((entry): entry is string => typeof entry === "string") : [];
    const description = typeof value.description === "string" ? value.description.trim() : undefined;
    const contextWindow = typeof value.model_info?.context_window === "number" ? value.model_info.context_window : undefined;
    return [{
      id: value.model.trim(),
      name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : value.model,
      description,
      categories: categoriesFor(value.model, capabilities, description),
      contextWindow
    }];
  });
}

function uniqueModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const values = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const current = values.get(model.id);
    if (!current) values.set(model.id, model);
    else values.set(model.id, { ...current, categories: [...new Set([...current.categories, ...model.categories])] });
  }
  return [...values.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { message?: unknown; error?: { message?: unknown } };
    const message = payload.error?.message ?? payload.message;
    return typeof message === "string" && message.trim() ? message.trim().slice(0, 240) : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function discoverProviderModels(section: ProviderSection, settings: ProviderSettings, fetchImpl: FetchLike = fetch): Promise<ModelCatalogResult> {
  if (!settings.apiKey && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)/i.test(settings.baseUrl)) throw new Error("MODEL_CATALOG_AUTH_REQUIRED: 请先输入并保存 API Key");
  const isQwen = qwenProvider(settings);
  const endpoint = isQwen ? qwenModelsEndpoint(settings) : providerEndpoint(settings, "models");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(settings.timeoutMs || 15_000, 5_000), 30_000));
  try {
    const response = await fetchImpl(endpoint, { method: "GET", headers: { Accept: "application/json", ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) }, signal: controller.signal });
    if (!response.ok) throw new Error(`MODEL_CATALOG_REQUEST_FAILED: ${await responseError(response)}`);
    const payload = await response.json() as unknown;
    let models = isQwen ? parseQwenModels(payload) : parseOpenAiModels(payload);
    let warning: string | undefined;
    if (section === "asr" && isQwen) {
      const returnedCount = models.filter((model) => model.categories.includes("realtime-asr")).length;
      models.push(...QWEN_STREAMING_ASR_MODELS);
      warning = returnedCount < QWEN_STREAMING_ASR_MODELS.length
        ? `供应商目录仅返回 ${returnedCount} 个实时语音模型；已合并官方兼容目录`
        : undefined;
    }
    models = uniqueModels(models);
    if (section === "llm") models = models.filter((model) => model.categories.some((category) => category === "fast" || category === "general" || category === "reasoning" || category === "vision"));
    if (section === "embedding") models = models.filter((model) => model.categories.includes("embedding"));
    if (section === "asr") models = models.filter((model) => model.categories.includes("realtime-asr"));
    if (models.length === 0) throw new Error("MODEL_CATALOG_EMPTY: 供应商没有返回适用于当前用途的模型");
    return { section, provider: settings.providerName, source: warning ? "provider-api-with-fallback" : "provider-api", models, fetchedAt: Date.now(), warning };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("MODEL_CATALOG_TIMEOUT: 获取模型列表超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const modelCatalogInternals = { categoriesFor, parseOpenAiModels, parseQwenModels, qwenModelsEndpoint, QWEN_STREAMING_ASR_MODELS };
