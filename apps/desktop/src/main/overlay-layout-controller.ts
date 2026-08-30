import type { OverlayDisplayInfo } from "./overlay-manager";
import type { OverlayPreferences } from "../shared/overlay-preferences";

export type OverlayNativePanel = "question" | "answer" | "control";
export type OverlayContentPanel = "question" | "answer";

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

type OverlayGeometryPreferences = Pick<OverlayPreferences["questionWindow"], "x" | "y" | "width" | "height">;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function clampOverlayBounds(bounds: OverlayNativeBounds, workArea: OverlayNativeBounds, minimumWidth: number, minimumHeight: number): OverlayNativeBounds {
  const width = clamp(Math.round(bounds.width), minimumWidth, Math.max(minimumWidth, workArea.width));
  const height = clamp(Math.round(bounds.height), minimumHeight, Math.max(minimumHeight, workArea.height));
  return {
    width,
    height,
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + Math.max(0, workArea.width - width)),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + Math.max(0, workArea.height - height))
  };
}

export function clampOverlayPanelBounds(panel: OverlayNativePanel, bounds: OverlayNativeBounds, workArea: OverlayNativeBounds): OverlayNativeBounds {
  const minimumWidth = panel === "question" ? 220 : panel === "answer" ? 300 : 120;
  const minimumHeight = panel === "question" ? OVERLAY_CONTENT_LIMITS.question.minHeight : panel === "answer" ? OVERLAY_CONTENT_LIMITS.answer.minHeight : 36;
  return clampOverlayBounds(bounds, workArea, minimumWidth, minimumHeight);
}

export function contentDrivenHeight(panel: OverlayContentPanel, measuredHeight: number): number {
  const limits = OVERLAY_CONTENT_LIMITS[panel];
  return clamp(Math.round(measuredHeight), limits.minHeight, limits.maxHeight);
}

function resolvePanel(panel: OverlayNativePanel, preferences: OverlayGeometryPreferences, defaults: OverlayNativeBounds, workArea: OverlayNativeBounds): OverlayNativeBounds {
  return clampOverlayPanelBounds(panel, {
    x: workArea.x + (preferences.x ?? defaults.x - workArea.x),
    y: workArea.y + (preferences.y ?? defaults.y - workArea.y),
    width: preferences.width,
    height: preferences.height
  }, workArea);
}

/** Converts persisted work-area-relative preferences into safe native bounds. */
export function resolveOverlayNativeBounds(preferences: { questionWindow: OverlayGeometryPreferences; answerWindow: OverlayGeometryPreferences; controlBar: OverlayGeometryPreferences }, options: OverlayLayoutControllerOptions): Record<OverlayNativePanel, OverlayNativeBounds> {
  const workArea = options.display.workArea;
  return {
    question: resolvePanel("question", preferences.questionWindow, options.defaults.question, workArea),
    answer: resolvePanel("answer", preferences.answerWindow, options.defaults.answer, workArea),
    control: resolvePanel("control", preferences.controlBar, options.defaults.control, workArea)
  };
}
