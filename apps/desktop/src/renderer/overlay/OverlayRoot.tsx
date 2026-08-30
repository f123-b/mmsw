import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type JSX, type RefObject } from "react";
import type { AnswerThread, TranscriptSnapshot } from "@interview-copilot/shared";
import type { HUDLayout, HUDState, OverlayMode } from "../../main/overlay-manager";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../../shared/overlay-preferences";
import { resolveOverlayPersistedGeometry, toRelativeOverlayBounds } from "../../shared/overlay-layout";
import { boundsForPanel, clampDesignerRect, resizeDesignerRect, snapDesignerRect, type DesignerPanel, type ResizeHandle } from "./overlay-designer";
import { isDisplayableQuestionGroup, type RuntimePhaseState } from "./runtime-state";
import { buildAnswerOverlayViewModel, buildDialogueOverlayViewModel, buildQuestionOverlayViewModel, type AnswerOverlayViewModel, type DialogueSpeakingBlock, type QuestionOverlayViewModel } from "./view-models";

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
  remoteTranscript?: TranscriptSnapshot;
  micTranscript?: TranscriptSnapshot;
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

function viewportDefaults(preferences = DEFAULT_OVERLAY_PREFERENCES, surface: OverlaySurface | undefined = undefined, operationMode: OverlayRootProps["operationMode"] = "INTERVIEW"): OverlayLayout {
  if (surface === "control") return { ...defaults, toolbar: { ...defaults.toolbar, width: window.innerWidth, height: window.innerHeight }, transcript: { ...defaults.transcript, visible: false }, answer: { ...defaults.answer, visible: false } };
  if (surface === "question") return { ...defaults, toolbar: { ...defaults.toolbar, visible: false }, transcript: { ...defaults.transcript, width: window.innerWidth, height: window.innerHeight }, answer: { ...defaults.answer, visible: false } };
  if (surface === "answer") return { ...defaults, toolbar: { ...defaults.toolbar, visible: false }, transcript: { ...defaults.transcript, visible: false }, answer: { ...defaults.answer, width: window.innerWidth, height: window.innerHeight } };
  const mode = operationMode === "WRITTEN_TEST" ? "written_test" : "interview";
  const source = mode === "written_test" ? preferences.writtenTest : preferences.interview;
  const resolved = resolveOverlayPersistedGeometry({ mode, preset: source.layoutPreset, workArea: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, questionWindow: source.questionWindow, answerWindow: source.answerWindow, controlBar: source.controlBar });
  const relative = { question: toRelativeOverlayBounds(resolved.question, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }), answer: toRelativeOverlayBounds(resolved.answer, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }), control: toRelativeOverlayBounds(resolved.control, { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }) };
  return {
    toolbar: { ...defaults.toolbar, x: relative.control.x, y: relative.control.y, width: relative.control.width, height: relative.control.height },
    transcript: { ...defaults.transcript, x: relative.question.x, y: relative.question.y, width: relative.question.width, height: relative.question.height },
    answer: { ...defaults.answer, x: relative.answer.x, y: relative.answer.y, width: relative.answer.width, height: relative.answer.height }
  };
}

function clampLayout(panel: PanelKey, layout: PanelLayout): PanelLayout {
  const designerPanel: DesignerPanel = panel === "transcript" ? "question" : panel === "answer" ? "answer" : "controlBar";
  const next = clampDesignerRect({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, { width: window.innerWidth, height: window.innerHeight }, boundsForPanel(designerPanel));
  return { ...layout, ...next };
}

function useOverlayLayout(preferences: OverlayPreferences, surface: OverlaySurface | undefined, operationMode: OverlayRootProps["operationMode"]): [OverlayLayout, (key: PanelKey, patch: Partial<PanelLayout>, altPressed?: boolean) => void, (next: HUDLayout) => void, () => void, () => OverlayLayout] {
  const [layout, setLayout] = useState<OverlayLayout>(() => viewportDefaults(preferences, surface, operationMode));
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
  const applyMainLayout = useCallback((_next: HUDLayout) => { const next = viewportDefaults(preferencesRef.current, surface, operationMode); layoutRef.current = next; setLayout(next); }, [surface, operationMode]);
  const clearSavedLayout = useCallback(() => { const next = viewportDefaults(preferencesRef.current, surface, operationMode); layoutRef.current = next; setLayout(next); }, [surface, operationMode]);
  useEffect(() => {
    setLayout((current) => {
      const next = viewportDefaults(preferences, surface, operationMode);
      const merged = { ...current, transcript: { ...next.transcript }, answer: { ...next.answer }, toolbar: { ...current.toolbar, ...next.toolbar } };
      layoutRef.current = merged;
      return merged;
    });
  }, [surface, preferences, operationMode]);
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

function useScrollFollow(ref: RefObject<HTMLDivElement | null>, contentKey: string, enabled = true): { following: boolean; onScroll: () => void; follow: () => void } {
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled || !following) return;
    element.scrollTop = element.scrollHeight;
  }, [contentKey, enabled, following, ref]);
  const onScroll = () => {
    const element = ref.current;
    if (!element) return;
    setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 18);
  };
  const follow = () => {
    const element = ref.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setFollowing(true);
  };
  return { following, onScroll, follow };
}

function LatestButton({ visible, onClick }: { visible: boolean; onClick: () => void }): JSX.Element | null {
  return visible ? <button type="button" className="overlay-latest-button hud-interactive-region" onClick={onClick}>回到最新</button> : null;
}

function QuestionOverlayContent({ groups, viewModel }: { groups: OverlayRootProps["questionGroups"]; viewModel: QuestionOverlayViewModel }): JSX.Element {
  const older = groups.filter((group) => isDisplayableQuestionGroup(group) && group.id !== viewModel.activeGroupId).reverse();
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useScrollFollow(scrollRef, `${viewModel.currentQuestion ?? ""}:${viewModel.currentFollowUp ?? ""}:${older.length}`);
  return <section className="overlay-panel-card question-card question-overlay-content" data-overlay-content="question" aria-label="当前问题">
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      <div className="overlay-content-status"><span className="content-status-dot" />{viewModel.status === "detected" ? "已识别" : "正在听取"}</div>
      <p className="current-question-text">{compactText(viewModel.currentQuestion)}</p>
      {viewModel.currentFollowUp && <div className="current-follow-up"><span>追问</span><strong>{compactText(viewModel.currentFollowUp, 220)}</strong></div>}
      {viewModel.hasHistory && <details className="overlay-history"><summary>历史 {viewModel.historyCount}</summary>{older.map((group) => <p className="overlay-history-item" key={group.id}>{compactText(group.primaryQuestion ?? group.title, 180)}</p>)}</details>}
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

function AnswerOverlayContent({ viewModel }: { viewModel: AnswerOverlayViewModel }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useScrollFollow(scrollRef, `${viewModel.answer}:${viewModel.streaming}`);
  return <section className="overlay-panel-card answer-card answer-overlay-content" data-overlay-content="answer" aria-label="当前回答">
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      {viewModel.question && <p className="answer-context-question">{compactText(viewModel.question, 220)}</p>}
      {viewModel.streaming && <div className="answer-content-status generating"><span className="content-status-dot" />生成中</div>}
      <div className="answer-core">{viewModel.answer ? <AnswerCore text={viewModel.answer} /> : <p className="overlay-empty">等待回答</p>}{viewModel.streaming && <span className="answer-cursor">▌</span>}</div>
      {viewModel.hasOlderAnswers && <details className="overlay-history"><summary>历史回答 {viewModel.olderAnswerCount}</summary></details>}
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

function DialogueOverlayContent({ blocks }: { blocks: DialogueSpeakingBlock[] }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useScrollFollow(scrollRef, blocks.map((block) => block.id).join("|"));
  return <section className="overlay-panel-card dialogue-card dialogue-overlay-content" data-overlay-content="dialogue" aria-label="面试对话">
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      <div className="overlay-content-status"><span className="content-status-dot" />最近对话</div>
      {blocks.length === 0 ? <p className="overlay-empty">等待面试对话</p> : blocks.map((block) => <div className={`dialogue-block dialogue-${block.speaker}`} key={block.id}><strong>{block.label}</strong><p>{block.text}</p></div>)}
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

function WrittenQuestionContent({ viewModel }: { viewModel: AnswerOverlayViewModel }): JSX.Element {
  return <section className="overlay-panel-card written-question-card written-question-content" data-overlay-content="written-question" aria-label="截图识别的问题">
    <div className="overlay-content-status"><span className="content-status-dot" />笔试 · 识别题目</div>
    <p className="current-question-text">{compactText(viewModel.question, 600)}</p>
  </section>;
}

function WrittenTestReaderContent({ viewModel }: { viewModel: AnswerOverlayViewModel }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useScrollFollow(scrollRef, `${viewModel.question}:${viewModel.answer}:${viewModel.streaming}`);
  return <section className="overlay-panel-card written-reader-card written-reader-content" data-overlay-content="written-test" aria-label="笔试阅读器">
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      <div className="overlay-content-status"><span className="content-status-dot" />笔试 · {viewModel.answer ? "回答" : "等待截图"}</div>
      <h2>截图识别的问题</h2>
      <p className="written-reader-question">{compactText(viewModel.question, 600)}</p>
      <div className="written-reader-divider" />
      <h2>AI 回答</h2>
      <div className="answer-core">{viewModel.answer ? <AnswerCore text={viewModel.answer} /> : <p className="overlay-empty">按 Ctrl + Alt + S 截图识别并回答</p>}{viewModel.streaming && <span className="answer-cursor">▌</span>}</div>
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

const DESIGNER_QUESTION_GROUPS: OverlayRootProps["questionGroups"] = [{ id: "designer-question-group", title: "布局编辑示例", primaryQuestion: "CAN 总线是什么？", displayable: true, hasAnswerableQuestion: true, items: [{ id: "designer-question", questionId: "designer-question", text: "CAN 总线是什么？", type: "NEW_TOPIC", answerable: true, state: "detected" }], slots: [], updatedAt: 0 }];
const DESIGNER_ANSWER_THREADS: AnswerThread[] = [{ groupId: "designer-question-group", questionId: "designer-question", title: "CAN 总线是什么？", answers: [{ answerId: "designer-answer", questionId: "designer-question", groupId: "designer-question-group", questionText: "CAN 总线是什么？", answerText: "CAN 使用基于 ID 的逐位仲裁，显性位会覆盖隐性位，适合可靠的实时通信。", relation: "PRIMARY", status: "complete", visible: true, startedAt: 0, finishedAt: 0 }], createdAt: 0, updatedAt: 0 }];

export function OverlayRoot(props: OverlayRootProps): JSX.Element {
  const panel = props.panel ?? "all";
  const nativeSurface = props.surface;
  const writtenTestMode = props.operationMode === "WRITTEN_TEST";
  const [preferences, setPreferences] = useState<OverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const [layout, updateLayout, applyMainLayout, clearSavedLayout, getCurrentLayout] = useOverlayLayout(preferences, nativeSurface, props.operationMode);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [runtimeProtection, setRuntimeProtection] = useState<{ requested: boolean; osFlagApplied: boolean; displayCaptureVerified: boolean | null; lastError?: string }>();
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
  const interviewPreferences = preferences.interview;
  const writtenPreferences = preferences.writtenTest;
  const leftPanel = writtenTestMode ? "question" : interviewPreferences.leftPanel;
  const transcriptVisible = !visualHidden && leftPanel !== "hidden" && (!nativeSurface || nativeSurface === "question") && panel !== "answer" && (layoutEditMode || props.hudState.transcriptVisible);
  const answerVisible = !visualHidden && (!nativeSurface || nativeSurface === "answer") && panel !== "question" && (writtenTestMode ? writtenPreferences.showAnswer : interviewPreferences.showAnswer) && (layoutEditMode || props.hudState.answerVisible);
  const singleWrittenReader = writtenTestMode && writtenPreferences.layoutPreset === "single_reader";
  const displayedGroups = layoutEditMode && props.questionGroups.length === 0 ? DESIGNER_QUESTION_GROUPS : props.questionGroups;
  const displayedThreads = layoutEditMode && props.answerThreads.length === 0 ? DESIGNER_ANSWER_THREADS : props.answerThreads;
  const questionViewModel = buildQuestionOverlayViewModel(displayedGroups, props.activeQuestionGroupId, props.question?.text);
  const answerViewModel = buildAnswerOverlayViewModel(displayedThreads, props.activeAnswerGroupId, props.question?.text, props.answerText, props.answerStreaming);
  const dialogueBlocks = buildDialogueOverlayViewModel(props.remoteTranscript, props.micTranscript);
  useNativeContentSize(nativeSurface === "question" ? "question" : nativeSurface === "answer" ? "answer" : undefined, nativeContentRef, !layoutEditMode && !visualHidden && !writtenTestMode && interviewPreferences.layoutPreset === "minimal");
  const persistLayout = useCallback(() => {
    // Native drag/resize already commits absolute BrowserWindow bounds through
    // setWindowBounds(), whose Main callback converts them to work-area
    // relative preferences. Writing this renderer viewport back here would
    // replace the real display-relative coordinates with 0-based local ones.
    if (nativeSurface) return;
    const current = getCurrentLayout();
    const patch = (panelLayout: PanelLayout) => ({ x: panelLayout.x, y: panelLayout.y, width: panelLayout.width, height: panelLayout.height });
    const leftPatch = patch(current.transcript);
    const section = props.operationMode === "WRITTEN_TEST"
      ? { writtenTest: { questionWindow: leftPatch, answerWindow: patch(current.answer), controlBar: patch(current.toolbar) } }
      : { interview: { questionWindow: leftPatch, answerWindow: patch(current.answer), controlBar: patch(current.toolbar) } };
    void window.interviewCopilot.overlay.setPreferences(section);
  }, [getCurrentLayout, nativeSurface, props.operationMode]);
  const effectiveProtectionEnabled = runtimeProtection?.requested ?? props.captureProtectionEnabled;
  const protectionTone = !effectiveProtectionEnabled ? "off" : runtimeProtection?.displayCaptureVerified === true ? "verified" : "requested";
  return <main className="overlay-root" data-overlay-surface={nativeSurface ?? "designer"} data-hud-mode={props.hudState.mode} data-share-mode={props.hudState.shareMode ? "on" : "off"} data-overlay-mode={props.overlayMode} data-layout-edit-mode={layoutEditMode ? "on" : "off"} data-appearance-mode={preferences.appearance.mode} data-operation-mode={props.operationMode}>
    {props.captureTest && !visualHidden && <div className="capture-test-marker">CAPTURE_PROTECTION_TEST_MARKER_7F32</div>}
    {transcriptVisible && (nativeSurface === "question" && !layoutEditMode
      ? <div ref={nativeContentRef} className="native-content-window native-window-shell question-panel">{singleWrittenReader ? <WrittenTestReaderContent viewModel={answerViewModel} /> : writtenTestMode ? <WrittenQuestionContent viewModel={answerViewModel} /> : leftPanel === "dialogue" ? <DialogueOverlayContent blocks={dialogueBlocks} /> : <QuestionOverlayContent groups={displayedGroups} viewModel={questionViewModel} />}</div>
      : <DraggableResizablePanel panel="transcript" nativePanel={nativeSurface === "question" ? "question" : undefined} layout={{ ...layout.transcript, visible: true, locked: !layoutEditMode && (layout.transcript.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="question-panel">{writtenTestMode ? <WrittenQuestionContent viewModel={answerViewModel} /> : leftPanel === "dialogue" ? <DialogueOverlayContent blocks={dialogueBlocks} /> : <QuestionOverlayContent groups={displayedGroups} viewModel={questionViewModel} />}</DraggableResizablePanel>)}
    {answerVisible && !singleWrittenReader && (nativeSurface === "answer" && !layoutEditMode
      ? <div ref={nativeContentRef} className="native-content-window native-window-shell answer-panel"><AnswerOverlayContent viewModel={answerViewModel} /></div>
      : <DraggableResizablePanel panel="answer" nativePanel={nativeSurface === "answer" ? "answer" : undefined} layout={{ ...layout.answer, visible: true, locked: !layoutEditMode && (layout.answer.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="answer-panel"><AnswerOverlayContent viewModel={answerViewModel} /></DraggableResizablePanel>)}
    {layoutEditMode && !visualHidden && <div className="layout-edit-toolbar hud-interactive-region"><span>布局编辑模式</span><button onClick={() => void window.interviewCopilot.overlay.finishLayoutEditMode()}>完成布局</button></div>}
    {!visualHidden && <div className={`hud-protection-indicator ${protectionTone}`} aria-hidden="true">{effectiveProtectionEnabled ? "◈" : "·"}</div>}
  </main>;
}
