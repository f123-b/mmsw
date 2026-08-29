import { useEffect, useState, type JSX } from "react";
import type { OverlayPreferences } from "../../shared/overlay-preferences";
import { DEFAULT_OVERLAY_PREFERENCES } from "../../shared/overlay-preferences";
import { DraggableResizablePanel, type OverlayPanelLayout, type OverlayRootProps } from "./OverlayRoot";

/** ControlWindow deliberately renders only the always-clickable toolbar. */
export function ControlOverlayRoot(props: OverlayRootProps): JSX.Element {
  const [preferences, setPreferences] = useState<OverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [layout, setLayout] = useState<OverlayPanelLayout>(() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, visible: true, collapsed: false, locked: false, opacity: 1 }));
  useEffect(() => {
    let disposed = false;
    void window.interviewCopilot.overlay.getPreferences().then((next) => { if (!disposed && next) setPreferences(next); }).catch(() => undefined);
    const unsubscribe = window.interviewCopilot.events.onOverlayPreferences((next) => { if (!disposed) setPreferences(next); });
    const unsubscribeLayoutEdit = window.interviewCopilot.events.onOverlayLayoutEditMode((enabled) => { if (!disposed) setLayoutEditMode(enabled); });
    const onResize = () => setLayout((current) => ({ ...current, width: window.innerWidth, height: window.innerHeight }));
    window.addEventListener("resize", onResize);
    return () => { disposed = true; unsubscribe(); unsubscribeLayoutEdit(); window.removeEventListener("resize", onResize); };
  }, []);
  const modeLabel = props.operationMode === "WRITTEN_TEST" ? "笔试" : "面试";
  const statusLabel = !props.hudState.running ? "未开始" : props.answerStreaming ? "正在生成" : props.answerText ? "回答已就绪" : "正在听取";
  return <main className="overlay-root control-overlay-root" data-overlay-surface="control" data-hud-state={statusLabel}>
    {preferences.showToolbar && <DraggableResizablePanel panel="toolbar" nativePanel="control" layout={layout} onChange={(_panel, patch) => setLayout((current) => ({ ...current, ...patch }))} onCommit={() => undefined} editMode={layoutEditMode} className="toolbar-panel">
      <div className="floating-toolbar hud-interactive-region" role="toolbar" aria-label={`${modeLabel}控制栏`}>
        <span className="toolbar-audio-mark" aria-hidden="true">≈</span>
        <div className="toolbar-runtime"><span>{statusLabel}</span></div>
        <span className="toolbar-divider" aria-hidden="true" />
        {!props.hudState.running || props.operationMode === "WRITTEN_TEST" ? null : <div className="toolbar-mode-switch" role="group" aria-label="回答模式"><button className={props.automationMode === "AUTO" ? "selected" : ""} onClick={() => { if (props.automationMode !== "AUTO") void props.onToggleAutomation(); }}>自动</button><button className={props.automationMode === "MANUAL" ? "selected" : ""} onClick={() => { if (props.automationMode !== "MANUAL") void props.onToggleAutomation(); }}>手动</button></div>}
        {preferences.showTranscript && <button className="toolbar-inline-action" onClick={props.onToggleTranscript} aria-label="显示或隐藏问题">问题</button>}
        {preferences.showAnswer && <button className="toolbar-inline-action" onClick={props.onToggleAnswer} aria-label="显示或隐藏回答">回答</button>}
        <button className="toolbar-inline-action" onClick={props.onToggleShortcuts} aria-label="打开快捷操作">快捷</button>
        <button className="toolbar-end-button" onClick={props.onRequestEndInterview} aria-label={modeLabel === "笔试" ? "结束笔试" : "结束面试"}>结束{modeLabel}</button>
      </div>
    </DraggableResizablePanel>}
  </main>;
}
