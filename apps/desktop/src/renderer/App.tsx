import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { JSX } from "react";
import { create } from "zustand";
import type { AudioDevices, AudioDrift, AudioSidecarEvent, ProbeResult, RealtimeServerMessage } from "@interview-copilot/protocol";
import type { QuestionCandidate, QuestionEvent, SessionState, TranscriptSnapshot } from "@interview-copilot/shared";
import type { Profile } from "@interview-copilot/shared";
import type { ProviderCenterPublicConfig } from "../main/settings-store";
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
        <div className="answer-surface">{answerText || "答案将在确认完整问题后显示"}{answerStreaming && <span className="answer-cursor">▌</span>}</div>
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
  const [page, setPage] = useState<"home" | "interview" | "preparation" | "profiles" | "knowledge" | "history" | "settings">("home");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderCenterPublicConfig>();
  const [llmModel, setLlmModel] = useState("gpt-4o-mini");
  const [llmBaseUrl, setLlmBaseUrl] = useState("https://api.openai.com");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [asrBaseUrl, setAsrBaseUrl] = useState("");
  const [asrProviderName, setAsrProviderName] = useState("Custom WebSocket ASR Gateway");
  const [asrModel, setAsrModel] = useState("");
  const [asrApiKey, setAsrApiKey] = useState("");
  const [knowledgeBases, setKnowledgeBases] = useState<Array<{ id: string; name: string }>>([]);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<Array<{ id: string; filename: string; status: string; error?: string }>>([]);
  const [historyRecords, setHistoryRecords] = useState<Array<{ id: string; profileId: string; startedAt: number; endedAt?: number; status: string; automationMode: string }>>([]);
  const [historyMetrics, setHistoryMetrics] = useState<{ id: string; answerRate: number; questionCount: number; answeredQuestionCount: number; averageAnswerLatencyMs?: number }>();
  const [preparationGoal, setPreparationGoal] = useState("根据当前 Resume 和 JD 生成面试准备清单");
  const [preparationEvents, setPreparationEvents] = useState<Array<Record<string, unknown>>>([]);
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
    void (async () => {
      try {
        let storedProfiles = await window.interviewCopilot.profiles.list();
        if (storedProfiles.length === 0) {
          const created = await window.interviewCopilot.profiles.save({ name: "默认面试档案", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
          storedProfiles = created ? [created] : [];
        }
        setProfiles(storedProfiles);
        const active = await window.interviewCopilot.profiles.active();
        setProfileId(active?.id ?? storedProfiles[0]?.id ?? "");
        const settings = await window.interviewCopilot.settings.get();
        setProviderSettings(settings);
        if (settings) {
          setLlmModel(settings.llm.model);
          setLlmBaseUrl(settings.llm.baseUrl);
          setAsrBaseUrl(settings.asr.baseUrl);
          setAsrProviderName(settings.asr.providerName);
          setAsrModel(settings.asr.model);
        }
        let bases = await window.interviewCopilot.knowledge.listBases();
        if (bases.length === 0) {
          const created = await window.interviewCopilot.knowledge.createBase("默认知识库");
          bases = created ? [created] : [];
        }
        setKnowledgeBases(bases);
        setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(bases[0]?.id));
        const selectedProfile = storedProfiles.find((profile) => profile.id === (active?.id ?? storedProfiles[0]?.id));
        if (selectedProfile && selectedProfile.knowledgeBaseIds.length === 0 && bases[0]) {
          const linked = await window.interviewCopilot.profiles.save({ ...selectedProfile, knowledgeBaseIds: [bases[0].id] });
          if (linked) {
            setProfiles((current) => current.map((profile) => profile.id === linked.id ? linked : profile));
            setProfileId(linked.id);
          }
        }
        setHistoryRecords(await window.interviewCopilot.history.list());
      } catch (error) {
        store.setNotice(`工作区初始化失败：${String(error)}`);
      }
    })();

    const cleanups = [
      window.interviewCopilot.events.onAudio(store.applyEvent),
      window.interviewCopilot.events.onSessionState((state) => { store.setSessionState(state); if (state === "ENDED") void window.interviewCopilot.history.list().then(setHistoryRecords); }),
      window.interviewCopilot.events.onOverlayMode(store.setOverlayMode),
      window.interviewCopilot.events.onScreenshot(store.setScreenshot),
      window.interviewCopilot.events.onScreenshotError(store.setNotice),
      window.interviewCopilot.events.onScreenshotDiagnostic(store.setNotice),
      window.interviewCopilot.events.onRealtimeState(store.setRealtimeState),
      window.interviewCopilot.events.onRealtimeTranscript(store.applyTranscript),
      window.interviewCopilot.events.onRealtimeMessage(store.applyRealtimeMessage),
      window.interviewCopilot.events.onRealtimeDiagnostic(store.setNotice),
      window.interviewCopilot.events.onQuestion(store.applyQuestion),
      window.interviewCopilot.events.onPreparationEvent((event) => { if (event && typeof event === "object") setPreparationEvents((current) => [...current.slice(-30), event as Record<string, unknown>]); }),
      window.interviewCopilot.events.onShortcut((shortcut) => {
        if (shortcut === "toggle-automation") {
          const next = useAudioStore.getState().automationMode === "MANUAL" ? "AUTO" : "MANUAL";
          useAudioStore.getState().setAutomationMode(next);
          useAudioStore.getState().setNotice(`Automation 已切换为 ${next}`);
        } else if (shortcut === "answer-latest") {
          void window.interviewCopilot.interview.answerLatest();
        } else if (shortcut === "screenshot-answer") {
          useAudioStore.getState().setNotice("Screenshot shortcut received");
        } else if (shortcut === "end-interview") {
          void window.interviewCopilot.interview.stop();
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
    store.setNotice("音频诊断已启动；它只显示电平，不会发送 PCM。正式面试请使用“开始面试”。");
  };
  const startInterview = async () => {
    const asrUrl = realtimeUrl.trim() || asrBaseUrl.trim();
    if (!asrUrl) {
      store.setNotice("请在高级诊断中配置 ASR WebSocket 地址，或先接入你的 ASR Gateway。");
      setPage("settings");
      return;
    }
    if (!profileId) {
      store.setNotice("请先创建或选择一个面试档案。");
      setPage("profiles");
      return;
    }
    persistDevice("interview-copilot.input-device", inputDeviceId);
    persistDevice("interview-copilot.output-device", outputDeviceId);
    await window.interviewCopilot.profiles.selectActive(profileId);
    await window.interviewCopilot.interview.start({ profileId, url: asrUrl, ticket: realtimeTicket.trim() || undefined, inputDeviceId, outputDeviceId, automationMode: store.automationMode, answerMode: "NORMAL" });
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
  const saveProviderSettings = async () => {
    try {
      const llm = await window.interviewCopilot.settings.update("llm", { providerName: "OpenAI-compatible", baseUrl: llmBaseUrl.trim(), model: llmModel.trim(), apiKey: llmApiKey || undefined, timeoutMs: 30_000, maxRetries: 2 });
      const asr = await window.interviewCopilot.settings.update("asr", { providerName: asrProviderName.trim(), baseUrl: asrBaseUrl.trim(), model: asrModel.trim(), apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      const current = await window.interviewCopilot.settings.get();
      setProviderSettings(current);
      setLlmApiKey("");
      setAsrApiKey("");
      store.setNotice(`Provider 配置已保存：LLM ${llm?.hasApiKey ? "已配置密钥" : "未配置密钥"} · ASR ${asr?.hasApiKey ? "已配置密钥" : "未配置密钥"}`);
    } catch (error) {
      store.setNotice(`Provider 配置保存失败：${String(error)}`);
    }
  };
  const uploadKnowledge = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const knowledgeBaseId = knowledgeBases[0]?.id;
    if (!file || !knowledgeBaseId) return;
    try {
      await window.interviewCopilot.knowledge.ingest({ knowledgeBaseId, filename: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
      setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId));
      store.setNotice(`已导入知识文档：${file.name}`);
    } catch (error) {
      store.setNotice(`知识文档导入失败：${String(error)}`);
    } finally {
      event.target.value = "";
    }
  };
  const attachProfileMaterial = async (kind: "resume" | "jobDescription", event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !profileId) return;
    try {
      const updated = await window.interviewCopilot.profiles.attachMaterial({ profileId, kind, filename: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
      if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
      store.setNotice(`${kind === "resume" ? "Resume" : "JD"} 已解析并保存`);
    } catch (error) {
      store.setNotice(`材料解析失败：${String(error)}`);
    } finally {
      event.target.value = "";
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">IC</div>
        <div className="brand-copy"><strong>Interview</strong><span>Copilot</span></div>
        <nav>
          <button className={`nav-item ${page === "home" ? "active" : ""}`} onClick={() => setPage("home")}><span>⌂</span>首页</button>
          <button className={`nav-item ${page === "interview" ? "active" : ""}`} onClick={() => setPage("interview")}><span>◉</span>面试</button>
          <button className={`nav-item ${page === "preparation" ? "active" : ""}`} onClick={() => setPage("preparation")}><span>↗</span>准备 Agent</button>
          <button className={`nav-item ${page === "profiles" ? "active" : ""}`} onClick={() => setPage("profiles")}><span>◈</span>Profiles</button>
          <button className={`nav-item ${page === "knowledge" ? "active" : ""}`} onClick={() => setPage("knowledge")}><span>▤</span>知识库</button>
          <button className={`nav-item ${page === "history" ? "active" : ""}`} onClick={() => setPage("history")}><span>◷</span>历史</button>
          <button className={`nav-item ${page === "settings" ? "active" : ""}`} onClick={() => setPage("settings")}><span>⚙</span>设置</button>
        </nav>
        <div className="sidebar-footer"><span className="online-dot" />本地工作区</div>
      </aside>

      <section className="content-shell">
        <header className="topbar"><div><div className="eyebrow">REALTIME WORKSPACE</div><h1>面试工作台</h1></div><StatusPill state={store.state} /></header>
        <div className="content-scroll">
          {page === "settings" && <section className="panel settings-panel"><div className="panel-heading"><div><div className="eyebrow">PROVIDER CENTER</div><h3>Provider 配置</h3></div><span className="muted">API Key 仅进入系统安全存储</span></div><div className="dashboard-grid"><div><label className="device-field"><span>LLM Provider / Base URL</span><input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} placeholder="https://api.openai.com" /></label><label className="device-field"><span>LLM Model</span><input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} placeholder="gpt-4o-mini" /></label><label className="device-field"><span>LLM API Key</span><input value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} type="password" placeholder={providerSettings?.llm.hasApiKey ? "已配置，留空表示不修改" : "粘贴 API Key"} /></label></div><div><label className="device-field"><span>ASR Provider</span><input value={asrProviderName} onChange={(event) => setAsrProviderName(event.target.value)} placeholder="Custom WebSocket ASR Gateway" /></label><label className="device-field"><span>ASR Model</span><input value={asrModel} onChange={(event) => setAsrModel(event.target.value)} placeholder="gateway-model" /></label><label className="device-field"><span>ASR API Key</span><input value={asrApiKey} onChange={(event) => setAsrApiKey(event.target.value)} type="password" placeholder={providerSettings?.asr.hasApiKey ? "已配置，留空表示不修改" : "可选短期密钥"} /></label><p className="muted">ASR Provider 接受 16kHz、双声道、PCM16 LE；服务端需返回标准 asr_partial / asr_final。</p><details className="advanced-settings"><summary>高级连接设置</summary><label className="device-field"><span>ASR Gateway WebSocket URL</span><input value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} placeholder="wss://host/api/v1/realtime/{interviewId}" /></label></details></div></div><button className="primary-button" onClick={() => void saveProviderSettings()}>保存 Provider 配置</button></section>}
          {page === "profiles" && <section className="panel profiles-panel"><div className="panel-heading"><div><div className="eyebrow">PROFILES</div><h3>面试档案</h3></div><span className="muted">SQLite 持久化</span></div><div className="profile-list">{profiles.map((profile) => <button className={`profile-row ${profile.id === profileId ? "selected" : ""}`} key={profile.id} onClick={() => { setProfileId(profile.id); void window.interviewCopilot.profiles.selectActive(profile.id); }}><span>{profile.name}</span><small>{profile.language} · {profile.skills.length} skills · {profile.knowledgeBaseIds.length} KB</small></button>)}</div><div className="hero-actions"><label className="secondary-button file-button">导入 Resume<input type="file" accept=".txt,.md,.pdf,.docx,.html" onChange={(event) => void attachProfileMaterial("resume", event)} /></label><label className="secondary-button file-button">导入 JD<input type="file" accept=".txt,.md,.pdf,.docx,.html" onChange={(event) => void attachProfileMaterial("jobDescription", event)} /></label><button className="secondary-button" onClick={async () => { const created = await window.interviewCopilot.profiles.save({ name: `面试档案 ${profiles.length + 1}`, language: "zh-CN", skills: [], knowledgeBaseIds: knowledgeBases[0] ? [knowledgeBases[0].id] : [] }); if (created) { setProfiles((current) => [created, ...current]); setProfileId(created.id); } }}>新建档案</button></div></section>}
          {page === "knowledge" && <section className="panel knowledge-panel"><div className="panel-heading"><div><div className="eyebrow">KNOWLEDGE</div><h3>知识库</h3></div><span className="muted">SQLite chunks · hybrid retrieval</span></div><div className="setup-list compact"><div><span className="setup-icon">▤</span><span>{knowledgeBases[0]?.name ?? "默认知识库"}</span><strong>{knowledgeDocuments.length} 文档</strong></div></div><label className="secondary-button file-button">导入 Resume / JD / PDF / DOCX / MD / PPTX / XLSX<input type="file" accept=".txt,.md,.pdf,.docx,.pptx,.xlsx,.html,.htm" onChange={(event) => void uploadKnowledge(event)} /></label><div className="knowledge-document-list">{knowledgeDocuments.map((document) => <div className="knowledge-document" key={document.id}><span>{document.filename}</span><small className={document.status === "error" ? "error-text" : ""}>{document.status}{document.error ? ` · ${document.error}` : ""}</small></div>)}</div></section>}
          {page === "history" && <section className="panel history-panel"><div className="panel-heading"><div><div className="eyebrow">HISTORY</div><h3>面试历史与分析</h3></div><span className="muted">本地 SQLite</span></div><div className="profile-list">{historyRecords.length === 0 && <span className="muted">完成一次面试后，这里会显示时长、问题数、回答率和延迟。</span>}{historyRecords.map((record) => <button className={`profile-row ${historyMetrics?.id === record.id ? "selected" : ""}`} key={record.id} onClick={async () => { const metrics = await window.interviewCopilot.history.analyze(record.id); if (metrics) setHistoryMetrics({ id: record.id, ...metrics }); }}><span>{new Date(record.startedAt).toLocaleString()} · {record.status}</span><small>{record.automationMode} · {record.profileId}</small></button>)}</div>{historyMetrics && <div className="setup-list compact"><div><span>问题数</span><strong>{historyMetrics.questionCount}</strong></div><div><span>已回答</span><strong>{historyMetrics.answeredQuestionCount} · {(historyMetrics.answerRate * 100).toFixed(0)}%</strong></div><div><span>平均答案延迟</span><strong>{historyMetrics.averageAnswerLatencyMs ? `${Math.round(historyMetrics.averageAnswerLatencyMs)}ms` : "—"}</strong></div></div>}</section>}
          {page === "preparation" && <section className="panel preparation-panel"><div className="panel-heading"><div><div className="eyebrow">PREPARATION AGENT</div><h3>准备 Agent</h3></div><span className="muted">最多 40 步 · 写入需审批</span></div><label className="device-field"><span>目标</span><textarea value={preparationGoal} onChange={(event) => setPreparationGoal(event.target.value)} rows={3} /></label><button className="primary-button" onClick={async () => { setPreparationEvents([]); try { await window.interviewCopilot.preparation.start(preparationGoal); } catch (error) { store.setNotice(`Preparation 启动失败：${String(error)}`); } }}>开始准备</button><div className="agent-events">{preparationEvents.map((event, index) => { const type = String(event.type ?? "event"); const requestId = typeof event.requestId === "string" ? event.requestId : undefined; return <div className="agent-event" key={`${type}-${requestId ?? index}`}><span>{type}</span><small>{typeof event.tool === "string" ? event.tool : typeof event.summary === "string" ? event.summary : ""}</small>{type === "approval_required" && requestId && <span className="agent-actions"><button className="secondary-button" onClick={() => void window.interviewCopilot.preparation.approve(requestId)}>批准</button><button className="ghost-button" onClick={() => void window.interviewCopilot.preparation.reject(requestId)}>拒绝</button></span>}</div>; })}</div></section>}
          {(page === "home" || page === "interview") && <>
          <section className="hero-card">
            <div><div className="eyebrow accent-text">INTERVIEW WORKSPACE</div><h2>准备好后，一键开始面试</h2><p>正式面试会启动双通道 PCM、ASR、问题确认、答案生成和历史记录；音频测试只用于诊断。</p></div>
            <div className="hero-actions"><button className="primary-button" onClick={() => void startInterview()}>开始面试</button><button className="secondary-button" onClick={() => void startAudio()}>测试音频</button><button className="secondary-button" onClick={openOverlay}>打开悬浮窗</button></div>
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
              <div className="panel-heading"><div><div className="eyebrow">INTERVIEW SETUP</div><h3>设备与自动化</h3></div><span className="step-count">Ready</span></div>
              <label className="device-field"><span>Microphone</span><select value={inputDeviceId} onChange={(event) => { setInputDeviceId(event.target.value); persistDevice("interview-copilot.input-device", event.target.value); }}><option value="">选择麦克风</option>{devices.inputs.map((device) => <option value={device.id} key={device.id}>{device.name}{device.default ? " · 默认" : ""}</option>)}</select></label>
              <label className="device-field"><span>System Audio</span><select value={outputDeviceId} onChange={(event) => { setOutputDeviceId(event.target.value); persistDevice("interview-copilot.output-device", event.target.value); }}><option value="">选择输出设备</option>{devices.outputs.map((device) => <option value={device.id} key={device.id}>{device.name}{device.default ? " · 默认" : ""}</option>)}</select></label>
              <div className="setup-list compact"><div><span className="setup-icon">A</span><span>Automation</span><strong>{store.automationMode}</strong></div><div><span className="setup-icon">◉</span><span>Sidecar</span><strong>{store.state}</strong></div></div>
              <button className="primary-button full-width" onClick={() => void startInterview()}>使用当前设置开始面试</button>
            </section>
          </div>

          <section className="panel realtime-panel"><div className="panel-heading"><div><div className="eyebrow">REALTIME ASR</div><h3>MIC / REMOTE Transcript</h3></div><StatusPill state={store.realtimeState.toUpperCase()} /></div><div className="transcript-grid"><TranscriptColumn label="REMOTE / 面试官" snapshot={store.remoteTranscript} /><TranscriptColumn label="MIC / 用户" snapshot={store.micTranscript} /></div><details className="advanced-settings"><summary>高级诊断：ASR Gateway 连接</summary><div className="realtime-connect"><input value={realtimeUrl} onChange={(event) => setRealtimeUrl(event.target.value)} placeholder="wss://host/api/v1/realtime/{interviewId}" aria-label="Realtime WebSocket URL" /><input value={realtimeTicket} onChange={(event) => setRealtimeTicket(event.target.value)} placeholder="短期 ticket（可选）" aria-label="Realtime ticket" type="password" /><button className="secondary-button" onClick={() => void connectRealtime()}>连接</button><button className="ghost-button" onClick={() => void disconnectRealtime()}>断开</button></div><p className="muted">正常面试由 InterviewCoordinator 管理；这里仅用于诊断网关、连接状态和原始协议。</p></details></section>

          {store.probeResult && <section className="panel probe-panel"><div className="panel-heading"><div><div className="eyebrow">PROBE RESULT</div><h3>2 秒采集统计</h3></div><span className="muted">{store.probeResult.durationMs}ms</span></div><div className="probe-grid"><div><strong>MIC</strong><span>{store.probeResult.mic.ok ? "OK" : "FAILED"} · {store.probeResult.mic.sampleRate}Hz · {store.probeResult.mic.channels}ch</span><small>callbacks {store.probeResult.mic.callbackCount} · samples {store.probeResult.mic.sampleCount} · peak {store.probeResult.mic.peak.toFixed(2)}</small></div><div><strong>SYSTEM</strong><span>{store.probeResult.system.ok ? "OK" : "FAILED"} · {store.probeResult.system.sampleRate}Hz · {store.probeResult.system.channels}ch</span><small>callbacks {store.probeResult.system.callbackCount} · samples {store.probeResult.system.sampleCount} · peak {store.probeResult.system.peak.toFixed(2)}</small></div></div></section>}

          {store.screenshot && <section className="panel screenshot-panel"><div className="panel-heading"><div><div className="eyebrow">SCREENSHOT TEST</div><h3>最近截图</h3></div><span className="muted">{store.screenshot.mimeType} · {store.screenshot.size} bytes</span></div><img className="screenshot-preview" src={store.screenshot.dataUrl} alt="最近一次桌面截图" /><div className="muted screenshot-path">已保存：{store.screenshot.path}</div></section>}

          <section className="panel flow-panel"><div className="panel-heading"><div><div className="eyebrow">CORE PIPELINE</div><h3>实时链路</h3></div><span className="muted">Coordinator-managed</span></div><div className="pipeline"><div className="pipeline-node active"><b>01</b><span>WASAPI</span><small>双通道 PCM</small></div><div className="pipeline-line" /><div className="pipeline-node active"><b>02</b><span>ASR</span><small>MIC / SYSTEM</small></div><div className="pipeline-line" /><div className="pipeline-node"><b>03</b><span>QUESTION</span><small>聚合确认</small></div><div className="pipeline-line" /><div className="pipeline-node"><b>04</b><span>ANSWER</span><small>SSE 流式</small></div></div></section>
          </>}
        </div>
      </section>
    </main>
  );
}
