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

/** Apply native hit testing to one bounded overlay window. */
export function applyOverlayMode(window: OverlayWindowLike, mode: OverlayMode): void {
  window.setFocusable(false);
  window.setIgnoreMouseEvents(mode !== "interactive", { forward: true });
}
