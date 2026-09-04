import type { OverlayDisplayInfo } from "./overlay-manager";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../shared/overlay-preferences";
import { resolveOverlayGeometryConstraints, resolveOverlayPersistedGeometry, type OverlayLayoutBounds, type OverlayLayoutMode } from "../shared/overlay-layout";

export type OverlayNativePanel = "question" | "answer" | "script" | "control";
export type OverlayContentPanel = "question" | "answer";
export type OverlayRuntimeLayoutMode = OverlayLayoutMode;
export type OverlayNativeBounds = OverlayLayoutBounds;

export interface OverlayLayoutControllerOptions {
  display: Pick<OverlayDisplayInfo, "workArea">;
  /** Kept for callers that still provide HUD defaults; shared geometry is now canonical. */
  defaults: { question: OverlayNativeBounds; answer: OverlayNativeBounds; control: OverlayNativeBounds };
}

export const OVERLAY_CONTENT_LIMITS: Record<OverlayContentPanel, { minHeight: number; maxHeight: number }> = {
  question: { minHeight: resolveOverlayGeometryConstraints({ mode: "interview", preset: "minimal", panel: "question" }).minHeight, maxHeight: resolveOverlayGeometryConstraints({ mode: "interview", preset: "minimal", panel: "question" }).maxHeight },
    answer: { minHeight: resolveOverlayGeometryConstraints({ mode: "interview", preset: "minimal", panel: "answer" }).minHeight, maxHeight: resolveOverlayGeometryConstraints({ mode: "interview", preset: "minimal", panel: "answer" }).maxHeight }
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function clampOverlayBounds(bounds: OverlayNativeBounds, workArea: OverlayNativeBounds, constraints: { minWidth: number; maxWidth: number; minHeight: number; maxHeight: number }): OverlayNativeBounds {
  const width = clamp(Math.round(bounds.width), constraints.minWidth, Math.min(constraints.maxWidth, Math.max(constraints.minWidth, workArea.width)));
  const height = clamp(Math.round(bounds.height), constraints.minHeight, Math.min(constraints.maxHeight, Math.max(constraints.minHeight, workArea.height)));
  return { width, height, x: clamp(Math.round(bounds.x), workArea.x, workArea.x + Math.max(0, workArea.width - width)), y: clamp(Math.round(bounds.y), workArea.y, workArea.y + Math.max(0, workArea.height - height)) };
}

export function clampOverlayPanelBounds(panel: OverlayNativePanel, bounds: OverlayNativeBounds, workArea: OverlayNativeBounds, mode: OverlayRuntimeLayoutMode = "interview", preset: OverlayPreferences["interview"]["layoutPreset"] | OverlayPreferences["writtenTest"]["layoutPreset"] = "classic_split"): OverlayNativeBounds {
  return clampOverlayBounds(bounds, workArea, resolveOverlayGeometryConstraints({ mode, preset, panel: panel === "control" ? "control" : panel }));
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
    scriptWindow: mode === "interview" ? preferences.interview.scriptWindow : undefined,
    controlBar: modePreferences.controlBar
  });
}

export function layoutGeometryForMode(preferences: OverlayPreferences, mode: OverlayRuntimeLayoutMode, workArea: OverlayNativeBounds, defaults: OverlayLayoutControllerOptions["defaults"]): Record<OverlayNativePanel, OverlayNativeBounds> {
  return resolveOverlayNativeBounds(preferences, { display: { workArea }, defaults }, mode);
}

export { DEFAULT_OVERLAY_PREFERENCES };
