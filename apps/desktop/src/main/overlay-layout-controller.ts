import type { OverlayDisplayInfo } from "./overlay-manager";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../shared/overlay-preferences";
import { resolveOverlayPersistedGeometry, type OverlayLayoutBounds, type OverlayLayoutMode } from "../shared/overlay-layout";

export type OverlayNativePanel = "question" | "answer" | "control";
export type OverlayContentPanel = "question" | "answer";
export type OverlayRuntimeLayoutMode = OverlayLayoutMode;
export type OverlayNativeBounds = OverlayLayoutBounds;

export interface OverlayLayoutControllerOptions {
  display: Pick<OverlayDisplayInfo, "workArea">;
  /** Kept for callers that still provide HUD defaults; shared geometry is now canonical. */
  defaults: { question: OverlayNativeBounds; answer: OverlayNativeBounds; control: OverlayNativeBounds };
}

export const OVERLAY_CONTENT_LIMITS: Record<OverlayContentPanel, { minHeight: number; maxHeight: number }> = {
  question: { minHeight: 88, maxHeight: 280 },
  answer: { minHeight: 132, maxHeight: 440 }
};

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
  const minimumHeight = panel === "control" ? 36 : 220;
  return clampOverlayBounds(bounds, workArea, minimumWidth, minimumHeight);
}

export function contentDrivenHeight(panel: OverlayContentPanel, measuredHeight: number): number {
  const limits = OVERLAY_CONTENT_LIMITS[panel];
  return clamp(Math.round(measuredHeight), limits.minHeight, limits.maxHeight);
}

/** Main-process adapter over the shared Main/Renderer geometry resolver. */
export function resolveOverlayNativeBounds(preferences: OverlayPreferences, options: OverlayLayoutControllerOptions, mode: OverlayRuntimeLayoutMode = "interview"): Record<OverlayNativePanel, OverlayNativeBounds> {
  const workArea = options.display.workArea;
  const modePreferences = mode === "written_test" ? preferences.writtenTest : preferences.interview;
  const questionWindow = mode === "written_test" ? preferences.writtenTest.questionWindow : preferences.interview.questionWindow;
  return resolveOverlayPersistedGeometry({
    mode,
    preset: modePreferences.layoutPreset,
    workArea,
    questionWindow,
    answerWindow: modePreferences.answerWindow,
    controlBar: modePreferences.controlBar
  });
}

export function layoutGeometryForMode(preferences: OverlayPreferences, mode: OverlayRuntimeLayoutMode, workArea: OverlayNativeBounds, defaults: OverlayLayoutControllerOptions["defaults"]): Record<OverlayNativePanel, OverlayNativeBounds> {
  return resolveOverlayNativeBounds(preferences, { display: { workArea }, defaults }, mode);
}

export { DEFAULT_OVERLAY_PREFERENCES };
