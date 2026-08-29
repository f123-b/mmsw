import type { HUDState } from "../../main/hud-state";

/**
 * Layout editing is a setup-only state. Starting an interview while it is
 * still enabled leaves resize outlines/handles on screen and makes the HUD
 * look like an editor instead of an interview aid. Keep the two lifecycles
 * separate even when the same native BrowserWindow is reused.
 */
export function installOverlayRuntimeGuard(): () => void {
  if (new URLSearchParams(window.location.search).get("window") !== "overlay") return () => undefined;

  let running = false;
  let layoutEditing = false;
  let finishing = false;

  const finishEditorIfNeeded = (): void => {
    if (!running || !layoutEditing || finishing) return;
    finishing = true;
    void window.interviewCopilot.overlay.finishLayoutEditMode().finally(() => { finishing = false; });
  };

  const unsubscribeState = window.interviewCopilot.events.onOverlayState((state: HUDState) => {
    running = state.running;
    finishEditorIfNeeded();
  });
  const unsubscribeEdit = window.interviewCopilot.events.onOverlayLayoutEditMode((enabled: boolean) => {
    layoutEditing = enabled;
    finishEditorIfNeeded();
  });

  return () => {
    unsubscribeState();
    unsubscribeEdit();
  };
}
