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

export function applyOverlayMode(window: OverlayWindowLike, mode: OverlayMode): void {
  const passive = mode === "passive";
  window.setFocusable(!passive);
  window.setIgnoreMouseEvents(passive, { forward: true });
}
