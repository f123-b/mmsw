export type OverlayFollowMode = "following" | "manual";

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const SCROLL_BOTTOM_THRESHOLD = 32;

export function isNearBottom(metrics: ScrollMetrics, threshold = SCROLL_BOTTOM_THRESHOLD): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function followModeAfterScroll(metrics: ScrollMetrics): OverlayFollowMode {
  return isNearBottom(metrics) ? "following" : "manual";
}

export function shouldAutoFollowLatest(mode: OverlayFollowMode): boolean {
  return mode === "following";
}

export function newContentBadgeLabel(count: number): string {
  const safeCount = Math.max(0, Math.floor(count));
  return safeCount ? `${safeCount} 条新内容` : "";
}
