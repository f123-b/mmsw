import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type JSX } from "react";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { HUDLayout, HUDState, OverlayMode } from "../../main/overlay-manager";

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

const STORAGE_KEY = "interview-copilot.overlay-layout-v2";
const defaults: OverlayLayout = {
  toolbar: { x: 0, y: 80, width: 680, height: 50, visible: true, collapsed: false, locked: true, opacity: 1 },
  transcript: { x: 0, y: 320, width: 394, height: 406, visible: true, collapsed: false, locked: false, opacity: 1 },
  answer: { x: 410, y: 320, width: 670, height: 406, visible: true, collapsed: false, locked: false, opacity: 1 },
  shortcuts: { x: 24, y: 0, width: 320, height: 360, visible: false, collapsed: false, locked: false, opacity: 1 }
};

function viewportDefaults(): OverlayLayout {
  const usablePanelWidth = Math.max(0, Math.min(1080, window.innerWidth - 48));
  const horizontalMargin = Math.max(24, Math.round((window.innerWidth - usablePanelWidth) / 2));
  const panelTop = Math.max(180, Math.round(window.innerHeight * 0.325));
  const panelHeight = Math.max(300, Math.min(Math.round(window.innerHeight * 0.39), window.innerHeight - panelTop - 32));
  const transcriptWidth = Math.round(usablePanelWidth * 0.365);
  const answerWidth = Math.max(0, usablePanelWidth - transcriptWidth - 16);
  const toolbarWidth = Math.min(680, Math.max(460, Math.round(window.innerWidth * 0.42)), Math.max(0, window.innerWidth - 40));
  return {
    toolbar: { ...defaults.toolbar, x: Math.max(0, Math.round((window.innerWidth - toolbarWidth) / 2)), y: Math.max(24, Math.round(window.innerHeight * 0.08)), width: toolbarWidth },
    transcript: { ...defaults.transcript, x: horizontalMargin, y: panelTop, width: transcriptWidth, height: panelHeight },
    answer: { ...defaults.answer, x: horizontalMargin + transcriptWidth + 40, y: panelTop, width: answerWidth, height: panelHeight },
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

function useOverlayLayout(): [OverlayLayout, (key: PanelKey, patch: Partial<PanelLayout>) => void, (next: HUDLayout) => void] {
  const [layout, setLayout] = useState<OverlayLayout>(() => loadLayout());
  const update = useCallback((key: PanelKey, patch: Partial<PanelLayout>) => setLayout((current) => {
    const next = { ...current, [key]: clampLayout({ ...current[key], ...patch }) };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* best effort */ }
    return next;
  }), []);
  const applyMainLayout = useCallback((next: HUDLayout) => {
    const nextLayout = fromHUDLayout(next);
    setLayout(nextLayout);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* best effort */ }
  }, []);
  return [layout, update, applyMainLayout];
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
  const panelStyle = { left: layout.x, top: layout.y, width: layout.width, height: layout.height, opacity: layout.opacity, display: layout.visible ? undefined : "none", "--hud-panel-width": `${layout.width}px` } as CSSProperties;
  return <div className={`floating-panel ${className} ${dragging ? "dragging" : ""}`} style={panelStyle} onPointerDown={beginDrag}>{children}{!layout.locked && <div className="resize-handle" aria-label="调整大小" onPointerDown={beginResize} />}</div>;
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

function formatTranscriptTimestamp(startMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(startMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

function TranscriptTimeline({ remoteSnapshot, micSnapshot, currentQuestion }: { remoteSnapshot: TranscriptSnapshot; micSnapshot: TranscriptSnapshot; currentQuestion?: string }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [followLatest, setFollowLatest] = useState(true);
  useEffect(() => { if (followLatest && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [remoteSnapshot, micSnapshot, followLatest]);
  const onScroll = () => { const element = scrollRef.current; if (element) setFollowLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 30); };
  const segments = [...remoteSnapshot.final.map((segment) => ({ ...segment, speaker: "interviewer" as const })), ...micSnapshot.final.map((segment) => ({ ...segment, speaker: "self" as const }))].sort((left, right) => left.startMs - right.startMs).slice(-12);
  const partials = [
    remoteSnapshot.partial ? { ...remoteSnapshot.partial, speaker: "interviewer" as const } : undefined,
    micSnapshot.partial ? { ...micSnapshot.partial, speaker: "self" as const } : undefined
  ].filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));
  return <div className="transcript-wrap"><div className="transcript-scroll" ref={scrollRef} onScroll={onScroll}>{segments.map((segment, index) => <article className={`transcript-line ${segment.speaker} ${currentQuestion && segment.text === currentQuestion ? "current-bubble" : index === segments.length - 1 ? "latest-bubble" : ""}`} key={`${segment.id ?? segment.startMs}-${segment.speaker}`}><div className="transcript-line-meta"><span className="transcript-speaker">{segment.speaker === "interviewer" ? "面试官" : "我"}</span><time>{formatTranscriptTimestamp(segment.startMs)}</time></div><p>{segment.text}</p></article>)}{partials.map((partial) => <article className={`transcript-line ${partial.speaker} partial-bubble`} key={`partial-${partial.speaker}`}><div className="transcript-line-meta"><span className="transcript-speaker">{partial.speaker === "interviewer" ? "面试官" : "我"}</span><time>识别中</time></div><p>{partial.text}</p></article>)}</div>{!followLatest && <button className="latest-jump" onClick={() => { setFollowLatest(true); if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }}>↓ 最新</button>}</div>;
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

function AnswerSummary({ answerText, answerStreaming }: { answerText: string; answerStreaming: boolean }): JSX.Element {
  const keywords = useMemo(() => [...new Set((answerText.match(/[A-Za-z][A-Za-z0-9+#.-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []).slice(0, 6))], [answerText]);
  const hasAnswer = Boolean(answerText.trim());
  return <div className="answer-summary">{hasAnswer && <div className="answer-summary-label">CORE ANSWER</div>}<div className="answer-core"><AnswerCore text={answerText} />{answerStreaming && <span className="answer-cursor">▌</span>}</div>{hasAnswer && keywords.length > 0 && <><div className="answer-summary-label">KEYWORDS</div><div className="answer-keywords">{keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></>}</div>;
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
  return <section className="shortcut-card" role="dialog" aria-label="快捷操作"><header><div><span className="panel-kicker">QUICK ACTIONS</span><strong>快捷操作</strong></div><button onClick={onClose} aria-label="关闭快捷操作">×</button></header><div className="shortcut-actions">{!writtenTestMode && <button onClick={() => void onAnswerLatest()}><span>回答最新问题</span><kbd>Ctrl + Alt + A</kbd></button>}<button onClick={() => void onAnswerScreenshot()}><span>截图识别并回答</span><kbd>Ctrl + Alt + S</kbd></button><button onClick={onHideAll}><span>显示 / 隐藏全部悬浮窗</span><kbd>Ctrl + Alt + D</kbd></button><button onClick={onClose}><span>显示 / 隐藏快捷操作</span><kbd>Ctrl + Alt + K</kbd></button><button onClick={onEndInterview}><span>{writtenTestMode ? "结束笔试" : "结束面试"}</span><kbd>Ctrl + Alt + Q</kbd></button>{!writtenTestMode && <button onClick={onToggleAutomation}><span>自动 / 手动回答</span><kbd>Ctrl + Alt + X</kbd></button>}<button onClick={onToggleMode}><span>交互 / 穿透模式</span><kbd>Ctrl + Alt + P</kbd></button>{!writtenTestMode && <><div className="shortcut-static"><span>切换面试官记录</span><kbd>Ctrl + Alt + 1–8</kbd></div><div className="shortcut-static"><span>滚动回答面板</span><kbd>Ctrl + Alt + ↑↓</kbd></div></>}<button onClick={onResetLayout}><span>恢复默认布局</span></button></div></section>;
}

export function OverlayRoot(props: OverlayRootProps): JSX.Element {
  const { state, sessionState, realtimeState, operationMode, overlayMode, hudState: sharedHUDState, automationMode, question, answerText, answerStreaming, remoteTranscript, micTranscript, onToggleMode, onToggleAutomation, onAnswerQuestion, onAnswerLatest, onAnswerScreenshot, onEndInterview, onHideAll, onTogglePanels, onToggleTranscript, onToggleAnswer, onToggleShortcuts, captureProtectionEnabled, captureProtectionSupported, captureProtectionOsFlagApplied, captureProtectionDisplayVerified, captureProtectionLastError, captureTest } = props;
  const writtenTestMode = operationMode === "WRITTEN_TEST";
  const [layout, updateLayout, applyMainLayout] = useOverlayLayout();
  const [answerDraft, setAnswerDraft] = useState("");
  const [answerSending, setAnswerSending] = useState(false);
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
    const unsubscribeProtection = window.interviewCopilot.events.onOverlayCaptureProtection((next) => { if (!disposed) setRuntimeProtection(next); });
    const unsubscribeLayout = window.interviewCopilot.events.onOverlayLayout((next) => { if (!disposed) applyMainLayout(next); });
    const unsubscribeCommands = window.interviewCopilot.events.onOverlayCommand((command: OverlayCommand) => { if (command === "confirm-end") setEndConfirmOpen(true); });
    return () => { disposed = true; unsubscribeProtection(); unsubscribeLayout(); unsubscribeCommands(); };
  }, [applyMainLayout]);
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
  const transcriptVisible = sharedHUDState.transcriptVisible && !visualHidden;
  const answerVisible = sharedHUDState.answerVisible && !visualHidden;
  const shortcutVisible = sharedHUDState.shortcutVisible && !visualHidden;
  return <main className="overlay-root" data-hud-state={status} data-hud-mode={sharedHUDState.mode} data-share-mode={sharedHUDState.shareMode ? "on" : "off"} data-overlay-mode={overlayMode} data-operation-mode={operationMode}>
    {captureTest && !visualHidden && <div className="capture-test-marker">CAPTURE_PROTECTION_TEST_MARKER_7F32</div>}
     {sharedHUDState.topBarVisible && !visualHidden && <DraggableResizablePanel panel="toolbar" layout={{ ...layout.toolbar, visible: true, locked: true }} onChange={updateLayout} className="toolbar-panel"><div className="floating-toolbar hud-interactive-region" role="toolbar" aria-label={writtenTestMode ? "笔试控制栏" : "面试控制栏"}><span className="toolbar-audio-mark" aria-hidden="true"><ToolbarIcon name="waveform" /></span><div className="toolbar-runtime"><span>{elapsedLabel}</span></div><span className="toolbar-divider" aria-hidden="true" /><div className={`toolbar-status-inline ${statusMeta.tone}`}><i aria-hidden="true" /><span>{listeningLabel}</span></div>{!writtenTestMode && <div className="toolbar-mode-switch" role="group" aria-label="回答模式"><button className={automationMode === "AUTO" ? "selected" : ""} onClick={() => { if (automationMode !== "AUTO") void onToggleAutomation(); }}>自动</button><button className={automationMode === "MANUAL" ? "selected" : ""} onClick={() => { if (automationMode !== "MANUAL") void onToggleAutomation(); }}>手动</button></div>}<button className={`toolbar-inline-action toolbar-panel-toggle ${transcriptVisible ? "active" : "inactive"}`} onClick={onToggleTranscript} title={transcriptVisible ? "隐藏左侧对话" : "显示左侧对话"} aria-label={transcriptVisible ? "隐藏左侧对话" : "显示左侧对话"} aria-pressed={transcriptVisible}><ToolbarIcon name="panel-left" /></button><button className={`toolbar-inline-action toolbar-panel-toggle ${answerVisible ? "active" : "inactive"}`} onClick={onToggleAnswer} title={answerVisible ? "隐藏右侧回答" : "显示右侧回答"} aria-label={answerVisible ? "隐藏右侧回答" : "显示右侧回答"} aria-pressed={answerVisible}><ToolbarIcon name="panel-right" /></button><button className="toolbar-inline-action toolbar-shortcut-toggle" onClick={onToggleShortcuts} title="打开快捷操作" aria-label="打开快捷操作"><ToolbarIcon name="keyboard" /></button><button className="toolbar-end-button" onClick={() => setEndConfirmOpen(true)} title={writtenTestMode ? "结束笔试 Ctrl+Alt+Q" : "结束面试 Ctrl+Alt+Q"} aria-label={writtenTestMode ? "结束笔试" : "结束面试"}>{writtenTestMode ? "结束笔试" : "结束面试"}</button></div></DraggableResizablePanel>}
     {transcriptVisible && !writtenTestMode && <DraggableResizablePanel panel="transcript" layout={{ ...layout.transcript, visible: true }} onChange={updateLayout} className="transcript-panel"><section className="overlay-panel-card transcript-card" aria-label="对话"><TranscriptTimeline remoteSnapshot={remoteTranscript} micSnapshot={micTranscript} currentQuestion={question?.text} /></section></DraggableResizablePanel>}
     {answerVisible && <DraggableResizablePanel panel="answer" layout={{ ...layout.answer, visible: true }} onChange={updateLayout} className="answer-panel"><section className="overlay-panel-card answer-card" aria-label="回答"><div className="answer-question-row"><div>{question?.text && <><span className="current-question-label">{writtenTestMode ? "截图题目" : "当前问题"}</span><strong>{question.text}</strong></>}</div>{(answerStreaming || answerText) && <span className={`answer-ready ${answerStreaming ? "generating" : ""}`}>{answerStreaming ? "生成中" : "回答已就绪"}</span>}</div><AnswerSummary answerText={answerText} answerStreaming={answerStreaming} /><div className="overlay-answer-composer hud-interactive-region">{writtenTestMode ? <div className="written-test-hint">按 Ctrl+Alt+S 截取当前题目，自动识别并回答</div> : <textarea value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitAnswer(); } }} placeholder="输入问题，或空发最新面试官问题..." disabled={answerSending} rows={2} />}<div><button onClick={() => void submitScreenshot()} disabled={answerSending}>{writtenTestMode ? "⊕ 截图回答" : "⊕ 附截图"}</button>{!writtenTestMode && <button className="auto-answer" onClick={() => void onToggleAutomation()} disabled={answerSending}>{automationMode === "AUTO" ? "◉ 自动回答" : "Ⅱ 手动回答"}</button>}{!writtenTestMode && <button className="overlay-send" onClick={() => void submitAnswer()} disabled={answerSending}>↑</button>}</div></div></section></DraggableResizablePanel>}
    {shortcutVisible && <DraggableResizablePanel panel="shortcuts" layout={{ ...layout.shortcuts, visible: true }} onChange={updateLayout} className="shortcut-panel"><div className="hud-interactive-region"><ShortcutPopover writtenTestMode={writtenTestMode} onAnswerLatest={onAnswerLatest} onAnswerScreenshot={onAnswerScreenshot} onHideAll={onHideAll} onToggleMode={onToggleMode} onToggleAutomation={() => void onToggleAutomation()} onResetLayout={() => void window.interviewCopilot.overlay.resetLayout()} onEndInterview={() => setEndConfirmOpen(true)} onClose={onToggleShortcuts} /></div></DraggableResizablePanel>}
    {endConfirmOpen && !visualHidden && <EndInterviewDialog writtenTestMode={writtenTestMode} onCancel={() => setEndConfirmOpen(false)} onConfirm={() => { setEndConfirmOpen(false); void onEndInterview(); }} />}
    {!visualHidden && <div className={`hud-protection-indicator ${protectionTone}`} title={!effectiveProtectionSupported ? "当前平台不支持 Windows Capture Protection" : effectiveLastError ? "Windows protection flag 失败" : effectiveDisplayVerified === true ? "Display Capture Verified" : effectiveProtectionEnabled ? "Windows protection on" : "Windows protection off"}>{effectiveProtectionSupported ? "◈" : "·"}</div>}
  </main>;
}
