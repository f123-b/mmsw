import type { MouseInteractionMode, OverlayControlBarPositionMode, OverlayControlBarOrientation, OverlayLayoutPreset, WheelRoutingMode } from "../../shared/overlay-preferences";

export type DesignerPanel = "question" | "answer" | "controlBar";

export interface DesignerCanvas {
  width: number;
  height: number;
}

export interface DesignerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignerBounds {
  minimumWidth: number;
  maximumWidth: number;
  minimumHeight: number;
  maximumHeight: number;
}

export interface DesignerLayout {
  question: DesignerRect;
  answer: DesignerRect;
  controlBar: DesignerRect;
}

export interface DesignerPoint {
  x: number;
  y: number;
}

export interface DesignerDisplay {
  id?: number;
  bounds?: DesignerCanvas & { x?: number; y?: number };
  workArea: DesignerCanvas & { x?: number; y?: number };
  scaleFactor?: number;
}

export interface ResolvedOverlayLayout {
  questionWindow: DesignerRect;
  answerWindow: DesignerRect;
  controlBar: DesignerRect;
  controlBarOrientation: OverlayControlBarOrientation;
  controlBarPositionMode: OverlayControlBarPositionMode;
  displayId?: number;
  scaleFactor?: number;
}

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const QUESTION_DESIGNER_BOUNDS: DesignerBounds = { minimumWidth: 320, maximumWidth: 760, minimumHeight: 88, maximumHeight: 280 };
export const ANSWER_DESIGNER_BOUNDS: DesignerBounds = { minimumWidth: 480, maximumWidth: 1_000, minimumHeight: 132, maximumHeight: 440 };
export const CONTROL_BAR_DESIGNER_BOUNDS: DesignerBounds = { minimumWidth: 320, maximumWidth: 560, minimumHeight: 42, maximumHeight: 64 };

export function boundsForPanel(panel: DesignerPanel): DesignerBounds {
  if (panel === "question") return QUESTION_DESIGNER_BOUNDS;
  if (panel === "answer") return ANSWER_DESIGNER_BOUNDS;
  return CONTROL_BAR_DESIGNER_BOUNDS;
}

export function clampDesignerRect(rect: DesignerRect, canvas: DesignerCanvas, bounds: DesignerBounds, visibleMargin = 40): DesignerRect {
  const width = Math.max(bounds.minimumWidth, Math.min(bounds.maximumWidth, Math.min(rect.width, Math.max(bounds.minimumWidth, canvas.width))));
  const height = Math.max(bounds.minimumHeight, Math.min(bounds.maximumHeight, Math.min(rect.height, Math.max(bounds.minimumHeight, canvas.height))));
  return {
    width,
    height,
    x: Math.round(Math.max(visibleMargin - width, Math.min(rect.x, canvas.width - visibleMargin))),
    y: Math.round(Math.max(visibleMargin - height, Math.min(rect.y, canvas.height - visibleMargin)))
  };
}

function snapValue(value: number, targets: number[], threshold: number): number {
  const target = targets.find((candidate) => Math.abs(candidate - value) <= threshold);
  return target === undefined ? value : target;
}

export function snapDesignerRect(panel: DesignerPanel, rect: DesignerRect, layout: DesignerLayout, canvas: DesignerCanvas, threshold = 12, altPressed = false): DesignerRect {
  if (altPressed) return clampDesignerRect(rect, canvas, boundsForPanel(panel));
  const others = Object.entries(layout).filter(([key]) => key !== panel).map(([, value]) => value as DesignerRect);
  const xTargets = [0, canvas.width - rect.width];
  const yTargets = [0, canvas.height - rect.height];
  others.forEach((other) => {
    xTargets.push(other.x, other.x + other.width, other.x - rect.width, other.x + other.width - rect.width);
    yTargets.push(other.y, other.y + other.height, other.y - rect.height, other.y + other.height - rect.height);
  });
  return clampDesignerRect({ ...rect, x: snapValue(rect.x, xTargets, threshold), y: snapValue(rect.y, yTargets, threshold) }, canvas, boundsForPanel(panel));
}

export function resizeDesignerRect(rect: DesignerRect, handle: ResizeHandle, delta: DesignerPoint, canvas: DesignerCanvas, bounds: DesignerBounds, altPressed = false): DesignerRect {
  let next = { ...rect };
  if (handle.includes("e")) next.width = rect.width + delta.x;
  if (handle.includes("s")) next.height = rect.height + delta.y;
  if (handle.includes("w")) { next.x = rect.x + delta.x; next.width = rect.width - delta.x; }
  if (handle.includes("n")) { next.y = rect.y + delta.y; next.height = rect.height - delta.y; }
  if (next.width < bounds.minimumWidth) { if (handle.includes("w")) next.x = rect.x + rect.width - bounds.minimumWidth; next.width = bounds.minimumWidth; }
  if (next.height < bounds.minimumHeight) { if (handle.includes("n")) next.y = rect.y + rect.height - bounds.minimumHeight; next.height = bounds.minimumHeight; }
  if (next.width > bounds.maximumWidth) { if (handle.includes("w")) next.x = rect.x + rect.width - bounds.maximumWidth; next.width = bounds.maximumWidth; }
  if (next.height > bounds.maximumHeight) { if (handle.includes("n")) next.y = rect.y + rect.height - bounds.maximumHeight; next.height = bounds.maximumHeight; }
  return clampDesignerRect(next, canvas, bounds, 40);
}

/**
 * Resize from an immutable pointer-down rectangle. The delta is always derived
 * from the original pointer position, so repeated pointermove events do not
 * compound an already-applied resize.
 */
export function resizeDesignerRectFromPointer(
  startRect: DesignerRect,
  handle: ResizeHandle,
  startPointer: DesignerPoint,
  currentPointer: DesignerPoint,
  preview: DesignerCanvas,
  canvas: DesignerCanvas,
  bounds: DesignerBounds
): DesignerRect {
  return resizeDesignerRect(
    startRect,
    handle,
    {
      x: (currentPointer.x - startPointer.x) * canvas.width / Math.max(1, preview.width),
      y: (currentPointer.y - startPointer.y) * canvas.height / Math.max(1, preview.height)
    },
    canvas,
    bounds
  );
}

export function controlBarPosition(mode: OverlayControlBarPositionMode, orientation: OverlayControlBarOrientation, canvas: DesignerCanvas, size: Pick<DesignerRect, "width" | "height">, custom?: DesignerPoint): DesignerPoint {
  if (mode === "custom" && custom) return custom;
  const horizontalCenter = Math.round((canvas.width - size.width) / 2);
  const verticalCenter = Math.round((canvas.height - size.height) / 2);
  const sideGap = orientation === "vertical" ? 18 : 24;
  const top = sideGap;
  const bottom = canvas.height - size.height - sideGap;
  const left = sideGap;
  const right = canvas.width - size.width - sideGap;
  if (mode === "top_left") return { x: left, y: top };
  if (mode === "top_right") return { x: right, y: top };
  if (mode === "bottom_left") return { x: left, y: bottom };
  if (mode === "bottom_right") return { x: right, y: bottom };
  if (mode === "bottom_center") return { x: horizontalCenter, y: bottom };
  if (orientation === "vertical" && mode === "top_center") return { x: left, y: verticalCenter };
  return { x: horizontalCenter, y: top };
}

function fitPresetPanels(canvas: DesignerCanvas, questionSize: Pick<DesignerRect, "width" | "height">, answerSize: Pick<DesignerRect, "width" | "height">, gap: number, margin: number): { question: DesignerRect; answer: DesignerRect } {
  const availableWidth = Math.max(QUESTION_DESIGNER_BOUNDS.minimumWidth + gap + ANSWER_DESIGNER_BOUNDS.minimumWidth, canvas.width - margin * 2);
  const preferredWidth = questionSize.width + gap + answerSize.width;
  const scale = Math.min(1, availableWidth / Math.max(1, preferredWidth));
  const question: DesignerRect = { x: 0, y: 0, width: Math.round(questionSize.width * scale), height: Math.round(Math.min(questionSize.height, canvas.height - 2 * margin)) };
  const answer: DesignerRect = { x: 0, y: 0, width: Math.round(answerSize.width * scale), height: Math.round(Math.min(answerSize.height, canvas.height - 2 * margin)) };
  const totalWidth = question.width + gap + answer.width;
  const left = Math.max(margin, Math.round((canvas.width - totalWidth) / 2));
  const top = Math.max(margin, Math.round((canvas.height - Math.max(question.height, answer.height)) / 2));
  question.x = left;
  question.y = top;
  answer.x = left + question.width + gap;
  answer.y = top;
  return { question, answer };
}

/**
 * Resolve a named layout into real display-pixel geometry. The renderer and
 * the settings designer both use this function so changing a preset cannot
 * silently leave the previous coordinates in place.
 */
export function resolveOverlayLayoutPreset(preset: OverlayLayoutPreset, display: DesignerDisplay, current?: Partial<ResolvedOverlayLayout>): ResolvedOverlayLayout {
  const canvas = { width: Math.max(1, Math.round(display.workArea.width)), height: Math.max(1, Math.round(display.workArea.height)) };
  const margin = preset === "dual_screen" ? 28 : 40;
  const sizes = preset === "compact"
    ? { question: { width: 360, height: 150 }, answer: { width: 520, height: 180 }, gap: 12 }
    : preset === "wide"
      ? { question: { width: 460, height: 240 }, answer: { width: 760, height: 360 }, gap: 18 }
      : preset === "dual_screen"
        ? { question: { width: 440, height: 220 }, answer: { width: 700, height: 360 }, gap: 24 }
        : { question: { width: 410, height: 180 }, answer: { width: 620, height: 220 }, gap: 16 };
  const panels = preset === "custom" && current?.questionWindow && current.answerWindow
    ? { question: { ...current.questionWindow }, answer: { ...current.answerWindow } }
    : fitPresetPanels(canvas, sizes.question, sizes.answer, sizes.gap, margin);
  const question = clampDesignerRect(panels.question, canvas, QUESTION_DESIGNER_BOUNDS);
  const answer = clampDesignerRect(panels.answer, canvas, ANSWER_DESIGNER_BOUNDS);
  const orientation = preset === "dual_screen" ? "vertical" : current?.controlBarOrientation ?? "horizontal";
  const controlSize = orientation === "vertical" ? { width: 54, height: 220 } : { width: Math.min(480, Math.max(360, canvas.width - 2 * margin)), height: 44 };
  const positionMode = preset === "custom" ? current?.controlBarPositionMode ?? "custom" : preset === "compact" ? "top_right" : preset === "wide" ? "bottom_center" : "top_center";
  const customPoint = preset === "custom" && current?.controlBar ? { x: current.controlBar.x, y: current.controlBar.y } : undefined;
  const controlPoint = controlBarPosition(positionMode, orientation, canvas, controlSize, customPoint);
  const controlBar = clampDesignerRect({ ...controlPoint, ...controlSize }, canvas, CONTROL_BAR_DESIGNER_BOUNDS);
  return {
    questionWindow: question,
    answerWindow: answer,
    controlBar,
    controlBarOrientation: orientation,
    controlBarPositionMode: positionMode,
    ...(display.id !== undefined ? { displayId: display.id } : {}),
    ...(display.scaleFactor !== undefined ? { scaleFactor: display.scaleFactor } : {})
  };
}

export const applyLayoutPreset = resolveOverlayLayoutPreset;

export function mapPreviewPointToCanvas(point: DesignerPoint, preview: DesignerCanvas, canvas: DesignerCanvas): DesignerPoint {
  return { x: Math.round(point.x * canvas.width / Math.max(1, preview.width)), y: Math.round(point.y * canvas.height / Math.max(1, preview.height)) };
}

export function interactionModeAllowsOverlayInput(mode: MouseInteractionMode, temporaryInteractive: boolean, layoutEditMode: boolean, hitRegion = true): boolean {
  return temporaryInteractive || (hitRegion && (layoutEditMode || mode === "interactive"));
}

export type OverlayHitRegion = "modal" | "layout_toolbar" | "control_bar" | "resize_handle" | "content" | "background";

export function overlayHitRegionAllowsInput(region: OverlayHitRegion, mode: MouseInteractionMode, contentInteractive: boolean): boolean {
  if (region === "modal" || region === "layout_toolbar" || region === "control_bar" || region === "resize_handle") return true;
  if (region === "content") return contentInteractive && mode !== "full_passthrough";
  return false;
}

export function wheelTargetAtPoint(point: DesignerPoint, layout: DesignerLayout, mode: WheelRoutingMode): "question" | "answer" | "underlying_app" | "none" {
  if (mode === "underlying_app") return "underlying_app";
  const inRect = (rect: DesignerRect) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  if (inRect(layout.question)) return mode === "dual" ? "question" : "question";
  if (inRect(layout.answer)) return mode === "dual" ? "answer" : "answer";
  return mode === "dual" ? "underlying_app" : "none";
}

export function modifierPressed(modifier: "ctrl" | "alt" | "shift" | "ctrl_shift", event: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey">): boolean {
  if (modifier === "ctrl") return event.ctrlKey && !event.altKey && !event.shiftKey;
  if (modifier === "alt") return event.altKey && !event.ctrlKey && !event.shiftKey;
  if (modifier === "shift") return event.shiftKey && !event.ctrlKey && !event.altKey;
  return event.ctrlKey && event.shiftKey && !event.altKey;
}
