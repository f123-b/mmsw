export type OverlayMode = "interactive" | "passive";

export interface OverlayWindowLike {
  isDestroyed(): boolean;
  isFocusable(): boolean;
  setFocusable(focusable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  webContents: { send(channel: string, payload: unknown): void };
}

export function nextOverlayMode(mode: OverlayMode): OverlayMode {
  return mode === "interactive" ? "passive" : "interactive";
}

export function ensureOverlayNonFocusable(window: Pick<OverlayWindowLike, "isFocusable" | "setFocusable">): void {
  // On Windows setFocusable(false) also deactivates a visible window. Repeating
  // it during a settings or z-order update can change the foreground window.
  if (window.isFocusable()) window.setFocusable(false);
}

/** Apply native hit testing to one bounded overlay window. */
export function applyOverlayMode(window: OverlayWindowLike, mode: OverlayMode): void {
  ensureOverlayNonFocusable(window);
  window.setIgnoreMouseEvents(mode !== "interactive", { forward: true });
}
