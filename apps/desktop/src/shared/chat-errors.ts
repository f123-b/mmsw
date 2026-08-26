export const PROJECT_AGENT_TIMEOUT_MS = 120_000;

export function classifyChatError(error: unknown): string {
  const explicit = typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : "";
  if (explicit) return explicit;
  const message = String(error);
  if (/timeout|timed out/i.test(message)) return "CHAT_TIMEOUT";
  if (/HTTP\s+(?:401|403)\b/i.test(message)) return "CHAT_AUTH_FAILED";
  if (/HTTP\s+429\b/i.test(message)) return "CHAT_RATE_LIMITED";
  if (/HTTP\s+(?:404|400)\b.*(?:model|模型)|(?:model|模型).*HTTP\s+(?:404|400)\b/i.test(message)) return "CHAT_MODEL_NOT_FOUND";
  if (/HTTP\s+5\d\d\b/i.test(message)) return "CHAT_PROVIDER_SERVER_ERROR";
  if (/fetch failed|ECONN|ENOTFOUND|network|socket|certificate/i.test(message)) return "CHAT_NETWORK_FAILED";
  return "CHAT_PROVIDER_ERROR";
}

export function chatFailureText(errorCode: string | undefined, model?: string): string {
  const modelText = model?.trim() ? `（${model.trim()}）` : "";
  if (errorCode === "CHAT_TIMEOUT") return `模型${modelText}在等待时限内没有返回内容。请重试；如果仍然超时，请到模型设置测试连接或更换“AI 对话模型”。`;
  if (errorCode === "CHAT_AUTH_FAILED" || errorCode === "LLM_NOT_CONFIGURED") return "模型密钥未配置、已失效或没有访问权限。请到模型设置更新密钥并测试连接。";
  if (errorCode === "CHAT_MODEL_NOT_FOUND") return `当前模型${modelText}不可用。请到模型设置重新获取模型并选择可用的“AI 对话模型”。`;
  if (errorCode === "CHAT_RATE_LIMITED") return `模型服务${modelText}当前限流或额度不足，请稍后重试或更换模型。`;
  if (errorCode === "CHAT_PROVIDER_SERVER_ERROR") return `模型服务${modelText}暂时异常，请稍后重试。`;
  if (errorCode === "CHAT_NETWORK_FAILED") return "无法连接模型服务，请检查网络、Base URL 和代理设置后重试。";
  return `项目 Agent 生成失败${modelText ? ` ${modelText}` : ""}。请重试；如果仍然失败，请到模型设置测试连接。`;
}
