import { useEffect, useMemo } from "react";
import type { JSX } from "react";
import { create } from "zustand";
import type { AudioSidecarEvent } from "@interview-copilot/protocol";
import type { SessionState } from "@interview-copilot/shared";
import { normalizeMeter } from "@interview-copilot/shared";
import type { OverlayMode } from "../main/overlay-manager";

interface AudioStore {
  mic: number;
  system: number;
  state: "STARTING" | "READY" | "DEGRADED" | "RECOVERING" | "FAILED" | "STOPPED";
  micHealth: "ok" | "degraded" | "failed" | "unknown";
  loopbackHealth: "ok" | "degraded" | "failed" | "unknown";
  overlayMode: OverlayMode;
  sessionState: SessionState;
  diagnostic?: string;
  applyEvent: (event: AudioSidecarEvent) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setSessionState: (state: SessionState) => void;
  setDiagnostic: (message: string) => void;
}

const useAudioStore = create<AudioStore>((set) => ({
  mic: 0,
  system: 0,
  state: "STOPPED",
  micHealth: "unknown",
  loopbackHealth: "unknown",
  overlayMode: "interactive",
  sessionState: "IDLE",
  applyEvent: (event) => set((current) => {
    if (event.type === "meter") {
      return { mic: normalizeMeter(event.mic), system: normalizeMeter(event.system) };
    }
    if (event.type === "audio_health") {
      return { micHealth: event.mic, loopbackHealth: event.loopback, state: event.mic === "ok" && event.loopback === "ok" ? "READY" : "DEGRADED" };
    }
    if (event.type === "audio_state") return { state: event.state };
    return { state: event.recoverable ? "DEGRADED" : "FAILED", diagnostic: event.reason };
  }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setSessionState: (sessionState) => set({ sessionState }),
  setDiagnostic: (diagnostic) => set({ diagnostic })
}));

function Meter({ label, value, accent }: { label: string; value: number; accent: string }): JSX.Element {
  return (
    <div className="meter-row">
      <div className="meter-label"><span>{label}</span><span>{Math.round(value * 100)}%</span></div>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${value * 100}%`, background: accent }} /></div>
    </div>
  );
}

function StatusPill({ state }: { state: string }): JSX.Element {
  const tone = state === "READY" || state === "RUNNING" ? "success" : state === "FAILED" ? "danger" : "warning";
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{state}</span>;
}

function OverlayView(): JSX.Element {
  const { mic, system, state, overlayMode, setOverlayMode } = useAudioStore();
  return (
    <main className="overlay-shell">
      <div className="overlay-bar"><span>Interview Copilot</span><StatusPill state={state} /></div>
      <section className="overlay-card">
        <div className="eyebrow">CURRENT QUESTION</div>
        <h1>等待面试官问题</h1>
        <div className="answer-placeholder">答案将在确认完整问题后显示</div>
        <div className="overlay-meters"><Meter label="MIC" value={mic} accent="#8b5cf6" /><Meter label="SYSTEM" value={system} accent="#22d3ee" /></div>
      </section>
      <button className="overlay-mode" onClick={() => void setOverlayMode(overlayMode === "interactive" ? "passive" : "interactive")}>
        {overlayMode === "interactive" ? "切换 Passive 模式" : "切换 Interactive 模式"}
      </button>
    </main>
  );
}

export function App(): JSX.Element {
  const isOverlay = useMemo(() => new URLSearchParams(window.location.search).get("window") === "overlay", []);
  const store = useAudioStore();

  useEffect(() => {
    const cleanups = [
      window.interviewCopilot.events.onAudio(store.applyEvent),
      window.interviewCopilot.events.onAudioDiagnostic(store.setDiagnostic),
      window.interviewCopilot.events.onSessionState(store.setSessionState),
      window.interviewCopilot.events.onOverlayMode(store.setOverlayMode)
    ];
    void window.interviewCopilot.session.getState().then(store.setSessionState);
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [store.applyEvent, store.setDiagnostic, store.setOverlayMode, store.setSessionState]);

  if (isOverlay) return <OverlayView />;

  const startAudio = async () => {
    await window.interviewCopilot.audio.start({ meterOnly: true });
  };
  const stopAudio = async () => {
    await window.interviewCopilot.audio.stop();
  };
  const openOverlay = async () => {
    await window.interviewCopilot.overlay.show();
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">IC</div>
        <div className="brand-copy"><strong>Interview</strong><span>Copilot</span></div>
        <nav>
          <button className="nav-item active"><span>⌂</span>概览</button>
          <button className="nav-item"><span>◈</span>Profiles</button>
          <button className="nav-item"><span>↗</span>Preparation Agent</button>
          <button className="nav-item"><span>◷</span>面试历史</button>
          <button className="nav-item"><span>⚙</span>设置</button>
        </nav>
        <div className="sidebar-footer"><span className="online-dot" />本地工作区</div>
      </aside>

      <section className="content-shell">
        <header className="topbar"><div><div className="eyebrow">REALTIME WORKSPACE</div><h1>面试工作台</h1></div><StatusPill state={store.state} /></header>
        <div className="content-scroll">
          <section className="hero-card">
            <div><div className="eyebrow accent-text">READY WHEN YOU ARE</div><h2>开始一场更专注的面试</h2><p>先完成音频检测，再进入实时转写和回答流程。</p></div>
            <div className="hero-actions"><button className="primary-button" onClick={startAudio}>启动音频检测</button><button className="secondary-button" onClick={openOverlay}>打开悬浮窗</button></div>
          </section>

          <div className="dashboard-grid">
            <section className="panel audio-panel"><div className="panel-heading"><div><div className="eyebrow">AUDIO TEST</div><h3>双通道音频</h3></div><StatusPill state={store.state} /></div><p className="muted">LEFT = MIC · RIGHT = SYSTEM LOOPBACK</p><div className="meters"><Meter label="MIC / 用户" value={store.mic} accent="#8b5cf6" /><Meter label="SYSTEM / 对方" value={store.system} accent="#22d3ee" /></div><div className="audio-actions"><button className="secondary-button" onClick={() => void window.interviewCopilot.audio.probe()}>探测设备</button><button className="ghost-button" onClick={stopAudio}>停止 Sidecar</button></div>{store.diagnostic && <div className="diagnostic">{store.diagnostic}</div>}</section>
            <section className="panel setup-panel"><div className="panel-heading"><div><div className="eyebrow">INTERVIEW SETUP</div><h3>开始前配置</h3></div><span className="step-count">01 / 05</span></div><div className="setup-list"><div><span className="setup-icon">P</span><span>Profile</span><strong>默认 Profile</strong></div><div><span className="setup-icon">⌁</span><span>Microphone</span><strong>未选择设备</strong></div><div><span className="setup-icon">◉</span><span>System Audio</span><strong>未选择设备</strong></div><div><span className="setup-icon">A</span><span>Automation</span><strong>MANUAL</strong></div></div><button className="primary-button full-width" onClick={openOverlay}>进入面试设置</button></section>
          </div>

          <section className="panel flow-panel"><div className="panel-heading"><div><div className="eyebrow">CORE PIPELINE</div><h3>实时链路</h3></div><span className="muted">Phase 1 foundation</span></div><div className="pipeline"><div className="pipeline-node active"><b>01</b><span>WASAPI</span><small>双通道捕获</small></div><div className="pipeline-line" /><div className="pipeline-node"><b>02</b><span>ASR</span><small>下一阶段</small></div><div className="pipeline-line" /><div className="pipeline-node"><b>03</b><span>QUESTION</span><small>边界检测</small></div><div className="pipeline-line" /><div className="pipeline-node"><b>04</b><span>ANSWER</span><small>流式输出</small></div></div></section>
        </div>
      </section>
    </main>
  );
}
