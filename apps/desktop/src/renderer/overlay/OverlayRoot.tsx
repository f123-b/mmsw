import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type JSX, type RefObject } from "react";
import { renderDiagramSvg, type AnswerThread, type TranscriptSnapshot } from "@interview-copilot/shared";
import type { WrittenTestState } from "../../main/written-test-controller";
import { WrittenTestStatus } from "../written-test-status";
import type { HUDLayout, HUDState, OverlayMode } from "../../main/overlay-manager";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayAppearancePreferences, type OverlayPreferences, type OverlayWindowPreferences } from "../../shared/overlay-preferences";
import { resolveOverlayPersistedGeometry, toRelativeOverlayBounds } from "../../shared/overlay-layout";
import { boundsForPanel, clampDesignerRect, resizeDesignerRect, snapDesignerRect, type DesignerPanel, type ResizeHandle, type DesignerGeometryContext } from "./overlay-designer";
import { isDisplayableQuestionGroup, type RuntimePhaseState } from "./runtime-state";
import { buildAnswerOverlayViewModel, buildDialogueOverlayViewModel, buildQuestionOverlayViewModel, type AnswerOverlayViewModel, type DialogueSpeakingBlock, type QuestionOverlayViewModel } from "./view-models";
import type { SpeechScript } from "../../main/speech-script";

type PanelKey = "toolbar" | "transcript" | "answer";
export type OverlaySurface = "question" | "answer" | "script" | "control" | "transient";
export type OverlayPanelLayout = { x: number; y: number; width: number; height: number; visible: boolean; collapsed: boolean; locked: boolean; opacity: number };
type PanelLayout = OverlayPanelLayout;
type OverlayLayout = Record<PanelKey, PanelLayout>;

type OverlayCssVariables = CSSProperties & Record<`--${string}`, string>;

/** Keep preference application at the surface root instead of scattering
 * inline styles across content nodes.  Each native window/panel supplies its
 * own variables, so question, dialogue, answer and control text stay
 * independently configurable. */
export function overlayWindowStyle(windowPreferences: OverlayWindowPreferences, appearance: OverlayAppearancePreferences = DEFAULT_OVERLAY_PREFERENCES.appearance): OverlayCssVariables {
  const shadow = appearance.textShadow === "medium"
    ? "0 1px 3px rgba(0, 0, 0, .92)"
    : appearance.textShadow === "soft"
      ? "0 1px 2px rgba(0, 0, 0, .72)"
      : "none";
  return {
    "--overlay-font-size": `${windowPreferences.fontSize}px`,
    "--overlay-title-font-size": `${windowPreferences.titleFontSize}px`,
    "--overlay-font-weight": String(windowPreferences.fontWeight),
    "--overlay-line-height": String(windowPreferences.lineHeight),
    "--overlay-paragraph-gap": `${windowPreferences.paragraphGap}px`,
    "--overlay-item-gap": `${windowPreferences.itemGap}px`,
    "--overlay-padding": `${windowPreferences.padding}px`,
    "--overlay-background-color": windowPreferences.backgroundColor,
    "--overlay-background-opacity": String(windowPreferences.backgroundOpacity),
    "--overlay-text-color": windowPreferences.textColor,
    "--overlay-text-opacity": String(windowPreferences.textOpacity),
    "--overlay-border-opacity": String(windowPreferences.border ? windowPreferences.borderOpacity : 0),
    "--overlay-border-width": windowPreferences.border ? "1px" : "0px",
    "--overlay-blur": `${windowPreferences.blur}px`,
    "--overlay-radius": `${windowPreferences.radius}px`,
    "--overlay-shadow": windowPreferences.shadow ? "0 10px 26px rgba(17, 39, 67, .18)" : "none",
    "--overlay-text-shadow": shadow,
    "--overlay-text-only-shadow": "0 1px 2px rgba(0, 0, 0, .88), 0 0 1px rgba(0, 0, 0, .88)",
    "--overlay-text-outline": appearance.textOutline ? `${appearance.textOutline}px` : "0px"
  };
}

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
  runtimeNotice?: string;
  questionIssues?: Record<string, string>;
  automationMode: "MANUAL" | "AUTO";
  answerMode: "FAST" | "NORMAL" | "DEEP";
  writtenTest: WrittenTestState;
  question?: { text: string };
  answerText: string;
  answerStreaming: boolean;
  screenshot?: { dataUrl: string };
  questionGroups: Array<{ id: string; title: string; primaryQuestion?: string; displayable?: boolean; hasAnswerableQuestion?: boolean; status?: "collecting" | "answering" | "active" | "closed"; items: Array<{ id: string; questionId: string; text: string; type: string; answerable: boolean; state: string; sequence?: number }>; slots: Array<{ id: string; text: string; status: string }>; updatedAt: number }>;
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
  onToggleScript: () => void;
  onToggleShortcuts: () => void;
  onRequestEndInterview: () => void;
  onToggleShare: () => void;
  speechScript?: SpeechScript;
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

function clampLayout(panel: PanelKey, layout: PanelLayout, preferences: OverlayPreferences, operationMode: OverlayRootProps["operationMode"]): PanelLayout {
  const designerPanel: DesignerPanel = panel === "transcript" ? "question" : panel === "answer" ? "answer" : "controlBar";
  const source = operationMode === "WRITTEN_TEST" ? preferences.writtenTest : preferences.interview;
  const next = clampDesignerRect({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, { width: window.innerWidth, height: window.innerHeight }, boundsForPanel({ panel: designerPanel, mode: operationMode === "WRITTEN_TEST" ? "writtenTest" : "interview", preset: source.layoutPreset }));
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
    const source = operationMode === "WRITTEN_TEST" ? preferencesRef.current.writtenTest : preferencesRef.current.interview;
    const snapped = designerPanel && preferencesRef.current.behavior.snapEnabled
      ? snapDesignerRect({ panel: designerPanel, mode: operationMode === "WRITTEN_TEST" ? "writtenTest" : "interview", preset: source.layoutPreset }, nextPanel, { question: current.transcript, answer: current.answer, controlBar: current.toolbar }, { width: window.innerWidth, height: window.innerHeight }, preferencesRef.current.behavior.snapThreshold, altPressed)
      : nextPanel;
    const next = { ...current, [key]: clampLayout(key, { ...nextPanel, ...snapped }, preferencesRef.current, operationMode) };
    layoutRef.current = next;
    return next;
  }), [operationMode]);
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
  geometryMode: DesignerGeometryContext["mode"];
  geometryPreset: DesignerGeometryContext["preset"];
  windowPreferences?: OverlayWindowPreferences;
  appearance?: OverlayAppearancePreferences;
}

export function DraggableResizablePanel({ panel, layout, onChange, onCommit, editMode, className, children, nativePanel, geometryMode, geometryPreset, windowPreferences, appearance }: DraggableResizablePanelProps): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => cleanupRef.current?.(), []);
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editMode || layout.locked || (event.target as HTMLElement).closest("button, input, textarea, select, .resize-handle, .overlay-scroll-region")) return;
    const origin = { x: event.clientX - layout.x, y: event.clientY - layout.y };
    const nativeOrigin = nativePanel ? { x: window.screenX, y: window.screenY, width: window.outerWidth, height: window.outerHeight } : undefined;
    setDragging(true);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* best effort */ }
    let pendingBounds: { x: number; y: number; width: number; height: number } | undefined;
    let raf = 0;
    const flush = () => { raf = 0; if (nativePanel && pendingBounds) void window.interviewCopilot.overlay.setWindowBounds(nativePanel, pendingBounds, false); };
    const move = (next: PointerEvent) => {
      const nextLayout = { x: next.clientX - origin.x, y: next.clientY - origin.y };
      onChange(panel, nextLayout, next.altKey);
      if (nativePanel && nativeOrigin) { pendingBounds = { x: nativeOrigin.x + nextLayout.x - layout.x, y: nativeOrigin.y + nextLayout.y - layout.y, width: nativeOrigin.width, height: nativeOrigin.height }; if (!raf) raf = requestAnimationFrame(flush); }
    };
    const end = () => { if (raf) cancelAnimationFrame(raf); if (nativePanel && pendingBounds) void window.interviewCopilot.overlay.setWindowBounds(nativePanel, pendingBounds, true); setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); cleanupRef.current = undefined; onCommit(); };
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
    let pendingBounds: { x: number; y: number; width: number; height: number } | undefined;
    let raf = 0;
    const flush = () => { raf = 0; if (nativePanel && pendingBounds) void window.interviewCopilot.overlay.setWindowBounds(nativePanel, pendingBounds, false); };
    const move = (next: PointerEvent) => {
      const designerPanel: DesignerPanel = panel === "transcript" ? "question" : panel === "answer" ? "answer" : "controlBar";
      const resized = resizeDesignerRect({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, handle, { x: next.clientX - start.x, y: next.clientY - start.y }, { width: window.innerWidth, height: window.innerHeight }, boundsForPanel({ panel: designerPanel, mode: geometryMode, preset: geometryPreset }), next.altKey);
      onChange(panel, resized, next.altKey);
      if (nativePanel && nativeOrigin) { pendingBounds = { x: nativeOrigin.x + resized.x - layout.x, y: nativeOrigin.y + resized.y - layout.y, width: nativeOrigin.width + resized.width - layout.width, height: nativeOrigin.height + resized.height - layout.height }; if (!raf) raf = requestAnimationFrame(flush); }
    };
    const end = () => { if (raf) cancelAnimationFrame(raf); if (nativePanel && pendingBounds) void window.interviewCopilot.overlay.setWindowBounds(nativePanel, pendingBounds, true); setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); window.removeEventListener("blur", end); cleanupRef.current = undefined; onCommit(); };
    setDragging(true);
    cleanupRef.current = end;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    window.addEventListener("blur", end, { once: true });
  };
  const panelStyle = { left: layout.x, top: layout.y, width: layout.width, height: layout.height, display: layout.visible ? undefined : "none", ...(windowPreferences ? overlayWindowStyle(windowPreferences, appearance) : {}) } as CSSProperties;
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

function useScrollFollow(ref: RefObject<HTMLDivElement | null>, contentKey: string, enabled = true, resetKey?: string): { following: boolean; onScroll: () => void; follow: () => void } {
  const [following, setFollowing] = useState(true);
  const lastResetKey = useRef(resetKey);
  useLayoutEffect(() => {
    const element = ref.current;
    const newQuestion = resetKey !== lastResetKey.current;
    lastResetKey.current = resetKey;
    if (!element || !enabled || (!following && !newQuestion)) return;
    element.scrollTop = element.scrollHeight;
    if (newQuestion) setFollowing(true);
  }, [contentKey, resetKey, enabled, following, ref]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { if (enabled && following) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, following, ref]);
  const onScroll = () => {
    const element = ref.current;
    if (!element) return;
    const atTail = element.scrollHeight - element.scrollTop - element.clientHeight < 18;
    setFollowing(atTail);
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

function QuestionOverlayContent({ groups, viewModel, autoFollow, notice }: { groups: OverlayRootProps["questionGroups"]; viewModel: QuestionOverlayViewModel; autoFollow: boolean; notice?: string }): JSX.Element {
  const older = groups.filter((group) => isDisplayableQuestionGroup(group) && group.id !== viewModel.activeGroupId).reverse();
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useScrollFollow(scrollRef, `${viewModel.currentQuestion ?? ""}:${viewModel.currentFollowUp ?? ""}:${older.length}`, autoFollow);
  return <section className="overlay-panel-card question-card question-overlay-content" data-overlay-content="question" aria-label="当前问题">
    <div className="overlay-panel-drag-handle" data-layout-drag-handle="true" aria-label="拖动问题悬浮窗">布局编辑 · 拖动窗口</div>
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      <div className="overlay-content-status"><span className="content-status-dot" />{viewModel.status === "detected" ? "已识别" : "正在听取"}</div>
      {notice && <p className="overlay-runtime-notice" role="status">{notice}</p>}
      <p className="current-question-text">{compactText(viewModel.currentQuestion)}</p>
      {viewModel.currentFollowUp && <div className="current-follow-up"><span>追问</span><strong>{compactText(viewModel.currentFollowUp, 220)}</strong></div>}
      {viewModel.hasHistory && <details className="overlay-history"><summary>历史 {viewModel.historyCount}</summary>{older.map((group) => <p className="overlay-history-item" key={group.id}>{compactText(group.primaryQuestion ?? group.title, 180)}</p>)}</details>}
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

function AnswerOverlayContent({ viewModel, autoFollow, notice }: { viewModel: AnswerOverlayViewModel; autoFollow: boolean; notice?: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const standaloneNotice = notice && !viewModel.items.some(item => item.status === "blocked" && item.answer === notice) ? notice : undefined;
  const follow = useScrollFollow(scrollRef, viewModel.items.map(item => `${item.id}:${item.status}:${item.answer}`).join("|"), autoFollow, viewModel.items.at(-1)?.questionId);
  return <section className="overlay-panel-card answer-card answer-overlay-content" data-overlay-content="answer" aria-label="连续问答">
    <div className="overlay-panel-drag-handle" data-layout-drag-handle="true" aria-label="拖动回答悬浮窗">布局编辑 · 拖动窗口</div>
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      <div className="answer-content-stack">
        {viewModel.items.length === 0 && <p className="overlay-empty">等待提问 · 回答会依次保留在这里</p>}
        {viewModel.items.map((item, index) => <article className="answer-feed-item" data-answer-id={item.id} key={item.id}>
          <div className="answer-feed-heading"><span className="answer-feed-number">{String(index + 1).padStart(2, "0")}</span><p className="answer-context-question">{item.question}</p></div>
          <div className="answer-core">{item.answer ? <AnswerCore text={item.answer} /> : <p className="overlay-empty">{["cancelled", "failed", "blocked"].includes(item.status) ? "本题暂未生成答案，请核对识别文字或项目资料后重试。" : item.status === "answering" || item.status === "generating" ? "正在组织回答…" : "已识别，等待回答…"}</p>}{item.status === "generating" && <span className="answer-cursor">▌</span>}</div>
          {["cancelled", "failed", "blocked"].includes(item.status) && <button className="answer-retry hud-interactive-region" onClick={() => void window.interviewCopilot.interview.answerQuestion(item.question)}>重试本题</button>}
        </article>)}
      </div>
      {standaloneNotice && <p className="overlay-runtime-notice" role="status">{standaloneNotice}</p>}
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

function DialogueOverlayContent({ blocks, autoFollow }: { blocks: DialogueSpeakingBlock[]; autoFollow: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useScrollFollow(scrollRef, blocks.map((block) => `${block.id}:${block.text}`).join("|"), autoFollow);
  return <section className="overlay-panel-card dialogue-card dialogue-overlay-content" data-overlay-content="dialogue" aria-label="面试对话">
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      <div className="overlay-content-status"><span className="content-status-dot" />实时对话 · 面试官在左，我在右</div>
      {blocks.length === 0 ? <p className="overlay-empty">等待面试对话</p> : blocks.map((block) => <div className={`dialogue-block dialogue-${block.speaker}`} key={block.id}><strong>{block.label}</strong><p>{block.text}</p></div>)}
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

function WrittenQuestionContent({ viewModel, writtenTest }: { viewModel: AnswerOverlayViewModel; writtenTest: WrittenTestState }): JSX.Element {
  return <section className="overlay-panel-card written-question-card written-question-content" data-overlay-content="written-question" aria-label="截图识别的问题">
    <header className="written-panel-header"><span>笔试练习</span><strong>题目 · {String(writtenTest.questionCount || 1).padStart(2, "0")}</strong></header>
    <div className="overlay-scroll-region" tabIndex={0}>
    <WrittenTestStatus state={writtenTest} />
    <p className="written-question-type">{writtenTest.currentProblem?.questionType ?? "UNKNOWN"}</p>
    <p className="current-question-text">{["CAPTURING", "ANALYZING", "SOLVING"].includes(writtenTest.screenshotStatus) ? "正在读取新截图…" : writtenTest.currentProblem?.canonicalQuestion ?? "等待识别题目"}</p>
    {writtenTest.currentProblem?.requirements.length ? <div className="written-requirements"><strong>要求</strong>{writtenTest.currentProblem.requirements.slice(0, 4).map((item) => <span key={item}>{item}</span>)}</div> : null}
    </div>
  </section>;
}

function WrittenStructuredAnswerContent({ viewModel, writtenTest, screenshot }: { viewModel: AnswerOverlayViewModel; writtenTest: WrittenTestState; screenshot?: { dataUrl: string } }): JSX.Element {
  const [tab, setTab] = useState<"answer" | "code" | "diagram" | "steps" | "original">("answer");
  const answer = writtenTest.currentAnswer;
  const availableTabs = ["answer", ...(answer?.code ? ["code"] : []), ...(answer?.diagram ? ["diagram"] : []), ...(answer?.steps.length ? ["steps"] : []), ...(screenshot ? ["original"] : [])] as typeof tab[];
  useEffect(() => { if (!availableTabs.includes(tab)) setTab(availableTabs[0] ?? "answer"); }, [answer?.code, answer?.diagram, answer?.steps.length, screenshot]);
  useEffect(() => { setTab("answer"); }, [answer]);
  return <section className="written-structured-answer" aria-label="结构化笔试答案">
    <div className="written-answer-tabs">{availableTabs.map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{({ answer: "结论", code: "代码", diagram: "图示", steps: "步骤", original: "原图" } as Record<string, string>)[item]}</button>)}</div>
    <div className="written-answer-tab-content">
      {tab === "answer" && <><strong>{answer?.questionType ?? "笔试练习"}</strong><div className="answer-core">{answer ? <p className="written-explanation">{answer.finalAnswer}</p> : <p className="overlay-empty">{["CAPTURING", "ANALYZING", "SOLVING"].includes(writtenTest.screenshotStatus) ? "正在处理，完成检查后显示答案…" : "暂无通过检查的答案，请查看处理状态。"}</p>}</div>{answer?.explanation && <p className="written-explanation">{answer.explanation}</p>}{answer?.equations.length ? <div className="written-equations"><strong>公式</strong>{answer.equations.map((equation, index) => <pre key={index}>{equation}</pre>)}</div> : null}{answer?.table && <div className="written-table-scroll"><table><thead><tr>{answer.table.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{answer.table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}{answer?.complexity && <p className="written-explanation">复杂度：{answer.complexity}</p>}{answer?.warnings.map((warning) => <small className="written-warning" key={warning}>⚠ {warning}</small>)}</>}
      {tab === "code" && <pre className="written-code-block"><code>{answer?.code?.content ?? "暂无完整代码"}</code></pre>}
      {tab === "diagram" && answer?.diagram && <img className="written-diagram" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderDiagramSvg(answer.diagram))}`} alt={answer.diagram.title ?? "题目关系图"} />}
      {tab === "steps" && <ol className="written-step-list">{answer?.steps.map((step) => <li key={`${step.title}-${step.content}`}><strong>{step.title}</strong><span>{step.content}</span></li>)}</ol>}
      {tab === "original" && screenshot && <img className="written-original-image" src={screenshot.dataUrl} alt="笔试原始截图" />}
    </div>
  </section>;
}

function WrittenTestReaderContent({ viewModel, writtenTest, screenshot, autoFollow }: { viewModel: AnswerOverlayViewModel; writtenTest: WrittenTestState; screenshot?: { dataUrl: string }; autoFollow: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useScrollFollow(scrollRef, `${writtenTest.currentQuestion?.id}:${writtenTest.screenshotStatus}`, autoFollow);
  return <section className="overlay-panel-card written-reader-card written-reader-content" data-overlay-content="written-test" aria-label="笔试阅读器">
    <header className="written-panel-header"><span>笔试练习</span><strong>题目与解答 · {String(writtenTest.questionCount || 1).padStart(2, "0")}</strong></header>
    <div ref={scrollRef} className="overlay-scroll-region" onScroll={follow.onScroll} tabIndex={0}>
      <WrittenTestStatus state={writtenTest} />
      <h2>截图识别的问题</h2>
      <p className="written-reader-question">{["CAPTURING", "ANALYZING", "SOLVING"].includes(writtenTest.screenshotStatus) ? "正在读取新截图…" : writtenTest.currentProblem?.canonicalQuestion ?? "等待识别题目"}</p>
      <div className="written-reader-divider" />
      <h2>AI 回答</h2>
      <WrittenStructuredAnswerContent viewModel={viewModel} writtenTest={writtenTest} screenshot={screenshot} />
    </div>
    <LatestButton visible={!follow.following} onClick={follow.follow} />
  </section>;
}

function WrittenAnswerPanel(props: { viewModel: AnswerOverlayViewModel; writtenTest: WrittenTestState; screenshot?: { dataUrl: string } }): JSX.Element {
  return <section className="overlay-panel-card written-answer-panel" aria-label="笔试解答"><header className="written-panel-header"><span>AI ASSISTANT</span><strong>解答 · {String(props.writtenTest.questionCount || 1).padStart(2, "0")}</strong></header><div className="overlay-scroll-region" tabIndex={0}><WrittenTestStatus state={props.writtenTest} /><WrittenStructuredAnswerContent {...props} /></div></section>;
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
  const autoFollowQuestion = preferences.behavior.followLatestQuestion;
  const autoFollowAnswer = preferences.behavior.followLatestAnswer;
  const transcriptVisible = !visualHidden && leftPanel !== "hidden" && (!nativeSurface || nativeSurface === "question") && panel !== "answer" && (layoutEditMode || props.hudState.transcriptVisible);
  const answerVisible = !visualHidden && (!nativeSurface || nativeSurface === "answer") && panel !== "question" && (writtenTestMode ? writtenPreferences.showAnswer : interviewPreferences.showAnswer) && (layoutEditMode || props.hudState.answerVisible);
  const singleWrittenReader = writtenTestMode && writtenPreferences.layoutPreset === "single_reader";
  const questionPreferences = writtenTestMode ? writtenPreferences.questionWindow : leftPanel === "dialogue" ? interviewPreferences.dialogueWindow : interviewPreferences.questionWindow;
  const answerPreferences = writtenTestMode ? writtenPreferences.answerWindow : interviewPreferences.answerWindow;
  const displayedGroups = layoutEditMode && props.questionGroups.length === 0 ? DESIGNER_QUESTION_GROUPS : props.questionGroups;
  const displayedThreads = layoutEditMode && props.answerThreads.length === 0 ? DESIGNER_ANSWER_THREADS : props.answerThreads;
  const questionViewModel = buildQuestionOverlayViewModel(displayedGroups, props.activeQuestionGroupId, props.question?.text);
  const answerViewModel = buildAnswerOverlayViewModel(displayedThreads, props.activeAnswerGroupId, props.question?.text, props.answerText, props.answerStreaming, displayedGroups, props.questionIssues);
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
  return <main className="overlay-root" data-overlay-surface={nativeSurface ?? "designer"} data-hud-mode={props.hudState.mode} data-share-mode={props.hudState.shareMode ? "on" : "off"} data-overlay-mode={props.overlayMode} data-layout-edit-mode={layoutEditMode ? "on" : "off"} data-ui-style={preferences.appearance.uiStyle} data-appearance-mode={preferences.appearance.mode} data-operation-mode={props.operationMode}>
    {props.captureTest && !visualHidden && <div className="capture-test-marker">CAPTURE_PROTECTION_TEST_MARKER_7F32</div>}
    {transcriptVisible && (nativeSurface === "question" && !layoutEditMode
      ? <div ref={nativeContentRef} className="native-content-window native-window-shell question-panel" style={overlayWindowStyle(questionPreferences, preferences.appearance)}>{singleWrittenReader ? <WrittenTestReaderContent viewModel={answerViewModel} writtenTest={props.writtenTest} screenshot={props.screenshot} autoFollow={autoFollowAnswer} /> : writtenTestMode ? <WrittenQuestionContent viewModel={answerViewModel} writtenTest={props.writtenTest} /> : leftPanel === "dialogue" ? <DialogueOverlayContent blocks={dialogueBlocks} autoFollow={autoFollowQuestion} /> : <QuestionOverlayContent notice={props.runtimeNotice} groups={displayedGroups} viewModel={questionViewModel} autoFollow={autoFollowQuestion} />}</div>
      : <DraggableResizablePanel panel="transcript" nativePanel={nativeSurface === "question" ? "question" : undefined} geometryMode={writtenTestMode ? "writtenTest" : "interview"} geometryPreset={writtenTestMode ? writtenPreferences.layoutPreset : interviewPreferences.layoutPreset} layout={{ ...layout.transcript, visible: true, locked: !layoutEditMode && (layout.transcript.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="question-panel" windowPreferences={questionPreferences} appearance={preferences.appearance}>{writtenTestMode ? <WrittenQuestionContent viewModel={answerViewModel} writtenTest={props.writtenTest} /> : leftPanel === "dialogue" ? <DialogueOverlayContent blocks={dialogueBlocks} autoFollow={autoFollowQuestion} /> : <QuestionOverlayContent notice={props.runtimeNotice} groups={displayedGroups} viewModel={questionViewModel} autoFollow={autoFollowQuestion} />}</DraggableResizablePanel>)}
    {answerVisible && !singleWrittenReader && (nativeSurface === "answer" && !layoutEditMode
      ? <div ref={nativeContentRef} className="native-content-window native-window-shell answer-panel" style={overlayWindowStyle(answerPreferences, preferences.appearance)}>{writtenTestMode ? <WrittenAnswerPanel viewModel={answerViewModel} writtenTest={props.writtenTest} screenshot={props.screenshot} /> : <AnswerOverlayContent notice={props.runtimeNotice} viewModel={answerViewModel} autoFollow={autoFollowAnswer} />}</div>
      : <DraggableResizablePanel panel="answer" nativePanel={nativeSurface === "answer" ? "answer" : undefined} geometryMode={writtenTestMode ? "writtenTest" : "interview"} geometryPreset={writtenTestMode ? writtenPreferences.layoutPreset : interviewPreferences.layoutPreset} layout={{ ...layout.answer, visible: true, locked: !layoutEditMode && (layout.answer.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="answer-panel" windowPreferences={answerPreferences} appearance={answerPreferences ? preferences.appearance : preferences.appearance}>{writtenTestMode ? <WrittenAnswerPanel viewModel={answerViewModel} writtenTest={props.writtenTest} screenshot={props.screenshot} /> : <AnswerOverlayContent notice={props.runtimeNotice} viewModel={answerViewModel} autoFollow={autoFollowAnswer} />}</DraggableResizablePanel>)}
    {layoutEditMode && !visualHidden && <div className="layout-edit-toolbar hud-interactive-region"><span>布局编辑模式</span><button onClick={() => void window.interviewCopilot.overlay.finishLayoutEditMode()}>完成布局</button></div>}
    {!visualHidden && <div className={`hud-protection-indicator ${protectionTone}`} aria-hidden="true">{effectiveProtectionEnabled ? "◈" : "·"}</div>}
  </main>;
}
