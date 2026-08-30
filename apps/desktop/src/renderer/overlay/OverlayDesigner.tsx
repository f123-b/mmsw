import { useEffect, useState, type JSX } from "react";
import type { OverlayDisplayInfo } from "../../main/overlay-manager";
import type { InterviewLayoutPreset, OverlayPreferences, OverlayPreferencesPatch, WrittenTestLayoutPreset } from "../../shared/overlay-preferences";
import { applyLayoutPreset, resolveWrittenTestLayoutPreset } from "./overlay-designer";
import { DesignerNumberField, DesignerOpacityField } from "./OverlayInspector";
import { OverlayDesignerCanvas, DESIGNER_CANVAS, type OverlayDesignerMode } from "./OverlayDesignerCanvas";

const INTERVIEW_PRESETS: Array<[InterviewLayoutPreset, string, string]> = [
  ["classic_split", "经典双栏", "Control · 左侧问题 · 右侧回答"],
  ["compact_split", "紧凑双栏", "更窄的左窗和回答区"],
  ["answer_focus", "回答优先", "扩大回答阅读区"],
  ["minimal", "极简悬浮", "内容驱动的小窗"]
];
const WRITTEN_PRESETS: Array<[WrittenTestLayoutPreset, string, string]> = [
  ["single_reader", "单阅读器", "题目与回答在同一窗口"],
  ["split", "左右分栏", "左题目 · 右回答"]
];

export function OverlayDesigner({ value, onChange, onReset }: { value: OverlayPreferences; onChange: (patch: OverlayPreferencesPatch) => void; onReset: () => void }): JSX.Element {
  const [displays, setDisplays] = useState<OverlayDisplayInfo[]>([]);
  const [designMode, setDesignMode] = useState<OverlayDesignerMode>("interview");
  useEffect(() => { void window.interviewCopilot.overlay.getDisplays().then(setDisplays).catch(() => setDisplays([])); }, []);
  useEffect(() => () => { void window.interviewCopilot.overlay.finishLayoutEditMode(); }, []);
  const selectedDisplayId = designMode === "interview" ? value.interview.questionWindow.displayId : value.writtenTest.questionWindow.displayId;
  const activeDisplay = displays.find((display) => display.id === selectedDisplayId) ?? displays[0];
  const display = activeDisplay ?? { id: undefined, workArea: DESIGNER_CANVAS, bounds: { ...DESIGNER_CANVAS }, scaleFactor: 1 };
  const setBehavior = (patch: Partial<OverlayPreferences["behavior"]>) => onChange({ behavior: patch });
  const setAppearance = (patch: Partial<OverlayPreferences["appearance"]>) => onChange({ appearance: patch });
  const applyInterviewPreset = (preset: InterviewLayoutPreset) => {
    const current = value.interview;
    const resolved = applyLayoutPreset(preset, display, { questionWindow: { x: current.questionWindow.x ?? 120, y: current.questionWindow.y ?? 180, width: current.questionWindow.width, height: current.questionWindow.height }, answerWindow: { x: current.answerWindow.x ?? 570, y: current.answerWindow.y ?? 180, width: current.answerWindow.width, height: current.answerWindow.height }, controlBar: { x: current.controlBar.x ?? 620, y: current.controlBar.y ?? 24, width: current.controlBar.width, height: current.controlBar.height }, controlBarOrientation: current.controlBar.orientation, controlBarPositionMode: current.controlBar.positionMode });
    const displayFields = resolved.displayId === undefined ? {} : { displayId: resolved.displayId, scaleFactor: resolved.scaleFactor };
    onChange({ interview: { layoutPreset: preset, questionWindow: { ...resolved.questionWindow, ...displayFields }, dialogueWindow: { ...current.dialogueWindow, ...resolved.questionWindow, ...displayFields }, answerWindow: { ...resolved.answerWindow, ...displayFields }, controlBar: { ...resolved.controlBar, ...displayFields, positionMode: resolved.controlBarPositionMode, orientation: resolved.controlBarOrientation } } });
  };
  const applyWrittenPreset = (preset: WrittenTestLayoutPreset) => {
    const current = value.writtenTest;
    const resolved = resolveWrittenTestLayoutPreset(preset, display);
    const displayFields = resolved.displayId === undefined ? {} : { displayId: resolved.displayId, scaleFactor: resolved.scaleFactor };
    onChange({ writtenTest: { layoutPreset: preset, questionWindow: { ...resolved.questionWindow, ...displayFields }, answerWindow: { ...resolved.answerWindow, ...displayFields }, controlBar: { ...resolved.controlBar, ...displayFields, positionMode: resolved.controlBarPositionMode, orientation: resolved.controlBarOrientation } } });
  };
  const writtenShowAnswerControl = value.writtenTest.layoutPreset === "split"
    ? <section className="designer-section"><label className="designer-check-row"><input type="checkbox" checked={value.writtenTest.showAnswer} onChange={(event) => onChange({ writtenTest: { showAnswer: event.target.checked } })} /><span><strong>显示回答窗口</strong><small>分栏布局允许单独隐藏回答窗口</small></span></label></section>
    : <section className="designer-section"><p className="designer-inline-note">单阅读器：回答显示在题目窗口内，无独立回答窗口开关。</p></section>;
  const interview = value.interview;
  return <section className="settings-service-card overlay-preferences-card overlay-designer-card">
    <header className="overlay-designer-header"><div><span className="page-kicker">悬浮窗设计器</span><h2>面试与笔试悬浮窗</h2><p>两种工作流分别保存窗口位置和尺寸；运行时窗口稳定，内容在内部滚动。</p></div><button className="outline-pill" onClick={onReset}>恢复布局默认</button></header>
    <div className="overlay-designer-mode-tabs"><button className={designMode === "interview" ? "selected" : ""} onClick={() => setDesignMode("interview")}>面试悬浮窗</button><button className={designMode === "writtenTest" ? "selected" : ""} onClick={() => setDesignMode("writtenTest")}>笔试悬浮窗</button></div>
    {designMode === "interview" ? <aside className="overlay-designer-controls"><section className="designer-section"><div className="designer-section-heading"><div><h3>布局模式</h3><p>默认使用稳定的经典双栏。</p></div></div><div className="designer-preset-card-grid">{INTERVIEW_PRESETS.map(([preset, label, description]) => <button key={preset} type="button" className={`designer-preset-card ${interview.layoutPreset === preset ? "selected" : ""}`} onClick={() => applyInterviewPreset(preset)}><span className={`preset-thumb preset-thumb-${preset}`} aria-hidden="true"><i /><i /></span><strong>{label}</strong><small>{description}</small></button>)}</div><button className="dark-pill designer-edit-real-button" onClick={() => void window.interviewCopilot.overlay.enterLayoutEditMode()}>在桌面上调整</button></section><section className="designer-section"><div className="designer-section-heading"><div><h3>左侧窗口内容</h3><p>布局模式和左窗内容是两个独立设置。</p></div></div><div className="designer-choice-row">{([["dialogue", "对话"], ["question", "问题"], ["hidden", "隐藏"]] as const).map(([mode, label]) => <button key={mode} className={interview.leftPanel === mode ? "selected" : ""} onClick={() => onChange({ interview: { leftPanel: mode } })}>{label}</button>)}</div></section><section className="designer-section"><label className="designer-check-row"><input type="checkbox" checked={interview.showAnswer} onChange={(event) => onChange({ interview: { showAnswer: event.target.checked } })} /><span><strong>显示右侧回答</strong><small>回答窗口始终保持固定高度并在内部滚动</small></span></label></section></aside> : <aside className="overlay-designer-controls"><section className="designer-section"><div className="designer-section-heading"><div><h3>笔试布局</h3><p>笔试只保留截图题目与 AI 回答。</p></div></div><div className="designer-preset-card-grid">{WRITTEN_PRESETS.map(([preset, label, description]) => <button key={preset} type="button" className={`designer-preset-card ${value.writtenTest.layoutPreset === preset ? "selected" : ""}`} onClick={() => applyWrittenPreset(preset)}><span className={`preset-thumb preset-thumb-written-${preset}`} aria-hidden="true"><i /><i /></span><strong>{label}</strong><small>{description}</small></button>)}</div></section>{writtenShowAnswerControl}</aside>}
    <OverlayDesignerCanvas value={value} mode={designMode} onChange={onChange} displays={displays} activeDisplay={activeDisplay} />
    <section className="designer-section designer-common-section"><div className="designer-section-heading"><div><h3>通用交互与外观</h3><p>控制栏保持独立可点击，内容窗口默认穿透。</p></div></div><div className="designer-fields-grid"><label className="designer-select-field"><span>默认交互</span><select value={value.behavior.interactionMode} onChange={(event) => setBehavior({ interactionMode: event.target.value as OverlayPreferences["behavior"]["interactionMode"] })}><option value="click_through">鼠标穿透</option><option value="interactive">内容可交互</option><option value="full_passthrough">完全穿透</option></select></label><label className="designer-select-field"><span>滚轮路由</span><select value={value.behavior.wheelRouting} onChange={(event) => setBehavior({ wheelRouting: event.target.value as OverlayPreferences["behavior"]["wheelRouting"] })}><option value="overlay_under_cursor">悬浮窗下滚动</option><option value="underlying_app">交给下面应用</option><option value="dual">两边都滚动</option></select></label><DesignerNumberField label="模糊" value={value.appearance.blur} min={0} max={40} suffix="px" onChange={(next) => setAppearance({ blur: next })} /><DesignerNumberField label="圆角" value={value.appearance.radius} min={0} max={32} suffix="px" onChange={(next) => setAppearance({ radius: next })} /><DesignerOpacityField label="面试问题背景" value={value.interview.questionWindow.backgroundOpacity} onChange={(next) => onChange({ interview: { questionWindow: { backgroundOpacity: next } } })} /><DesignerOpacityField label="面试回答背景" value={value.interview.answerWindow.backgroundOpacity} onChange={(next) => onChange({ interview: { answerWindow: { backgroundOpacity: next } } })} /></div><div className="designer-toggle-grid"><label className="designer-check-row"><input type="checkbox" checked={value.behavior.alwaysOnTop} onChange={(event) => setBehavior({ alwaysOnTop: event.target.checked })} /><span><strong>始终置顶</strong></span></label><label className="designer-check-row"><input type="checkbox" checked={value.behavior.lockLayout} onChange={(event) => setBehavior({ lockLayout: event.target.checked })} /><span><strong>锁定布局</strong></span></label><label className="designer-check-row"><input type="checkbox" checked={value.screenshot.middleMouseEnabled} onChange={(event) => onChange({ screenshot: { middleMouseEnabled: event.target.checked } })} /><span><strong>启用中键截图</strong></span></label></div></section>
  </section>;
}
