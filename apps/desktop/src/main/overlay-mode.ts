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
 * Apply native hit testing for the full-screen transparent HUD window.
 *
 * The BrowserWindow covers the monitor so it must never become a normal
 * full-window mouse target: doing so blocks every application underneath the
 * transparent pixels. Renderer-side hit testing reports only the concrete HUD
 * region currently under the pointer (toolbar, reader, dialog, resize handle),
 * and `interactiveRegion` temporarily promotes that region at the native
 * window level. `mode` remains a renderer/display policy and must not change
 * the native full-window hit target.
 */
export function applyOverlayMode(window: OverlayWindowLike, _mode: OverlayMode, interactiveRegion = false): void {
  window.setFocusable(false);
  window.setIgnoreMouseEvents(!interactiveRegion, { forward: true });
}
