export type OverlayLayoutPreset = "compact" | "standard" | "wide" | "dual_screen" | "transparent" | "custom";
export type ScreenshotCaptureMode = "full_screen" | "current_display" | "fixed_region" | "last_region" | "interactive";
export type OverlayAppearanceMode = "glass" | "translucent" | "text_only" | "custom";
export type OverlayTextShadow = "none" | "soft" | "medium";
export type OverlayControlBarPositionMode = "top_left" | "top_center" | "top_right" | "bottom_left" | "bottom_center" | "bottom_right" | "custom";
export type OverlayControlBarOrientation = "horizontal" | "vertical";
export type MouseInteractionMode = "interactive" | "click_through" | "full_passthrough";
export type WheelRoutingMode = "overlay_under_cursor" | "underlying_app" | "dual";
export type TemporaryInteractionModifier = "ctrl" | "alt" | "shift" | "ctrl_shift";
export type OverlayPreviewBackground = "light_desktop" | "dark_ide" | "web_page" | "custom_color";
export type OverlayFontWeight = 400 | 500 | 600;

export interface OverlayRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayWindowPreferences {
  width: number;
  height: number;
  x?: number;
  y?: number;
  displayId?: number;
  scaleFactor?: number;
  fontSize: number;
  titleFontSize: number;
  fontWeight: OverlayFontWeight;
  lineHeight: number;
  paragraphGap: number;
  itemGap: number;
  padding: number;
  backgroundOpacity: number;
  textOpacity: number;
  borderOpacity: number;
  backgroundColor: string;
  textColor: string;
  blur: number;
  radius: number;
  shadow: boolean;
  border: boolean;
  /** Legacy alias. It is kept in persisted settings for backward compatibility. */
  opacity: number;
}

export interface OverlayControlBarPreferences extends OverlayWindowPreferences {
  positionMode: OverlayControlBarPositionMode;
  orientation: OverlayControlBarOrientation;
}

export interface OverlayBehaviorPreferences {
  followLatestQuestion: boolean;
  followLatestAnswer: boolean;
  alwaysOnTop: boolean;
  lockLayout: boolean;
  /** Legacy alias for lockLayout. */
  lockPosition: boolean;
  interactionMode: MouseInteractionMode;
  /** Legacy alias for interactionMode !== interactive. */
  mousePassthrough: boolean;
  wheelRouting: WheelRoutingMode;
  temporaryInteractionModifier: TemporaryInteractionModifier;
  snapEnabled: boolean;
  snapThreshold: number;
  liveApply: boolean;
  autoDim: boolean;
  rememberPosition: boolean;
  rememberSize: boolean;
  showQuestionStatus: boolean;
  showAnswerStatus: boolean;
  compactHeader: boolean;
}

export interface OverlayAppearancePreferences {
  mode: OverlayAppearanceMode;
  blur: number;
  radius: number;
  shadow: boolean;
  border: boolean;
  textShadow: OverlayTextShadow;
  textOutline: 0 | 0.5 | 1;
}

export interface OverlayScreenshotPreferences {
  middleMouseEnabled: boolean;
  enabledInManualInterview: boolean;
  enabledInExamMode: boolean;
  captureMode: ScreenshotCaptureMode;
  fixedRegion?: OverlayRegion;
  lastRegion?: OverlayRegion;
}

export interface OverlayPreferences {
  /** Persisted schema version. Missing values are treated as the legacy v1 schema. */
  schemaVersion: number;
  backgroundOpacity: number;
  backgroundColor: string;
  fontColor: string;
  fontSize: number;
  showToolbar: boolean;
  showTranscript: boolean;
  showAnswer: boolean;
  showTimestamps: boolean;
  layoutPreset: OverlayLayoutPreset;
  questionWindow: OverlayWindowPreferences;
  answerWindow: OverlayWindowPreferences;
  controlBar: OverlayControlBarPreferences;
  behavior: OverlayBehaviorPreferences;
  appearance: OverlayAppearancePreferences;
  screenshot: OverlayScreenshotPreferences;
  previewBackground: OverlayPreviewBackground;
  previewCustomColor: string;
}

export interface OverlayPreferencesPatch extends Omit<Partial<OverlayPreferences>, "questionWindow" | "answerWindow" | "controlBar" | "behavior" | "appearance" | "screenshot"> {
  questionWindow?: Partial<OverlayWindowPreferences>;
  answerWindow?: Partial<OverlayWindowPreferences>;
  controlBar?: Partial<OverlayControlBarPreferences>;
  behavior?: Partial<OverlayBehaviorPreferences>;
  appearance?: Partial<OverlayAppearancePreferences>;
  screenshot?: Partial<OverlayScreenshotPreferences>;
  /** Flat fields from the pre-designer settings schema. */
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  opacity?: number;
}

const sharedWindowDefaults = {
  titleFontSize: 12,
  fontWeight: 400 as OverlayFontWeight,
  lineHeight: 1.55,
  paragraphGap: 8,
  itemGap: 8,
  padding: 14,
  textOpacity: 1,
  borderOpacity: 0,
  backgroundColor: "#1d304a",
  textColor: "#f8fbff",
  blur: 10,
  radius: 12,
  shadow: true,
  border: false
};

export const DEFAULT_OVERLAY_PREFERENCES: OverlayPreferences = {
  schemaVersion: 2,
  backgroundOpacity: 0.78,
  backgroundColor: "#1d304a",
  fontColor: "#f8fbff",
  fontSize: 14,
  showToolbar: true,
  showTranscript: true,
  showAnswer: true,
  showTimestamps: true,
  layoutPreset: "standard",
  questionWindow: {
    width: 430,
    height: 500,
    fontSize: 14,
    ...sharedWindowDefaults,
    fontWeight: 600,
    lineHeight: 1.55,
    itemGap: 7,
    backgroundOpacity: 0.84,
    opacity: 0.84
  },
  answerWindow: {
    width: 680,
    height: 500,
    fontSize: 14,
    ...sharedWindowDefaults,
    lineHeight: 1.62,
    paragraphGap: 8,
    backgroundOpacity: 0.88,
    opacity: 0.88
  },
  controlBar: {
    width: 680,
    height: 50,
    fontSize: 13,
    ...sharedWindowDefaults,
    titleFontSize: 13,
    fontWeight: 500,
    lineHeight: 1.2,
    paragraphGap: 0,
    itemGap: 5,
    padding: 8,
    backgroundOpacity: 0.86,
    opacity: 0.86,
    positionMode: "top_center",
    orientation: "horizontal"
  },
  behavior: {
    followLatestQuestion: true,
    followLatestAnswer: true,
    alwaysOnTop: true,
    lockLayout: true,
    lockPosition: true,
    interactionMode: "click_through",
    mousePassthrough: true,
    wheelRouting: "overlay_under_cursor",
    temporaryInteractionModifier: "ctrl",
    snapEnabled: true,
    snapThreshold: 12,
    liveApply: true,
    autoDim: false,
    rememberPosition: true,
    rememberSize: true,
    showQuestionStatus: true,
    showAnswerStatus: true,
    compactHeader: true
  },
  appearance: {
    mode: "glass",
    blur: 18,
    radius: 12,
    shadow: true,
    border: false,
    textShadow: "soft",
    textOutline: 0
  },
  screenshot: {
    middleMouseEnabled: true,
    enabledInManualInterview: true,
    enabledInExamMode: true,
    captureMode: "current_display"
  },
  previewBackground: "dark_ide",
  previewCustomColor: "#e8edf4"
};
