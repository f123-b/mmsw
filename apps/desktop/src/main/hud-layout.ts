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

const TOPBAR_MAX_WIDTH = 680;
const TOPBAR_HEIGHT = 50;
const TOPBAR_TOP_RATIO = 0.08;
const SHORTCUT_WIDTH = 320;
const SHORTCUT_HEIGHT = 360;
const PANEL_GAP = 16;
const PANEL_CONTENT_MAX_WIDTH = 1080;

/**
 * Calculate the default HUD geometry in work-area coordinates.
 *
 * The BrowserWindow itself is positioned on the display work area by the main
 * process, so these coordinates remain valid for taskbars, multi-monitor
 * setups, and per-monitor DPI scaling.
 */
export function calculateHUDLayout(workArea: HUDWorkArea): HUDLayout {
  const usableWidth = Math.max(0, Math.min(PANEL_CONTENT_MAX_WIDTH, workArea.width - 48));
  const horizontalMargin = Math.max(24, Math.round((workArea.width - usableWidth) / 2));
  const panelTop = Math.max(180, Math.round(workArea.height * 0.325));
  const panelHeight = Math.max(300, Math.min(Math.round(workArea.height * 0.39), workArea.height - panelTop - 32));
  const transcriptWidth = Math.round(usableWidth * 0.365);
  const answerWidth = Math.max(0, usableWidth - transcriptWidth - PANEL_GAP);
  const toolbarWidth = Math.min(TOPBAR_MAX_WIDTH, Math.max(460, Math.round(workArea.width * 0.42)), Math.max(0, workArea.width - 40));

  return {
    toolbar: {
      x: Math.max(0, Math.round((workArea.width - toolbarWidth) / 2)),
      y: Math.max(24, Math.round(workArea.height * TOPBAR_TOP_RATIO)),
      width: toolbarWidth,
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
