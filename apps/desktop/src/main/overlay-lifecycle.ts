export type OverlayLifecycleState =
  | "HIDDEN"
  | "LAYOUT_EDIT"
  | "INTERVIEW_PASSIVE"
  | "INTERVIEW_TEMP_INTERACTIVE"
  | "SHARE_HIDDEN"
  | "ENDING";

export type OverlayLifecycleAction =
  | { type: "enter-layout-edit" }
  | { type: "start-interview" }
  | { type: "claim-interaction" }
  | { type: "release-interaction" }
  | { type: "share"; enabled: boolean }
  | { type: "begin-ending" }
  | { type: "finish" }
  | { type: "hide" };

export const initialOverlayLifecycleState: OverlayLifecycleState = "HIDDEN";

/**
 * The overlay has one primary lifecycle. Transient mouse claims are allowed
 * only in runtime or while the layout editor is active; starting an interview
 * always lands in INTERVIEW_PASSIVE.
 */
export function reduceOverlayLifecycle(state: OverlayLifecycleState, action: OverlayLifecycleAction): OverlayLifecycleState {
  switch (action.type) {
    case "enter-layout-edit":
      return state === "INTERVIEW_PASSIVE" || state === "INTERVIEW_TEMP_INTERACTIVE" || state === "SHARE_HIDDEN"
        ? state
        : "LAYOUT_EDIT";
    case "start-interview":
      return "INTERVIEW_PASSIVE";
    case "claim-interaction":
      return state === "INTERVIEW_PASSIVE" ? "INTERVIEW_TEMP_INTERACTIVE" : state;
    case "release-interaction":
      return state === "INTERVIEW_TEMP_INTERACTIVE" ? "INTERVIEW_PASSIVE" : state;
    case "share":
      if (action.enabled && (state === "INTERVIEW_PASSIVE" || state === "INTERVIEW_TEMP_INTERACTIVE")) return "SHARE_HIDDEN";
      if (!action.enabled && state === "SHARE_HIDDEN") return "INTERVIEW_PASSIVE";
      return state;
    case "begin-ending":
      return state === "INTERVIEW_PASSIVE" || state === "INTERVIEW_TEMP_INTERACTIVE" ? "ENDING" : state;
    case "finish":
    case "hide":
      return "HIDDEN";
  }
}

export function isOverlayLayoutEditing(state: OverlayLifecycleState): boolean {
  return state === "LAYOUT_EDIT";
}

export function isOverlayRuntime(state: OverlayLifecycleState): boolean {
  return state === "INTERVIEW_PASSIVE" || state === "INTERVIEW_TEMP_INTERACTIVE" || state === "SHARE_HIDDEN" || state === "ENDING";
}
