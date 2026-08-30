export type HUDMode = "FULL" | "MINI" | "HIDDEN";
export type HUDMouseMode = "interactive" | "passthrough";
export type OverlayTransientLayer = "none" | "shortcut" | "end_confirm";

export interface HUDState {
  running: boolean;
  panelVisible: boolean;
  transcriptVisible: boolean;
  answerVisible: boolean;
  transientLayer: OverlayTransientLayer;
  shareMode: boolean;
  topBarVisible: boolean;
  mouseMode: HUDMouseMode;
  mode: HUDMode;
  previousVisualState?: Pick<HUDState, "panelVisible" | "transcriptVisible" | "answerVisible" | "transientLayer" | "topBarVisible" | "mode" | "mouseMode">;
}

export type HUDAction =
  | { type: "start" }
  | { type: "stop" }
  | { type: "show-all" }
  | { type: "hide-all" }
  | { type: "toggle-panels" }
  | { type: "toggle-transcript" }
  | { type: "toggle-answer" }
  | { type: "toggle-shortcuts" }
  | { type: "set-transient-layer"; layer: OverlayTransientLayer }
  | { type: "set-share-mode"; enabled: boolean }
  | { type: "set-mouse-mode"; mode: HUDMouseMode };

export const initialHUDState: HUDState = {
  running: false,
  panelVisible: false,
  transcriptVisible: false,
  answerVisible: false,
  transientLayer: "none",
  shareMode: false,
  topBarVisible: false,
  mouseMode: "passthrough",
  mode: "HIDDEN"
};

function fullState(state: HUDState): HUDState {
  return {
    ...state,
    panelVisible: true,
    transcriptVisible: true,
    answerVisible: true,
    transientLayer: "none",
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
      return { ...state, panelVisible: false, transcriptVisible: false, answerVisible: false, transientLayer: "none", topBarVisible: false, shareMode: false, mode: "HIDDEN", previousVisualState: undefined };
    case "toggle-panels":
      if (state.shareMode) return state;
      if (state.mode === "FULL") return { ...state, panelVisible: false, transcriptVisible: false, answerVisible: false, transientLayer: "none", mode: "MINI", topBarVisible: true };
      return fullState({ ...state, running: true });
    case "toggle-transcript": {
      if (state.shareMode || !state.running) return state;
      const transcriptVisible = !state.transcriptVisible;
      const panelVisible = transcriptVisible || state.answerVisible;
      return { ...state, panelVisible, transcriptVisible, topBarVisible: true, mode: panelVisible ? "FULL" : "MINI" };
    }
    case "toggle-answer": {
      if (state.shareMode || !state.running) return state;
      const answerVisible = !state.answerVisible;
      const panelVisible = state.transcriptVisible || answerVisible;
      return { ...state, panelVisible, answerVisible, topBarVisible: true, mode: panelVisible ? "FULL" : "MINI" };
    }
    case "toggle-shortcuts":
      if (state.shareMode || !state.running || state.transientLayer === "end_confirm") return state;
      return { ...state, transientLayer: state.transientLayer === "shortcut" ? "none" : "shortcut" };
    case "set-transient-layer":
      if (state.shareMode && action.layer !== "none") return state;
      return { ...state, transientLayer: action.layer };
    case "set-share-mode": {
      if (!state.running) return state;
      if (action.enabled && !state.shareMode) {
        return {
          ...state,
          panelVisible: false,
          transcriptVisible: false,
          answerVisible: false,
          transientLayer: "none",
          topBarVisible: false,
          shareMode: true,
          mouseMode: "passthrough",
          mode: "HIDDEN",
          previousVisualState: {
            panelVisible: state.panelVisible,
            transcriptVisible: state.transcriptVisible,
            answerVisible: state.answerVisible,
            transientLayer: state.transientLayer,
            topBarVisible: state.topBarVisible,
            mode: state.mode,
            mouseMode: state.mouseMode
          }
        };
      }
      if (!action.enabled && state.shareMode) {
        const previous = state.previousVisualState ?? { panelVisible: true, transcriptVisible: true, answerVisible: true, transientLayer: "none" as const, topBarVisible: true, mode: "FULL" as const, mouseMode: "passthrough" as const };
        return { ...state, ...previous, shareMode: false, previousVisualState: undefined };
      }
      return state;
    }
    case "set-mouse-mode":
      return { ...state, mouseMode: action.mode };
  }
}
