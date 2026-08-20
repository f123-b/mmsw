import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type JSX } from "react";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { HUDState, OverlayMode } from "../../main/overlay-manager";

type HudState = "IDLE" | "LISTENING" | "QUESTION_DETECTED" | "GENERATING" | "ANSWER_READY" | "PAUSED" | "ERROR";
type PanelKey = "toolbar" | "transcript" | "answer" | "shortcuts";
type PanelLayout = { x: number; y: number; width: number; height: number; visible: boolean; collapsed: boolean; locked: boolean; opacity: number };
type OverlayLayout = Record<PanelKey, PanelLayout>;
type OverlayCommand = "show-all" | "hide-all" | "toggle-all" | "reset-layout" | "toggle-shortcuts";

interface OverlayRootProps {
  mic: number;
  system: number;
  state: string;
  sessionState: string;
  realtimeState: string;
  overlayMode: OverlayMode;
  hudState: HUDState;
  automationMode: "MANUAL" | "AUTO";
  answerMode: "FAST" | "NORMAL" | "DEEP";
  question?: { text: string };
  answerText: string;
  answerStreaming: boolean;
  remoteTranscript: TranscriptSnapshot;
  micTranscript: TranscriptSnapshot;
  onToggleMode: () => void;
  onToggleAutomation: () => Promise<void> | void;
  onAnswerQuestion: (text: string) => Promise<void>;
  onAnswerLatest: () => Promise<void>;
  onAnswerScreenshot: () => Promise<void>;
  onEndInterview: () => Promise<void>;
  onHideAll: () => void;
  onShowAll: () => void;
  onTogglePanels: () => void;
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

const STORAGE_KEY = "interview-copilot.overlay-layout";
const defaults: OverlayLayout = {
  toolbar: { x: 0, y: 22, width: 300, height: 38, visible: true, collapsed: false, locked: false, opacity: 1 },
  transcript: { x: 36, y: 104, width: 480, height: 520, visible: true, collapsed: false, locked: false, opacity: 1 },
  answer: { x: 828, y: 104, width: 520, height: 520, visible: true, collapsed: false, locked: false, opacity: 1 },
  shortcuts: { x: 18, y: 642, width: 300, height: 320, visible: false, collapsed: false, locked: false, opacity: 1 }
};

function viewportDefaults(): OverlayLayout {
  return {
    ...defaults,
    toolbar: { ...defaults.toolbar, x: Math.max(8, Math.round((window.innerWidth - defaults.toolbar.width) / 2)) },
    shortcuts: { ...defaults.shortcuts, y: Math.max(8, window.innerHeight - defaults.shortcuts.height - 18) }
  };
}

function loadLayout(): OverlayLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const fallback = viewportDefaults();
    const savedToolbar = saved.toolbar?.width === defaults.toolbar.width ? saved.toolbar : {};
    const savedShortcuts = saved.shortcuts?.width === defaults.shortcuts.width ? saved.shortcuts : {};
    return Object.fromEntries(Object.entries(fallback).map(([key, value]) => [key, { ...value, ...(key === "toolbar" ? savedToolbar : key === "shortcuts" ? savedShortcuts : (saved[key] ?? {})) }])) as OverlayLayout;
  } catch {
    return defaults;
  }
}

function clampLayout(layout: PanelLayout): PanelLayout {
  const width = Math.max(260, Math.min(layout.width, Math.max(260, window.innerWidth - 16)));
  const height = Math.max(120, Math.min(layout.height, Math.max(120, window.innerHeight - 16)));
  return { ...layout, width, height, x: Math.max(8, Math.min(layout.x, Math.max(8, window.innerWidth - width - 8))), y: Math.max(8, Math.min(layout.y, Math.max(8, window.innerHeight - height - 8))) };
}

function useOverlayLayout(): [OverlayLayout, (key: PanelKey, patch: Partial<PanelLayout>) => void, () => void] {
  const [layout, setLayout] = useState<OverlayLayout>(() => loadLayout());
  const update = (key: PanelKey, patch: Partial<PanelLayout>) => setLayout((current) => {
    const next = { ...current, [key]: clampLayout({ ...current[key], ...patch }) };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best effort */ }
    return next;
  });
  const reset = () => { const next = viewportDefaults(); setLayout(next); try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best effort */ } };
  return [layout, update, reset];
}

function DraggableResizablePanel({ panel, layout, onChange, className, children }: { panel: PanelKey; layout: PanelLayout; onChange: (key: PanelKey, patch: Partial<PanelLayout>) => void; className: string; children: JSX.Element }): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (layout.locked || (event.target as HTMLElement).closest("button, input, textarea, select, .resize-handle")) return;
    const origin = { x: event.clientX - layout.x, y: event.clientY - layout.y };
    setDragging(true);
    const move = (next: PointerEvent) => onChange(panel, { x: next.clientX - origin.x, y: next.clientY - origin.y });
    const end = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (layout.locked) return;
    event.stopPropagation();
    const origin = { width: layout.width - event.clientX, height: layout.height - event.clientY };
    const move = (next: PointerEvent) => onChange(panel, { width: next.clientX + origin.width - layout.x, height: next.clientY + origin.height - layout.y });
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  return <div className={`floating-panel ${className} ${dragging ? "dragging" : ""}`} style={{ left: layout.x, top: layout.y, width: layout.width, height: layout.height, opacity: layout.opacity, display: layout.visible ? undefined : "none" }} onPointerDown={beginDrag}>{children}{!layout.locked && <div className="resize-handle" aria-label="调整大小" onPointerDown={beginResize} />}</div>;
}

function hudState({ state, sessionState, realtimeState, question, answerText, answerStreaming }: Pick<OverlayRootProps, "state" | "sessionState" | "realtimeState" | "question" | "answerText" | "answerStreaming">): HudState {
  if (state === "FAILED" || sessionState === "ERROR" || realtimeState === "error") return "ERROR";
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

function TranscriptTimeline({ snapshot, currentQuestion }: { snapshot: TranscriptSnapshot; currentQuestion?: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followLatest, setFollowLatest] = useState(true);
  useEffect(() => { if (followLatest && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [snapshot, followLatest]);
  const onScroll = () => { const element = scrollRef.current; if (element) setFollowLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 30); };
  const segments = snapshot.final.slice(-12);
  return <div className="timeline-wrap"><div className="timeline-scroll" ref={scrollRef} onScroll={onScroll}>{segments.length === 0 && !snapshot.partial && <p className="overlay-muted">等待转录...</p>}{segments.map((segment, index) => <article className={`timeline-entry ${currentQuestion && segment.text === currentQuestion ? "current-entry" : index === segments.length - 1 ? "latest-entry" : ""}`} key={segment.id}><span className="timeline-time">{new Date(segment.startMs ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><span className="timeline-speaker">面试官</span><p>{segment.text}</p></article>)}{snapshot.partial && <article className="timeline-entry partial-entry"><span className="timeline-time">现在</span><span className="timeline-speaker">识别中</span><p>{snapshot.partial.text}</p></article>}</div>{!followLatest && <button className="latest-jump" onClick={() => { setFollowLatest(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}>↓ Latest</button>}</div>;
}

function MicTimeline({ snapshot }: { snapshot: TranscriptSnapshot }): JSX.Element {
  return <div className="mic-timeline">{snapshot.final.slice(-4).map((segment) => <p key={segment.id}><span>我</span>{segment.text}</p>)}{snapshot.partial && <p className="partial-line"><span>我</span>{snapshot.partial.text}</p>}{snapshot.final.length === 0 && !snapshot.partial && <p className="overlay-muted">等待我的语音...</p>}</div>;
}

function AnswerSummary({ answerText, answerStreaming }: { answerText: string; answerStreaming: boolean }): JSX.Element {
  const lines = answerText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const core = lines.slice(0, 4);
  const keywords = useMemo(() => [...new Set((answerText.match(/[A-Za-z][A-Za-z0-9+#.-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []).slice(0, 6))], [answerText]);
  return <div className="answer-summary"><div className="answer-summary-label">CORE ANSWER</div><div className="answer-core">{core.length ? core.map((line, index) => <p key={`${line}-${index}`}>{line.replace(/^[-*]\s+/, "")}</p>) : <p className="overlay-muted">确认完整问题后显示简洁回答。</p>}{answerStreaming && <span className="answer-cursor">▌</span>}</div><div className="answer-summary-label">KEYWORDS</div><div className="answer-keywords">{keywords.length ? keywords.map((keyword) => <span key={keyword}>{keyword}</span>) : <span className="overlay-muted">等待答案</span>}</div></div>;
}

function ShortcutPopover({ onAnswerLatest, onAnswerScreenshot, onHideAll, onToggleMode, onToggleAutomation, onResetLayout, onEndInterview, onClose }: { onAnswerLatest: () => Promise<void>; onAnswerScreenshot: () => Promise<void>; onHideAll: () => void; onToggleMode: () => void; onToggleAutomation: () => void; onResetLayout: () => void; onEndInterview: () => void; onClose: () => void }): JSX.Element {
  return <section className="shortcut-card" role="dialog" aria-label="键盘快捷方式"><header><div><span className="panel-kicker">QUICK ACTIONS</span><strong>快捷操作</strong></div><button onClick={onClose} aria-label="关闭快捷操作">×</button></header><div className="shortcut-actions"><button onClick={() => void onAnswerLatest()}>回答问题 <kbd>Ctrl Alt A</kbd></button><button onClick={() => void onAnswerScreenshot()}>截图并回答 <kbd>Ctrl Alt S</kbd></button><button onClick={onHideAll}>隐藏 / 显示悬浮窗 <kbd>Ctrl Alt D</kbd></button><button onClick={onClose}>隐藏 / 显示快捷方式 <kbd>Ctrl Alt K</kbd></button><button onClick={onEndInterview}>结束面试 <kbd>Ctrl Alt Q</kbd></button><button onClick={onToggleAutomation}>切换自动回答 <kbd>Ctrl Alt X</kbd></button><button onClick={onToggleMode}>切换交互 / 穿透 <kbd>Ctrl Alt P</kbd></button><div className="shortcut-static">发送面试官记录 <kbd>Ctrl Alt 1–8</kbd></div><div className="shortcut-static">滚动回答面板 <kbd>Ctrl Alt ↑↓</kbd></div><button onClick={onResetLayout}>重置面板布局</button></div></section>;
}

export function OverlayRoot(props: OverlayRootProps): JSX.Element {
  const { state, sessionState, realtimeState, overlayMode, hudState: sharedHUDState, automationMode, question, answerText, answerStreaming, remoteTranscript, micTranscript, onToggleMode, onToggleAutomation, onAnswerQuestion, onAnswerLatest, onAnswerScreenshot, onEndInterview, onHideAll, onTogglePanels, onToggleShortcuts, onToggleShare, captureProtectionEnabled, captureProtectionSupported, captureProtectionOsFlagApplied, captureProtectionDisplayVerified, captureProtectionLastError, captureTest } = props;
  const [layout, updateLayout, resetLayout] = useOverlayLayout();
  const [answerDraft, setAnswerDraft] = useState("");
  const [answerSending, setAnswerSending] = useState(false);
  const [runtimeProtection, setRuntimeProtection] = useState<{ requested: boolean; osFlagApplied: boolean; displayCaptureVerified: boolean | null; lastError?: string }>();
  useEffect(() => {
    let disposed = false;
    void window.interviewCopilot.overlay.getCaptureProtection().then((next) => { if (!disposed) setRuntimeProtection(next); }).catch(() => undefined);
    const unsubscribeProtection = window.interviewCopilot.events.onOverlayCaptureProtection((next) => { if (!disposed) setRuntimeProtection(next); });
    const unsubscribeCommands = window.interviewCopilot.events.onOverlayCommand((command: OverlayCommand) => { if (command === "reset-layout") resetLayout(); });
    return () => { disposed = true; unsubscribeProtection(); unsubscribeCommands(); };
  }, [resetLayout]);
  const status = hudState({ state, sessionState, realtimeState, question, answerText, answerStreaming });
  const statusMeta = HUD_LABELS[status];
  const effectiveProtectionEnabled = runtimeProtection?.requested ?? captureProtectionEnabled;
  const effectiveProtectionSupported = captureProtectionSupported;
  const effectiveOsFlagApplied = runtimeProtection?.osFlagApplied ?? captureProtectionOsFlagApplied;
  const effectiveDisplayVerified = runtimeProtection?.displayCaptureVerified ?? captureProtectionDisplayVerified;
  const effectiveLastError = runtimeProtection?.lastError ?? captureProtectionLastError;
  const protectionTone = !effectiveProtectionEnabled ? "off" : effectiveDisplayVerified === true ? "verified" : effectiveOsFlagApplied === false || effectiveLastError ? "failed" : "requested";
  const submitAnswer = async () => { if (answerSending) return; setAnswerSending(true); try { if (answerDraft.trim()) await onAnswerQuestion(answerDraft.trim()); else await onAnswerLatest(); setAnswerDraft(""); } finally { setAnswerSending(false); } };
  const submitScreenshot = async () => { if (answerSending) return; setAnswerSending(true); try { await onAnswerScreenshot(); } finally { setAnswerSending(false); } };
  useEffect(() => {
    if (overlayMode === "interactive" || sharedHUDState.shareMode) return;
    let lastInteractive: boolean | undefined;
    const reportControlRegion = (interactive: boolean) => { if (lastInteractive === interactive) return; lastInteractive = interactive; void window.interviewCopilot.overlay.setControlRegion(interactive); };
    const onMouseMove = (event: MouseEvent) => { const hit = document.elementsFromPoint(event.clientX, event.clientY).some((element) => Boolean((element as HTMLElement).closest?.(".hud-interactive-region"))); reportControlRegion(hit); };
    const onMouseLeave = () => reportControlRegion(false);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseleave", onMouseLeave, true);
    return () => { window.removeEventListener("mousemove", onMouseMove, true); window.removeEventListener("mouseleave", onMouseLeave, true); reportControlRegion(false); };
  }, [overlayMode, sharedHUDState.shareMode]);
  const visualHidden = !sharedHUDState.running || sharedHUDState.shareMode;
  const panelVisible = sharedHUDState.panelVisible && !visualHidden;
  const shortcutVisible = sharedHUDState.shortcutVisible && !visualHidden;
  return <main className="overlay-root" data-hud-state={status} data-hud-mode={sharedHUDState.mode} data-share-mode={sharedHUDState.shareMode ? "on" : "off"} data-overlay-mode={overlayMode}>
    {captureTest && !visualHidden && <div className="capture-test-marker">CAPTURE_PROTECTION_TEST_MARKER_7F32</div>}
    {sharedHUDState.topBarVisible && !visualHidden && <DraggableResizablePanel panel="toolbar" layout={{ ...layout.toolbar, width: 300, height: 38, visible: true, locked: true }} onChange={updateLayout} className="toolbar-panel"><div className="floating-toolbar hud-interactive-region" role="toolbar" aria-label="面试控制栏"><div className="toolbar-brand"><strong>Interview Copilot</strong></div><button className="toolbar-control" onClick={onTogglePanels} title="显示 / 隐藏对话和回答面板" aria-label="显示或隐藏面板">▣</button><button className="toolbar-control" onClick={onToggleShortcuts} title="快捷方式 Ctrl+Alt+K" aria-label="显示快捷方式">⌨</button><button className="toolbar-control" onClick={onToggleShare} title="Share Mode：隐藏全部 HUD，Ctrl+Alt+Shift+S 恢复" aria-label="切换分享模式">◌</button><button className="toolbar-control toolbar-end-button" onClick={() => void onEndInterview()} title="结束面试 Ctrl+Alt+Q" aria-label="结束面试">×</button></div></DraggableResizablePanel>}
    {panelVisible && <DraggableResizablePanel panel="transcript" layout={{ ...layout.transcript, visible: true }} onChange={updateLayout} className="transcript-panel"><section className="overlay-panel-card" aria-label="Conversation Timeline"><header><div><span className="panel-kicker">CONVERSATION TIMELINE</span><strong>对话记录</strong></div><span className="panel-health">{statusMeta.label}</span></header><div className="current-question-card"><span>CURRENT QUESTION</span><strong>{question?.text ?? "等待面试官问题"}</strong></div><TranscriptTimeline snapshot={remoteTranscript} currentQuestion={question?.text} /><div className="my-voice"><span className="panel-kicker">MY VOICE</span><MicTimeline snapshot={micTranscript} /></div></section></DraggableResizablePanel>}
    {panelVisible && <DraggableResizablePanel panel="answer" layout={{ ...layout.answer, visible: true }} onChange={updateLayout} className="answer-panel"><section className="overlay-panel-card answer-card" aria-label="Answer"><header><div><span className="panel-kicker">ANSWER</span><strong>快速回答</strong></div><span className={`answer-ready ${answerStreaming ? "generating" : ""}`}>{answerStreaming ? "✦ 生成中" : answerText ? "✓ 可扫读" : "○ 等待问题"}</span></header><div className="answer-question-strip"><span>CURRENT QUESTION</span><strong>{question?.text ?? "等待面试官问题"}</strong></div><AnswerSummary answerText={answerText} answerStreaming={answerStreaming} /><div className="overlay-answer-composer hud-interactive-region"><textarea value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitAnswer(); } }} placeholder="输入问题，Enter 发送；Shift+Enter 换行" disabled={answerSending} rows={2} /><div><button onClick={() => void submitScreenshot()} disabled={answerSending}>⊕ 截图回答</button><button className="auto-answer" onClick={() => void onToggleAutomation()} disabled={answerSending}>{automationMode === "AUTO" ? "◉ 自动" : "Ⅱ 暂停"}</button><button className="overlay-send" onClick={() => void submitAnswer()} disabled={answerSending}>↑</button></div></div></section></DraggableResizablePanel>}
    {shortcutVisible && <DraggableResizablePanel panel="shortcuts" layout={{ ...layout.shortcuts, width: 300, visible: true }} onChange={updateLayout} className="shortcut-panel"><div className="hud-interactive-region"><ShortcutPopover onAnswerLatest={onAnswerLatest} onAnswerScreenshot={onAnswerScreenshot} onHideAll={onHideAll} onToggleMode={onToggleMode} onToggleAutomation={() => void onToggleAutomation()} onResetLayout={resetLayout} onEndInterview={() => void onEndInterview()} onClose={onToggleShortcuts} /></div></DraggableResizablePanel>}
    {!visualHidden && <div className={`hud-protection-indicator ${protectionTone}`} title={!effectiveProtectionSupported ? "当前平台不支持 Windows Capture Protection" : effectiveLastError ? "Windows protection flag 失败" : effectiveDisplayVerified === true ? "Display Capture Verified" : effectiveProtectionEnabled ? "Windows protection on" : "Windows protection off"}>{effectiveProtectionSupported ? "◈" : "·"}</div>}
  </main>;
}
