import type { OverlayPreferencesPatch } from "../../shared/overlay-preferences";
import { boundsForPanel, resizeDesignerRect, type DesignerCanvas, type DesignerPanel, type DesignerRect, type ResizeHandle } from "./overlay-designer";

const HANDLE_CLASS = /^desktop-preview-resize-(n|ne|e|se|s|sw|w|nw)$/;

function percentage(value: string): number | undefined {
  if (!value.endsWith("%")) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed / 100 : undefined;
}

function logicalCanvas(frame: HTMLElement): DesignerCanvas {
  const label = frame.querySelector<HTMLElement>(".desktop-preview-browser-chrome small")?.textContent ?? "";
  const match = label.match(/(\d+)\s*[×x]\s*(\d+)/i);
  if (match) return { width: Math.max(1, Number(match[1])), height: Math.max(1, Number(match[2])) };
  return { width: 1920, height: 1080 };
}

function logicalRect(element: HTMLElement, canvasElement: HTMLElement, canvas: DesignerCanvas): DesignerRect {
  const left = percentage(element.style.left);
  const top = percentage(element.style.top);
  const width = percentage(element.style.width);
  const height = percentage(element.style.height);
  if (left !== undefined && top !== undefined && width !== undefined && height !== undefined) {
    return {
      x: left * canvas.width,
      y: top * canvas.height,
      width: width * canvas.width,
      height: height * canvas.height
    };
  }

  const canvasBounds = canvasElement.getBoundingClientRect();
  const elementBounds = element.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(1, canvasBounds.width);
  const scaleY = canvas.height / Math.max(1, canvasBounds.height);
  return {
    x: (elementBounds.left - canvasBounds.left) * scaleX,
    y: (elementBounds.top - canvasBounds.top) * scaleY,
    width: elementBounds.width * scaleX,
    height: elementBounds.height * scaleY
  };
}

function renderRect(element: HTMLElement, rect: DesignerRect, canvas: DesignerCanvas): void {
  element.style.left = `${rect.x / canvas.width * 100}%`;
  element.style.top = `${rect.y / canvas.height * 100}%`;
  element.style.width = `${rect.width / canvas.width * 100}%`;
  element.style.height = `${rect.height / canvas.height * 100}%`;
}

function panelPatch(panel: DesignerPanel, rect: DesignerRect): OverlayPreferencesPatch {
  const geometry = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
  if (panel === "question") return { layoutPreset: "custom", questionWindow: geometry };
  if (panel === "answer") return { layoutPreset: "custom", answerWindow: geometry };
  return { layoutPreset: "custom", controlBar: { ...geometry, positionMode: "custom" } };
}

/**
 * Installs a narrow compatibility fix for the settings preview.
 *
 * The React preview currently reports a cumulative pointer delta but applies it
 * to the already-resized rectangle on every pointermove. A long drag therefore
 * accelerates and becomes difficult to control. This capture-phase handler
 * keeps the pointer-down rectangle immutable, applies cumulative delta exactly
 * once, and persists only the final geometry. It can be removed when the
 * preview component is split out of App.tsx and owns the same start-rect logic.
 */
export function installPreviewResizeFix(): () => void {
  if (new URLSearchParams(window.location.search).get("window") === "overlay") return () => undefined;

  const onPointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof HTMLElement) || event.button !== 0) return;
    const handleElement = event.target.closest<HTMLElement>(".desktop-preview-resize-handle");
    if (!handleElement) return;
    const handleClass = Array.from(handleElement.classList).find((value) => HANDLE_CLASS.test(value));
    const handleMatch = handleClass?.match(HANDLE_CLASS);
    if (!handleMatch) return;

    const previewWindow = handleElement.closest<HTMLElement>(".desktop-preview-window");
    const canvasElement = previewWindow?.closest<HTMLElement>(".desktop-preview-canvas");
    const frame = previewWindow?.closest<HTMLElement>(".desktop-preview-frame");
    const rawPanel = previewWindow?.dataset.previewPanel;
    if (!previewWindow || !canvasElement || !frame || (rawPanel !== "question" && rawPanel !== "answer" && rawPanel !== "controlBar")) return;

    const panel = rawPanel as DesignerPanel;
    const handle = handleMatch[1] as ResizeHandle;
    const canvas = logicalCanvas(frame);
    const canvasBounds = canvasElement.getBoundingClientRect();
    const startRect = logicalRect(previewWindow, canvasElement, canvas);
    const startPoint = { x: event.clientX, y: event.clientY };
    let latest = startRect;
    let finished = false;

    event.preventDefault();
    event.stopImmediatePropagation();
    try { handleElement.setPointerCapture(event.pointerId); } catch { /* best effort */ }

    const onMove = (next: PointerEvent): void => {
      const delta = {
        x: (next.clientX - startPoint.x) * canvas.width / Math.max(1, canvasBounds.width),
        y: (next.clientY - startPoint.y) * canvas.height / Math.max(1, canvasBounds.height)
      };
      latest = resizeDesignerRect(startRect, handle, delta, canvas, boundsForPanel(panel), next.altKey);
      renderRect(previewWindow, latest, canvas);
      next.preventDefault();
      next.stopImmediatePropagation();
    };

    const finish = (next: PointerEvent): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", onBlur, true);
      next.preventDefault();
      next.stopImmediatePropagation();
      void window.interviewCopilot.overlay.setPreferences(panelPatch(panel, latest));
    };

    const onBlur = (): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", onBlur, true);
      void window.interviewCopilot.overlay.setPreferences(panelPatch(panel, latest));
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", onBlur, true);
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  return () => document.removeEventListener("pointerdown", onPointerDown, true);
}
