export const CHAT_MESSAGE_STATUSES = ["pending", "streaming", "completed", "cancelled", "partial_error", "failed"] as const;
export type ChatMessageStatus = typeof CHAT_MESSAGE_STATUSES[number];

export const CHAT_CANCEL_REASONS = ["user_stop", "navigation", "shutdown", "superseded", "provider_abort", "timeout"] as const;
export type ChatCancelReason = typeof CHAT_CANCEL_REASONS[number];

export interface ChatStreamTelemetry {
  provider?: string;
  model?: string;
  charactersGenerated: number;
  startedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
  durationMs?: number;
  finishReason?: string;
  cancelReason?: ChatCancelReason;
  errorCode?: string;
}

export interface ChatMessageStatusPayload {
  status: ChatMessageStatus;
  cancelReason?: ChatCancelReason;
  errorCode?: string;
  telemetry?: ChatStreamTelemetry;
}
