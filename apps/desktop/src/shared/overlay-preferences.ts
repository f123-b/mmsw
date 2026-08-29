export type OverlayLayoutPreset = "compact" | "standard" | "wide" | "dual_screen" | "custom";
export type ScreenshotCaptureMode = "full_screen" | "current_display" | "fixed_region" | "last_region" | "interactive";

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
  fontSize: number;
  titleFontSize: number;
  lineHeight: number;
  paragraphGap: number;
  padding: number;
  opacity: number;
  blur: number;
  radius: number;
  shadow: boolean;
}

export interface OverlayBehaviorPreferences {
  followLatestQuestion: boolean;
  followLatestAnswer: boolean;
  alwaysOnTop: boolean;
  lockPosition: boolean;
  mousePassthrough: boolean;
  autoDim: boolean;
  rememberPosition: boolean;
  rememberSize: boolean;
  showQuestionStatus: boolean;
  showAnswerStatus: boolean;
  compactHeader: boolean;
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
  behavior: OverlayBehaviorPreferences;
  screenshot: OverlayScreenshotPreferences;
}

export type OverlayPreferencesPatch = Omit<Partial<OverlayPreferences>, "questionWindow" | "answerWindow" | "behavior" | "screenshot"> & {
  questionWindow?: Partial<OverlayWindowPreferences>;
  answerWindow?: Partial<OverlayWindowPreferences>;
  behavior?: Partial<OverlayBehaviorPreferences>;
  screenshot?: Partial<OverlayScreenshotPreferences>;
};

export const DEFAULT_OVERLAY_PREFERENCES: OverlayPreferences = {
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
    titleFontSize: 12,
    lineHeight: 1.55,
    paragraphGap: 7,
    padding: 14,
    opacity: 0.84,
    blur: 10,
    radius: 12,
    shadow: true
  },
  answerWindow: {
    width: 680,
    height: 500,
    fontSize: 14,
    titleFontSize: 12,
    lineHeight: 1.62,
    paragraphGap: 8,
    padding: 15,
    opacity: 0.88,
    blur: 10,
    radius: 12,
    shadow: true
  },
  behavior: {
    followLatestQuestion: true,
    followLatestAnswer: true,
    alwaysOnTop: true,
    lockPosition: false,
    mousePassthrough: true,
    autoDim: false,
    rememberPosition: true,
    rememberSize: true,
    showQuestionStatus: true,
    showAnswerStatus: true,
    compactHeader: true
  },
  screenshot: {
    middleMouseEnabled: true,
    enabledInManualInterview: true,
    enabledInExamMode: true,
    captureMode: "current_display"
  }
};
