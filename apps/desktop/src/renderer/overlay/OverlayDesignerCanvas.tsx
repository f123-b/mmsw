import { useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import type { OverlayPreferences, OverlayPreferencesPatch } from "../../shared/overlay-preferences";
import type { OverlayDisplayInfo } from "../../main/overlay-manager";
import { OVERLAY_LABELS } from "./overlay-labels";
import { ANSWER_DESIGNER_BOUNDS, CONTROL_BAR_DESIGNER_BOUNDS, QUESTION_DESIGNER_BOUNDS, applyLayoutPreset, boundsForPanel, clampDesignerRect, resolveWrittenTestLayoutPreset, resizeDesignerRectFromPointer, type DesignerCanvas, type DesignerLayout, type DesignerPanel, type DesignerRect, type ResizeHandle } from "./overlay-designer";
import { LayoutInspector } from "./OverlayInspector";

export const DESIGNER_CANVAS: DesignerCanvas = { width: 1920, height: 1080 };
export type OverlayDesignerMode = "interview" | "writtenTest";

function designerLayoutFromPreferences(value: OverlayPreferences, canvas: DesignerCanvas, mode: OverlayDesignerMode): DesignerLayout {
  const source = mode === "writtenTest" ? value.writtenTest : value.interview;
  const resolved = mode === "writtenTest" ? resolveWrittenTestLayoutPreset(value.writtenTest.layoutPreset, { workArea: canvas }) : applyLayoutPreset(value.interview.layoutPreset, { workArea: canvas }, {
    questionWindow: { x: source.questionWindow.x ?? 120, y: source.questionWindow.y ?? 180, width: source.questionWindow.width, height: source.questionWindow.height },
    answerWindow: { x: source.answerWindow.x ?? 570, y: source.answerWindow.y ?? 180, width: source.answerWindow.width, height: source.answerWindow.height },
    controlBar: { x: source.controlBar.x ?? 620, y: source.controlBar.y ?? 24, width: source.controlBar.width, height: source.controlBar.height },
    controlBarOrientation: source.controlBar.orientation,
    controlBarPositionMode: source.controlBar.positionMode
  });
  return { question: resolved.questionWindow, answer: resolved.answerWindow, controlBar: resolved.controlBar };
}

function previewBackgroundStyle(background: OverlayPreferences["previewBackground"], customColor: string): CSSProperties {
  if (background === "light_desktop") return { background: "linear-gradient(135deg,#eef3f7 0%,#dce5ee 48%,#f8fafc 100%)" };
  if (background === "web_page") return { background: "linear-gradient(180deg,#ffffff 0 13%,#dbeafe 13% 19%,#f8fafc 19% 56%,#e8eef5 56% 100%)" };
  if (background === "custom_color") return { background: customColor };
  return { background: "linear-gradient(135deg,#182333 0%,#27364b 48%,#101722 100%)" };
}

function PreviewWindow({ panel, rect, canvas, selected, onSelect, onMove, onResize, onCommit, orientation, children }: { panel: DesignerPanel; rect: DesignerRect; canvas: DesignerCanvas; selected: boolean; onSelect: () => void; onMove: (rect: DesignerRect) => void; onResize: (rect: DesignerRect) => void; onCommit: () => void; orientation?: OverlayPreferences["interview"]["controlBar"]["orientation"]; children: JSX.Element }): JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ clientX: number; clientY: number; rect: DesignerRect; handle?: ResizeHandle } | undefined>(undefined);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupRef.current?.(), []);
  const bounds = boundsForPanel(panel);
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, .desktop-preview-resize-handle")) return;
    event.stopPropagation();
    onSelect();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    startRef.current = { clientX: event.clientX, clientY: event.clientY, rect: { ...rect } };
    const move = (next: PointerEvent) => { const frame = frameRef.current?.parentElement; const start = startRef.current; if (!frame || !start) return; onMove(clampDesignerRect({ ...start.rect, x: start.rect.x + (next.clientX - start.clientX) * canvas.width / Math.max(1, frame.clientWidth), y: start.rect.y + (next.clientY - start.clientY) * canvas.height / Math.max(1, frame.clientHeight) }, canvas, bounds)); };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); cleanupRef.current = undefined; startRef.current = undefined; onCommit(); };
    cleanupRef.current = end;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true }); window.addEventListener("blur", end, { once: true });
  };
  const beginResize = (handle: ResizeHandle, event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onSelect();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    startRef.current = { clientX: event.clientX, clientY: event.clientY, rect: { ...rect }, handle };
    const move = (next: PointerEvent) => { const frame = frameRef.current?.parentElement; const start = startRef.current; if (!frame || !start?.handle) return; onResize(resizeDesignerRectFromPointer(start.rect, start.handle, { x: start.clientX, y: start.clientY }, { x: next.clientX, y: next.clientY }, { width: frame.clientWidth, height: frame.clientHeight }, canvas, bounds)); };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); cleanupRef.current = undefined; startRef.current = undefined; onCommit(); };
    cleanupRef.current = end;
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true }); window.addEventListener("blur", end, { once: true });
  };
  const style: CSSProperties = { left: `${rect.x / canvas.width * 100}%`, top: `${rect.y / canvas.height * 100}%`, width: `${rect.width / canvas.width * 100}%`, height: `${rect.height / canvas.height * 100}%` };
  return <div ref={frameRef} className={`desktop-preview-window preview-window-${panel} ${selected ? "is-selected" : ""} ${orientation === "vertical" ? "preview-window-vertical" : ""}`} style={style} data-preview-panel={panel} onPointerDown={beginDrag}>{children}{selected && ( ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as ResizeHandle[]).map((handle) => <div key={handle} className={`desktop-preview-resize-handle desktop-preview-resize-${handle}`} onPointerDown={(event) => beginResize(handle, event)} />)}</div>;
}

function previewContent(panel: DesignerPanel, mode: OverlayDesignerMode): JSX.Element {
  if (panel === "question") return <><span className="preview-window-kicker">{mode === "writtenTest" ? "截图题目" : OVERLAY_LABELS.questionNavigator}</span><strong>{mode === "writtenTest" ? "截图识别的问题" : "CAN 总线是什么？"}</strong><small>窗口稳定 · 内容内部滚动</small></>;
  if (panel === "answer") return <><span className="preview-window-kicker">{OVERLAY_LABELS.answerReader}</span><strong>AI 回答</strong><p>CAN 采用基于 ID 的逐位仲裁，显性位会覆盖隐性位。</p><p>回答会继续追加到答案栈。</p></>;
  return <><span className="preview-control-dot">◈</span><span>00:24</span><span>回答中</span></>;
}

export function OverlayDesignerCanvas({ value, mode = "interview", onChange, displays = [], activeDisplay }: { value: OverlayPreferences; mode?: OverlayDesignerMode; onChange: (patch: OverlayPreferencesPatch) => void; displays?: OverlayDisplayInfo[]; activeDisplay?: OverlayDisplayInfo }): JSX.Element {
  const [selected, setSelected] = useState<DesignerPanel>("question");
  const [screenSize, setScreenSize] = useState<DesignerCanvas>(() => activeDisplay ? { width: activeDisplay.workArea.width, height: activeDisplay.workArea.height } : DESIGNER_CANVAS);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | undefined>(activeDisplay?.id);
  const [zoom, setZoom] = useState<"fit" | 0.5 | 0.75 | 1 | 1.25>("fit");
  const [layout, setLayout] = useState<DesignerLayout>(() => designerLayoutFromPreferences(value, screenSize, mode));
  const layoutRef = useRef(layout);
  const draggingRef = useRef(false);
  useEffect(() => { if (!draggingRef.current) { const next = designerLayoutFromPreferences(value, screenSize, mode); layoutRef.current = next; setLayout(next); } }, [mode, screenSize.width, screenSize.height, value.interview.layoutPreset, value.interview.questionWindow.x, value.interview.questionWindow.y, value.interview.questionWindow.width, value.interview.questionWindow.height, value.interview.answerWindow.x, value.interview.answerWindow.y, value.interview.answerWindow.width, value.interview.answerWindow.height, value.interview.controlBar.x, value.interview.controlBar.y, value.interview.controlBar.width, value.interview.controlBar.height, value.interview.controlBar.orientation, value.interview.controlBar.positionMode, value.writtenTest.layoutPreset, value.writtenTest.questionWindow.x, value.writtenTest.questionWindow.y, value.writtenTest.questionWindow.width, value.writtenTest.questionWindow.height, value.writtenTest.answerWindow.x, value.writtenTest.answerWindow.y, value.writtenTest.answerWindow.width, value.writtenTest.answerWindow.height, value.writtenTest.controlBar.x, value.writtenTest.controlBar.y, value.writtenTest.controlBar.width, value.writtenTest.controlBar.height, value.writtenTest.controlBar.orientation, value.writtenTest.controlBar.positionMode]);
  useEffect(() => { if (!activeDisplay) return; setSelectedDisplayId(activeDisplay.id); setScreenSize({ width: activeDisplay.workArea.width, height: activeDisplay.workArea.height }); }, [activeDisplay?.id, activeDisplay?.workArea.width, activeDisplay?.workArea.height]);
  const updateLayout = (next: DesignerLayout) => { draggingRef.current = true; layoutRef.current = next; setLayout(next); };
  const commit = () => { draggingRef.current = false; const next = layoutRef.current; const currentControl = mode === "writtenTest" ? value.writtenTest.controlBar : value.interview.controlBar; const leftWindow = { x: next.question.x, y: next.question.y, width: next.question.width, height: next.question.height }; const section = { questionWindow: leftWindow, ...(mode === "interview" ? { dialogueWindow: leftWindow } : {}), answerWindow: { x: next.answer.x, y: next.answer.y, width: next.answer.width, height: next.answer.height }, controlBar: { x: next.controlBar.x, y: next.controlBar.y, width: next.controlBar.width, height: next.controlBar.height, positionMode: "custom" as const, orientation: currentControl.orientation } }; onChange({ [mode]: section } as OverlayPreferencesPatch); };
  const movePanel = (panel: DesignerPanel, next: DesignerRect) => updateLayout({ ...layoutRef.current, [panel]: next });
  const selectedRect = layout[selected];
  const selectedBounds = boundsForPanel(selected);
  const editSelectedGeometry = (patch: Partial<DesignerRect>) => { const next = { ...layoutRef.current, [selected]: clampDesignerRect({ ...layoutRef.current[selected], ...patch }, screenSize, selectedBounds) }; updateLayout(next); commit(); };
  const displayOptions = displays.length ? displays : [{ id: -1, bounds: { x: 0, y: 0, width: DESIGNER_CANVAS.width, height: DESIGNER_CANVAS.height }, workArea: DESIGNER_CANVAS, scaleFactor: 1 }];
  const renderCanvas = (large = false): JSX.Element => { const zoomScale = zoom === "fit" ? 1 : zoom; const panels: DesignerPanel[] = mode === "writtenTest" && value.writtenTest.layoutPreset === "single_reader" ? ["question", "controlBar"] : ["question", "answer", "controlBar"]; const orientation = mode === "writtenTest" ? value.writtenTest.controlBar.orientation : value.interview.controlBar.orientation; return <div className={`desktop-preview-frame ${large ? "desktop-preview-frame-large" : ""}`} style={previewBackgroundStyle(value.previewBackground, value.previewCustomColor)} data-preview-background={value.previewBackground} data-preview-mode={mode}><div className="desktop-preview-browser-chrome"><span /><span /><span /><small>{screenSize.width} × {screenSize.height} · 设计坐标</small></div><div className="desktop-preview-canvas-viewport"><div className="desktop-preview-canvas" style={{ aspectRatio: `${screenSize.width} / ${screenSize.height}`, width: `${zoomScale * 100}%` }}>{panels.map((panel) => <PreviewWindow key={panel} panel={panel} rect={layout[panel]} canvas={screenSize} selected={selected === panel} onSelect={() => setSelected(panel)} onMove={(rect) => movePanel(panel, rect)} onResize={(rect) => movePanel(panel, rect)} onCommit={commit} orientation={panel === "controlBar" ? orientation : undefined}>{previewContent(panel, mode)}</PreviewWindow>)}</div></div></div>; };
  return <div className="desktop-preview-shell"><div className="desktop-preview-heading"><div><span className="page-kicker">{OVERLAY_LABELS.currentDisplay}</span><strong>桌面效果预览</strong><small>同一份悬浮窗布局数据用于小画布、桌面调整和面试运行。</small></div><div className="desktop-preview-heading-actions"><select aria-label="选择显示器" value={selectedDisplayId ?? displayOptions[0].id} onChange={(event) => { const next = displayOptions.find((display) => display.id === Number(event.target.value)); if (next) { setSelectedDisplayId(next.id); setScreenSize({ width: next.workArea.width, height: next.workArea.height }); } }}><option value={displayOptions[0].id}>{displays.length ? "选择显示器" : "模拟显示器"}</option>{displayOptions.filter((display) => display.id !== displayOptions[0].id || displays.length).map((display, index) => <option value={display.id} key={display.id}>显示器 {index + 1} · {display.workArea.width}×{display.workArea.height} · {Math.round(display.scaleFactor * 100)}%</option>)}</select></div></div><div className="desktop-preview-background-switcher">{([ ["light_desktop", "浅色桌面"], ["dark_ide", "深色 IDE"], ["web_page", "网页"], ["custom_color", "自定义"] ] as const).map(([key, label]) => <button key={key} type="button" className={value.previewBackground === key ? "selected" : ""} onClick={() => onChange({ previewBackground: key })}>{label}</button>)}{value.previewBackground === "custom_color" && <input type="color" aria-label="预览自定义背景色" value={value.previewCustomColor} onChange={(event) => onChange({ previewCustomColor: event.target.value })} />}</div><div className="desktop-preview-background-switcher"><span className="preview-tool-label">编辑对象</span>{([ ["controlBar", "控制栏"], ["question", "问题导航"], ["answer", "答案阅读器"] ] as const).map(([panel, label]) => <button key={panel} type="button" className={selected === panel ? "selected" : ""} onClick={() => setSelected(panel)}>{selected === panel ? "● " : "○ "}{label}</button>)}<span className="preview-tool-label">画布缩放</span>{([ [0.5, "50%"], [0.75, "75%"], [1, "100%"], [1.25, "125%"], ["fit", "适应窗口"] ] as const).map(([key, label]) => <button key={String(key)} type="button" className={zoom === key ? "selected" : ""} onClick={() => setZoom(key as typeof zoom)}>{label}</button>)}</div>{renderCanvas()}<LayoutInspector panel={selected} rect={selectedRect} bounds={selectedBounds} onChange={editSelectedGeometry} /><div className="desktop-preview-legend"><small>可拖动 · 八方向 resize · 释放后提交到 OverlayPreferences</small></div></div>;
}
