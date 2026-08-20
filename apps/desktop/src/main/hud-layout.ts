export interface HUDWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HUDPanelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HUDLayout {
  toolbar: HUDPanelLayout;
  transcript: HUDPanelLayout;
  answer: HUDPanelLayout;
  shortcuts: HUDPanelLayout;
}

const TOPBAR_WIDTH = 300;
const TOPBAR_HEIGHT = 42;
const SHORTCUT_WIDTH = 320;
const SHORTCUT_HEIGHT = 360;
const PANEL_GAP = 40;

/**
 * Calculate the default HUD geometry in work-area coordinates.
 *
 * The BrowserWindow itself is positioned on the display work area by the main
 * process, so these coordinates remain valid for taskbars, multi-monitor
 * setups, and per-monitor DPI scaling.
 */
export function calculateHUDLayout(workArea: HUDWorkArea): HUDLayout {
  const horizontalMargin = Math.round(workArea.width * 0.05);
  const panelHeight = Math.max(360, Math.round(workArea.height * 0.65));
  const panelTop = Math.max(84, Math.round(workArea.height * 0.11));
  const desiredTranscriptWidth = Math.round(workArea.width * 0.28);
  const desiredAnswerWidth = Math.round(workArea.width * 0.42);
  const usablePanelWidth = Math.max(560, workArea.width - horizontalMargin * 2 - PANEL_GAP);
  const transcriptWidth = Math.min(desiredTranscriptWidth, Math.max(260, Math.round(usablePanelWidth * 0.4)));
  const answerWidth = Math.min(desiredAnswerWidth, Math.max(320, usablePanelWidth - transcriptWidth));

  return {
    toolbar: {
      x: Math.max(0, Math.round((workArea.width - TOPBAR_WIDTH) / 2)),
      y: 20,
      width: TOPBAR_WIDTH,
      height: TOPBAR_HEIGHT
    },
    transcript: {
      x: horizontalMargin,
      y: panelTop,
      width: transcriptWidth,
      height: panelHeight
    },
    answer: {
      x: horizontalMargin + transcriptWidth + PANEL_GAP,
      y: panelTop,
      width: answerWidth,
      height: panelHeight
    },
    shortcuts: {
      x: 24,
      y: Math.max(0, workArea.height - SHORTCUT_HEIGHT - 24),
      width: SHORTCUT_WIDTH,
      height: SHORTCUT_HEIGHT
    }
  };
}
