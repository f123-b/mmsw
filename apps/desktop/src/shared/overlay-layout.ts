import type { InterviewLayoutPreset, OverlayControlBarPreferences, OverlayWindowPreferences, WrittenTestLayoutPreset } from "./overlay-preferences";

export type OverlayLayoutMode = "interview" | "written_test";
export type OverlayLayoutPanel = "question" | "answer" | "script" | "control";

export interface OverlayGeometryContext {
  mode: OverlayLayoutMode;
  preset: InterviewLayoutPreset | WrittenTestLayoutPreset;
  panel: OverlayLayoutPanel;
}

export interface OverlayGeometryConstraints {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
}

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
  scriptWindow?: Pick<OverlayWindowPreferences, "width" | "height">;
}

type PersistedWindowGeometry = Pick<OverlayWindowPreferences, "x" | "y" | "width" | "height"> &
  Partial<Pick<OverlayWindowPreferences, "displayId" | "scaleFactor">>;

type PersistedControlBarGeometry = Pick<OverlayControlBarPreferences, "x" | "y" | "width" | "height" | "orientation"> &
  Partial<Pick<OverlayControlBarPreferences, "displayId" | "scaleFactor">>;

export interface OverlayPersistedGeometryOptions extends OverlayPresetGeometryOptions {
  questionWindow: PersistedWindowGeometry;
  answerWindow: PersistedWindowGeometry;
  scriptWindow?: PersistedWindowGeometry;
  controlBar: PersistedControlBarGeometry;
}

const INTERVIEW_STABLE_CONSTRAINTS: Record<Exclude<OverlayLayoutPanel, "control">, OverlayGeometryConstraints> = {
  question: { minWidth: 320, maxWidth: 900, minHeight: 220, maxHeight: 840 },
  answer: { minWidth: 480, maxWidth: 1_100, minHeight: 220, maxHeight: 840 },
  script: { minWidth: 280, maxWidth: 700, minHeight: 180, maxHeight: 840 }
};

const INTERVIEW_MINIMAL_CONSTRAINTS: Record<Exclude<OverlayLayoutPanel, "control">, OverlayGeometryConstraints> = {
  question: { minWidth: 320, maxWidth: 760, minHeight: 88, maxHeight: 280 },
  answer: { minWidth: 480, maxWidth: 1_000, minHeight: 132, maxHeight: 440 },
  script: { minWidth: 280, maxWidth: 700, minHeight: 140, maxHeight: 440 }
};

const WRITTEN_CONSTRAINTS: Record<Exclude<OverlayLayoutPanel, "control">, OverlayGeometryConstraints> = {
  question: { minWidth: 480, maxWidth: 1_200, minHeight: 320, maxHeight: 840 },
  answer: { minWidth: 480, maxWidth: 1_200, minHeight: 320, maxHeight: 840 },
  script: { minWidth: 320, maxWidth: 900, minHeight: 220, maxHeight: 840 }
};

const CONTROL_CONSTRAINTS: OverlayGeometryConstraints = { minWidth: 360, maxWidth: 1_200, minHeight: 44, maxHeight: 100 };

/** Single source of truth for Settings normalize, Designer and native Runtime geometry. */
export function resolveOverlayGeometryConstraints(context: OverlayGeometryContext): OverlayGeometryConstraints {
  if (context.panel === "control") return { ...CONTROL_CONSTRAINTS };
  if (context.mode === "written_test") return { ...WRITTEN_CONSTRAINTS[context.panel] };
  return { ...(context.preset === "minimal" ? INTERVIEW_MINIMAL_CONSTRAINTS : INTERVIEW_STABLE_CONSTRAINTS)[context.panel] };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function dimension(value: number, minimum: number, maximum: number): number {
  return clamp(Math.round(value), minimum, Math.max(minimum, Math.round(maximum)));
}

function fitSize(width: number, height: number, workArea: OverlayLayoutWorkArea, constraints: OverlayGeometryConstraints): { width: number; height: number } {
  return {
    width: dimension(width, constraints.minWidth, Math.min(constraints.maxWidth, workArea.width - 32)),
    height: dimension(height, constraints.minHeight, Math.min(constraints.maxHeight, workArea.height - 32))
  };
}

function centeredX(workArea: OverlayLayoutWorkArea, width: number): number {
  return workArea.x + Math.round((workArea.width - width) / 2);
}

function clampBounds(bounds: OverlayLayoutBounds, workArea: OverlayLayoutWorkArea, constraints: OverlayGeometryConstraints): OverlayLayoutBounds {
  const width = dimension(bounds.width, constraints.minWidth, Math.min(constraints.maxWidth, workArea.width));
  const height = dimension(bounds.height, constraints.minHeight, Math.min(constraints.maxHeight, workArea.height));
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

function panelHeight(workArea: OverlayLayoutWorkArea, preferred: number, constraints: OverlayGeometryConstraints): number {
  return dimension(preferred, constraints.minHeight, Math.min(constraints.maxHeight, workArea.height - 120));
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
  const questionConstraints = resolveOverlayGeometryConstraints({ mode, preset: normalized, panel: "question" });
  const answerConstraints = resolveOverlayGeometryConstraints({ mode, preset: normalized, panel: "answer" });
  const controlConstraints = resolveOverlayGeometryConstraints({ mode, preset: normalized, panel: "control" });
  const controlSize = {
    width: dimension(controlBar.width, controlConstraints.minWidth, controlConstraints.maxWidth),
    height: dimension(controlBar.height, controlConstraints.minHeight, controlConstraints.maxHeight)
  };
  const controlPositionMode = isWritten ? "top_center" : normalized === "compact_split" ? "top_right" : "top_center";
  const control = clampBounds({ ...controlPosition(controlPositionMode, workArea, controlSize.width, controlSize.height), ...controlSize }, workArea, controlConstraints);

  if (isWritten) {
    const height = panelHeight(workArea, writtenPreset === "single_reader" ? 700 : 560, questionConstraints);
    if (writtenPreset === "single_reader") {
      const question = fitSize(Math.min(560, workArea.width - margin * 2), height, workArea, questionConstraints);
      return {
        question: clampBounds({ x: centeredX(workArea, question.width), y: workArea.y + 104, ...question }, workArea, questionConstraints),
        answer: clampBounds({ x: centeredX(workArea, 700), y: workArea.y + 104, width: 700, height }, workArea, answerConstraints),
        script: clampBounds({ x: workArea.x + margin, y: workArea.y + workArea.height - 260 - margin, width: 360, height: 260 }, workArea, resolveOverlayGeometryConstraints({ mode, preset: normalized, panel: "script" })),
        control
      };
    }
    const gap = 24;
    const questionWidth = Math.min(520, Math.max(480, Math.floor((workArea.width - gap - 480 - margin * 2) / 2)));
    const answerWidth = Math.min(700, Math.max(480, workArea.width - questionWidth - gap - margin * 2));
    const total = questionWidth + gap + answerWidth;
    const left = centeredX(workArea, total);
    return {
      question: clampBounds({ x: left, y: workArea.y + 104, width: questionWidth, height }, workArea, questionConstraints),
      answer: clampBounds({ x: left + questionWidth + gap, y: workArea.y + 104, width: answerWidth, height }, workArea, answerConstraints),
      script: clampBounds({ x: workArea.x + margin, y: workArea.y + workArea.height - 260 - margin, width: 360, height: 260 }, workArea, resolveOverlayGeometryConstraints({ mode, preset: normalized, panel: "script" })),
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
  const height = normalized === "minimal" ? sizes.height : panelHeight(workArea, sizes.height, questionConstraints);
  const question = fitSize(sizes.question, height, workArea, questionConstraints);
  const answer = fitSize(sizes.answer, height, workArea, answerConstraints);
  const scriptConstraints = resolveOverlayGeometryConstraints({ mode, preset: normalized, panel: "script" });
  const scriptSize = fitSize(options.scriptWindow?.width ?? 360, options.scriptWindow?.height ?? 420, workArea, scriptConstraints);
  const total = question.width + sizes.gap + answer.width;
  const left = centeredX(workArea, total);
  return {
    question: clampBounds({ x: left, y: workArea.y + (normalized === "minimal" ? 150 : 104), ...question }, workArea, questionConstraints),
    answer: clampBounds({ x: left + question.width + sizes.gap, y: workArea.y + (normalized === "minimal" ? 150 : 104), ...answer }, workArea, answerConstraints),
    script: clampBounds({ x: workArea.x + margin, y: workArea.y + workArea.height - scriptSize.height - margin, ...scriptSize }, workArea, scriptConstraints),
    control
  };
}

function hasPersistedPosition(value: Pick<OverlayWindowPreferences, "x" | "y">): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y);
}

function persistedBounds(context: OverlayGeometryContext, value: Partial<Pick<OverlayWindowPreferences, "x" | "y" | "width" | "height">>, fallback: OverlayLayoutBounds, workArea: OverlayLayoutWorkArea): OverlayLayoutBounds {
  const constraints = resolveOverlayGeometryConstraints(context);
  // A fresh preference has dimensions but no position. Keep the preset's
  // placement in that case while still honoring an explicitly customized
  // width/height; once x/y exist, all four geometry fields are persisted.
  const position = hasPersistedPosition(value)
    ? { x: workArea.x + (value.x ?? 0), y: workArea.y + (value.y ?? 0) }
    : { x: fallback.x, y: fallback.y };
  return clampBounds({ ...position, width: value.width ?? fallback.width, height: value.height ?? fallback.height }, workArea, constraints);
}

/** Resolve persisted geometry while using the preset only for uninitialized panels. */
export function resolveOverlayPersistedGeometry(options: OverlayPersistedGeometryOptions): Record<OverlayLayoutPanel, OverlayLayoutBounds> {
  const preset = resolveOverlayPresetGeometry(options);
  return {
    question: persistedBounds({ mode: options.mode, preset: options.preset, panel: "question" }, options.questionWindow, preset.question, options.workArea),
    answer: persistedBounds({ mode: options.mode, preset: options.preset, panel: "answer" }, options.answerWindow, preset.answer, options.workArea),
    script: persistedBounds({ mode: options.mode, preset: options.preset, panel: "script" }, options.scriptWindow ?? {}, preset.script, options.workArea),
    control: persistedBounds({ mode: options.mode, preset: options.preset, panel: "control" }, options.controlBar, preset.control, options.workArea)
  };
}

export function toRelativeOverlayBounds(bounds: OverlayLayoutBounds, workArea: OverlayLayoutWorkArea): OverlayLayoutBounds {
  return { ...bounds, x: Math.round(bounds.x - workArea.x), y: Math.round(bounds.y - workArea.y) };
}

/**
 * Written-test camera control: a small native interactive window anchored to
 * the AnswerWindow's upper-right corner. The answer surface remains passive;
 * only this returned rectangle is reserved for pointer interaction.
 */
export function resolveWrittenTestCameraBounds(answer: OverlayLayoutBounds, workArea: OverlayLayoutWorkArea, gap = 8): OverlayLayoutBounds {
  const width = 128;
  const height = 44;
  return {
    width,
    height,
    x: clamp(answer.x + answer.width - width - gap, workArea.x, workArea.x + Math.max(0, workArea.width - width)),
    y: clamp(answer.y + gap, workArea.y, workArea.y + Math.max(0, workArea.height - height))
  };
}
