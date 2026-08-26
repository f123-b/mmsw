export interface OverlayPreferences {
  backgroundOpacity: number;
  backgroundColor: string;
  fontColor: string;
  fontSize: number;
  showToolbar: boolean;
  showTranscript: boolean;
  showAnswer: boolean;
  showTimestamps: boolean;
}

export const DEFAULT_OVERLAY_PREFERENCES: OverlayPreferences = {
  backgroundOpacity: 0.78,
  backgroundColor: "#1d304a",
  fontColor: "#f8fbff",
  fontSize: 14,
  showToolbar: true,
  showTranscript: true,
  showAnswer: true,
  showTimestamps: true
};
