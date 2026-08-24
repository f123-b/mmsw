export type ChatCardKind = "completeness" | "coverage" | "gap" | "fact" | "question";
export type ChatActionType = "add_project_fact" | "review_fact" | "create_question";
export type ChatActionStatus = "pending" | "approved" | "failed";

export interface ChatSource {
  id: string;
  label: string;
  kind?: "project-fact" | "document" | "question-bank" | "resume" | "job" | "knowledge";
  quote?: string;
}

export interface ChatCard {
  id: string;
  kind: ChatCardKind;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface ChatAction {
  id: string;
  type: ChatActionType;
  label: string;
  rationale?: string;
  payload: Record<string, unknown>;
  requiresConfirmation: true;
  status?: ChatActionStatus;
}

export interface ChatResponseContext {
  profileId?: string;
  projectIds?: string[];
  jobTargetId?: string;
  intent?: string;
}

export interface ChatResponse {
  text: string;
  sources?: ChatSource[];
  cards?: ChatCard[];
  actions?: ChatAction[];
  context?: ChatResponseContext;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : []; }

function normalizeAction(value: unknown, index: number): ChatAction | undefined {
  const item = record(value);
  const type = stringValue(item.type);
  if (!["add_project_fact", "review_fact", "create_question"].includes(type)) return undefined;
  const payload = record(item.payload);
  return {
    id: stringValue(item.id, `action-${index + 1}`),
    type: type as ChatActionType,
    label: stringValue(item.label, type === "add_project_fact" ? "确认添加项目事实" : type === "review_fact" ? "确认更新事实" : "确认加入题库"),
    ...(item.rationale ? { rationale: stringValue(item.rationale) } : {}),
    payload,
    requiresConfirmation: true,
    status: item.status && ["pending", "approved", "failed"].includes(stringValue(item.status)) ? stringValue(item.status) as ChatActionStatus : "pending"
  };
}

export function parseStructuredChatResponse(raw: unknown, fallbackContext?: ChatResponseContext): ChatResponse {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return normalizeStructuredResponse(record(raw), fallbackContext);
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const trimmed = text.trim();
  const candidate = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (candidate.startsWith("{")) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") return normalizeStructuredResponse(record(parsed), fallbackContext);
    } catch { /* Plain markdown beginning with { remains a normal answer. */ }
  }
  return { text, ...(fallbackContext ? { context: fallbackContext } : {}) };
}

function normalizeStructuredResponse(source: Record<string, unknown>, fallbackContext?: ChatResponseContext): ChatResponse {
  const cards = Array.isArray(source.cards) ? source.cards.map((value, index) => {
    const item = record(value);
    const kind = stringValue(item.kind, "gap");
    return { id: stringValue(item.id, `card-${index + 1}`), kind: ["completeness", "coverage", "gap", "fact", "question"].includes(kind) ? kind as ChatCardKind : "gap", title: stringValue(item.title, "分析结果"), ...(item.body ? { body: stringValue(item.body) } : {}), ...(item.data && typeof item.data === "object" ? { data: record(item.data) } : {}) };
  }) : [];
  const actions = Array.isArray(source.actions) ? source.actions.map(normalizeAction).filter((item): item is ChatAction => Boolean(item)) : [];
  const sources = Array.isArray(source.sources) ? source.sources.map((value, index) => {
    const item = record(value);
    return { id: stringValue(item.id, `source-${index + 1}`), label: stringValue(item.label, stringValue(value, "资料来源")), ...(item.kind ? { kind: stringValue(item.kind) as ChatSource["kind"] } : {}), ...(item.quote ? { quote: stringValue(item.quote) } : {}) };
  }) : [];
  const context = source.context && typeof source.context === "object" ? record(source.context) : fallbackContext;
  return { text: stringValue(source.text, ""), ...(sources.length ? { sources } : {}), ...(cards.length ? { cards } : {}), ...(actions.length ? { actions } : {}), ...(context ? { context: { ...(typeof context.profileId === "string" ? { profileId: context.profileId } : {}), ...(stringArray(context.projectIds).length ? { projectIds: stringArray(context.projectIds) } : {}), ...(typeof context.jobTargetId === "string" ? { jobTargetId: context.jobTargetId } : {}), ...(typeof context.intent === "string" ? { intent: context.intent } : {}) } } : {}) };
}
