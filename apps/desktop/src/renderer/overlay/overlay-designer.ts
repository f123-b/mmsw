import type { InterviewLayoutPreset, MouseInteractionMode, OverlayControlBarPositionMode, OverlayControlBarOrientation, LegacyOverlayLayoutPreset, WheelRoutingMode, WrittenTestLayoutPreset } from "../../shared/overlay-preferences";
import { resolveOverlayGeometryConstraints, resolveOverlayPresetGeometry, toRelativeOverlayBounds, type OverlayGeometryConstraints } from "../../shared/overlay-layout";

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

export interface DesignerGeometryContext {
  panel: DesignerPanel;
  mode: "interview" | "writtenTest";
  preset: InterviewLayoutPreset | WrittenTestLayoutPreset;
}

function geometryContext(context: DesignerGeometryContext): { mode: "interview" | "written_test"; preset: InterviewLayoutPreset | WrittenTestLayoutPreset; panel: "question" | "answer" | "control" } {
  return { mode: context.mode === "writtenTest" ? "written_test" : "interview", preset: context.preset, panel: context.panel === "controlBar" ? "control" : context.panel };
}

function toDesignerBounds(constraints: OverlayGeometryConstraints): DesignerBounds {
  return { minimumWidth: constraints.minWidth, maximumWidth: constraints.maxWidth, minimumHeight: constraints.minHeight, maximumHeight: constraints.maxHeight };
}

export function boundsForPanel(context: DesignerGeometryContext): DesignerBounds {
  return toDesignerBounds(resolveOverlayGeometryConstraints(geometryContext(context)));
}

// Compatibility exports for extensions that imported the old names. Runtime
// and Designer code use boundsForPanel({ mode, preset, panel }) instead.
export const QUESTION_DESIGNER_BOUNDS: DesignerBounds = boundsForPanel({ mode: "interview", preset: "minimal", panel: "question" });
export const ANSWER_DESIGNER_BOUNDS: DesignerBounds = boundsForPanel({ mode: "interview", preset: "minimal", panel: "answer" });
export const CONTROL_BAR_DESIGNER_BOUNDS: DesignerBounds = boundsForPanel({ mode: "interview", preset: "classic_split", panel: "controlBar" });

function clampDimension(value: number, minimum: number, maximum: number, canvasMaximum: number): number {
  const upperBound = Math.min(maximum, Math.max(minimum, canvasMaximum));
  return Math.max(minimum, Math.min(upperBound, value));
}

export function clampDesignerSize(rect: DesignerRect, canvas: DesignerCanvas, bounds: DesignerBounds): DesignerRect {
  const width = clampDimension(rect.width, bounds.minimumWidth, bounds.maximumWidth, canvas.width);
  const height = clampDimension(rect.height, bounds.minimumHeight, bounds.maximumHeight, canvas.height);
  return { ...rect, width, height };
}

/** Clamp only position; valid dimensions are carried through unchanged. */
export function clampDesignerPosition(rect: DesignerRect, canvas: DesignerCanvas, bounds: DesignerBounds, visibleMargin = 40): DesignerRect {
  const sized = clampDesignerSize(rect, canvas, bounds);
  return {
    ...sized,
    x: Math.round(Math.max(visibleMargin - sized.width, Math.min(rect.x, canvas.width - visibleMargin))),
    y: Math.round(Math.max(visibleMargin - sized.height, Math.min(rect.y, canvas.height - visibleMargin)))
  };
}

export function clampDesignerRect(rect: DesignerRect, canvas: DesignerCanvas, bounds: DesignerBounds, visibleMargin = 40): DesignerRect {
  return clampDesignerPosition(rect, canvas, bounds, visibleMargin);
}

function snapValue(value: number, targets: number[], threshold: number): number {
  const target = targets.find((candidate) => Math.abs(candidate - value) <= threshold);
  return target === undefined ? value : target;
}

export function snapDesignerRect(context: DesignerGeometryContext, rect: DesignerRect, layout: DesignerLayout, canvas: DesignerCanvas, threshold = 12, altPressed = false): DesignerRect {
  const bounds = boundsForPanel(context);
  if (altPressed) return clampDesignerPosition(rect, canvas, bounds);
  const panel = context.panel;
  const others = Object.entries(layout).filter(([key]) => key !== panel).map(([, value]) => value as DesignerRect);
  const xTargets = [0, canvas.width - rect.width];
  const yTargets = [0, canvas.height - rect.height];
  others.forEach((other) => {
    xTargets.push(other.x, other.x + other.width, other.x - rect.width, other.x + other.width - rect.width);
    yTargets.push(other.y, other.y + other.height, other.y - rect.height, other.y + other.height - rect.height);
  });
  return clampDesignerPosition({ ...rect, x: snapValue(rect.x, xTargets, threshold), y: snapValue(rect.y, yTargets, threshold) }, canvas, bounds);
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

/**
 * Resolve a named layout into work-area-relative preference geometry. The
 * shared resolver owns the actual preset algorithm used by Main and Renderer.
 */
export function resolveOverlayLayoutPreset(preset: LegacyOverlayLayoutPreset | InterviewLayoutPreset, display: DesignerDisplay, current?: Partial<ResolvedOverlayLayout>): ResolvedOverlayLayout {
  const normalized = preset === "compact" ? "compact_split" : preset === "standard" || preset === "dual_screen" ? "classic_split" : preset === "wide" ? "answer_focus" : preset === "transparent" || preset === "custom" ? "minimal" : preset;
  const workArea = { x: display.workArea.x ?? 0, y: display.workArea.y ?? 0, width: Math.max(1, Math.round(display.workArea.width)), height: Math.max(1, Math.round(display.workArea.height)) };
  const orientation = current?.controlBarOrientation ?? "horizontal";
  const resolved = resolveOverlayPresetGeometry({ mode: "interview", preset: normalized as InterviewLayoutPreset, workArea, controlBar: { width: current?.controlBar?.width ?? 440, height: current?.controlBar?.height ?? 44, orientation } });
  const canvas = { width: workArea.width, height: workArea.height };
  const question = clampDesignerRect(toRelativeOverlayBounds(resolved.question, workArea), canvas, boundsForPanel({ mode: "interview", preset: normalized as InterviewLayoutPreset, panel: "question" }));
  const answer = clampDesignerRect(toRelativeOverlayBounds(resolved.answer, workArea), canvas, boundsForPanel({ mode: "interview", preset: normalized as InterviewLayoutPreset, panel: "answer" }));
  const controlBar = clampDesignerRect(toRelativeOverlayBounds(resolved.control, workArea), canvas, boundsForPanel({ mode: "interview", preset: normalized as InterviewLayoutPreset, panel: "controlBar" }));
  const positionMode: OverlayControlBarPositionMode = normalized === "compact_split" ? "top_right" : "top_center";
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

export function resolveWrittenTestLayoutPreset(preset: WrittenTestLayoutPreset, display: DesignerDisplay, current?: Partial<ResolvedOverlayLayout>): ResolvedOverlayLayout {
  const workArea = { x: display.workArea.x ?? 0, y: display.workArea.y ?? 0, width: Math.max(1, Math.round(display.workArea.width)), height: Math.max(1, Math.round(display.workArea.height)) };
  const orientation = current?.controlBarOrientation ?? "horizontal";
  const resolved = resolveOverlayPresetGeometry({ mode: "written_test", preset, workArea, controlBar: { width: current?.controlBar?.width ?? 360, height: current?.controlBar?.height ?? 44, orientation } });
  const canvas = { width: workArea.width, height: workArea.height };
  const questionWindow = clampDesignerRect(toRelativeOverlayBounds(resolved.question, workArea), canvas, boundsForPanel({ mode: "writtenTest", preset, panel: "question" }));
  const answerWindow = clampDesignerRect(toRelativeOverlayBounds(resolved.answer, workArea), canvas, boundsForPanel({ mode: "writtenTest", preset, panel: "answer" }));
  const controlBar = clampDesignerRect(toRelativeOverlayBounds(resolved.control, workArea), canvas, boundsForPanel({ mode: "writtenTest", preset, panel: "controlBar" }));
  return { questionWindow, answerWindow, controlBar, controlBarOrientation: orientation, controlBarPositionMode: "top_center", ...(display.id === undefined ? {} : { displayId: display.id }), ...(display.scaleFactor === undefined ? {} : { scaleFactor: display.scaleFactor }) };
}

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
