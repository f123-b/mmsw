import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type JSX } from "react";
import type { AnswerThread } from "@interview-copilot/shared";
import type { HUDLayout, HUDState, OverlayMode } from "../../main/overlay-manager";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../../shared/overlay-preferences";
import { followModeAfterScroll, newContentBadgeLabel, shouldAutoFollowLatest, type OverlayFollowMode } from "./overlay-interaction";
import { boundsForPanel, clampDesignerRect, controlBarPosition, interactionModeAllowsOverlayInput, modifierPressed, resizeDesignerRect, snapDesignerRect, type DesignerPanel, type ResizeHandle } from "./overlay-designer";

type HudState = "IDLE" | "LISTENING" | "QUESTION_DETECTED" | "GENERATING" | "ANSWER_READY" | "PAUSED" | "ERROR";
type PanelKey = "toolbar" | "transcript" | "answer" | "shortcuts";
type PanelLayout = { x: number; y: number; width: number; height: number; visible: boolean; collapsed: boolean; locked: boolean; opacity: number };
type OverlayLayout = Record<PanelKey, PanelLayout>;
type OverlayCommand = "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts" | "confirm-end";

interface OverlayRootProps {
  mic: number;
  system: number;
  state: string;
  sessionState: string;
  realtimeState: string;
  operationMode: "IDLE" | "INTERVIEW" | "WRITTEN_TEST";
  overlayMode: OverlayMode;
  hudState: HUDState;
  automationMode: "MANUAL" | "AUTO";
  answerMode: "FAST" | "NORMAL" | "DEEP";
  question?: { text: string };
  answerText: string;
  answerStreaming: boolean;
  questionGroups: Array<{ id: string; title: string; primaryQuestion: string; items: Array<{ id: string; questionId: string; text: string; type: string; answerable: boolean; state: string }>; slots: Array<{ id: string; text: string; status: string }>; updatedAt: number }>;
  activeQuestionGroupId?: string;
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
  onToggleShare: () => void;
  captureProtectionEnabled?: boolean;
  captureProtectionSupported?: boolean;
  captureProtectionOsFlagApplied?: boolean;
  captureProtectionDisplayVerified?: boolean | null;
  captureProtectionLastError?: string;
  onToggleCaptureProtection?: () => void;
  captureTest?: boolean;
}

const STORAGE_KEY = "interview-copilot.overlay-layout-v3";
const LEGACY_STORAGE_KEY = "interview-copilot.overlay-layout-v2";
const defaults: OverlayLayout = {
  toolbar: { x: 0, y: 80, width: 680, height: 50, visible: true, collapsed: false, locked: true, opacity: 1 },
  transcript: { x: 0, y: 320, width: 394, height: 406, visible: true, collapsed: false, locked: false, opacity: 1 },
  answer: { x: 410, y: 320, width: 670, height: 406, visible: true, collapsed: false, locked: false, opacity: 1 },
  shortcuts: { x: 24, y: 0, width: 320, height: 360, visible: false, collapsed: false, locked: false, opacity: 1 }
};

function storageKey(displayId?: number, scaleFactor?: number): string {
  return displayId === undefined ? STORAGE_KEY : `${STORAGE_KEY}-${displayId}-${Math.round((scaleFactor ?? 1) * 100)}`;
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function viewportDefaults(preferences = DEFAULT_OVERLAY_PREFERENCES): OverlayLayout {
  const preset = preferences.layoutPreset;
  const gap = 12;
  const margin = preset === "dual_screen" ? 20 : Math.max(20, Math.round((window.innerWidth - Math.min(1_340, window.innerWidth - 40)) / 2));
  const availableWidth = Math.max(0, window.innerWidth - margin * 2);
  const panelTop = Math.max(96, Math.min(150, Math.round(window.innerHeight * 0.12)));
  const panelHeight = Math.max(260, Math.min(Math.round(window.innerHeight * (preset === "compact" ? 0.46 : 0.62)), window.innerHeight - panelTop - 24));
  const presetQuestionWidth = preset === "compact" ? 360 : preset === "wide" || preset === "dual_screen" ? 500 : preferences.questionWindow.width;
  const presetAnswerWidth = preset === "compact" ? 560 : preset === "wide" || preset === "dual_screen" ? 760 : preferences.answerWindow.width;
  const totalPreferred = presetQuestionWidth + gap + presetAnswerWidth;
  const scale = totalPreferred > availableWidth ? availableWidth / Math.max(1, totalPreferred) : 1;
  const questionWidth = Math.max(220, Math.round(presetQuestionWidth * scale));
  const answerWidth = Math.max(300, Math.min(presetAnswerWidth * scale, availableWidth - questionWidth - gap));
  const totalWidth = questionWidth + gap + answerWidth;
  const horizontalMargin = Math.max(12, Math.round((window.innerWidth - totalWidth) / 2));
  const controlBarSize = preferences.controlBar.orientation === "vertical"
    ? { width: Math.max(36, Math.min(preferences.controlBar.width, 88)), height: Math.max(120, Math.min(preferences.controlBar.height * 5, window.innerHeight - 40)) }
    : { width: Math.min(preferences.controlBar.width, Math.max(220, window.innerWidth - 40)), height: Math.max(36, Math.min(preferences.controlBar.height, 240)) };
  const controlBarPoint = controlBarPosition(preferences.controlBar.positionMode, preferences.controlBar.orientation, { width: window.innerWidth, height: window.innerHeight }, controlBarSize, preferences.controlBar.x !== undefined && preferences.controlBar.y !== undefined ? { x: preferences.controlBar.x, y: preferences.controlBar.y } : undefined);
  return {
    toolbar: { ...defaults.toolbar, x: Math.round(controlBarPoint.x), y: Math.round(controlBarPoint.y), width: controlBarSize.width, height: controlBarSize.height },
    transcript: { ...defaults.transcript, x: preferences.questionWindow.x ?? horizontalMargin, y: preferences.questionWindow.y ?? panelTop, width: preferences.questionWindow.width === DEFAULT_OVERLAY_PREFERENCES.questionWindow.width && preset !== "custom" ? questionWidth : preferences.questionWindow.width, height: preferences.questionWindow.height === DEFAULT_OVERLAY_PREFERENCES.questionWindow.height && preset !== "custom" ? panelHeight : preferences.questionWindow.height },
    answer: { ...defaults.answer, x: preferences.answerWindow.x ?? horizontalMargin + questionWidth + gap, y: preferences.answerWindow.y ?? panelTop, width: preferences.answerWindow.width === DEFAULT_OVERLAY_PREFERENCES.answerWindow.width && preset !== "custom" ? answerWidth : preferences.answerWindow.width, height: preferences.answerWindow.height === DEFAULT_OVERLAY_PREFERENCES.answerWindow.height && preset !== "custom" ? panelHeight : preferences.answerWindow.height },
    shortcuts: { ...defaults.shortcuts, y: Math.max(0, window.innerHeight - 360 - 24) }
  };
}

function fromHUDLayout(next: HUDLayout): OverlayLayout {
  const panel = (key: PanelKey): PanelLayout => ({ ...next[key === "toolbar" ? "toolbar" : key], visible: true, collapsed: false, locked: key === "toolbar", opacity: 1 });
  return {
    toolbar: panel("toolbar"),
    transcript: panel("transcript"),
    answer: panel("answer"),
    shortcuts: { ...panel("shortcuts"), visible: false }
  };
}

function loadLayout(key = STORAGE_KEY, preferences = DEFAULT_OVERLAY_PREFERENCES, fallback?: OverlayLayout): OverlayLayout {
  try {
    const raw = localStorage.getItem(key) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    const saved = JSON.parse(raw ?? "{}");
    const base = fallback ?? viewportDefaults(preferences);
    const savedToolbar = saved.toolbar?.width ? saved.toolbar : {};
    const savedShortcuts = saved.shortcuts?.width ? saved.shortcuts : {};
    return Object.fromEntries(Object.entries(base).map(([panelKey, value]) => [panelKey, { ...value, ...(panelKey === "toolbar" ? savedToolbar : panelKey === "shortcuts" ? savedShortcuts : (saved[panelKey] ?? {})) }])) as OverlayLayout;
  } catch {
    return fallback ?? viewportDefaults(preferences);
  }
}

function clampLayout(panel: PanelKey, layout: PanelLayout): PanelLayout {
  if (panel === "shortcuts") return { ...layout, width: Math.max(260, Math.min(layout.width, Math.max(260, window.innerWidth - 16))), height: Math.max(120, Math.min(layout.height, Math.max(120, window.innerHeight - 16))), x: Math.max(8, Math.min(layout.x, Math.max(8, window.innerWidth - layout.width - 8))), y: Math.max(8, Math.min(layout.y, Math.max(8, window.innerHeight - layout.height - 8))) };
  const designerPanel: DesignerPanel = panel === "transcript" ? "question" : panel === "answer" ? "answer" : "controlBar";
  const next = clampDesignerRect({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, { width: window.innerWidth, height: window.innerHeight }, boundsForPanel(designerPanel));
  return { ...layout, ...next };
}

function useOverlayLayout(preferences: OverlayPreferences): [OverlayLayout, (key: PanelKey, patch: Partial<PanelLayout>, altPressed?: boolean) => void, (next: HUDLayout) => void, () => void, () => OverlayLayout] {
  const [layout, setLayout] = useState<OverlayLayout>(() => loadLayout(STORAGE_KEY, preferences));
  const storageKeyRef = useRef(STORAGE_KEY);
  const preferencesRef = useRef(preferences);
  const layoutRef = useRef(layout);
  preferencesRef.current = preferences;
  const update = useCallback((key: PanelKey, patch: Partial<PanelLayout>, altPressed = false) => setLayout((current) => {
    const nextPanel = { ...current[key], ...patch };
    const designerPanel: DesignerPanel | undefined = key === "transcript" ? "question" : key === "answer" ? "answer" : key === "toolbar" ? "controlBar" : undefined;
    const snapped = designerPanel && preferencesRef.current.behavior.snapEnabled
      ? snapDesignerRect(designerPanel, nextPanel, { question: current.transcript, answer: current.answer, controlBar: current.toolbar }, { width: window.innerWidth, height: window.innerHeight }, preferencesRef.current.behavior.snapThreshold, altPressed)
      : nextPanel;
    const next = { ...current, [key]: designerPanel ? clampLayout(key, { ...nextPanel, ...snapped }) : clampLayout(key, nextPanel) };
    layoutRef.current = next;
    try { localStorage.setItem(storageKeyRef.current, JSON.stringify(next)); } catch { /* best effort */ }
    return next;
  }), []);
  const applyMainLayout = useCallback((next: HUDLayout) => {
    const nextLayout = fromHUDLayout(next);
    storageKeyRef.current = storageKey(next.displayId, next.scaleFactor);
    const loaded = loadLayout(storageKeyRef.current, preferencesRef.current, nextLayout);
    layoutRef.current = loaded;
    setLayout(loaded);
  }, []);
  const clearSavedLayout = useCallback(() => {
    try { localStorage.removeItem(storageKeyRef.current); } catch { /* best effort */ }
    const next = viewportDefaults(preferencesRef.current);
    layoutRef.current = next;
    setLayout(next);
  }, []);
  useEffect(() => {
    setLayout((current) => {
      const next = viewportDefaults(preferences);
      // Settings coordinates are the source of truth when they change. Dragging
      // remains local until pointer-up, so this does not interrupt an in-flight
      // edit and keeps Settings → Overlay synchronization bidirectional.
      const merged = { ...current, transcript: { ...next.transcript }, answer: { ...next.answer }, toolbar: { ...current.toolbar, ...next.toolbar }, shortcuts: { ...current.shortcuts, ...next.shortcuts } };
      layoutRef.current = merged;
      try { localStorage.setItem(storageKeyRef.current, JSON.stringify(merged)); } catch { /* best effort */ }
      return merged;
    });
  }, [preferences.layoutPreset, preferences.questionWindow.x, preferences.questionWindow.y, preferences.questionWindow.width, preferences.questionWindow.height, preferences.answerWindow.x, preferences.answerWindow.y, preferences.answerWindow.width, preferences.answerWindow.height, preferences.controlBar.x, preferences.controlBar.y, preferences.controlBar.width, preferences.controlBar.height, preferences.controlBar.orientation, preferences.controlBar.positionMode]);
  return [layout, update, applyMainLayout, clearSavedLayout, () => layoutRef.current];
}

function DraggableResizablePanel({ panel, layout, onChange, onCommit, editMode, className, children }: { panel: PanelKey; layout: PanelLayout; onChange: (key: PanelKey, patch: Partial<PanelLayout>, altPressed?: boolean) => void; onCommit: () => void; editMode: boolean; className: string; children: JSX.Element }): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (layout.locked || (event.target as HTMLElement).closest("button, input, textarea, select, .resize-handle, .overlay-scroll-region") || (!editMode && (event.target as HTMLElement).closest(".overlay-content"))) return;
    const origin = { x: event.clientX - layout.x, y: event.clientY - layout.y };
    setDragging(true);
    const move = (next: PointerEvent) => onChange(panel, { x: next.clientX - origin.x, y: next.clientY - origin.y }, next.altKey);
    const end = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); onCommit(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  const beginResize = (handle: ResizeHandle, event: ReactPointerEvent<HTMLDivElement>) => {
    if (layout.locked) return;
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const move = (next: PointerEvent) => {
      const designerPanel: DesignerPanel = panel === "transcript" ? "question" : panel === "answer" ? "answer" : "controlBar";
      const resized = resizeDesignerRect({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, handle, { x: next.clientX - start.x, y: next.clientY - start.y }, { width: window.innerWidth, height: window.innerHeight }, boundsForPanel(designerPanel), next.altKey);
      onChange(panel, resized, next.altKey);
    };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); onCommit(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  // Panel transparency belongs to the background surface, never to the
  // container itself; parent opacity also fades text and harms readability.
  const panelStyle = { left: layout.x, top: layout.y, width: layout.width, height: layout.height, display: layout.visible ? undefined : "none", "--hud-panel-width": `${layout.width}px` } as CSSProperties;
  const resizeHandles: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  return <div className={`floating-panel ${className} ${dragging ? "dragging" : ""} ${editMode ? "layout-editing" : ""}`} data-panel={panel} style={panelStyle} onPointerDown={beginDrag}>{children}{!layout.locked && resizeHandles.map((handle) => <div className={`resize-handle resize-handle-${handle}`} aria-label={`调整大小 ${handle}`} key={handle} onPointerDown={(event) => beginResize(handle, event)} />)}</div>;
}

function hudState({ state, sessionState, realtimeState, operationMode, question, answerText, answerStreaming }: Pick<OverlayRootProps, "state" | "sessionState" | "realtimeState" | "operationMode" | "question" | "answerText" | "answerStreaming">): HudState {
  if (state === "FAILED" || sessionState === "ERROR" || realtimeState === "error") return "ERROR";
  if (operationMode === "WRITTEN_TEST") {
    if (answerStreaming) return "GENERATING";
    if (answerText) return "ANSWER_READY";
    return "LISTENING";
  }
  if (sessionState === "ENDING" || sessionState === "ENDED" || sessionState === "IDLE") return "IDLE";
  if (answerStreaming) return "GENERATING";
  if (answerText && question) return "ANSWER_READY";
  if (question) return "QUESTION_DETECTED";
  return "LISTENING";
}

const HUD_LABELS: Record<HudState, { label: string; icon: string; tone: string }> = {
  IDLE: { label: "Idle", icon: "○", tone: "idle" },
  LISTENING: { label: "Listening", icon: "●", tone: "listening" },
  QUESTION_DETECTED: { label: "Question detected", icon: "◌", tone: "detecting" },
  GENERATING: { label: "Generating answer", icon: "✦", tone: "generating" },
  ANSWER_READY: { label: "Answer ready", icon: "✓", tone: "ready" },
  PAUSED: { label: "Paused", icon: "Ⅱ", tone: "paused" },
  ERROR: { label: "ASR / runtime error", icon: "!", tone: "error" }
};

type OverlayGroup = OverlayRootProps["questionGroups"][number];

function visibleQuestionItems(group: OverlayGroup): OverlayGroup["items"] {
  return group.items.filter((item) => item.answerable && (item.type === "FOLLOW_UP" || item.type === "PARALLEL_SUBQUESTION"));
}

function compactQuestionText(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function questionItemLabel(type: string): string {
  if (type === "TOPIC_FRAGMENT") return "上下文";
  if (type === "ANSWER_CONSTRAINT") return "回答要求";
  if (type === "EXAMPLE") return "举例";
  if (type === "FOLLOW_UP") return "追问";
  if (type === "PARALLEL_SUBQUESTION") return "子问题";
  if (type === "NEW_TOPIC") return "新主题";
  return "识别项";
}

function visibleQuestionDetails(group: OverlayGroup): OverlayGroup["items"] {
  return group.items.filter((item) => item.type === "ANSWER_CONSTRAINT" || item.type === "EXAMPLE" || item.type === "SAME_QUESTION_AUGMENTATION");
}

function QuestionThreadPanel({ groups, activeGroupId, followLatestPreference, showStatus, onSelectQuestion }: { groups: OverlayRootProps["questionGroups"]; activeGroupId?: string; followLatestPreference: boolean; showStatus: boolean; onSelectQuestion: (questionId: string) => void }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followMode, setFollowMode] = useState<OverlayFollowMode>(followLatestPreference ? "following" : "manual");
  const [newCount, setNewCount] = useState(0);
  const previousItemCount = useRef(groups.reduce((total, group) => total + group.items.length, 0));
  const active = groups.find((group) => group.id === activeGroupId) ?? groups.at(-1);
  const older = groups.filter((group) => group.id !== active?.id).reverse();
  useEffect(() => { setFollowMode(followLatestPreference ? "following" : "manual"); }, [followLatestPreference]);
  useEffect(() => {
    const itemCount = groups.reduce((total, group) => total + group.items.length, 0);
    const delta = Math.max(0, itemCount - previousItemCount.current);
    previousItemCount.current = itemCount;
    if (shouldAutoFollowLatest(followMode)) {
      setNewCount(0);
      requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
    } else if (delta) setNewCount((count) => count + delta);
  }, [groups, followMode]);
  const onScroll = () => { if (scrollRef.current) { const nextMode = followModeAfterScroll(scrollRef.current); setFollowMode(nextMode); if (nextMode === "following") setNewCount(0); } };
  const jumpToLatest = () => { setFollowMode("following"); setNewCount(0); requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }); };
  const selectGroupQuestion = (group: OverlayGroup) => { const item = group.items.find((candidate) => candidate.answerable) ?? group.items[0]; if (item) onSelectQuestion(item.questionId); };
  return <div className="question-thread-panel overlay-scroll-region" ref={scrollRef} onScroll={onScroll}>
    {!active && <p className="overlay-empty">等待识别问题</p>}
    {active && <article className="question-group-card active-group">
      <div className="question-group-heading"><span className="panel-kicker">QUESTION NAVIGATOR</span>{showStatus && <span className="question-group-status">{active.items.some((item) => item.state === "answering") ? "回答中" : "已识别"}</span>}</div>
      <button type="button" className="question-primary-button" onClick={() => selectGroupQuestion(active)}>{compactQuestionText(active.primaryQuestion)}</button>
      {visibleQuestionDetails(active).map((item) => <div className="question-thread-detail" key={item.id}><span>{questionItemLabel(item.type)}</span><strong>{compactQuestionText(item.text, 140)}</strong></div>)}
      {visibleQuestionItems(active).map((item, index) => <button type="button" className="question-thread-follow-up question-select-button" key={item.id} onClick={() => onSelectQuestion(item.questionId)}><span>追问 {index + 1}</span><strong>{compactQuestionText(item.text, 150)}</strong></button>)}
    </article>}
    {older.length > 0 && <details className="older-question-groups" open={older.some((group) => group.id.startsWith("screenshot-group-"))}><summary>更早问题 · {older.length} 组</summary>{older.map((group) => <article className="question-group-card compact-group" key={group.id}><button type="button" className="question-history-button" onClick={() => selectGroupQuestion(group)}><span className="panel-kicker">{compactQuestionText(group.title, 80)}</span><strong>{compactQuestionText(group.primaryQuestion, 150)}</strong></button>{visibleQuestionItems(group).map((item) => <button type="button" className="question-history-follow-up" key={item.id} onClick={() => onSelectQuestion(item.questionId)}>追问 · {compactQuestionText(item.text, 130)}</button>)}</article>)}</details>}
    {newCount > 0 && <button type="button" className="new-content-badge" onClick={jumpToLatest}>{newContentBadgeLabel(newCount)}</button>}
  </div>;
}

function backgroundWithOpacity(color: string, opacity: number): string {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return `rgba(29,48,74,${opacity})`;
  return `rgba(${parseInt(match[1], 16)},${parseInt(match[2], 16)},${parseInt(match[3], 16)},${opacity})`;
}

function visualWindowPreferences(preferences: OverlayPreferences, windowPreferences: OverlayPreferences["questionWindow"]): OverlayPreferences["questionWindow"] {
  const mode = preferences.appearance.mode;
  if (mode === "text_only") return { ...windowPreferences, backgroundOpacity: 0, textOpacity: 1, borderOpacity: 0, blur: 0, shadow: false, border: false };
  if (mode === "glass") return { ...windowPreferences, backgroundOpacity: clampNumber(windowPreferences.backgroundOpacity, 0.7, 0.85), blur: preferences.appearance.blur, shadow: preferences.appearance.shadow, border: preferences.appearance.border };
  if (mode === "translucent") return { ...windowPreferences, backgroundOpacity: clampNumber(windowPreferences.backgroundOpacity, 0.25, 0.5), blur: clampNumber(preferences.appearance.blur, 4, 12), shadow: preferences.appearance.shadow, border: preferences.appearance.border };
  return windowPreferences;
}

function AnswerCore({ text }: { text: string }): JSX.Element {
  const lines = text.split(/\r?\n/);
  const blocks: JSX.Element[] = [];
  let code = false;
  let codeLines: string[] = [];
  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (code) blocks.push(<pre key={`code-${index}`}><code>{codeLines.join("\n")}</code></pre>);
      code = !code;
      codeLines = [];
    } else if (code) codeLines.push(line);
    else if (line.trim()) blocks.push(<p key={`line-${index}`}>{line.replace(/^[-*]\s+/, "")}</p>);
  });
  if (code && codeLines.length) blocks.push(<pre key="code-tail"><code>{codeLines.join("\n")}</code></pre>);
  return <>{blocks}</>;
}

function answerStatusLabel(status: AnswerThread["answers"][number]["status"]): string {
  if (status === "generating") return "生成中";
  if (status === "complete") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return "等待中";
}

function answerRelationLabel(relation: AnswerThread["answers"][number]["relation"]): string {
  if (relation === "FOLLOW_UP") return "追问";
  if (relation === "AUGMENTATION") return "补充";
  if (relation === "PARALLEL_SUBQUESTION") return "子问题";
  return "主回答";
}

function AnswerThreadPanel({ threads, activeGroupId, fallbackText, fallbackQuestion, streaming, followLatestPreference, selectedQuestionId }: { threads: AnswerThread[]; activeGroupId?: string; fallbackText: string; fallbackQuestion?: string; streaming: boolean; followLatestPreference: boolean; selectedQuestionId?: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const answerRefs = useRef(new Map<string, HTMLElement>());
  const [followMode, setFollowMode] = useState<OverlayFollowMode>(followLatestPreference ? "following" : "manual");
  const [newCount, setNewCount] = useState(0);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set(activeGroupId ? [activeGroupId] : []));
  const [olderGroupsOpen, setOlderGroupsOpen] = useState(false);
  const previousAnswerCount = useRef(threads.reduce((total, thread) => total + thread.answers.length, 0));
  const active = threads.find((thread) => thread.groupId === activeGroupId) ?? threads.at(-1);
  const older = threads.filter((thread) => thread.groupId !== active?.groupId).reverse();
  useEffect(() => { setFollowMode(followLatestPreference ? "following" : "manual"); }, [followLatestPreference]);
  useEffect(() => { if (active) setExpandedGroupIds((current) => new Set(current).add(active.groupId)); }, [active?.groupId]);
  useEffect(() => {
    const answerCount = threads.reduce((total, thread) => total + thread.answers.length, 0);
    const delta = Math.max(0, answerCount - previousAnswerCount.current);
    previousAnswerCount.current = answerCount;
    if (shouldAutoFollowLatest(followMode)) {
      setNewCount(0);
      requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
    } else if (delta) setNewCount((count) => count + delta);
  }, [threads, followMode]);
  useEffect(() => {
    if (!selectedQuestionId) return;
    const selected = threads.flatMap((thread) => thread.answers.map((answer) => ({ thread, answer }))).find(({ answer }) => answer.questionId === selectedQuestionId);
    if (!selected) return;
    setExpandedGroupIds((current) => new Set(current).add(selected.thread.groupId));
    if (selected.thread.groupId !== active?.groupId) setOlderGroupsOpen(true);
    requestAnimationFrame(() => answerRefs.current.get(selected.answer.answerId)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [selectedQuestionId, threads]);
  const onScroll = () => { const element = scrollRef.current; if (element) { const nextMode = followModeAfterScroll(element); setFollowMode(nextMode); if (nextMode === "following") setNewCount(0); } };
  const jumpToLatest = () => { setFollowMode("following"); setNewCount(0); requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }); };
  return <div className="answer-thread-panel-wrap"><div className="answer-thread-panel" ref={scrollRef} onScroll={onScroll}>
    {!active && fallbackText && <article className="answer-thread-card active-answer-card"><div className="answer-card-heading"><span>主回答</span><small>{streaming ? "生成中" : "已完成"}</small></div>{fallbackQuestion && <strong>{fallbackQuestion}</strong>}<AnswerCore text={fallbackText} /></article>}
    {active && <article className="answer-thread-group active-answer-group"><div className="answer-group-heading"><div><span className="panel-kicker">{compactQuestionText(active.title, 100)}</span><strong>ANSWER READER</strong></div><span>{active.answers.length} 条</span></div>{active.answers.map((answer) => <article className={`answer-thread-card ${answer.status}`} data-answer-id={answer.answerId} ref={(node) => { if (node) answerRefs.current.set(answer.answerId, node); else answerRefs.current.delete(answer.answerId); }} key={answer.answerId}><div className="answer-card-heading"><span>{answerRelationLabel(answer.relation)}</span><small>{answerStatusLabel(answer.status)}</small></div>{answer.questionText !== active.title && <strong>{compactQuestionText(answer.questionText, 150)}</strong>}<AnswerCore text={answer.answerText} />{answer.status === "generating" && <span className="answer-cursor">▌</span>}</article>)}</article>}
    {older.length > 0 && <details className="older-answer-groups" open={olderGroupsOpen || older.some((thread) => thread.groupId.startsWith("screenshot-group-"))} onToggle={(event) => setOlderGroupsOpen(event.currentTarget.open)}><summary>更早回答 · {older.length} 组</summary>{older.map((thread) => <article className="answer-thread-group compact-answer-group" key={thread.groupId}><div className="answer-group-heading"><strong>{compactQuestionText(thread.title, 100)}</strong><span>{thread.answers.length} 条回答</span></div>{thread.answers.map((answer) => <article className="answer-thread-card" data-answer-id={answer.answerId} ref={(node) => { if (node) answerRefs.current.set(answer.answerId, node); else answerRefs.current.delete(answer.answerId); }} key={answer.answerId}><div className="answer-card-heading"><span>{answerRelationLabel(answer.relation)}</span><small>{answerStatusLabel(answer.status)}</small></div><AnswerCore text={answer.answerText} /></article>)}</article>)}</details>}
  </div>{newCount > 0 && <button className="new-content-badge answer-new-content-badge" onClick={jumpToLatest}>{newContentBadgeLabel(newCount)}</button>}{followMode === "manual" && <button className="latest-jump" onClick={jumpToLatest}>↓ 最新回答</button>}</div>;
}

function ToolbarIcon({ name }: { name: "eye" | "eye-off" | "glasses" | "keyboard" | "share" | "share-off" | "stop" | "menu" | "waveform" | "transcript" | "panel-left" | "panel-right" }): JSX.Element {
  const common = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "waveform") return <svg {...common}><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" /></svg>;
  if (name === "transcript") return <svg {...common}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;
  if (name === "panel-left") return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M6 8h1M6 12h1M6 16h1" /></svg>;
  if (name === "panel-right") return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16M18 8h-1M18 12h-1M18 16h-1" /></svg>;
  if (name === "glasses") return <svg {...common}><path d="M3 9h4l1.2 5h7.6L17 9h4" /><path d="M7 9 8.2 6h7.6L17 9" /><circle cx="8.5" cy="14" r="2.5" /><circle cx="15.5" cy="14" r="2.5" /><path d="M11 14h2" /></svg>;
  if (name === "eye" || name === "eye-off") return <svg {...common}>{name === "eye-off" && <path d="m3 3 18 18" />}<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
  if (name === "keyboard") return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9h.01M10 9h.01M13 9h.01M16 9h.01M7 13h.01M10 13h.01M13 13h.01M16 13h.01M8 16h8" /></svg>;
  if (name === "menu") return <svg {...common} stroke="none"><circle cx="7" cy="7" r="1.5" fill="currentColor" /><circle cx="12" cy="7" r="1.5" fill="currentColor" /><circle cx="17" cy="7" r="1.5" fill="currentColor" /><circle cx="7" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="17" cy="12" r="1.5" fill="currentColor" /><circle cx="7" cy="17" r="1.5" fill="currentColor" /><circle cx="12" cy="17" r="1.5" fill="currentColor" /><circle cx="17" cy="17" r="1.5" fill="currentColor" /></svg>;
  if (name === "share" || name === "share-off") return <svg {...common}>{name === "share-off" && <path d="m3 3 18 18" />}<circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" /></svg>;
  return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>;
}

function EndInterviewDialog({ writtenTestMode, onCancel, onConfirm }: { writtenTestMode: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return <div className="end-interview-backdrop hud-interactive-region" role="presentation"><section className="end-interview-dialog" role="dialog" aria-modal="true" aria-labelledby="end-interview-title"><strong id="end-interview-title">{writtenTestMode ? "结束笔试？" : "结束面试？"}</strong><p>{writtenTestMode ? "结束后将关闭笔试小窗，不会启动录音。" : "结束后将停止录音，并保存本次面试记录。"}</p><div><button className="dialog-cancel" onClick={onCancel}>取消</button><button className="dialog-confirm" onClick={onConfirm}>结束</button></div></section></div>;
}

function ShortcutPopover({ writtenTestMode, onAnswerLatest, onAnswerScreenshot, onHideAll, onToggleMode, onToggleAutomation, onResetLayout, onEndInterview, onClose }: { writtenTestMode: boolean; onAnswerLatest: () => Promise<void>; onAnswerScreenshot: () => Promise<void>; onHideAll: () => void; onToggleMode: () => void; onToggleAutomation: () => void; onResetLayout: () => void; onEndInterview: () => void; onClose: () => void }): JSX.Element {
  return <section className="shortcut-card" role="dialog" aria-label="快捷操作"><header><div><span className="panel-kicker">QUICK ACTIONS</span><strong>快捷操作</strong></div><button onClick={onClose} aria-label="关闭快捷操作">×</button></header><div className="shortcut-actions">{!writtenTestMode && <button onClick={() => void onAnswerLatest()}><span>回答最新问题</span><kbd>Ctrl + Alt + A</kbd></button>}<button onClick={() => void onAnswerScreenshot()}><span>截图识别并回答</span><kbd>Ctrl + Alt + S</kbd></button>{!writtenTestMode && <div className="shortcut-static"><span>截图识别并回答（仅手动模式）</span><kbd>鼠标中键</kbd></div>}<button onClick={onHideAll}><span>显示 / 隐藏全部悬浮窗</span><kbd>Ctrl + Alt + D</kbd></button><button onClick={onClose}><span>显示 / 隐藏快捷操作</span><kbd>Ctrl + Alt + K</kbd></button><button onClick={onEndInterview}><span>{writtenTestMode ? "结束笔试" : "结束面试"}</span><kbd>Ctrl + Alt + Q</kbd></button>{!writtenTestMode && <button onClick={onToggleAutomation}><span>自动 / 手动回答</span><kbd>Ctrl + Alt + X</kbd></button>}<button onClick={onToggleMode}><span>交互 / 穿透模式</span><kbd>Ctrl + Alt + P</kbd></button>{!writtenTestMode && <><div className="shortcut-static"><span>切换面试官记录</span><kbd>Ctrl + Alt + 1–8</kbd></div><div className="shortcut-static"><span>滚动回答面板</span><kbd>Ctrl + Alt + ↑↓</kbd></div></>}<button onClick={onResetLayout}><span>恢复默认布局</span></button></div></section>;
}

export function OverlayRoot(props: OverlayRootProps): JSX.Element {
  const { state, sessionState, realtimeState, operationMode, overlayMode, hudState: sharedHUDState, automationMode, question, answerText, answerStreaming, questionGroups, activeQuestionGroupId, answerThreads, onToggleMode, onToggleAutomation, onAnswerLatest, onAnswerScreenshot, onEndInterview, onHideAll, onTogglePanels, onToggleTranscript, onToggleAnswer, onToggleShortcuts, captureProtectionEnabled, captureProtectionSupported, captureProtectionOsFlagApplied, captureProtectionDisplayVerified, captureProtectionLastError, captureTest } = props;
  const writtenTestMode = operationMode === "WRITTEN_TEST";
  const [preferences, setPreferences] = useState<OverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const [layout, updateLayout, applyMainLayout, clearSavedLayout, getCurrentLayout] = useOverlayLayout(preferences);
  const [answerSending, setAnswerSending] = useState(false);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>();
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const displayMeta = useRef<{ displayId?: number; scaleFactor?: number }>({});
  const [runtimeProtection, setRuntimeProtection] = useState<{ requested: boolean; osFlagApplied: boolean; displayCaptureVerified: boolean | null; lastError?: string }>();
  useEffect(() => {
    if (!sharedHUDState.running) {
      setElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [sharedHUDState.running]);
  useEffect(() => {
    let disposed = false;
    void window.interviewCopilot.overlay.getCaptureProtection().then((next) => { if (!disposed) setRuntimeProtection(next); }).catch(() => undefined);
    void window.interviewCopilot.overlay.getLayout().then((next) => { if (!disposed && next) applyMainLayout(next); }).catch(() => undefined);
    void window.interviewCopilot.overlay.getPreferences().then((next) => { if (!disposed && next) setPreferences(next); }).catch(() => undefined);
    const unsubscribeProtection = window.interviewCopilot.events.onOverlayCaptureProtection((next) => { if (!disposed) setRuntimeProtection(next); });
    const unsubscribeLayout = window.interviewCopilot.events.onOverlayLayout((next) => { if (!disposed) { displayMeta.current = { displayId: next.displayId, scaleFactor: next.scaleFactor }; applyMainLayout(next); } });
    const unsubscribeLayoutEdit = window.interviewCopilot.events.onOverlayLayoutEditMode((enabled) => { if (!disposed) setLayoutEditMode(enabled); });
    const unsubscribeGlobalWheel = window.interviewCopilot.events.onOverlayGlobalWheel(({ x, y, deltaY }) => {
      const element = document.elementsFromPoint(x, y).find((candidate) => candidate instanceof HTMLElement && candidate.matches(".question-thread-panel, .answer-thread-panel")) as HTMLElement | undefined;
      if (element) element.scrollTop += deltaY;
    });
    const unsubscribePreferences = window.interviewCopilot.events.onOverlayPreferences((next) => { if (!disposed) setPreferences(next); });
    const unsubscribeCommands = window.interviewCopilot.events.onOverlayCommand((command: OverlayCommand) => { if (command === "confirm-end") setEndConfirmOpen(true); else if (command === "reset-layout") clearSavedLayout(); });
    return () => { disposed = true; unsubscribeProtection(); unsubscribeLayout(); unsubscribeLayoutEdit(); unsubscribeGlobalWheel(); unsubscribePreferences(); unsubscribeCommands(); };
  }, [applyMainLayout, clearSavedLayout]);
  const status = hudState({ state, sessionState, realtimeState, operationMode, question, answerText, answerStreaming });
  const statusMeta = HUD_LABELS[status];
  const effectiveProtectionEnabled = runtimeProtection?.requested ?? captureProtectionEnabled;
  const effectiveProtectionSupported = captureProtectionSupported;
  const effectiveOsFlagApplied = runtimeProtection?.osFlagApplied ?? captureProtectionOsFlagApplied;
  const effectiveDisplayVerified = runtimeProtection?.displayCaptureVerified ?? captureProtectionDisplayVerified;
  const effectiveLastError = runtimeProtection?.lastError ?? captureProtectionLastError;
  const protectionTone = !effectiveProtectionEnabled ? "off" : effectiveDisplayVerified === true ? "verified" : effectiveOsFlagApplied === false || effectiveLastError ? "failed" : "requested";
  const elapsedLabel = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const listeningLabel = !sharedHUDState.running ? "未开始" : writtenTestMode ? status === "ANSWER_READY" ? "回答已就绪" : status === "GENERATING" ? "正在生成" : "按 Ctrl+Alt+S 截图回答" : status === "ANSWER_READY" ? "回答已就绪" : status === "GENERATING" ? "正在生成" : status === "QUESTION_DETECTED" ? "识别问题" : "正在听取";
  const submitScreenshot = async () => { if (answerSending) return; setAnswerSending(true); try { await onAnswerScreenshot(); } finally { setAnswerSending(false); } };
  const persistLayout = useCallback(() => {
    const current = getCurrentLayout();
    const meta = displayMeta.current;
    const rememberPosition = preferences.behavior.rememberPosition;
    const rememberSize = preferences.behavior.rememberSize;
    const windowPatch = (panel: PanelLayout): Record<string, number> => ({
      ...(rememberPosition ? { x: panel.x, y: panel.y } : {}),
      ...(rememberSize ? { width: panel.width, height: panel.height } : {}),
      ...(meta.displayId !== undefined ? { displayId: meta.displayId } : {}),
      ...(meta.scaleFactor !== undefined ? { scaleFactor: meta.scaleFactor } : {})
    });
    void window.interviewCopilot.overlay.setPreferences({ questionWindow: windowPatch(current.transcript), answerWindow: windowPatch(current.answer), controlBar: windowPatch(current.toolbar) });
  }, [getCurrentLayout, preferences.behavior.rememberPosition, preferences.behavior.rememberSize]);
  useEffect(() => {
    if (sharedHUDState.shareMode) return;
    let lastInteractive: boolean | undefined;
    let temporaryInteractive = false;
    const reportControlRegion = (interactive: boolean) => { if (lastInteractive === interactive) return; lastInteractive = interactive; void window.interviewCopilot.overlay.setControlRegion(interactive); };
    const onMouseMove = (event: MouseEvent) => {
      const hit = document.elementsFromPoint(event.clientX, event.clientY).some((element) => Boolean((element as HTMLElement).closest?.(".hud-interactive-region, .overlay-scroll-region")));
      reportControlRegion(interactionModeAllowsOverlayInput(preferences.behavior.interactionMode, temporaryInteractive, layoutEditMode) && (preferences.behavior.interactionMode === "interactive" || temporaryInteractive || hit));
    };
    const onKey = (event: KeyboardEvent) => { temporaryInteractive = modifierPressed(preferences.behavior.temporaryInteractionModifier, event); reportControlRegion(temporaryInteractive); };
    const onMouseLeave = () => reportControlRegion(false);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseleave", onMouseLeave, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => { window.removeEventListener("mousemove", onMouseMove, true); window.removeEventListener("mouseleave", onMouseLeave, true); window.removeEventListener("keydown", onKey, true); window.removeEventListener("keyup", onKey, true); reportControlRegion(false); };
  }, [overlayMode, sharedHUDState.shareMode, preferences.behavior.interactionMode, preferences.behavior.temporaryInteractionModifier, layoutEditMode]);
  const visualHidden = !sharedHUDState.running || sharedHUDState.shareMode;
  const transcriptVisible = preferences.showTranscript && sharedHUDState.transcriptVisible && !visualHidden;
  const answerVisible = preferences.showAnswer && sharedHUDState.answerVisible && !visualHidden;
  const shortcutVisible = sharedHUDState.shortcutVisible && !visualHidden;
  const questionVisual = visualWindowPreferences(preferences, preferences.questionWindow);
  const answerVisual = visualWindowPreferences(preferences, preferences.answerWindow);
  const toolbarVisual = visualWindowPreferences(preferences, preferences.controlBar);
  const textShadow = preferences.appearance.textShadow === "medium" ? "0 1px 7px rgba(0,0,0,.62)" : preferences.appearance.textShadow === "soft" ? "0 1px 4px rgba(0,0,0,.42)" : "none";
  const appearanceStyle = {
    "--overlay-panel-background": backgroundWithOpacity(questionVisual.backgroundColor, questionVisual.backgroundOpacity),
    "--overlay-font-color": questionVisual.textColor,
    "--overlay-font-size": `${preferences.fontSize}px`,
    "--overlay-question-font-size": `${questionVisual.fontSize}px`,
    "--overlay-question-title-size": `${questionVisual.titleFontSize}px`,
    "--overlay-question-line-height": questionVisual.lineHeight,
    "--overlay-question-padding": `${questionVisual.padding}px`,
    "--overlay-question-item-gap": `${questionVisual.itemGap}px`,
    "--overlay-answer-font-size": `${answerVisual.fontSize}px`,
    "--overlay-answer-title-size": `${answerVisual.titleFontSize}px`,
    "--overlay-answer-line-height": answerVisual.lineHeight,
    "--overlay-answer-padding": `${answerVisual.padding}px`,
    "--overlay-answer-paragraph-gap": `${answerVisual.paragraphGap}px`,
    "--overlay-question-background": backgroundWithOpacity(questionVisual.backgroundColor, questionVisual.backgroundOpacity),
    "--overlay-answer-background": backgroundWithOpacity(answerVisual.backgroundColor, answerVisual.backgroundOpacity),
    "--overlay-question-text-color": backgroundWithOpacity(questionVisual.textColor, questionVisual.textOpacity),
    "--overlay-answer-text-color": backgroundWithOpacity(answerVisual.textColor, answerVisual.textOpacity),
    "--overlay-toolbar-background": backgroundWithOpacity(toolbarVisual.backgroundColor, toolbarVisual.backgroundOpacity),
    "--overlay-toolbar-text-color": backgroundWithOpacity(toolbarVisual.textColor, toolbarVisual.textOpacity),
    "--overlay-toolbar-font-size": `${toolbarVisual.fontSize}px`,
    "--overlay-question-border-opacity": preferences.appearance.border ? questionVisual.borderOpacity : 0,
    "--overlay-answer-border-opacity": preferences.appearance.border ? answerVisual.borderOpacity : 0,
    "--overlay-toolbar-border-opacity": preferences.appearance.border ? toolbarVisual.borderOpacity : 0,
    "--overlay-blur": `${preferences.appearance.mode === "text_only" ? 0 : preferences.appearance.mode === "custom" ? preferences.appearance.blur : preferences.appearance.mode === "translucent" ? clampNumber(preferences.appearance.blur, 4, 12) : clampNumber(preferences.appearance.blur, 12, 24)}px`,
    "--overlay-radius": `${preferences.appearance.mode === "text_only" ? 0 : preferences.appearance.mode === "custom" ? questionVisual.radius : preferences.appearance.radius}px`,
    "--overlay-text-shadow": textShadow,
    "--overlay-text-outline": `${preferences.appearance.textOutline}px`,
    "--overlay-designer-shadow": preferences.appearance.mode === "text_only" || !preferences.appearance.shadow ? "none" : "0 18px 45px rgba(0,0,0,.24)"
  } as CSSProperties;
  return <main className="overlay-root" style={appearanceStyle} data-hud-state={status} data-hud-mode={sharedHUDState.mode} data-share-mode={sharedHUDState.shareMode ? "on" : "off"} data-overlay-mode={overlayMode} data-operation-mode={operationMode} data-compact-header={preferences.behavior.compactHeader ? "on" : "off"} data-layout-edit-mode={layoutEditMode ? "on" : "off"} data-interaction-mode={preferences.behavior.interactionMode} data-wheel-routing={preferences.behavior.wheelRouting} data-appearance-mode={preferences.appearance.mode}>
    {captureTest && !visualHidden && <div className="capture-test-marker">CAPTURE_PROTECTION_TEST_MARKER_7F32</div>}
      {preferences.showToolbar && sharedHUDState.topBarVisible && !visualHidden && <DraggableResizablePanel panel="toolbar" layout={{ ...layout.toolbar, visible: true, locked: !layoutEditMode }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className={`toolbar-panel ${preferences.controlBar.orientation === "vertical" ? "toolbar-vertical" : ""}`}><div className="floating-toolbar hud-interactive-region" role="toolbar" aria-label={writtenTestMode ? "笔试控制栏" : "面试控制栏"}><span className="toolbar-audio-mark" aria-hidden="true"><ToolbarIcon name="waveform" /></span><div className="toolbar-runtime"><span>{elapsedLabel}</span></div><span className="toolbar-divider" aria-hidden="true" /><div className={`toolbar-status-inline ${statusMeta.tone}`}><i aria-hidden="true" /><span>{listeningLabel}</span></div>{!writtenTestMode && <div className="toolbar-mode-switch" role="group" aria-label="回答模式"><button className={automationMode === "AUTO" ? "selected" : ""} onClick={() => { if (automationMode !== "AUTO") void onToggleAutomation(); }}>自动</button><button className={automationMode === "MANUAL" ? "selected" : ""} onClick={() => { if (automationMode !== "MANUAL") void onToggleAutomation(); }}>手动</button></div>}{preferences.showTranscript && <button className={`toolbar-inline-action toolbar-panel-toggle ${transcriptVisible ? "active" : "inactive"}`} onClick={onToggleTranscript} title={transcriptVisible ? "隐藏已识别问题" : "显示已识别问题"} aria-label={transcriptVisible ? "隐藏已识别问题" : "显示已识别问题"} aria-pressed={transcriptVisible}><ToolbarIcon name="panel-left" /></button>}{preferences.showAnswer && <button className={`toolbar-inline-action toolbar-panel-toggle ${answerVisible ? "active" : "inactive"}`} onClick={onToggleAnswer} title={answerVisible ? "隐藏AI回答" : "显示AI回答"} aria-label={answerVisible ? "隐藏AI回答" : "显示AI回答"} aria-pressed={answerVisible}><ToolbarIcon name="panel-right" /></button>}<button className="toolbar-inline-action toolbar-shortcut-toggle" onClick={onToggleShortcuts} title="打开快捷操作" aria-label="打开快捷操作"><ToolbarIcon name="keyboard" /></button><button className="toolbar-end-button" onClick={() => setEndConfirmOpen(true)} title={writtenTestMode ? "结束笔试 Ctrl+Alt+Q" : "结束面试 Ctrl+Alt+Q"} aria-label={writtenTestMode ? "结束笔试" : "结束面试"}>{writtenTestMode ? "结束笔试" : "结束面试"}</button></div></DraggableResizablePanel>}
      {transcriptVisible && !writtenTestMode && <DraggableResizablePanel panel="transcript" layout={{ ...layout.transcript, visible: true, locked: !layoutEditMode && (layout.transcript.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="question-panel"><section className="overlay-panel-card question-card overlay-content" aria-label="问题导航"><header><div><span className="panel-kicker">QUESTION NAVIGATOR</span><strong>问题导航</strong></div></header><QuestionThreadPanel groups={questionGroups} activeGroupId={activeQuestionGroupId} followLatestPreference={preferences.behavior.followLatestQuestion} showStatus={preferences.behavior.showQuestionStatus} onSelectQuestion={setSelectedQuestionId} /></section></DraggableResizablePanel>}
      {answerVisible && <DraggableResizablePanel panel="answer" layout={{ ...layout.answer, visible: true, locked: !layoutEditMode && (layout.answer.locked || preferences.behavior.lockLayout) }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="answer-panel"><section className="overlay-panel-card answer-card overlay-content" aria-label="答案阅读器"><header><div><span className="panel-kicker">ANSWER READER</span><strong>答案阅读器</strong></div>{preferences.behavior.showAnswerStatus && (answerStreaming || answerText) && <span className={`answer-ready ${answerStreaming ? "generating" : ""}`}>{answerStreaming ? "生成中" : "回答已就绪"}</span>}</header><AnswerThreadPanel threads={answerThreads} activeGroupId={activeQuestionGroupId} fallbackText={answerText} fallbackQuestion={question?.text} streaming={answerStreaming} followLatestPreference={preferences.behavior.followLatestAnswer} selectedQuestionId={selectedQuestionId} />{writtenTestMode ? <div className="written-test-action hud-interactive-region"><span>按 Ctrl+Alt+S 截取当前题目</span><button onClick={() => void submitScreenshot()} disabled={answerSending}>截图回答</button></div> : <div className="overlay-answer-actions hud-interactive-region"><button onClick={() => void submitScreenshot()} disabled={answerSending}>截图回答</button></div>}</section></DraggableResizablePanel>}
    {shortcutVisible && <DraggableResizablePanel panel="shortcuts" layout={{ ...layout.shortcuts, visible: true }} onChange={updateLayout} onCommit={persistLayout} editMode={layoutEditMode} className="shortcut-panel"><div className="hud-interactive-region"><ShortcutPopover writtenTestMode={writtenTestMode} onAnswerLatest={onAnswerLatest} onAnswerScreenshot={onAnswerScreenshot} onHideAll={onHideAll} onToggleMode={onToggleMode} onToggleAutomation={() => void onToggleAutomation()} onResetLayout={() => void window.interviewCopilot.overlay.resetLayout()} onEndInterview={() => setEndConfirmOpen(true)} onClose={onToggleShortcuts} /></div></DraggableResizablePanel>}
    {layoutEditMode && !visualHidden && <div className="layout-edit-toolbar hud-interactive-region"><span>布局编辑模式 · Alt 临时关闭吸附</span><button onClick={() => void window.interviewCopilot.overlay.finishLayoutEditMode()}>完成布局</button></div>}
    {endConfirmOpen && !visualHidden && <EndInterviewDialog writtenTestMode={writtenTestMode} onCancel={() => setEndConfirmOpen(false)} onConfirm={() => { setEndConfirmOpen(false); void onEndInterview(); }} />}
    {!visualHidden && <div className={`hud-protection-indicator ${protectionTone}`} title={!effectiveProtectionSupported ? "当前平台不支持 Windows Capture Protection" : effectiveLastError ? "Windows protection flag 失败" : effectiveDisplayVerified === true ? "Display Capture Verified" : effectiveProtectionEnabled ? "Windows protection on" : "Windows protection off"}>{effectiveProtectionSupported ? "◈" : "·"}</div>}
  </main>;
}
