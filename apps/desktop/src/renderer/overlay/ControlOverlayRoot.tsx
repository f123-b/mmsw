import { useEffect, useState, type JSX } from "react";
import type { OverlayPreferences } from "../../shared/overlay-preferences";
import { DEFAULT_OVERLAY_PREFERENCES } from "../../shared/overlay-preferences";
import { DraggableResizablePanel, type OverlayPanelLayout, type OverlayRootProps } from "./OverlayRoot";
import { primaryRuntimeStatus } from "./runtime-state";

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
    window.interviewCopilot.diagnostics.markRendererReady();
    return () => { disposed = true; unsubscribe(); unsubscribeLayoutEdit(); window.removeEventListener("resize", onResize); };
  }, []);
  const modeLabel = props.operationMode === "WRITTEN_TEST" ? "笔试" : "面试";
  const interviewMode = props.operationMode !== "WRITTEN_TEST";
  const interviewPreferences = preferences.interview;
  const writtenPreferences = preferences.writtenTest;
  const statusLabel = primaryRuntimeStatus(props.runtimePhases);
  const answerReady = props.runtimePhases.answerPhase === "READY";
  return <main className="overlay-root control-overlay-root" data-overlay-surface="control" data-hud-state={statusLabel} data-operation-mode={props.operationMode}>
    {preferences.showToolbar && <DraggableResizablePanel panel="toolbar" nativePanel="control" layout={layout} onChange={(_panel, patch) => setLayout((current) => ({ ...current, ...patch }))} onCommit={() => undefined} editMode={layoutEditMode} className="toolbar-panel">
      <div className="floating-toolbar hud-interactive-region" role="toolbar" aria-label={`${modeLabel}控制栏`}>
        <span className="toolbar-audio-mark" aria-hidden="true">≈</span>
        <div className="toolbar-status-inline" data-testid="toolbar-status"><i aria-hidden="true" /><span>{statusLabel}</span></div>
        <span className="toolbar-divider" aria-hidden="true" />
        {!props.hudState.running || !interviewMode ? <button className="toolbar-screenshot-action" onClick={() => void props.onAnswerScreenshot()} title="截图识别并回答">截图</button> : <div className="toolbar-mode-switch" role="group" aria-label="回答模式"><button className={props.automationMode === "AUTO" ? "selected" : ""} onClick={() => { if (props.automationMode !== "AUTO") void props.onToggleAutomation(); }}>自动</button><button className={props.automationMode === "MANUAL" ? "selected" : ""} onClick={() => { if (props.automationMode !== "MANUAL") void props.onToggleAutomation(); }}>手动</button></div>}
        {answerReady && <span className="toolbar-answer-ready-dot" title="回答已就绪" aria-label="回答已就绪" />}
        {interviewMode && interviewPreferences.leftPanel !== "hidden" && <button className="toolbar-icon-action" onClick={props.onToggleTranscript} title="显示或隐藏左侧面板" aria-label="显示或隐藏左侧面板" aria-pressed={props.hudState.transcriptVisible}>◫</button>}
        {interviewMode && interviewPreferences.showAnswer && <button className="toolbar-icon-action" onClick={props.onToggleAnswer} title="显示或隐藏回答" aria-label="显示或隐藏回答" aria-pressed={props.hudState.answerVisible}>◧</button>}
        {!interviewMode && writtenPreferences.layoutPreset === "split" && <button className="toolbar-icon-action" onClick={props.onToggleAnswer} title="显示或隐藏回答" aria-label="显示或隐藏回答" aria-pressed={props.hudState.answerVisible}>◧</button>}
        <button className="toolbar-icon-action" onClick={props.onToggleShortcuts} title="打开快捷操作" aria-label="打开快捷操作">…</button>
        <button className="toolbar-end-button" onClick={props.onRequestEndInterview} title={`结束${modeLabel} Ctrl+Alt+Q`} aria-label={`结束${modeLabel}`}>结束</button>
      </div>
    </DraggableResizablePanel>}
  </main>;
}
