import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type JSX, type RefObject } from "react";
import type { AnswerThread } from "@interview-copilot/shared";
import type { HUDLayout, HUDState, OverlayMode } from "../../main/overlay-manager";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../../shared/overlay-preferences";
import { applyLayoutPreset, boundsForPanel, clampDesignerRect, resizeDesignerRect, snapDesignerRect, type DesignerPanel, type ResizeHandle } from "./overlay-designer";
import { isDisplayableQuestionGroup, type RuntimePhaseState } from "./runtime-state";
import { buildAnswerOverlayViewModel, buildQuestionOverlayViewModel, type AnswerOverlayViewModel, type QuestionOverlayViewModel } from "./view-models";

type PanelKey = "toolbar" | "transcript" | "answer";
export type OverlaySurface = "question" | "answer" | "control" | "transient";
export type OverlayPanelLayout = { x: number; y: number; width: number; height: number; visible: boolean; collapsed: boolean; locked: boolean; opacity: number };
type PanelLayout = OverlayPanelLayout;
type OverlayLayout = Record<PanelKey, PanelLayout>;

export interface OverlayRootProps {
  surface?: OverlaySurface;
  panel?: "all" | "question" | "answer";
  mic: number;
  system: number;
  state: string;
  sessionState: string;
  realtimeState: string;
  operationMode: "IDLE" | "INTERVIEW" | "WRITTEN_TEST";
  overlayMode: OverlayMode;
  hudState: HUDState;
  runtimePhases: RuntimePhaseState;
  automationMode: "MANUAL" | "AUTO";
  answerMode: "FAST" | "NORMAL" | "DEEP";
  question?: { text: string };
  answerText: string;
  answerStreaming: boolean;
  questionGroups: Array<{ id: string; title: string; primaryQuestion?: string; displayable?: boolean; hasAnswerableQuestion?: boolean; status?: "collecting" | "answering" | "active" | "closed"; items: Array<{ id: string; questionId: string; text: string; type: string; answerable: boolean; state: string }>; slots: Array<{ id: string; text: string; status: string }>; updatedAt: number }>;
  activeQuestionGroupId?: string;
  activeAnswerGroupId?: string;
  answerThreads: AnswerThread[];
  onToggleMode: () => void;
  onToggleAutomation: () => Promise<void> | void;
  onAnswerLatest: () => Promise<void>;
  onAnswerScreenshot: () => Promise<void>;
  onEndInterview: () => Promise<void>;
  onHideAll: () => void;
  onShowAll: () => void;
  onTogglePanels: () => void;
  onToggleTranscript: () => void;
  onToggleAnswer: () => void;
  onToggleShortcuts: () => void;
  onRequestEndInterview: () => void;
  onToggleShare: () => void;
  captureProtectionEnabled?: boolean;
  captureProtectionSupported?: boolean;
  captureProtectionOsFlagApplied?: boolean;
  captureProtectionDisplayVerified?: boolean | null;
  captureProtectionLastError?: string;
  onToggleCaptureProtection?: () => void;
  captureTest?: boolean;
}

const defaults: OverlayLayout = {
  toolbar: { x: 0, y: 0, width: 440, height: 44, visible: true, collapsed: false, locked: true, opacity: 1 },
  transcript: { x: 0, y: 0, width: 410, height: 180, visible: true, collapsed: false, locked: false, opacity: 1 },
  answer: { x: 0, y: 0, width: 620, height: 220, visible: true, collapsed: false, locked: false, opacity: 1 }
};

function viewportDefaults(preferences = DEFAULT_OVERLAY_PREFERENCES, surface: OverlaySurface | undefined = undefined): OverlayLayout {
  if (surface === "control") return { ...defaults, toolbar: { ...defaults.toolbar, width: window.innerWidth, height: window.innerHeight }, transcript: { ...defaults.transcript, visible: false }, answer: { ...defaults.answer, visible: false } };
  if (surface === "question") return { ...defaults, toolbar: { ...defaults.toolbar, visible: false }, transcript: { ...defaults.transcript, width: window.innerWidth, height: window.innerHeight }, answer: { ...defaults.answer, visible: false } };
  if (surface === "answer") return { ...defaults, toolbar: { ...defaults.toolbar, visible: false }, transcript: { ...defaults.transcript, visible: false }, answer: { ...defaults.answer, width: window.innerWidth, height: window.innerHeight } };
  const resolved = applyLayoutPreset(preferences.layoutPreset, { workArea: { width: window.innerWidth, height: window.innerHeight } }, {
    questionWindow: { x: preferences.questionWindow.x ?? 120, y: preferences.questionWindow.y ?? 180, width: preferences.questionWindow.width, height: preferences.questionWindow.height },
    answerWindow: { x: preferences.answerWindow.x ?? 570, y: preferences.answerWindow.y ?? 180, width: preferences.answerWindow.width, height: preferences.answerWindow.height },
    controlBar: { x: preferences.controlBar.x ?? 620, y: preferences.controlBar.y ?? 24, width: preferences.controlBar.width, height: preferences.controlBar.height },
    controlBarOrientation: preferences.controlBar.orientation,
    controlBarPositionMode: preferences.controlBar.positionMode
  });
  return {
    toolbar: { ...defaults.toolbar, x: resolved.controlBar.x, y: resolved.controlBar.y, width: resolved.controlBar.width, height: resolved.controlBar.height },
    transcript: { ...defaults.transcript, x: resolved.questionWindow.x, y: resolved.questionWindow.y, width: resolved.questionWindow.width, height: resolved.questionWindow.height },
    answer: { ...defaults.answer, x: resolved.answerWindow.x, y: resolved.answerWindow.y, width: resolved.answerWindow.width, height: resolved.answerWindow.height }
  };
}

function clampLayout(panel: PanelKey, layout: PanelLayout): PanelLayout {
  const designerPanel: DesignerPanel = panel === "transcript" ? "question" : panel === "answer" ? "answer" : "controlBar";
  const next = clampDesignerRect({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, { width: window.innerWidth, height: window.innerHeight }, boundsForPanel(designerPanel));
  return { ...layout, ...next };
}

function useOverlayLayout(preferences: OverlayPreferences, surface?: OverlaySurface): [OverlayLayout, (key: PanelKey, patch: Partial<PanelLayout>, altPressed?: boolean) => void, (next: HUDLayout) => void, () => void, () => OverlayLayout] {
  const [layout, setLayout] = useState<OverlayLayout>(() => viewportDefaults(preferences, surface));
  const preferencesRef = useRef(preferences);
  const layoutRef = useRef(layout);
  preferencesRef.current = preferences;
  const update = useCallback((key: PanelKey, patch: Partial<PanelLayout>, altPressed = false) => setLayout((current) => {
    const nextPanel = { ...current[key], ...patch };
    const designerPanel: DesignerPanel | undefined = key === "transcript" ? "question" : key === "answer" ? "answer" : "controlBar";
    const snapped = designerPanel && preferencesRef.current.behavior.snapEnabled
      ? snapDesignerRect(designerPanel, nextPanel, { question: current.transcript, answer: current.answer, controlBar: current.toolbar }, { width: window.innerWidth, height: window.innerHeight }, preferencesRef.current.behavior.snapThreshold, altPressed)
      : nextPanel;
    const next = { ...current, [key]: clampLayout(key, { ...nextPanel, ...snapped }) };
    layoutRef.current = next;
    return next;
  }), []);
  const applyMainLayout = useCallback((_next: HUDLayout) => { const next = viewportDefaults(preferencesRef.current, surface); layoutRef.current = next; setLayout(next); }, [surface]);
  const clearSavedLayout = useCallback(() => { const next = viewportDefaults(preferencesRef.current, surface); layoutRef.current = next; setLayout(next); }, [surface]);
  useEffect(() => {
    setLayout((current) => {
      const next = viewportDefaults(preferences, surface);
      const merged = { ...current, transcript: { ...next.transcript }, answer: { ...next.answer }, toolbar: { ...current.toolbar, ...next.toolbar } };
      layoutRef.current = merged;
      return merged;
    });
  }, [surface, preferences.layoutPreset, preferences.questionWindow.x, preferences.questionWindow.y, preferences.questionWindow.width, preferences.questionWindow.height, preferences.answerWindow.x, preferences.answerWindow.y, preferences.answerWindow.width, preferences.answerWindow.height, preferences.controlBar.x, preferences.controlBar.y, preferences.controlBar.width, preferences.controlBar.height, preferences.controlBar.orientation, preferences.controlBar.positionMode]);
  return [layout, update, applyMainLayout, clearSavedLayout, () => layoutRef.current];
}

export interface DraggableResizablePanelProps {
  panel: PanelKey;
  layout: PanelLayout;
  onChange: (key: PanelKey, patch: Partial<PanelLayout>, altPressed?: boolean) => void;
  onCommit: () => void;
  editMode: boolean;
  className: string;
  children: JSX.Element;
  nativePanel?: "question" | "answer" | "control";
}

export function DraggableResizablePanel({ panel, layout, onChange, onCommit, editMode, className, children, nativePanel }: DraggableResizablePanelProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupRef.current?.(), []);
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editMode || layout.locked || (event.target as HTMLElement).closest("button, input, textarea, select, .resize-handle, .overlay-scroll-region")) return;
    const origin = { x: event.clientX - layout.x, y: event.clientY - layout.y };
    const nativeOrigin = nativePanel ? { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight } : undefined;
    setDragging(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    const move = (next: PointerEvent) => {
      const nextLayout = { x: next.clientX - origin.x, y: next.clientY - origin.y };
      onChange(panel, nextLayout, next.altKey);
      if (nativePanel && nativeOrigin) void window.interviewCopilot.overlay.setWindowBounds(nativePanel, { x: nativeOrigin.x + nextLayout.x - layout.x, y: nativeOrigin.y + nextLayout.y - layout.y, width: nativeOrigin.width, height: nativeOrigin.height });
    };
    const end = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); cleanupRef.current = undefined; onCommit(); };
    cleanupRef.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    window.addEventListener("blur", end, { once: true });
  };
  const beginResize = (handle: ResizeHandle, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editMode || layout.locked) return;
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    const start = { x: event.clientX, y: event.clientY };
    const nativeOrigin = nativePanel ? { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight } : undefined;
    const move = (next: PointerEvent) => {
      const designerPanel: DesignerPanel = panel === "transcript" ? "question" : panel === "answer" ? "answer" : "controlBar";
      const resized = resizeDesignerRect({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, handle, { x: next.clientX - start.x, y: next.clientY - start.y }, { width: window.innerWidth, height: window.innerHeight }, boundsForPanel(designerPanel), next.altKey);
      onChange(panel, resized, next.altKey);
      if (nativePanel && nativeOrigin) void window.interviewCopilot.overlay.setWindowBounds(nativePanel, { x: nativeOrigin.x + resized.x - layout.x, y: nativeOrigin.y + resized.y - layout.y, width: nativeOrigin.width + resized.width - layout.width, height: nativeOrigin.height + resized.height - layout.height });
    };
    const end = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); cleanupRef.current = undefined; onCommit(); };
    setDragging(true);
    cleanupRef.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    window.addEventListener("blur", end, { once: true });
  };
  const panelStyle = { left: layout.x, top: layout.y, width: layout.width, height: layout.height, display: layout.visible ? undefined : "none" } as CSSProperties;
  const resizeHandles: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  return <div className={`floating-panel ${className} ${dragging ? "dragging" : ""} ${editMode ? "layout-editing" : ""}`} data-panel={panel} style={panelStyle} onPointerDown={beginDrag}>{children}{editMode && !layout.locked && resizeHandles.map((handle) => <div className={`resize-handle resize-handle-${handle}`} aria-label={`调整大小 ${handle}`} key={handle} onPointerDown={(event) => beginResize(handle, event)} />)}</div>;
}

function compactText(text: string | undefined, limit = 260): string {
  if (!text) return "等待主问题";
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function useNativeContentSize(panel: "question" | "answer" | undefined, targetRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!panel || !enabled || !targetRef.current) return undefined;
    const target = targetRef.current;
    let raf = 0;
    let timer: number | undefined;
    let lastHeight = 0;
    const report = () => {
      timer = undefined;
      const content = target.querySelector<HTMLElement>("[data-overlay-content]") ?? target;
      const rect = content.getBoundingClientRect();
      const height = Math.max(rect.height, content.scrollHeight);
      if (lastHeight && Math.abs(height - lastHeight) < 8) return;
      lastHeight = height;
      void window.interviewCopilot.overlay.reportContentSize(panel, { width: rect.width, height });
    };
    const schedule = () => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { if (timer !== undefined) window.clearTimeout(timer); timer = window.setTimeout(report, 120); }); };
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    schedule();
    return () => { observer.disconnect(); if (raf) cancelAnimationFrame(raf); if (timer !== undefined) window.clearTimeout(timer); };
  }, [enabled, panel, targetRef]);
}

function AnswerCore({ text }: { text: string }): JSX.Element {
  const blocks: JSX.Element[] = [];
  let code = false;
  let codeLines: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().startsWith("```")) { if (code) blocks.push(<pre key={`code-${index}`}><code>{codeLines.join("\n")}</code></pre>); code = !code; codeLines = []; }
    else if (code) codeLines.push(line);
    else if (line.trim()) blocks.push(<p key={`line-${index}`}>{line.replace(/^[-*]\s+/, "")}</p>);
  });
  if (code && codeLines.length) blocks.push(<pre key="code-tail"><code>{codeLines.join("\n")}</code></pre>);
  return <>{blocks}</>;
}

function QuestionOverlayContent({ groups, viewModel }: { groups: OverlayRootProps["questionGroups"]; viewModel: QuestionOverlayViewModel }): JSX.Element {
  const older = groups.filter((group) => isDisplayableQuestionGroup(group) && group.id !== viewModel.activeGroupId).reverse();
  return <section className="overlay-panel-card question-card question-overlay-content" data-overlay-content="question" aria-label="当前问题">
    <div className="overlay-content-status"><span className="content-status-dot" />{viewModel.status === "detected" ? "已识别" : "正在听取"}</div>
    <p className="current-question-text">{compactText(viewModel.currentQuestion)}</p>
    {viewModel.currentFollowUp && <div className="current-follow-up"><span>追问</span><strong>{compactText(viewModel.currentFollowUp, 220)}</strong></div>}
    {viewModel.hasHistory && <details className="overlay-history"><summary>历史 {viewModel.historyCount}</summary>{older.map((group) => <p className="overlay-history-item" key={group.id}>{compactText(group.primaryQuestion ?? group.title, 180)}</p>)}</details>}
  </section>;
}

function AnswerOverlayContent({ viewModel }: { viewModel: AnswerOverlayViewModel }): JSX.Element {
  return <section className="overlay-panel-card answer-card answer-overlay-content" data-overlay-content="answer" aria-label="当前回答">
    {viewModel.question && <p className="answer-context-question">{compactText(viewModel.question, 220)}</p>}
    {viewModel.streaming && <div className="answer-content-status generating"><span className="content-status-dot" />生成中</div>}
    <div className="answer-core">{viewModel.answer ? <AnswerCore text={viewModel.answer} /> : <p className="overlay-empty">等待回答</p>}{viewModel.streaming && <span className="answer-cursor">▌</span>}</div>
    {viewModel.hasOlderAnswers && <details className="overlay-history"><summary>历史回答 {viewModel.olderAnswerCount}</summary></details>}
  </section>;
}

const DESIGNER_QUESTION_GROUPS: OverlayRootProps["questionGroups"] = [{ id: "designer-question-group", title: "布局编辑示例", primaryQuestion: "CAN 总线是什么？", displayable: true, hasAnswerableQuestion: true, items: [{ id: "designer-question", questionId: "designer-question", text: "CAN 总线是什么？", type: "NEW_TOPIC", answerable: true, state: "detected" }], slots: [], updatedAt: 0 }];
const DESIGNER_ANSWER_THREADS: AnswerThread[] = [{ groupId: "designer-question-group", questionId: "designer-question", title: "CAN 总线是什么？", answers: [{ answerId: "designer-answer", questionId: "designer-question", groupId: "designer-question-group", questionText: "CAN 总线是什么？", answerText: "CAN 使用基于 ID 的逐位仲裁，显性位会覆盖隐性位，适合可靠的实时通信。", relation: "PRIMARY", status: "complete", visible: true, startedAt: 0, finishedAt: 0 }], createdAt: 0, updatedAt: 0 }];

export function OverlayRoot(props: OverlayRootProps): JSX.Element {
  const panel = props.panel ?? "all";
  const nativeSurface = props.surface;
  const writtenTestMode = props.operationMode === "WRITTEN_TEST";
  const [preferences, setPreferences] = useState<OverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const [layout, updateLayout, applyMainLayout, clearSavedLayout, getCurrentLayout] = useOverlayLayout(preferences, nativeSurface);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [runtimeProtection, setRuntimeProtection] = useState<{ requested: boolean; osFlagApplied: boolean; displayCaptureVerified: boolean | null; lastError?: string }>();
  const [answerSending, setAnswerSending] = useState(false);
  const nativeContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    void window.interviewCopilot.overlay.getPreferences().then((next) => { if (!disposed && next) setPreferences(next); }).catch(() => undefined);
    void window.interviewCopilot.overlay.getLayout().then((next) => { if (!disposed && next) applyMainLayout(next); }).catch(() => undefined);
    void window.interviewCopilot.overlay.getCaptureProtection().then((next) => { if (!disposed) setRuntimeProtection(next); }).catch(() => undefined);
    const unsubscribePreferences = window.interviewCopilot.events.onOverlayPreferences((next) => { if (!disposed) setPreferences(next); });
    const unsubscribeLayout = window.interviewCopilot.events.onOverlayLayout((next) => { if (!disposed) applyMainLayout(next); });
    const unsubscribeLayoutEdit = window.interviewCopilot.events.onOverlayLayoutEditMode((enabled) => { if (!disposed) setLayoutEditMode(enabled); });
    const unsubscribeProtection = window.interviewCopilot.events.onOverlayCaptureProtection((next) => { if (!disposed) setRuntimeProtection(next); });
    const unsubscribeCommands = window.interviewCopilot.events.onOverlayCommand((command) => { if (command === "reset-layout") clearSavedLayout(); });
    return () => { disposed = true; unsubscribePreferences(); unsubscribeLayout(); unsubscribeLayoutEdit(); unsubscribeProtection(); unsubscribeCommands(); };
  }, [applyMainLayout, clearSavedLayout]);
  const visualHidden = (!props.hudState.running && !layoutEditMode) || props.hudState.shareMode;
  const transcriptVisible = !visualHidden && !writtenTestMode && (!nativeSurface || nativeSurface === "question") && panel !== "answer" && preferences.showTranscript && (layoutEditMode || props.hudState.transcriptVisible);
  const answerVisible = !visualHidden && (!nativeSurface || nativeSurface === "answer") && panel !== "question" && preferences.showAnswer && (layoutEditMode || props.hudState.answerVisible);
  const displayedGroups = layoutEditMode && props.questionGroups.length === 0 ? DESIGNER_QUESTION_GROUPS : props.questionGroups;
  const displayedThreads = layoutEditMode && props.answerThreads.length === 0 ? DESIGNER_ANSWER_THREADS : props.answerThreads;
  const questionViewModel = buildQuestionOverlayViewModel(displayedGroups, props.activeQuestionGroupId, props.question?.text);
  const answerViewModel = buildAnswerOverlayViewModel(displayedThreads, props.activeAnswerGroupId, props.question?.text, props.answerText, props.answerStreaming);
  useNativeContentSize(nativeSurface === "question" ? "question" : nativeSurface === "answer" ? "answer" : undefined, nativeContentRef, !layoutEditMode && !visualHidden);
  const persistLayout = useCallback(() => {
    const current = getCurrentLayout();
    const patch = (panelLayout: PanelLayout) => ({ x: panelLayout.x, y: panelLayout.y, width: panelLayout.width, height: panelLayout.height });
    void window.interviewCopilot.overlay.setPreferences({ questionWindow: patch(current.transcript), answerWindow: patch(current.answer), controlBar: patch(current.toolbar) });
  }, [getCurrentLayout]);
  const effectiveProtectionEnabled = runtimeProtection?.requested ?? props.captureProtectionEnabled;
  const protectionTone = !effectiveProtectionEnabled ? "off" : runtimeProtection?.displayCaptureVerified === true ? "verified" : "requested";
  const submitScreenshot = async () => { if (answerSending) return; setAnswerSending(true); try { await props.onAnswerScreenshot(); } finally { setAnswerSending(false); } };
  return <main className="overlay-root" data-overlay-surface={nativeSurface ?? "designer"} data-hud-mode={props.hudState.mode} data-share-mode={props.hudState.shareMode ? "on" : "off"} data-overlay-mode={props.overlayMode} data-layout-edit-mode={layoutEditMode ? "on" : "off"} data-appearance-mode={preferences.appearance.mode}>
    {props.captureTest && !visualHidden && <div className="capture-test-marker">CAPTURE_PROTECTION_TEST_MARKER_7F32</div>}
    {transcriptVisible && (nativeSurface === "question" && !layoutEditMode
      ? <div ref={nativeContentRef} className="native-content-window question-panel"><QuestionOverlayContent groups={displayedGroups} viewModel={questionViewModel} /></div>
      : <DraggableResizablePanel panel="transcript" nativePanel={nativeSurface === "question" ? "question" : undefined} layout={{ ...layout.transcript, visible: true, locked: !layoutEditMode && (layout.transcript.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="question-panel"><QuestionOverlayContent groups={displayedGroups} viewModel={questionViewModel} /></DraggableResizablePanel>)}
    {answerVisible && (nativeSurface === "answer" && !layoutEditMode
      ? <div ref={nativeContentRef} className="native-content-window answer-panel"><AnswerOverlayContent viewModel={answerViewModel} /></div>
      : <DraggableResizablePanel panel="answer" nativePanel={nativeSurface === "answer" ? "answer" : undefined} layout={{ ...layout.answer, visible: true, locked: !layoutEditMode && (layout.answer.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="answer-panel"><div className="answer-content-stack"><AnswerOverlayContent viewModel={answerViewModel} />{writtenTestMode && <div className="written-test-action hud-interactive-region"><span>按 Ctrl+Alt+S 截取当前题目</span><button onClick={() => void submitScreenshot()} disabled={answerSending}>截图回答</button></div>}</div></DraggableResizablePanel>)}
    {layoutEditMode && !visualHidden && <div className="layout-edit-toolbar hud-interactive-region"><span>布局编辑模式</span><button onClick={() => void window.interviewCopilot.overlay.finishLayoutEditMode()}>完成布局</button></div>}
    {!visualHidden && <div className={`hud-protection-indicator ${protectionTone}`} aria-hidden="true">{effectiveProtectionEnabled ? "◈" : "·"}</div>}
  </main>;
}
