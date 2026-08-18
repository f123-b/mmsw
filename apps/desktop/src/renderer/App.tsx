import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { create } from "zustand";
import type { AudioDevices, AudioDrift, AudioSidecarEvent, ProbeResult, RealtimeServerMessage } from "@interview-copilot/protocol";
import type { QuestionCandidate, QuestionEvent, SessionState, TranscriptSnapshot } from "@interview-copilot/shared";
import { normalizeMeter, StableAnswerStateMachine } from "@interview-copilot/shared";
import type { OverlayMode } from "../main/overlay-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import { selectDeviceId } from "./device-selection";

const DETECT_THRESHOLD = 0.08;
const DEFAULT_DEVICES: AudioDevices = { inputs: [], outputs: [] };

interface AudioStore {
  mic: number;
  system: number;
  state: "STARTING" | "READY" | "DEGRADED" | "RECOVERING" | "FAILED" | "STOPPED";
  micHealth: "ok" | "degraded" | "failed" | "unknown";
  loopbackHealth: "ok" | "degraded" | "failed" | "unknown";
  micDetected: boolean;
  systemDetected: boolean;
  overlayMode: OverlayMode;
  sessionState: SessionState;
  automationMode: "MANUAL" | "AUTO";
  probeResult?: ProbeResult;
  drift?: AudioDrift;
  bufferStats?: { queuedFrames: number; droppedFrames: number; bufferDurationMs: number };
  realtimeState: string;
  remoteTranscript: TranscriptSnapshot;
  micTranscript: TranscriptSnapshot;
  question?: QuestionCandidate;
  answerText: string;
  answerStreaming: boolean;
  answerId?: string;
  screenshot?: ScreenshotResult;
  notice?: string;
  applyEvent: (event: AudioSidecarEvent) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setSessionState: (state: SessionState) => void;
  setAutomationMode: (mode: "MANUAL" | "AUTO") => void;
  setScreenshot: (screenshot: ScreenshotResult) => void;
  setNotice: (notice?: string) => void;
  setRealtimeState: (state: string) => void;
  applyTranscript: (snapshot: TranscriptSnapshot) => void;
  applyQuestion: (event: QuestionEvent) => void;
  applyRealtimeMessage: (message: RealtimeServerMessage) => void;
}

const stableAnswer = new StableAnswerStateMachine();

const useAudioStore = create<AudioStore>((set) => ({
  mic: 0,
  system: 0,
  state: "STOPPED",
  micHealth: "unknown",
  loopbackHealth: "unknown",
  micDetected: false,
  systemDetected: false,
  overlayMode: "interactive",
  sessionState: "IDLE",
  automationMode: "MANUAL",
  realtimeState: "disconnected",
  remoteTranscript: { source: "remote", final: [] },
  micTranscript: { source: "mic", final: [] },
  answerText: "",
  answerStreaming: false,
  applyEvent: (event) => set((current) => {
    if (event.type === "meter") {
      return {
        mic: normalizeMeter(event.mic),
        system: normalizeMeter(event.system),
        micDetected: event.mic >= DETECT_THRESHOLD,
        systemDetected: event.system >= DETECT_THRESHOLD
      };
    }
    if (event.type === "audio_health") {
      return {
        micHealth: event.mic,
        loopbackHealth: event.loopback,
        state: event.mic === "ok" && event.loopback === "ok" ? "READY" : "DEGRADED"
      };
    }
    if (event.type === "audio_state") return { state: event.state };
    if (event.type === "probe_result") return { probeResult: event, state: event.mic.ok && event.system.ok ? "READY" : "FAILED" };
    if (event.type === "audio_buffer") return { bufferStats: event };
    if (event.type === "audio_drift") return { drift: event };
    return { state: event.recoverable ? "DEGRADED" : "FAILED", notice: event.reason };
  }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setSessionState: (sessionState) => set({ sessionState }),
  setAutomationMode: (automationMode) => set({ automationMode }),
  setScreenshot: (screenshot) => set({ screenshot }),
  setNotice: (notice) => set({ notice }),
  setRealtimeState: (realtimeState) => set({ realtimeState }),
  applyTranscript: (snapshot) => set(snapshot.source === "remote" ? { remoteTranscript: snapshot } : { micTranscript: snapshot }),
  applyQuestion: (event) => set((current) => event.type === "question_confirmed" || event.type === "question_superseded" ? { question: event.question, notice: event.type === "question_superseded" ? "新问题已覆盖上一题" : current.notice } : current),
  applyRealtimeMessage: (message) => {
    const snapshot = message.type === "answer_start"
      ? stableAnswer.start(message.answerId)
      : message.type === "answer_delta"
        ? stableAnswer.delta(message.answerId, message.delta)
        : message.type === "answer_end"
          ? stableAnswer.end(message.answerId, message.text)
          : message.type === "answer_cancelled"
            ? stableAnswer.cancel(message.answerId)
            : stableAnswer.snapshot;
    set({ answerText: snapshot.displayedText, answerStreaming: snapshot.streaming, answerId: snapshot.displayedAnswerId });
  }
}));

function Meter({ label, value, accent }: { label: string; value: number; accent: string }): JSX.Element {
  return (
    <div className="meter-row">
      <div className="meter-label"><span>{label}</span><span>{Math.round(value * 100)}%</span></div>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${value * 100}%`, background: accent }} /></div>
    </div>
  );
}

function DetectionBadge({ label, detected }: { label: string; detected: boolean }): JSX.Element {
  return <span className={`detection-badge ${detected ? "detected" : "waiting"}`}><span />{label}: {detected ? "detected" : "waiting"}</span>;
}

function StatusPill({ state }: { state: string }): JSX.Element {
  const tone = state === "READY" || state === "RUNNING" ? "success" : state === "FAILED" ? "danger" : "warning";
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{state}</span>;
}

function OverlayView(): JSX.Element {
  const { mic, system, state, overlayMode, question, answerText, answerStreaming } = useAudioStore();
  const toggleMode = async () => {
    await window.interviewCopilot.overlay.setMode(overlayMode === "interactive" ? "passive" : "interactive");
  };
  return (
    <main className="overlay-shell">
      <div className="overlay-bar"><span>Interview Copilot</span><StatusPill state={state} /></div>
      <section className="overlay-card">
        <div className="eyebrow">CURRENT QUESTION</div>
        <h1>{question?.text ?? "等待面试官问题"}</h1>
        <div className="answer-placeholder">{answerText || "答案将在确认完整问题后显示"}{answerStreaming && <span className="answer-cursor">▌</span>}</div>
        <div className="overlay-meters"><Meter label="MIC" value={mic} accent="#8b5cf6" /><Meter label="SYSTEM" value={system} accent="#22d3ee" /></div>
      </section>
      <button className="overlay-mode" onClick={() => void toggleMode()}>
        {overlayMode === "interactive" ? "切换 Passive 模式" : "切换 Interactive 模式"}
      </button>
    </main>
  );
}

function TranscriptColumn({ label, snapshot }: { label: string; snapshot: TranscriptSnapshot }): JSX.Element {
  const latest = snapshot.final.slice(-4);
  return (
    <div className="transcript-column">
      <div className="transcript-label">{label}</div>
      <div className="transcript-lines">
        {latest.length === 0 && !snapshot.partial && <span className="muted">等待 ASR...</span>}
        {latest.map((segment) => <div className="transcript-line" key={segment.id}>{segment.text}</div>)}
        {snapshot.partial && <div className="transcript-line partial" key={snapshot.partial.id}>{snapshot.partial.text}</div>}
      </div>
    </div>
  );
}

function storedDevice(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

function persistDevice(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* localStorage can be unavailable in hardened environments */ }
}

export function App(): JSX.Element {
  const isOverlay = useMemo(() => new URLSearchParams(window.location.search).get("window") === "overlay", []);
  const store = useAudioStore();
  const [devices, setDevices] = useState<AudioDevices>(DEFAULT_DEVICES);
  const [inputDeviceId, setInputDeviceId] = useState("");
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [realtimeUrl, setRealtimeUrl] = useState(() => storedDevice("interview-copilot.realtime-url") ?? "");
  const [realtimeTicket, setRealtimeTicket] = useState("");

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const listed = await window.interviewCopilot.audio.listDevices();
        setDevices(listed);
        const savedInput = storedDevice("interview-copilot.input-device");
        const savedOutput = storedDevice("interview-copilot.output-device");
        const input = selectDeviceId(listed.inputs, savedInput);
        const output = selectDeviceId(listed.outputs, savedOutput);
        setInputDeviceId(input);
        setOutputDeviceId(output);
        if (input) persistDevice("interview-copilot.input-device", input);
        if (output) persistDevice("interview-copilot.output-device", output);
      } catch (error) {
        store.setNotice(`设备枚举失败：${String(error)}`);
      }
    };
    void loadDevices();

    const cleanups = [
      window.interviewCopilot.events.onAudio(store.applyEvent),
      window.interviewCopilot.events.onSessionState(store.setSessionState),
      window.interviewCopilot.events.onOverlayMode(store.setOverlayMode),
      window.interviewCopilot.events.onScreenshot(store.setScreenshot),
      window.interviewCopilot.events.onScreenshotError(store.setNotice),
      window.interviewCopilot.events.onScreenshotDiagnostic(store.setNotice),
      window.interviewCopilot.events.onRealtimeState(store.setRealtimeState),
      window.interviewCopilot.events.onRealtimeTranscript(store.applyTranscript),
      window.interviewCopilot.events.onRealtimeMessage(store.applyRealtimeMessage),
      window.interviewCopilot.events.onRealtimeDiagnostic(store.setNotice),
      window.interviewCopilot.events.onQuestion(store.applyQuestion),
      window.interviewCopilot.events.onShortcut((shortcut) => {
        if (shortcut === "toggle-automation") {
          const next = useAudioStore.getState().automationMode === "MANUAL" ? "AUTO" : "MANUAL";
          useAudioStore.getState().setAutomationMode(next);
          useAudioStore.getState().setNotice(`Automation 已切换为 ${next}`);
        } else if (shortcut === "answer-latest") {
          useAudioStore.getState().setNotice("Answer latest shortcut received");
        } else if (shortcut === "screenshot-answer") {
          useAudioStore.getState().setNotice("Screenshot shortcut received");
        } else if (shortcut === "end-interview") {
          useAudioStore.getState().setNotice("End interview shortcut received");
        }
      })
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  if (isOverlay) return <OverlayView />;

  const startAudio = async () => {
    persistDevice("interview-copilot.input-device", inputDeviceId);
    persistDevice("interview-copilot.output-device", outputDeviceId);
    await window.interviewCopilot.audio.start({ inputDeviceId, outputDeviceId, meterOnly: true });
  };
  const stopAudio = async () => { await window.interviewCopilot.audio.stop(); };
  const probeAudio = async () => { await window.interviewCopilot.audio.probe({ inputDeviceId, outputDeviceId }); };
  const openOverlay = async () => { await window.interviewCopilot.overlay.show(); };
  const captureScreenshot = async () => {
    try { store.setScreenshot(await window.interviewCopilot.screenshot.capture()); }
    catch (error) { store.setNotice(`截图失败：${String(error)}`); }
  };
  const connectRealtime = async () => {
    if (!realtimeUrl.trim()) {
      store.setNotice("请输入 Realtime WebSocket 地址");
      return;
    }
    persistDevice("interview-copilot.realtime-url", realtimeUrl.trim());
    await window.interviewCopilot.realtime.connect({ url: realtimeUrl.trim(), ticket: realtimeTicket.trim() || undefined });
  };
  const disconnectRealtime = async () => { await window.interviewCopilot.realtime.disconnect(); };

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
            <div><div className="eyebrow accent-text">PHASE 1 AUDIO VALIDATION</div><h2>验证两条独立音频路径</h2><p>先确认 MIC 和 SYSTEM Loopback，再进入后续实时处理阶段。</p></div>
            <div className="hero-actions"><button className="primary-button" onClick={() => void startAudio()}>启动音频检测</button><button className="secondary-button" onClick={() => void captureScreenshot()}>截图测试</button><button className="secondary-button" onClick={openOverlay}>打开悬浮窗</button></div>
          </section>

          <div className="dashboard-grid">
            <section className="panel audio-panel">
              <div className="panel-heading"><div><div className="eyebrow">AUDIO TEST</div><h3>双通道音频</h3></div><StatusPill state={store.state} /></div>
              <p className="muted">LEFT = MIC · RIGHT = SYSTEM LOOPBACK · threshold {DETECT_THRESHOLD}</p>
              <div className="meters"><Meter label="MIC / 用户" value={store.mic} accent="#8b5cf6" /><Meter label="SYSTEM / 对方" value={store.system} accent="#22d3ee" /></div>
              <div className="detections"><DetectionBadge label="MIC" detected={store.micDetected} /><DetectionBadge label="SYSTEM" detected={store.systemDetected} /></div>
              <div className="audio-actions"><button className="secondary-button" onClick={() => void probeAudio()}>Probe 2s</button><button className="ghost-button" onClick={stopAudio}>停止 Sidecar</button></div>
              {store.bufferStats && <div className="buffer-stats">buffer {store.bufferStats.bufferDurationMs}ms · queued {store.bufferStats.queuedFrames} · dropped {store.bufferStats.droppedFrames}</div>}
              {store.drift && <div className={`drift-stats ${store.drift.status}`}><span>Drift: {store.drift.driftMs}ms</span><small>{store.drift.status}</small></div>}
              {store.notice && <div className="diagnostic">{store.notice}</div>}
            </section>

            <section className="panel setup-panel">
              <div className="panel-heading"><div><div className="eyebrow">DEVICE SETUP</div><h3>音频设备</h3></div><span className="step-count">Phase 1</span></div>
              <label className="device-field"><span>Microphone</span><select value={inputDeviceId} onChange={(event) => { setInputDeviceId(event.target.value); persistDevice("interview-copilot.input-device", event.target.value); }}><option value="">选择麦克风</option>{devices.inputs.map((device) => <option value={device.id} key={device.id}>{device.name}{device.default ? " · 默认" : ""}</option>)}</select></label>
              <label className="device-field"><span>System Audio</span><select value={outputDeviceId} onChange={(event) => { setOutputDeviceId(event.target.value); persistDevice("interview-copilot.output-device", event.target.value); }}><option value="">选择输出设备</option>{devices.outputs.map((device) => <option value={device.id} key={device.id}>{device.name}{device.default ? " · 默认" : ""}</option>)}</select></label>
              <div className="setup-list compact"><div><span className="setup-icon">A</span><span>Automation</span><strong>{store.automationMode}</strong></div><div><span className="setup-icon">◉</span><span>Sidecar</span><strong>{store.state}</strong></div></div>
              <button className="primary-button full-width" onClick={() => void startAudio()}>使用当前设备启动</button>
            </section>
          </div>

          <section className="panel realtime-panel"><div className="panel-heading"><div><div className="eyebrow">REALTIME ASR</div><h3>MIC / REMOTE Transcript</h3></div><StatusPill state={store.realtimeState.toUpperCase()} /></div><div className="realtime-connect"><input value={realtimeUrl} onChange={(event) => setRealtimeUrl(event.target.value)} placeholder="wss://host/api/v1/realtime/{interviewId}" aria-label="Realtime WebSocket URL" /><input value={realtimeTicket} onChange={(event) => setRealtimeTicket(event.target.value)} placeholder="短期 ticket（可选）" aria-label="Realtime ticket" type="password" /><button className="secondary-button" onClick={() => void connectRealtime()}>连接 ASR</button><button className="ghost-button" onClick={() => void disconnectRealtime()}>断开</button></div><div className="transcript-grid"><TranscriptColumn label="REMOTE / 面试官" snapshot={store.remoteTranscript} /><TranscriptColumn label="MIC / 用户" snapshot={store.micTranscript} /></div></section>

          {store.probeResult && <section className="panel probe-panel"><div className="panel-heading"><div><div className="eyebrow">PROBE RESULT</div><h3>2 秒采集统计</h3></div><span className="muted">{store.probeResult.durationMs}ms</span></div><div className="probe-grid"><div><strong>MIC</strong><span>{store.probeResult.mic.ok ? "OK" : "FAILED"} · {store.probeResult.mic.sampleRate}Hz · {store.probeResult.mic.channels}ch</span><small>callbacks {store.probeResult.mic.callbackCount} · samples {store.probeResult.mic.sampleCount} · peak {store.probeResult.mic.peak.toFixed(2)}</small></div><div><strong>SYSTEM</strong><span>{store.probeResult.system.ok ? "OK" : "FAILED"} · {store.probeResult.system.sampleRate}Hz · {store.probeResult.system.channels}ch</span><small>callbacks {store.probeResult.system.callbackCount} · samples {store.probeResult.system.sampleCount} · peak {store.probeResult.system.peak.toFixed(2)}</small></div></div></section>}

          {store.screenshot && <section className="panel screenshot-panel"><div className="panel-heading"><div><div className="eyebrow">SCREENSHOT TEST</div><h3>最近截图</h3></div><span className="muted">{store.screenshot.mimeType} · {store.screenshot.size} bytes</span></div><img className="screenshot-preview" src={store.screenshot.dataUrl} alt="最近一次桌面截图" /><div className="muted screenshot-path">已保存：{store.screenshot.path}</div></section>}

          <section className="panel flow-panel"><div className="panel-heading"><div><div className="eyebrow">CORE PIPELINE</div><h3>实时链路</h3></div><span className="muted">Phase 2 realtime foundation · Phase 3 question detector</span></div><div className="pipeline"><div className="pipeline-node active"><b>01</b><span>WASAPI</span><small>双通道捕获</small></div><div className="pipeline-line" /><div className="pipeline-node active"><b>02</b><span>ASR</span><small>PCM + Transcript</small></div><div className="pipeline-line" /><div className="pipeline-node"><b>03</b><span>QUESTION</span><small>边界检测</small></div><div className="pipeline-line" /><div className="pipeline-node"><b>04</b><span>ANSWER</span><small>流式输出</small></div></div></section>
        </div>
      </section>
    </main>
  );
}
