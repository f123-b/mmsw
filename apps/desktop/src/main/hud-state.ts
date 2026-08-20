export type HUDMode = "FULL" | "MINI" | "HIDDEN";
export type HUDMouseMode = "interactive" | "passthrough";

export interface HUDState {
  running: boolean;
  panelVisible: boolean;
  shortcutVisible: boolean;
  shareMode: boolean;
  topBarVisible: boolean;
  mouseMode: HUDMouseMode;
  mode: HUDMode;
  previousVisualState?: Pick<HUDState, "panelVisible" | "shortcutVisible" | "topBarVisible" | "mode" | "mouseMode">;
}

export type HUDAction =
  | { type: "start" }
  | { type: "stop" }
  | { type: "show-all" }
  | { type: "hide-all" }
  | { type: "toggle-panels" }
  | { type: "toggle-shortcuts" }
  | { type: "set-share-mode"; enabled: boolean }
  | { type: "set-mouse-mode"; mode: HUDMouseMode };

export const initialHUDState: HUDState = {
  running: false,
  panelVisible: false,
  shortcutVisible: false,
  shareMode: false,
  topBarVisible: false,
  mouseMode: "passthrough",
  mode: "HIDDEN"
};

function fullState(state: HUDState): HUDState {
  return {
    ...state,
    panelVisible: true,
    shortcutVisible: false,
    shareMode: false,
    topBarVisible: true,
    mode: "FULL",
    previousVisualState: undefined
  };
}

export function reduceHUDState(state: HUDState, action: HUDAction): HUDState {
  switch (action.type) {
    case "start":
      return fullState({ ...initialHUDState, running: true });
    case "stop":
      return { ...initialHUDState };
    case "show-all":
      return fullState({ ...state, running: true });
    case "hide-all":
      return { ...state, panelVisible: false, shortcutVisible: false, topBarVisible: false, shareMode: false, mode: "HIDDEN", previousVisualState: undefined };
    case "toggle-panels":
      if (state.shareMode) return state;
      if (state.mode === "FULL") return { ...state, panelVisible: false, shortcutVisible: false, mode: "MINI", topBarVisible: true };
      return fullState({ ...state, running: true });
    case "toggle-shortcuts":
      if (state.shareMode || !state.running) return state;
      return { ...state, shortcutVisible: !state.shortcutVisible };
    case "set-share-mode": {
      if (!state.running) return state;
      if (action.enabled && !state.shareMode) {
        return {
          ...state,
          panelVisible: false,
          shortcutVisible: false,
          topBarVisible: false,
          shareMode: true,
          mouseMode: "passthrough",
          mode: "HIDDEN",
          previousVisualState: {
            panelVisible: state.panelVisible,
            shortcutVisible: state.shortcutVisible,
            topBarVisible: state.topBarVisible,
            mode: state.mode,
            mouseMode: state.mouseMode
          }
        };
      }
      if (!action.enabled && state.shareMode) {
        const previous = state.previousVisualState ?? { panelVisible: true, shortcutVisible: false, topBarVisible: true, mode: "FULL" as const, mouseMode: "passthrough" as const };
        return { ...state, ...previous, shareMode: false, previousVisualState: undefined };
      }
      return state;
    }
    case "set-mouse-mode":
      return { ...state, mouseMode: action.mode };
  }
}
