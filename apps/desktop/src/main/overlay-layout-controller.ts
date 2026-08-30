import type { OverlayDisplayInfo } from "./overlay-manager";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayInterviewPreferences, type OverlayPreferences, type OverlayWindowPreferences, type OverlayWrittenTestPreferences } from "../shared/overlay-preferences";

export type OverlayNativePanel = "question" | "answer" | "control";
export type OverlayContentPanel = "question" | "answer";
export type OverlayRuntimeLayoutMode = "interview" | "written_test";

export interface OverlayNativeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayLayoutControllerOptions {
  display: Pick<OverlayDisplayInfo, "workArea">;
  defaults: { question: OverlayNativeBounds; answer: OverlayNativeBounds; control: OverlayNativeBounds };
}

export const OVERLAY_CONTENT_LIMITS: Record<OverlayContentPanel, { minHeight: number; maxHeight: number }> = {
  question: { minHeight: 88, maxHeight: 280 },
  answer: { minHeight: 132, maxHeight: 440 }
};

type OverlayGeometryPreferences = Pick<OverlayWindowPreferences, "x" | "y" | "width" | "height" | "displayId" | "scaleFactor">;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function clampOverlayBounds(bounds: OverlayNativeBounds, workArea: OverlayNativeBounds, minimumWidth: number, minimumHeight: number): OverlayNativeBounds {
  const width = clamp(Math.round(bounds.width), minimumWidth, Math.max(minimumWidth, workArea.width));
  const height = clamp(Math.round(bounds.height), minimumHeight, Math.max(minimumHeight, workArea.height));
  return { width, height, x: clamp(Math.round(bounds.x), workArea.x, workArea.x + Math.max(0, workArea.width - width)), y: clamp(Math.round(bounds.y), workArea.y, workArea.y + Math.max(0, workArea.height - height)) };
}

export function clampOverlayPanelBounds(panel: OverlayNativePanel, bounds: OverlayNativeBounds, workArea: OverlayNativeBounds): OverlayNativeBounds {
  const minimumWidth = panel === "question" ? 320 : panel === "answer" ? 480 : 240;
  const minimumHeight = panel === "question" ? 220 : panel === "answer" ? 220 : 36;
  return clampOverlayBounds(bounds, workArea, minimumWidth, minimumHeight);
}

export function contentDrivenHeight(panel: OverlayContentPanel, measuredHeight: number): number {
  const limits = OVERLAY_CONTENT_LIMITS[panel];
  return clamp(Math.round(measuredHeight), limits.minHeight, limits.maxHeight);
}

function safeSize(value: Pick<OverlayGeometryPreferences, "width" | "height">, fallback: OverlayNativeBounds): Pick<OverlayNativeBounds, "width" | "height"> {
  return { width: Number.isFinite(value.width) ? value.width : fallback.width, height: Number.isFinite(value.height) ? value.height : fallback.height };
}

function preferredPoint(value: OverlayGeometryPreferences, fallback: OverlayNativeBounds, workArea: OverlayNativeBounds): { x: number; y: number } {
  return { x: workArea.x + (value.x ?? fallback.x - workArea.x), y: workArea.y + (value.y ?? fallback.y - workArea.y) };
}

function presetBounds(mode: OverlayRuntimeLayoutMode, preferences: OverlayInterviewPreferences | OverlayWrittenTestPreferences, workArea: OverlayNativeBounds, defaults: OverlayLayoutControllerOptions["defaults"]): Record<OverlayNativePanel, OverlayNativeBounds> {
  const width = workArea.width;
  const height = workArea.height;
  const margin = 28;
  const controlPreference = preferences.controlBar;
  const controlWidth = controlPreference.width;
  const controlHeight = controlPreference.height;
  const controlX = controlPreference.positionMode.endsWith("right") ? workArea.x + width - controlWidth - margin : controlPreference.positionMode.endsWith("left") ? workArea.x + margin : workArea.x + Math.round((width - controlWidth) / 2);
  const controlY = controlPreference.positionMode.startsWith("bottom") ? workArea.y + height - controlHeight - margin : workArea.y + margin;
  const control = clampOverlayBounds({ x: controlX, y: controlY, width: controlWidth, height: controlHeight }, workArea, 240, 36);
  const preset = preferences.layoutPreset;
  const fixedInterview = mode === "interview" && preset !== "minimal";
  const fixedWritten = mode === "written_test";
  const fixed = fixedInterview || fixedWritten;
  if (!fixed) {
    const questionPoint = preferredPoint(preferences.questionWindow, defaults.question, workArea);
    const answerPoint = preferredPoint(preferences.answerWindow, defaults.answer, workArea);
    return {
      question: clampOverlayPanelBounds("question", { ...questionPoint, ...safeSize(preferences.questionWindow, defaults.question) }, workArea),
      answer: clampOverlayPanelBounds("answer", { ...answerPoint, ...safeSize(preferences.answerWindow, defaults.answer) }, workArea),
      control
    };
  }
  const panelHeight = clamp(Math.round(height - 180), 320, Math.min(720, Math.max(320, height - 100)));
  const layout = mode === "written_test"
    ? preset === "split"
      ? { questionWidth: 520, answerWidth: 700, gap: 24, y: 104, height: panelHeight }
      : { questionWidth: Math.min(960, Math.max(560, width - 160)), answerWidth: 680, gap: 0, y: 104, height: panelHeight }
    : preset === "compact_split"
      ? { questionWidth: 340, answerWidth: 540, gap: 14, y: 104, height: Math.min(panelHeight, 520) }
      : preset === "answer_focus"
        ? { questionWidth: 360, answerWidth: 760, gap: 24, y: 104, height: panelHeight }
        : { questionWidth: 420, answerWidth: 680, gap: 24, y: 104, height: panelHeight };
  const totalWidth = layout.questionWidth + layout.gap + (mode === "written_test" && preset === "single_reader" ? 0 : layout.answerWidth);
  const left = workArea.x + Math.max(margin, Math.round((width - totalWidth) / 2));
  const question = clampOverlayPanelBounds("question", { x: left, y: workArea.y + layout.y, width: layout.questionWidth, height: layout.height }, workArea);
  const answer = clampOverlayPanelBounds("answer", { x: left + layout.questionWidth + layout.gap, y: workArea.y + layout.y, width: layout.answerWidth, height: layout.height }, workArea);
  return { question, answer, control };
}

function resolvePanel(panel: OverlayNativePanel, preferences: OverlayGeometryPreferences, defaults: OverlayNativeBounds, workArea: OverlayNativeBounds): OverlayNativeBounds {
  const point = preferredPoint(preferences, defaults, workArea);
  return clampOverlayPanelBounds(panel, { ...point, ...safeSize(preferences, defaults) }, workArea);
}

/** Resolve mode-specific persisted geometry. Preset layouts are stable; only minimal uses content-driven height. */
export function resolveOverlayNativeBounds(preferences: OverlayPreferences, options: OverlayLayoutControllerOptions, mode: OverlayRuntimeLayoutMode = "interview"): Record<OverlayNativePanel, OverlayNativeBounds> {
  const workArea = options.display.workArea;
  const modePreferences = mode === "written_test" ? preferences.writtenTest : preferences.interview;
  const preset = presetBounds(mode, modePreferences, workArea, options.defaults);
  const usePersisted = mode === "interview" && modePreferences.layoutPreset === "minimal";
  if (!usePersisted) return preset;
  const leftPreferences = preferences.interview.leftPanel === "dialogue" ? preferences.interview.dialogueWindow : preferences.interview.questionWindow;
  return {
    question: resolvePanel("question", leftPreferences, preset.question, workArea),
    answer: resolvePanel("answer", modePreferences.answerWindow, preset.answer, workArea),
    control: resolvePanel("control", modePreferences.controlBar, preset.control, workArea)
  };
}

export function layoutGeometryForMode(preferences: OverlayPreferences, mode: OverlayRuntimeLayoutMode, workArea: OverlayNativeBounds, defaults: OverlayLayoutControllerOptions["defaults"]): Record<OverlayNativePanel, OverlayNativeBounds> {
  return resolveOverlayNativeBounds(preferences, { display: { workArea }, defaults }, mode);
}

export { DEFAULT_OVERLAY_PREFERENCES };
