import type { MouseInteractionMode, OverlayControlBarPositionMode, OverlayControlBarOrientation, WheelRoutingMode } from "../../shared/overlay-preferences";

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

export type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export const QUESTION_DESIGNER_BOUNDS: DesignerBounds = { minimumWidth: 220, maximumWidth: 1_000, minimumHeight: 120, maximumHeight: 1_200 };
export const ANSWER_DESIGNER_BOUNDS: DesignerBounds = { minimumWidth: 300, maximumWidth: 1_600, minimumHeight: 150, maximumHeight: 1_200 };
export const CONTROL_BAR_DESIGNER_BOUNDS: DesignerBounds = { minimumWidth: 120, maximumWidth: 2_000, minimumHeight: 36, maximumHeight: 240 };

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

export function mapPreviewPointToCanvas(point: DesignerPoint, preview: DesignerCanvas, canvas: DesignerCanvas): DesignerPoint {
  return { x: Math.round(point.x * canvas.width / Math.max(1, preview.width)), y: Math.round(point.y * canvas.height / Math.max(1, preview.height)) };
}

export function interactionModeAllowsOverlayInput(mode: MouseInteractionMode, temporaryInteractive: boolean, layoutEditMode: boolean): boolean {
  return layoutEditMode || temporaryInteractive || mode === "interactive";
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
