export type LegacyOverlayLayoutPreset = "compact" | "standard" | "wide" | "dual_screen" | "transparent" | "custom";
export type InterviewLayoutPreset = "classic_split" | "compact_split" | "answer_focus" | "minimal";
export type WrittenTestLayoutPreset = "single_reader" | "split";
export type OverlayLayoutPreset = InterviewLayoutPreset | WrittenTestLayoutPreset;
export type InterviewLeftPanelMode = "dialogue" | "question" | "hidden";
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
  /** Legacy alias kept inside the style object for existing user settings. */
  opacity: number;
}

export interface OverlayControlBarPreferences extends OverlayWindowPreferences {
  positionMode: OverlayControlBarPositionMode;
  orientation: OverlayControlBarOrientation;
}

export interface OverlayInterviewPreferences {
  layoutPreset: InterviewLayoutPreset;
  leftPanel: InterviewLeftPanelMode;
  questionWindow: OverlayWindowPreferences;
  dialogueWindow: OverlayWindowPreferences;
  answerWindow: OverlayWindowPreferences;
  controlBar: OverlayControlBarPreferences;
  showAnswer: boolean;
}

export interface OverlayWrittenTestPreferences {
  layoutPreset: WrittenTestLayoutPreset;
  questionWindow: OverlayWindowPreferences;
  answerWindow: OverlayWindowPreferences;
  controlBar: OverlayControlBarPreferences;
  showAnswer: boolean;
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
  schemaVersion: 4;
  backgroundOpacity: number;
  backgroundColor: string;
  fontColor: string;
  fontSize: number;
  showToolbar: boolean;
  showTimestamps: boolean;
  interview: OverlayInterviewPreferences;
  writtenTest: OverlayWrittenTestPreferences;
  behavior: OverlayBehaviorPreferences;
  appearance: OverlayAppearancePreferences;
  screenshot: OverlayScreenshotPreferences;
  previewBackground: OverlayPreviewBackground;
  previewCustomColor: string;
}

export interface OverlayPreferencesPatch {
  schemaVersion?: number;
  backgroundOpacity?: number;
  backgroundColor?: string;
  fontColor?: string;
  fontSize?: number;
  showToolbar?: boolean;
  showTimestamps?: boolean;
  interview?: Partial<Omit<OverlayInterviewPreferences, "questionWindow" | "dialogueWindow" | "answerWindow" | "controlBar">> & {
    questionWindow?: Partial<OverlayWindowPreferences>;
    dialogueWindow?: Partial<OverlayWindowPreferences>;
    answerWindow?: Partial<OverlayWindowPreferences>;
    controlBar?: Partial<OverlayControlBarPreferences>;
  };
  writtenTest?: Partial<Omit<OverlayWrittenTestPreferences, "questionWindow" | "answerWindow" | "controlBar">> & {
    questionWindow?: Partial<OverlayWindowPreferences>;
    answerWindow?: Partial<OverlayWindowPreferences>;
    controlBar?: Partial<OverlayControlBarPreferences>;
  };
  behavior?: Partial<OverlayBehaviorPreferences>;
  appearance?: Partial<OverlayAppearancePreferences>;
  screenshot?: Partial<OverlayScreenshotPreferences>;
  previewBackground?: OverlayPreviewBackground;
  previewCustomColor?: string;
  /** Flat fields from the pre-designer settings schema. */
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  opacity?: number;
  /** v3 compatibility aliases; normalized values are always nested in v4. */
  layoutPreset?: LegacyOverlayLayoutPreset;
  questionWindow?: Partial<OverlayWindowPreferences>;
  answerWindow?: Partial<OverlayWindowPreferences>;
  controlBar?: Partial<OverlayControlBarPreferences>;
  showTranscript?: boolean;
  showAnswer?: boolean;
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
  border: false,
  opacity: 0.84
};

const questionWindow = {
  width: 420,
  height: 500,
  fontSize: 14,
  ...sharedWindowDefaults,
  fontWeight: 600 as OverlayFontWeight,
  itemGap: 7,
  backgroundOpacity: 0.84
};

const dialogueWindow = {
  ...questionWindow,
  width: 420,
  fontWeight: 400 as OverlayFontWeight
};

const answerWindow = {
  width: 680,
  height: 500,
  fontSize: 14,
  ...sharedWindowDefaults,
  lineHeight: 1.62,
  backgroundOpacity: 0.88,
  opacity: 0.88
};

const controlBar = {
  width: 440,
  height: 44,
  fontSize: 13,
  ...sharedWindowDefaults,
  titleFontSize: 13,
  fontWeight: 500 as OverlayFontWeight,
  lineHeight: 1.2,
  paragraphGap: 0,
  itemGap: 5,
  padding: 8,
  backgroundOpacity: 0.86,
  opacity: 0.86,
  positionMode: "top_center" as const,
  orientation: "horizontal" as const
};

export const DEFAULT_OVERLAY_PREFERENCES: OverlayPreferences = {
  schemaVersion: 4,
  backgroundOpacity: 0.78,
  backgroundColor: "#1d304a",
  fontColor: "#f8fbff",
  fontSize: 14,
  showToolbar: true,
  showTimestamps: true,
  interview: {
    layoutPreset: "classic_split",
    leftPanel: "question",
    questionWindow: { ...questionWindow },
    dialogueWindow: { ...dialogueWindow },
    answerWindow: { ...answerWindow },
    controlBar: { ...controlBar },
    showAnswer: true
  },
  writtenTest: {
    layoutPreset: "single_reader",
    questionWindow: { ...answerWindow, width: 920, height: 560 },
    answerWindow: { ...answerWindow, width: 700, height: 560 },
    controlBar: { ...controlBar, width: 360 },
    showAnswer: true
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
