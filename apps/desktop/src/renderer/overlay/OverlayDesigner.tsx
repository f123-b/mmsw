import { useEffect, useRef, useState, type JSX } from "react";
import type { OverlayDisplayInfo } from "../../main/overlay-manager";
import type { InterviewLayoutPreset, OverlayPreferences, OverlayPreferencesPatch, OverlayWindowPreferences, WrittenTestLayoutPreset } from "../../shared/overlay-preferences";
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

type TextWindowKey = "questionWindow" | "dialogueWindow" | "answerWindow" | "controlBar";
type BackgroundPreset = "transparent" | "dark_glass" | "light_glass" | "solid" | "custom";
type WindowChange = (patch: Partial<OverlayWindowPreferences>, commit?: boolean) => void;

function mergePatchSections(base: OverlayPreferencesPatch, next: OverlayPreferencesPatch): OverlayPreferencesPatch {
  const merged = { ...base, ...next } as OverlayPreferencesPatch;
  const interview = { ...(base.interview ?? {}), ...(next.interview ?? {}) };
  const writtenTest = { ...(base.writtenTest ?? {}), ...(next.writtenTest ?? {}) };
  for (const key of ["questionWindow", "dialogueWindow", "answerWindow", "controlBar"] as const) {
    const left = base.interview?.[key];
    const right = next.interview?.[key];
    if (left || right) interview[key] = { ...(left ?? {}), ...(right ?? {}) } as never;
  }
  for (const key of ["questionWindow", "answerWindow", "controlBar"] as const) {
    const left = base.writtenTest?.[key];
    const right = next.writtenTest?.[key];
    if (left || right) writtenTest[key] = { ...(left ?? {}), ...(right ?? {}) } as never;
  }
  if (base.interview || next.interview) merged.interview = interview;
  if (base.writtenTest || next.writtenTest) merged.writtenTest = writtenTest;
  if (base.behavior || next.behavior) merged.behavior = { ...(base.behavior ?? {}), ...(next.behavior ?? {}) };
  if (base.appearance || next.appearance) merged.appearance = { ...(base.appearance ?? {}), ...(next.appearance ?? {}) };
  if (base.screenshot || next.screenshot) merged.screenshot = { ...(base.screenshot ?? {}), ...(next.screenshot ?? {}) };
  return merged;
}

function mergeDraft(current: OverlayPreferences, patch: OverlayPreferencesPatch): OverlayPreferences {
  const interviewPatch = patch.interview ?? {};
  const writtenPatch = patch.writtenTest ?? {};
  return {
    ...current,
    ...patch,
    interview: {
      ...current.interview,
      ...interviewPatch,
      questionWindow: { ...current.interview.questionWindow, ...(interviewPatch.questionWindow ?? {}) },
      dialogueWindow: { ...current.interview.dialogueWindow, ...(interviewPatch.dialogueWindow ?? {}) },
      answerWindow: { ...current.interview.answerWindow, ...(interviewPatch.answerWindow ?? {}) },
      controlBar: { ...current.interview.controlBar, ...(interviewPatch.controlBar ?? {}) }
    },
    writtenTest: {
      ...current.writtenTest,
      ...writtenPatch,
      questionWindow: { ...current.writtenTest.questionWindow, ...(writtenPatch.questionWindow ?? {}) },
      answerWindow: { ...current.writtenTest.answerWindow, ...(writtenPatch.answerWindow ?? {}) },
      controlBar: { ...current.writtenTest.controlBar, ...(writtenPatch.controlBar ?? {}) }
    },
    behavior: { ...current.behavior, ...(patch.behavior ?? {}) },
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    screenshot: { ...current.screenshot, ...(patch.screenshot ?? {}) }
  } as OverlayPreferences;
}

function TextPreferencesPanel({ label, value, onChange }: { label: string; value: OverlayWindowPreferences; onChange: WindowChange }): JSX.Element {
  return <div className="designer-section-card designer-text-settings-card">
    <div className="designer-section-card-heading"><strong>{label}</strong><small>常用项直接可见，更多参数按需展开</small></div>
    <div className="designer-text-quick-fields">
      <DesignerNumberField label="文字大小" value={value.fontSize} min={10} max={32} suffix="px" onChange={(next) => onChange({ fontSize: next })} onCommit={() => onChange({}, true)} />
      <label className="designer-color-field"><span>文字颜色</span><div><input type="color" value={value.textColor} onChange={(event) => onChange({ textColor: event.target.value })} onBlur={() => onChange({}, true)} /><code>{value.textColor}</code></div></label>
    </div>
    <details className="designer-advanced-disclosure"><summary>高级文字参数</summary><div className="designer-fields-grid">
      <DesignerNumberField label="标题大小" value={value.titleFontSize} min={10} max={40} suffix="px" onChange={(next) => onChange({ titleFontSize: next })} onCommit={() => onChange({}, true)} />
      <label className="designer-select-field"><span>字重</span><select value={value.fontWeight} onChange={(event) => onChange({ fontWeight: Number(event.target.value) as OverlayWindowPreferences["fontWeight"] }, true)}><option value="400">常规</option><option value="500">中等</option><option value="600">半粗</option></select></label>
      <DesignerNumberField label="行距" value={value.lineHeight} min={1} max={2.5} step={0.05} onChange={(next) => onChange({ lineHeight: next })} onCommit={() => onChange({}, true)} />
      <DesignerOpacityField label="文字透明度" value={value.textOpacity} onChange={(next) => onChange({ textOpacity: next })} onCommit={() => onChange({}, true)} />
    </div></details>
  </div>;
}

function BackgroundPreferencesPanel({ value, preset, textOnly, onPreset, onChange }: { value: OverlayWindowPreferences; preset: BackgroundPreset; textOnly: boolean; onPreset: (preset: BackgroundPreset) => void; onChange: WindowChange }): JSX.Element {
  const presets: Array<[BackgroundPreset, string]> = [["transparent", "透明"], ["dark_glass", "深色玻璃"], ["light_glass", "浅色玻璃"], ["solid", "纯色"], ["custom", "自定义"]];
  return <div className="designer-section-card designer-background-settings-card">
    <div className="designer-section-card-heading"><strong>背景设置</strong><small>{textOnly ? "纯文字模式不会显示卡片背景" : "每个窗口独立保留背景参数"}</small></div>
    <fieldset disabled={textOnly} className="designer-background-fieldset">
      <div className="designer-background-presets">{presets.map(([key, label]) => <button type="button" key={key} className={preset === key ? "selected" : ""} onClick={() => onPreset(key)}>{label}</button>)}</div>
      <details className="designer-advanced-disclosure"><summary>高级背景参数</summary><div className="designer-fields-grid">
        <label className="designer-color-field"><span>背景颜色</span><div><input type="color" value={value.backgroundColor} onChange={(event) => onChange({ backgroundColor: event.target.value })} onBlur={() => onChange({}, true)} /><code>{value.backgroundColor}</code></div></label>
        <DesignerOpacityField label="背景透明度" value={value.backgroundOpacity} onChange={(next) => onChange({ backgroundOpacity: next })} onCommit={() => onChange({}, true)} />
        <DesignerNumberField label="模糊" value={value.blur} min={0} max={40} suffix="px" onChange={(next) => onChange({ blur: next })} onCommit={() => onChange({}, true)} />
        <DesignerNumberField label="圆角" value={value.radius} min={0} max={32} suffix="px" onChange={(next) => onChange({ radius: next })} onCommit={() => onChange({}, true)} />
        <DesignerOpacityField label="边框透明度" value={value.borderOpacity} onChange={(next) => onChange({ borderOpacity: next })} onCommit={() => onChange({}, true)} />
        <DesignerNumberField label="内边距" value={value.padding} min={0} max={40} suffix="px" onChange={(next) => onChange({ padding: next })} onCommit={() => onChange({}, true)} />
        <label className="designer-check-row"><input type="checkbox" checked={value.border} onChange={(event) => onChange({ border: event.target.checked }, true)} /><span><strong>显示边框</strong></span></label>
        <label className="designer-check-row"><input type="checkbox" checked={value.shadow} onChange={(event) => onChange({ shadow: event.target.checked }, true)} /><span><strong>显示阴影</strong></span></label>
      </div></details>
    </fieldset>
  </div>;
}

export function OverlayDesigner({ value, onChange, onPreview, onReset }: { value: OverlayPreferences; onChange: (patch: OverlayPreferencesPatch) => void; onPreview?: (patch: OverlayPreferencesPatch) => void | Promise<void>; onReset: () => void }): JSX.Element {
  const [displays, setDisplays] = useState<OverlayDisplayInfo[]>([]);
  const [designMode, setDesignMode] = useState<OverlayDesignerMode>("interview");
  const [activeWindowKey, setActiveWindowKey] = useState<TextWindowKey>("questionWindow");
  const [draftValue, setDraftValue] = useState(value);
  const draftRef = useRef(value);
  const pendingPreviewRef = useRef<OverlayPreferencesPatch>({});
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewInFlightRef = useRef(false);

  useEffect(() => { void window.interviewCopilot.overlay.getDisplays().then(setDisplays).catch(() => setDisplays([])); }, []);
  useEffect(() => () => { if (previewTimerRef.current) clearTimeout(previewTimerRef.current); void window.interviewCopilot.overlay.finishLayoutEditMode(); }, []);
  useEffect(() => {
    if (Object.keys(pendingPreviewRef.current).length === 0) {
      draftRef.current = value;
      setDraftValue(value);
    }
  }, [value]);

  const flushPreview = (): void => {
    if (!onPreview || previewInFlightRef.current) return;
    const patch = pendingPreviewRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingPreviewRef.current = {};
    previewInFlightRef.current = true;
    Promise.resolve(onPreview(patch)).catch(() => undefined).finally(() => {
      previewInFlightRef.current = false;
      if (Object.keys(pendingPreviewRef.current).length > 0) {
        previewTimerRef.current = setTimeout(() => { previewTimerRef.current = undefined; flushPreview(); }, 80);
      }
    });
  };
  const schedulePreview = (): void => {
    if (!onPreview || previewTimerRef.current) return;
    previewTimerRef.current = setTimeout(() => { previewTimerRef.current = undefined; flushPreview(); }, 80);
  };
  const applyPatch = (patch: OverlayPreferencesPatch, commit = true): void => {
    if (Object.keys(patch).length > 0) {
      const next = mergeDraft(draftRef.current, patch);
      draftRef.current = next;
      setDraftValue(next);
    }
    if (commit) {
      if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = undefined; }
      const finalPatch = mergePatchSections(pendingPreviewRef.current, patch);
      pendingPreviewRef.current = {};
      if (Object.keys(finalPatch).length > 0) onChange(finalPatch);
      return;
    }
    pendingPreviewRef.current = mergePatchSections(pendingPreviewRef.current, patch);
    schedulePreview();
  };

  const selectedDisplayId = designMode === "interview" ? draftValue.interview.questionWindow.displayId : draftValue.writtenTest.questionWindow.displayId;
  const activeDisplay = displays.find((display) => display.id === selectedDisplayId) ?? displays[0];
  const display = activeDisplay ?? { id: undefined, workArea: DESIGNER_CANVAS, bounds: { ...DESIGNER_CANVAS }, scaleFactor: 1 };
  const setBehavior = (patch: Partial<OverlayPreferences["behavior"]>): void => applyPatch({ behavior: patch });
  const setAppearance = (patch: Partial<OverlayPreferences["appearance"]>, commit = true): void => applyPatch({ appearance: patch }, commit);
  const applyInterviewPreset = (preset: InterviewLayoutPreset): void => {
    const current = draftValue.interview;
    const resolved = applyLayoutPreset(preset, display, { questionWindow: { x: current.questionWindow.x ?? 120, y: current.questionWindow.y ?? 180, width: current.questionWindow.width, height: current.questionWindow.height }, answerWindow: { x: current.answerWindow.x ?? 570, y: current.answerWindow.y ?? 180, width: current.answerWindow.width, height: current.answerWindow.height }, controlBar: { x: current.controlBar.x ?? 620, y: current.controlBar.y ?? 24, width: current.controlBar.width, height: current.controlBar.height }, controlBarOrientation: current.controlBar.orientation, controlBarPositionMode: current.controlBar.positionMode });
    const displayFields = resolved.displayId === undefined ? {} : { displayId: resolved.displayId, scaleFactor: resolved.scaleFactor };
    applyPatch({ interview: { layoutPreset: preset, questionWindow: { ...resolved.questionWindow, ...displayFields }, dialogueWindow: { ...current.dialogueWindow, ...resolved.questionWindow, ...displayFields }, answerWindow: { ...resolved.answerWindow, ...displayFields }, controlBar: { ...resolved.controlBar, ...displayFields, positionMode: resolved.controlBarPositionMode, orientation: resolved.controlBarOrientation } } });
  };
  const applyWrittenPreset = (preset: WrittenTestLayoutPreset): void => {
    const resolved = resolveWrittenTestLayoutPreset(preset, display);
    const displayFields = resolved.displayId === undefined ? {} : { displayId: resolved.displayId, scaleFactor: resolved.scaleFactor };
    applyPatch({ writtenTest: { layoutPreset: preset, questionWindow: { ...resolved.questionWindow, ...displayFields }, answerWindow: { ...resolved.answerWindow, ...displayFields }, controlBar: { ...resolved.controlBar, ...displayFields, positionMode: resolved.controlBarPositionMode, orientation: resolved.controlBarOrientation } } });
  };

  const interview = draftValue.interview;
  const activeControlBar = designMode === "interview" ? interview.controlBar : draftValue.writtenTest.controlBar;
  const updateActiveControlBar = (patch: Partial<OverlayPreferences["interview"]["controlBar"]>, commit = true): void => applyPatch(designMode === "interview" ? { interview: { controlBar: patch } } : { writtenTest: { controlBar: patch } }, commit);
  const activeTextWindows: Array<{ key: TextWindowKey; label: string; value: OverlayWindowPreferences }> = designMode === "interview"
    ? [{ key: "questionWindow", label: "问题窗口", value: interview.questionWindow }, { key: "answerWindow", label: "回答窗口", value: interview.answerWindow }, { key: "dialogueWindow", label: "对话窗口", value: interview.dialogueWindow }, { key: "controlBar", label: "控制栏", value: interview.controlBar }]
    : [{ key: "questionWindow", label: "问题窗口", value: draftValue.writtenTest.questionWindow }, { key: "answerWindow", label: "回答窗口", value: draftValue.writtenTest.answerWindow }, { key: "controlBar", label: "控制栏", value: draftValue.writtenTest.controlBar }];
  const activeTextWindow = activeTextWindows.find((item) => item.key === activeWindowKey) ?? activeTextWindows[0];
  const updateActiveTextWindow = (patch: Partial<OverlayWindowPreferences>, commit = false): void => {
    if (!activeTextWindow) return;
    const section = designMode === "interview" ? { interview: { [activeTextWindow.key]: patch } } : { writtenTest: { [activeTextWindow.key]: patch } };
    applyPatch(section as OverlayPreferencesPatch, commit);
  };
  const backgroundPreset = (windowValue: OverlayWindowPreferences): BackgroundPreset => {
    if (windowValue.backgroundOpacity <= 0.05) return "transparent";
    if (windowValue.backgroundColor.toLowerCase() === "#eaf0f6") return "light_glass";
    if (windowValue.backgroundOpacity >= 0.98 && windowValue.blur === 0) return "solid";
    if (windowValue.backgroundColor.toLowerCase() === "#223349") return "dark_glass";
    return "custom";
  };
  const applyBackgroundPreset = (preset: BackgroundPreset): void => {
    const patches: Record<Exclude<BackgroundPreset, "custom">, Partial<OverlayWindowPreferences>> = {
      transparent: { backgroundOpacity: 0, blur: 0, border: false, shadow: false },
      dark_glass: { backgroundColor: "#223349", backgroundOpacity: 0.86, blur: 16, border: true, borderOpacity: 0.2, shadow: true },
      light_glass: { backgroundColor: "#eaf0f6", backgroundOpacity: 0.82, blur: 16, border: true, borderOpacity: 0.24, shadow: true },
      solid: { backgroundOpacity: 1, blur: 0, border: true, borderOpacity: 0.18, shadow: false }
    };
    if (preset !== "custom") updateActiveTextWindow(patches[preset], true);
  };
  const writtenShowAnswerControl = draftValue.writtenTest.layoutPreset === "split"
    ? <section className="designer-section"><label className="designer-check-row"><input type="checkbox" checked={draftValue.writtenTest.showAnswer} onChange={(event) => applyPatch({ writtenTest: { showAnswer: event.target.checked } })} /><span><strong>显示回答窗口</strong><small>分栏布局允许单独隐藏回答窗口</small></span></label></section>
    : <section className="designer-section"><p className="designer-inline-note">单阅读器：回答显示在题目窗口内，无独立回答窗口开关。</p></section>;

  return <section className="settings-service-card overlay-preferences-card overlay-designer-card">
    <header className="overlay-designer-header"><div><span className="page-kicker">悬浮窗设计器</span><h2>面试与笔试悬浮窗</h2><p>两种工作流分别保存窗口位置和尺寸；运行时窗口稳定，内容在内部滚动。</p></div><button className="outline-pill" onClick={onReset}>恢复布局默认</button></header>
    <div className="overlay-designer-mode-tabs"><button className={designMode === "interview" ? "selected" : ""} onClick={() => setDesignMode("interview")}>面试悬浮窗</button><button className={designMode === "writtenTest" ? "selected" : ""} onClick={() => setDesignMode("writtenTest")}>笔试悬浮窗</button></div>
    {designMode === "interview" ? <aside className="overlay-designer-controls"><section className="designer-section"><div className="designer-section-heading"><div><h3>布局模式</h3><p>默认使用稳定的经典双栏。</p></div></div><div className="designer-preset-card-grid">{INTERVIEW_PRESETS.map(([preset, label, description]) => <button key={preset} type="button" data-testid={`designer-preset-${preset}`} className={`designer-preset-card ${interview.layoutPreset === preset ? "selected" : ""}`} onClick={() => applyInterviewPreset(preset)}><span className={`preset-thumb preset-thumb-${preset}`} aria-hidden="true"><i /><i /></span><strong>{label}</strong><small>{description}</small></button>)}</div><button className="dark-pill designer-edit-real-button" onClick={() => void window.interviewCopilot.overlay.enterLayoutEditMode()}>在桌面上调整</button></section><section className="designer-section"><div className="designer-section-heading"><div><h3>左侧窗口内容</h3><p>布局模式和左窗内容是两个独立设置。</p></div></div><div className="designer-choice-row">{([ ["dialogue", "对话"], ["question", "问题"], ["hidden", "隐藏"] ] as const).map(([mode, label]) => <button key={mode} className={interview.leftPanel === mode ? "selected" : ""} onClick={() => applyPatch({ interview: { leftPanel: mode } })}>{label}</button>)}</div></section><section className="designer-section"><label className="designer-check-row"><input type="checkbox" checked={interview.showAnswer} onChange={(event) => applyPatch({ interview: { showAnswer: event.target.checked } })} /><span><strong>显示右侧回答</strong><small>回答窗口始终保持固定高度并在内部滚动</small></span></label></section></aside> : <aside className="overlay-designer-controls"><section className="designer-section"><div className="designer-section-heading"><div><h3>笔试布局</h3><p>笔试只保留截图题目与 AI 回答。</p></div></div><div className="designer-preset-card-grid">{WRITTEN_PRESETS.map(([preset, label, description]) => <button key={preset} type="button" data-testid={`designer-preset-${preset}`} className={`designer-preset-card ${draftValue.writtenTest.layoutPreset === preset ? "selected" : ""}`} onClick={() => applyWrittenPreset(preset)}><span className={`preset-thumb preset-thumb-written-${preset}`} aria-hidden="true"><i /><i /></span><strong>{label}</strong><small>{description}</small></button>)}</div></section>{writtenShowAnswerControl}</aside>}
    <OverlayDesignerCanvas value={draftValue} mode={designMode} onChange={(patch) => applyPatch(patch)} displays={displays} activeDisplay={activeDisplay} />
    <section className="designer-section designer-common-section"><div className="designer-section-heading"><div><h3>通用交互与外观</h3><p>控制栏保持独立可点击，内容窗口默认穿透。</p></div></div><div className="designer-fields-grid"><label className="designer-select-field"><span>默认交互</span><select value={draftValue.behavior.interactionMode} onChange={(event) => setBehavior({ interactionMode: event.target.value as OverlayPreferences["behavior"]["interactionMode"] })}><option value="click_through">鼠标穿透</option><option value="interactive">内容可交互</option><option value="full_passthrough">完全穿透</option></select></label><label className="designer-select-field"><span>滚轮路由</span><select value={draftValue.behavior.wheelRouting} onChange={(event) => setBehavior({ wheelRouting: event.target.value as OverlayPreferences["behavior"]["wheelRouting"] })}><option value="overlay_under_cursor">悬浮窗下滚动</option><option value="underlying_app">交给下面应用</option><option value="dual">两边都滚动</option></select></label><DesignerNumberField label="全局模糊" value={draftValue.appearance.blur} min={0} max={40} suffix="px" onChange={(next) => setAppearance({ blur: next }, false)} onCommit={() => applyPatch({}, true)} /><DesignerNumberField label="全局圆角" value={draftValue.appearance.radius} min={0} max={32} suffix="px" onChange={(next) => setAppearance({ radius: next }, false)} onCommit={() => applyPatch({}, true)} /></div><div className="designer-toggle-grid"><label className="designer-check-row"><input type="checkbox" checked={draftValue.behavior.alwaysOnTop} onChange={(event) => setBehavior({ alwaysOnTop: event.target.checked })} /><span><strong>始终置顶</strong></span></label><label className="designer-check-row"><input type="checkbox" checked={draftValue.behavior.lockLayout} onChange={(event) => setBehavior({ lockLayout: event.target.checked })} /><span><strong>锁定布局</strong></span></label><label className="designer-check-row"><input type="checkbox" checked={draftValue.screenshot.middleMouseEnabled} onChange={(event) => applyPatch({ screenshot: { middleMouseEnabled: event.target.checked } })} /><span><strong>启用中键截图</strong></span></label></div><div className="designer-toolbar-settings"><div className="designer-section-card-heading"><strong>顶部控制栏</strong><small>隐藏后全局快捷键和结束面试仍然有效</small></div><div className="designer-fields-grid"><label className="designer-check-row"><input type="checkbox" checked={draftValue.showToolbar} onChange={(event) => applyPatch({ showToolbar: event.target.checked })} /><span><strong>显示控制栏</strong></span></label><label className="designer-select-field"><span>位置</span><select value={activeControlBar.positionMode} onChange={(event) => updateActiveControlBar({ positionMode: event.target.value as OverlayPreferences["interview"]["controlBar"]["positionMode"] })}><option value="top_left">顶部左侧</option><option value="top_center">顶部居中</option><option value="top_right">顶部右侧</option><option value="bottom_left">底部左侧</option><option value="bottom_center">底部居中</option><option value="bottom_right">底部右侧</option></select></label><label className="designer-select-field"><span>排列</span><select value={activeControlBar.orientation} onChange={(event) => updateActiveControlBar({ orientation: event.target.value as OverlayPreferences["interview"]["controlBar"]["orientation"] })}><option value="horizontal">横向</option><option value="vertical">纵向</option></select></label><DesignerOpacityField label="透明度" value={activeControlBar.backgroundOpacity} onChange={(next) => updateActiveControlBar({ backgroundOpacity: next }, false)} onCommit={() => applyPatch({}, true)} /><DesignerNumberField label="字体大小" value={activeControlBar.fontSize} min={10} max={24} suffix="px" onChange={(next) => updateActiveControlBar({ fontSize: next }, false)} onCommit={() => applyPatch({}, true)} /></div></div></section>
    <section className="designer-section designer-text-section"><div className="designer-section-heading"><div><h3>窗口设置</h3><p>先选择窗口，再分别调整文字和背景；数字输入在失焦或回车时保存。</p></div></div><div className="designer-window-tabs" role="tablist">{activeTextWindows.map((item) => <button type="button" key={item.key} role="tab" aria-selected={activeTextWindow?.key === item.key} className={activeTextWindow?.key === item.key ? "selected" : ""} onClick={() => setActiveWindowKey(item.key)}>{item.label}</button>)}</div>{activeTextWindow && <div className="designer-window-panels"><TextPreferencesPanel label={`${activeTextWindow.label} · 文字`} value={activeTextWindow.value} onChange={updateActiveTextWindow} /><BackgroundPreferencesPanel value={activeTextWindow.value} preset={backgroundPreset(activeTextWindow.value)} textOnly={draftValue.appearance.mode === "text_only"} onPreset={applyBackgroundPreset} onChange={updateActiveTextWindow} /></div>}</section>
    <section className="designer-section designer-display-section"><div className="designer-section-heading"><div><h3>显示方式</h3><p>文字模式适合放在 IDE 或网页上方；纯文字模式会隐藏卡片背景。</p></div></div><div className="designer-fields-grid"><label className="designer-select-field"><span>显示模式</span><select data-testid="overlay-appearance-mode" value={draftValue.appearance.mode} onChange={(event) => setAppearance({ mode: event.target.value as OverlayPreferences["appearance"]["mode"] })}><option value="glass">玻璃卡片</option><option value="translucent">半透明</option><option value="text_only">纯文字</option><option value="custom">自定义</option></select></label><label className="designer-select-field"><span>文字阴影</span><select value={draftValue.appearance.textShadow} onChange={(event) => setAppearance({ textShadow: event.target.value as OverlayPreferences["appearance"]["textShadow"] })}><option value="none">无</option><option value="soft">柔和</option><option value="medium">增强</option></select></label><label className="designer-select-field"><span>文字描边</span><select value={draftValue.appearance.textOutline} onChange={(event) => setAppearance({ textOutline: Number(event.target.value) as OverlayPreferences["appearance"]["textOutline"] })}><option value="0">无</option><option value="0.5">细</option><option value="1">增强</option></select></label></div><div className="designer-toggle-grid"><label className="designer-check-row"><input type="checkbox" checked={draftValue.behavior.followLatestQuestion} onChange={(event) => setBehavior({ followLatestQuestion: event.target.checked })} /><span><strong>问题自动跟随最新</strong><small>手动上滚后暂停，可点“回到最新”恢复</small></span></label><label className="designer-check-row"><input type="checkbox" checked={draftValue.behavior.followLatestAnswer} onChange={(event) => setBehavior({ followLatestAnswer: event.target.checked })} /><span><strong>回答自动跟随最新</strong><small>新问题或新回答开始时自动回到尾部</small></span></label></div></section>
  </section>;
}
