export type OverlayMode = "interactive" | "passive";

export interface OverlayWindowLike {
  isDestroyed(): boolean;
  setFocusable(focusable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  webContents: { send(channel: string, payload: unknown): void };
}

export function nextOverlayMode(mode: OverlayMode): OverlayMode {
  return mode === "interactive" ? "passive" : "interactive";
}

/**
 * Apply the native hit-test state for the HUD.
 *
 * The overlay is deliberately never focusable. `setIgnoreMouseEvents` is
 * enough to switch between pass-through and a clickable control region, while
 * `setFocusable(true)` would let the HUD steal focus from a meeting/browser
 * window and appear as a normal Windows window.
 */
export function applyOverlayMode(window: OverlayWindowLike, mode: OverlayMode, interactiveRegion = false): void {
  const interactive = mode === "interactive" || interactiveRegion;
  window.setFocusable(false);
  window.setIgnoreMouseEvents(!interactive, { forward: true });
}
