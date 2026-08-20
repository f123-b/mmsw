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
 * Passive mode is the normal interview state: the whole BrowserWindow is
 * transparent to the OS hit test until the renderer reports that the cursor
 * is over a small, explicitly interactive HUD region. This is necessary
 * because DOM pointer-events cannot make an Electron window itself pass
 * clicks to the window underneath it.
 */
export function applyOverlayMode(window: OverlayWindowLike, mode: OverlayMode, interactiveRegion = false): void {
  const interactive = mode === "interactive" || interactiveRegion;
  window.setFocusable(interactive);
  window.setIgnoreMouseEvents(!interactive, { forward: true });
}
