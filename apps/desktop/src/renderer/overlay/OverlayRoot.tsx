import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type JSX } from "react";
import type { TranscriptSnapshot } from "@interview-copilot/shared";
import type { OverlayMode } from "../../main/overlay-manager";

interface OverlayRootProps {
  mic: number;
  system: number;
  state: string;
  overlayMode: OverlayMode;
  answerMode: "FAST" | "NORMAL" | "DEEP";
  question?: { text: string };
  answerText: string;
  answerStreaming: boolean;
  remoteTranscript: TranscriptSnapshot;
  micTranscript: TranscriptSnapshot;
  onToggleMode: () => void;
}

type PanelKey = "toolbar" | "transcript" | "answer" | "shortcuts";
type Position = { x: number; y: number };

const defaults: Record<PanelKey, Position> = {
  toolbar: { x: 420, y: 24 },
  transcript: { x: 54, y: 138 },
  answer: { x: 890, y: 138 },
  shortcuts: { x: 54, y: 704 }
};

function usePanelPositions(): [Record<PanelKey, Position>, (key: PanelKey, position: Position) => void] {
  const [positions, setPositions] = useState<Record<PanelKey, Position>>(() => {
    try { return { ...defaults, ...JSON.parse(localStorage.getItem("interview-copilot.overlay-positions") ?? "{}") }; } catch { return defaults; }
  });
  const move = (key: PanelKey, position: Position) => setPositions((current) => {
    const next = { ...current, [key]: position };
    try { localStorage.setItem("interview-copilot.overlay-positions", JSON.stringify(next)); } catch { /* best effort */ }
    return next;
  });
  return [positions, move];
}

function DraggablePanel({ panel, position, onMove, className, children }: { panel: PanelKey; position: Position; onMove: (key: PanelKey, position: Position) => void; className: string; children: JSX.Element }): JSX.Element {
  const [dragging, setDragging] = useState(false);
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, input, textarea")) return;
    setDragging(true);
    const origin = { x: event.clientX - position.x, y: event.clientY - position.y };
    const move = (next: PointerEvent) => onMove(panel, { x: Math.max(10, next.clientX - origin.x), y: Math.max(10, next.clientY - origin.y) });
    const end = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  return <div className={`floating-panel ${className} ${dragging ? "dragging" : ""}`} style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }} onPointerDown={start}>{children}</div>;
}

function TranscriptPanel({ label, snapshot }: { label: string; snapshot: TranscriptSnapshot }): JSX.Element {
  const segments = snapshot.final.slice(-5);
  return <div className="overlay-transcript-content"><div className="overlay-panel-label">{label}</div>{segments.length === 0 && !snapshot.partial ? <p className="overlay-muted">等待转录...</p> : segments.map((segment) => <p key={segment.id}>{segment.text}</p>)}{snapshot.partial && <p className="partial-line">{snapshot.partial.text}</p>}</div>;
}

export function OverlayRoot({ mic, system, state, overlayMode, answerMode, question, answerText, answerStreaming, remoteTranscript, micTranscript, onToggleMode }: OverlayRootProps): JSX.Element {
  const [positions, movePanel] = usePanelPositions();
  const [answerDraft, setAnswerDraft] = useState("");
  const answerLines = useMemo(() => answerText.split(/\r?\n/).filter(Boolean).slice(-12), [answerText]);
  return (
    <main className="overlay-root">
      <DraggablePanel panel="toolbar" position={positions.toolbar} onMove={movePanel} className="toolbar-panel">
        <div className="floating-toolbar"><strong>Interview Copilot</strong><span className="toolbar-divider" /><span className="toolbar-status"><i />{state}</span><span className="toolbar-chip">麦克风 {Math.round(mic * 100)}%</span><span className="toolbar-chip">回答 {answerMode}</span><button onClick={onToggleMode}>{overlayMode === "interactive" ? "AUTO" : "PASSIVE"}</button><span className="toolbar-live">●</span></div>
      </DraggablePanel>
      <DraggablePanel panel="transcript" position={positions.transcript} onMove={movePanel} className="transcript-panel">
        <section className="overlay-panel-card"><header><strong>转录会显示在这里</strong><button aria-label="关闭转录">×</button></header><TranscriptPanel label="面试官" snapshot={remoteTranscript} /><TranscriptPanel label="我的语音" snapshot={micTranscript} /></section>
      </DraggablePanel>
      <DraggablePanel panel="answer" position={positions.answer} onMove={movePanel} className="answer-panel">
        <section className="overlay-panel-card"><header><strong>回答</strong><span className="answer-ready">● 自动回答已就绪</span></header><p className="answer-intro">你也可以输入问题，不输入文字发送最新问题，或附截图发送。</p><div className="overlay-question"><small>QUESTION</small><strong>{question?.text ?? "等待面试官问题"}</strong></div><div className="overlay-answer-body">{answerLines.length ? answerLines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>) : <><strong>核心回答</strong><p>回答将在确认完整问题后显示。</p><p>• 自动整理关键观点<br />• 保持回答简洁可扫读</p></>}{answerStreaming && <span className="answer-cursor">▌</span>}</div><div className="overlay-answer-composer"><input value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} placeholder="输入问题，或留空发送最新面试官问题..." /><div><button>⊕ 附截图</button><button className="auto-answer">◉ 自动回答</button><button className="overlay-send" onClick={() => setAnswerDraft("")}>↑</button></div></div></section>
      </DraggablePanel>
      <DraggablePanel panel="shortcuts" position={positions.shortcuts} onMove={movePanel} className="shortcut-panel">
        <section className="shortcut-card"><header><strong>键盘快捷方式</strong><button aria-label="关闭快捷键">×</button></header><div><span>回答问题</span><kbd>Ctrl Alt A</kbd><span>截图并回答</span><kbd>Ctrl Alt S</kbd><span>隐藏 / 显示悬浮窗</span><kbd>Ctrl Alt D</kbd><span>隐藏 / 显示快捷键</span><kbd>Ctrl Alt K</kbd><span>结束回答</span><kbd>Ctrl Alt Q</kbd><span>切换自动回答</span><kbd>Ctrl Alt X</kbd><span>发送面试官转录</span><kbd>Ctrl Alt 1–8</kbd><span>滚动回答面板</span><kbd>Ctrl Alt ↑ / ↓</kbd></div></section>
      </DraggablePanel>
    </main>
  );
}
