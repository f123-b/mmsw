const INTERNAL_RUNTIME_EVENT = /^(?:ANSWER_QUEUED|QUESTION_CONFIRMED|REQUEST_SENT|PROVIDER_REQUEST_SENT)\b/i;
const INTERNAL_RUNTIME_MARKERS = /(?:question-[a-z0-9-]+|(?:operation|queue)[-_ ]?id)/i;
const USER_FACING_FAILURE = /(?:error|failed|failure|timeout|timed out|denied|unavailable|disconnect|异常|失败|超时|拒绝|不可用|断开)/i;

/** Convert diagnostic-only events into an optional user notice. */
export function userFacingRuntimeDiagnostic(message: string): string | undefined {
  const raw = message.trim();
  if (!raw || INTERNAL_RUNTIME_EVENT.test(raw) || !USER_FACING_FAILURE.test(raw)) return undefined;
  const safe = raw.replace(/\bquestion-[a-z0-9-]+\b/gi, "").replace(/\b(?:operation|queue)[-_ ]?id[:=]?\s*[^\s]+/gi, "").replace(/\s{2,}/g, " ").trim();
  if (/^(?:LLM_FAILED|PROVIDER_FIRST_TOKEN_TIMEOUT)/i.test(safe)) return "AI 服务暂时中断，请重试";
  if (/^(?:ASR|AUDIO).*?(?:FAILED|ERROR|TIMEOUT|DISCONNECT)/i.test(safe)) return "语音识别或音频连接异常，请检查设置后重试";
  if (/^RUNTIME_CLEANUP_TIMEOUT/i.test(safe)) return "面试资源清理超时，请重启应用后重试";
  return safe.replace(/^(?:ERROR|FAILED|DIAGNOSTIC)[:：]?\s*/i, "");
}
