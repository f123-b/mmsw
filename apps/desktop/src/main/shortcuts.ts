export const GLOBAL_SHORTCUTS = {
  answerLatest: "CommandOrControl+Alt+A",
  screenshotAnswer: "CommandOrControl+Alt+S",
  toggleOverlay: "CommandOrControl+Alt+D",
  toggleShortcuts: "CommandOrControl+Alt+K",
  toggleOverlayMode: "CommandOrControl+Alt+P",
  toggleAutomation: "CommandOrControl+Alt+X",
  endInterview: "CommandOrControl+Alt+Q"
} as const;

export type ShortcutAction = "answer-latest" | "screenshot-answer" | "toggle-overlay-mode" | "toggle-automation" | "end-interview";
