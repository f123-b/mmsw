import type { InterviewLayoutPreset, OverlayControlBarPreferences, OverlayWindowPreferences, WrittenTestLayoutPreset } from "./overlay-preferences";

export type OverlayLayoutMode = "interview" | "written_test";
export type OverlayLayoutPanel = "question" | "answer" | "control";

export interface OverlayLayoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayLayoutWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayPresetGeometryOptions {
  mode: OverlayLayoutMode;
  preset: InterviewLayoutPreset | WrittenTestLayoutPreset;
  workArea: OverlayLayoutWorkArea;
  controlBar: Pick<OverlayControlBarPreferences, "width" | "height" | "orientation">;
}

type PersistedWindowGeometry = Pick<OverlayWindowPreferences, "x" | "y" | "width" | "height"> &
  Partial<Pick<OverlayWindowPreferences, "displayId" | "scaleFactor">>;

type PersistedControlBarGeometry = Pick<OverlayControlBarPreferences, "x" | "y" | "width" | "height" | "orientation"> &
  Partial<Pick<OverlayControlBarPreferences, "displayId" | "scaleFactor">>;

export interface OverlayPersistedGeometryOptions extends OverlayPresetGeometryOptions {
  questionWindow: PersistedWindowGeometry;
  answerWindow: PersistedWindowGeometry;
  controlBar: PersistedControlBarGeometry;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function dimension(value: number, minimum: number, maximum: number): number {
  return clamp(Math.round(value), minimum, Math.max(minimum, Math.round(maximum)));
}

function fitSize(width: number, height: number, workArea: OverlayLayoutWorkArea, minimumWidth: number, minimumHeight: number): { width: number; height: number } {
  return {
    width: dimension(width, minimumWidth, workArea.width - 32),
    height: dimension(height, minimumHeight, workArea.height - 32)
  };
}

function centeredX(workArea: OverlayLayoutWorkArea, width: number): number {
  return workArea.x + Math.round((workArea.width - width) / 2);
}

function clampBounds(bounds: OverlayLayoutBounds, workArea: OverlayLayoutWorkArea, minimumWidth: number, minimumHeight: number): OverlayLayoutBounds {
  const width = dimension(bounds.width, minimumWidth, workArea.width);
  const height = dimension(bounds.height, minimumHeight, workArea.height);
  return {
    width,
    height,
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + Math.max(0, workArea.width - width)),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + Math.max(0, workArea.height - height))
  };
}

function controlPosition(mode: OverlayControlBarPreferences["positionMode"], workArea: OverlayLayoutWorkArea, width: number, height: number): { x: number; y: number } {
  const gap = 24;
  const top = workArea.y + gap;
  const bottom = workArea.y + workArea.height - height - gap;
  const left = workArea.x + gap;
  const right = workArea.x + workArea.width - width - gap;
  if (mode.endsWith("left")) return { x: left, y: mode.startsWith("bottom") ? bottom : top };
  if (mode.endsWith("right")) return { x: right, y: mode.startsWith("bottom") ? bottom : top };
  return { x: centeredX(workArea, width), y: mode.startsWith("bottom") ? bottom : top };
}

function panelHeight(workArea: OverlayLayoutWorkArea, preferred: number): number {
  return dimension(preferred, 320, Math.min(600, workArea.height - 120));
}

/**
 * The only preset algorithm used by the main process and the renderer
 * designer. It returns absolute screen coordinates so callers can explicitly
 * convert to/from work-area-relative preference coordinates.
 */
export function resolveOverlayPresetGeometry(options: OverlayPresetGeometryOptions): Record<OverlayLayoutPanel, OverlayLayoutBounds> {
  const { mode, preset, workArea, controlBar } = options;
  const isWritten = mode === "written_test";
  const interviewPreset = preset as InterviewLayoutPreset;
  const writtenPreset = preset as WrittenTestLayoutPreset;
  const normalized = isWritten ? writtenPreset : interviewPreset;
  const margin = 28;
  const controlSize = controlBar.orientation === "vertical"
    ? { width: Math.max(54, Math.min(controlBar.width, 96)), height: Math.max(180, controlBar.height) }
    : { width: Math.max(360, Math.min(controlBar.width, 520)), height: Math.max(42, Math.min(controlBar.height, 48)) };
  const controlPositionMode = isWritten ? "top_center" : normalized === "compact_split" ? "top_right" : "top_center";
  const control = clampBounds({ ...controlPosition(controlPositionMode, workArea, controlSize.width, controlSize.height), ...controlSize }, workArea, 240, 36);

  if (isWritten) {
    const height = panelHeight(workArea, 560);
    if (writtenPreset === "single_reader") {
      const question = fitSize(Math.min(920, workArea.width - margin * 2), height, workArea, 480, 320);
      return {
        question: clampBounds({ x: centeredX(workArea, question.width), y: workArea.y + 104, ...question }, workArea, 480, 320),
        answer: clampBounds({ x: centeredX(workArea, 700), y: workArea.y + 104, width: 700, height }, workArea, 480, 320),
        control
      };
    }
    const gap = 24;
    const questionWidth = Math.min(520, Math.max(480, Math.floor((workArea.width - gap - 480 - margin * 2) / 2)));
    const answerWidth = Math.min(700, Math.max(480, workArea.width - questionWidth - gap - margin * 2));
    const total = questionWidth + gap + answerWidth;
    const left = centeredX(workArea, total);
    return {
      question: clampBounds({ x: left, y: workArea.y + 104, width: questionWidth, height }, workArea, 480, 320),
      answer: clampBounds({ x: left + questionWidth + gap, y: workArea.y + 104, width: answerWidth, height }, workArea, 480, 320),
      control
    };
  }

  const sizes = normalized === "compact_split"
    ? { question: 360, answer: 560, height: 500, gap: 16 }
    : normalized === "answer_focus"
      ? { question: 380, answer: 720, height: 500, gap: 24 }
      : normalized === "minimal"
        ? { question: 410, answer: 620, height: 220, gap: 16 }
        : { question: 420, answer: 680, height: 500, gap: 24 };
  const height = normalized === "minimal" ? sizes.height : panelHeight(workArea, sizes.height);
  const question = fitSize(sizes.question, height, workArea, 320, 220);
  const answer = fitSize(sizes.answer, height, workArea, 480, 220);
  const total = question.width + sizes.gap + answer.width;
  const left = centeredX(workArea, total);
  return {
    question: clampBounds({ x: left, y: workArea.y + (normalized === "minimal" ? 150 : 104), ...question }, workArea, 320, 220),
    answer: clampBounds({ x: left + question.width + sizes.gap, y: workArea.y + (normalized === "minimal" ? 150 : 104), ...answer }, workArea, 480, 220),
    control
  };
}

function hasPersistedPosition(value: Pick<OverlayWindowPreferences, "x" | "y">): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y);
}

function persistedBounds(panel: OverlayLayoutPanel, value: Pick<OverlayWindowPreferences, "x" | "y" | "width" | "height">, fallback: OverlayLayoutBounds, workArea: OverlayLayoutWorkArea): OverlayLayoutBounds {
  const minimumWidth = panel === "question" ? 320 : panel === "answer" ? 480 : 240;
  const minimumHeight = panel === "control" ? 36 : 220;
  // A fresh preference has dimensions but no position. Keep the preset's
  // placement in that case while still honoring an explicitly customized
  // width/height; once x/y exist, all four geometry fields are persisted.
  const position = hasPersistedPosition(value)
    ? { x: workArea.x + (value.x ?? 0), y: workArea.y + (value.y ?? 0) }
    : { x: fallback.x, y: fallback.y };
  return clampBounds({ ...position, width: value.width ?? fallback.width, height: value.height ?? fallback.height }, workArea, minimumWidth, minimumHeight);
}

/** Resolve persisted geometry while using the preset only for uninitialized panels. */
export function resolveOverlayPersistedGeometry(options: OverlayPersistedGeometryOptions): Record<OverlayLayoutPanel, OverlayLayoutBounds> {
  const preset = resolveOverlayPresetGeometry(options);
  return {
    question: persistedBounds("question", options.questionWindow, preset.question, options.workArea),
    answer: persistedBounds("answer", options.answerWindow, preset.answer, options.workArea),
    control: persistedBounds("control", options.controlBar, preset.control, options.workArea)
  };
}

export function toRelativeOverlayBounds(bounds: OverlayLayoutBounds, workArea: OverlayLayoutWorkArea): OverlayLayoutBounds {
  return { ...bounds, x: Math.round(bounds.x - workArea.x), y: Math.round(bounds.y - workArea.y) };
}
