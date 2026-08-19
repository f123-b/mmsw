export const SCREENSHOT_TTL_MS = 15 * 60_000;

export function isScreenshotExpired(mtimeMs: number, now = Date.now(), ttlMs = SCREENSHOT_TTL_MS): boolean {
  return now - mtimeMs >= ttlMs;
}
