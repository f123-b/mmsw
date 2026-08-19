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
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import { selectDeviceId } from "./device-selection";
import type { AppPage } from "./app/routes";
import { Sidebar } from "./layout/Sidebar";
import { WelcomeScreen } from "./chat/WelcomeScreen";
import { ChatComposer } from "./chat/ChatComposer";
import { OverlayRoot } from "./overlay/OverlayRoot";

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
  answerMode: "FAST" | "NORMAL" | "DEEP";
  probeResult?: ProbeResult;
  drift?: AudioDrift;
  bufferStats?: { queuedFrames: number; droppedFrames: number; bufferDurationMs: number };
  realtimeState: string;
  asrDiagnostics: AsrRuntimeDiagnostics;
  remoteTranscript: TranscriptSnapshot;
  micTranscript: TranscriptSnapshot;
  question?: QuestionCandidate;
  questionDiagnostics: Array<Extract<QuestionEvent, { type: "question_diagnostic" }>>;
  answerText: string;
  answerStreaming: boolean;
  answerId?: string;
  screenshot?: ScreenshotResult;
  notice?: string;
  applyEvent: (event: AudioSidecarEvent) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setSessionState: (state: SessionState) => void;
  setAutomationMode: (mode: "MANUAL" | "AUTO") => void;
  setAnswerMode: (mode: "FAST" | "NORMAL" | "DEEP") => void;
  setScreenshot: (screenshot: ScreenshotResult) => void;
  setNotice: (notice?: string) => void;
  setRealtimeState: (state: string) => void;
  setAsrDiagnostics: (diagnostics: AsrRuntimeDiagnostics) => void;
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
  answerMode: "NORMAL",
  realtimeState: "disconnected",
  asrDiagnostics: { provider: "unknown", model: "", language: "", micState: "stopped", remoteState: "stopped", reconnectCount: 0, droppedPcmPackets: 0 },
  remoteTranscript: { source: "remote", final: [] },
  micTranscript: { source: "mic", final: [] },
  questionDiagnostics: [],
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
  setAnswerMode: (answerMode) => set({ answerMode }),
  setScreenshot: (screenshot) => set({ screenshot }),
  setNotice: (notice) => set({ notice }),
  setRealtimeState: (realtimeState) => set({ realtimeState }),
  setAsrDiagnostics: (asrDiagnostics) => set({ asrDiagnostics }),
  applyTranscript: (snapshot) => set(snapshot.source === "remote" ? { remoteTranscript: snapshot } : { micTranscript: snapshot }),
  applyQuestion: (event) => set((current) => event.type === "question_diagnostic" ? { questionDiagnostics: [...current.questionDiagnostics.slice(-19), event] } : event.type === "question_confirmed" || event.type === "question_superseded" ? { question: event.question, notice: event.type === "question_superseded" ? "新问题已覆盖上一题" : current.notice } : current),
  applyRealtimeMessage: (message) => {
    if (message.type === "runtime_error") { set({ notice: `${message.code}: ${message.message}${message.recoverable ? " · 可重试" : ""}` }); return; }
    const snapshot = message.type === "answer_start"
      ? stableAnswer.start(message.answerId)
      : message.type === "answer_delta"
        ? stableAnswer.delta(message.answerId, message.delta)
        : message.type === "answer_end"
          ? stableAnswer.end(message.answerId, message.text)
          : message.type === "answer_cancelled"
            ? stableAnswer.cancel(message.answerId)
            : stableAnswer.snapshot;
    set({ answerText: snapshot.displayedText, answerStreaming: snapshot.streaming, answerId: snapshot.displayedAnswerId, ...(message.type === "answer_start" ? { answerMode: message.mode } : {}) });
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

function inlineMarkdown(text: string): JSX.Element[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function MarkdownAnswer({ text }: { text: string }): JSX.Element {
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
    else if (/^\s*[-*]\s+/.test(line)) blocks.push(<div className="markdown-bullet" key={index}>• {inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</div>);
    else if (line.trim()) blocks.push(<div key={index}>{inlineMarkdown(line)}</div>);
  });
  if (code && codeLines.length) blocks.push(<pre key="code-tail"><code>{codeLines.join("\n")}</code></pre>);
  return <div className="markdown-answer">{blocks}</div>;
}

function OverlayView(): JSX.Element {
  const { mic, system, state, overlayMode, question, answerText, answerStreaming, answerMode } = useAudioStore();
  const toggleMode = async () => {
    await window.interviewCopilot.overlay.setMode(overlayMode === "interactive" ? "passive" : "interactive");
  };
  return (
    <main className="overlay-shell">
      <div className="overlay-bar"><span>Interview Copilot · {answerMode}</span><StatusPill state={state} /></div>
      <section className="overlay-card">
        <div className="eyebrow">CURRENT QUESTION</div>
        <h1>{question?.text ?? "等待面试官问题"}</h1>
        <div className="answer-surface">{answerText ? <MarkdownAnswer text={answerText} /> : "答案将在确认完整问题后显示"}{answerStreaming && <span className="answer-cursor">▌</span>}</div>
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
  const [page, setPage] = useState<AppPage>("home");
  const [setupOpen, setSetupOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [conversationStarted, setConversationStarted] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderCenterPublicConfig>();
  const [llmModel, setLlmModel] = useState("gpt-4o-mini");
  const [llmBaseUrl, setLlmBaseUrl] = useState("https://api.openai.com");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [normalModel, setNormalModel] = useState("");
  const [deepModel, setDeepModel] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [answerMode, setAnswerMode] = useState<"FAST" | "NORMAL" | "DEEP">("NORMAL");
  const [asrProviderType, setAsrProviderType] = useState<"deepgram" | "custom-gateway">("deepgram");
  const [asrBaseUrl, setAsrBaseUrl] = useState("wss://api.deepgram.com/v1/listen");
  const [asrProviderName, setAsrProviderName] = useState("Deepgram");
  const [asrModel, setAsrModel] = useState("nova-3");
  const [asrLanguage, setAsrLanguage] = useState<"zh-CN" | "en-US" | "multi">("zh-CN");
  const [asrApiKey, setAsrApiKey] = useState("");
  const [knowledgeBases, setKnowledgeBases] = useState<Array<{ id: string; name: string }>>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<Array<{ id: string; filename: string; status: string; error?: string }>>([]);
  const [historyRecords, setHistoryRecords] = useState<Array<{ id: string; profileId: string; startedAt: number; endedAt?: number; status: string; automationMode: string }>>([]);
  const [historyMetrics, setHistoryMetrics] = useState<{ id: string; answerRate: number; questionCount: number; answeredQuestionCount: number; averageAnswerLatencyMs?: number }>();
  const [historySearch, setHistorySearch] = useState("");
  const [historyDetail, setHistoryDetail] = useState<{ interview: { id: string; startedAt: number; endedAt?: number; profileId: string; automationMode: string }; transcripts: Array<{ id: string; source: string; text: string }>; questions: Array<{ id: string; text: string; confidence: string; status: string }>; answers: Array<{ id: string; questionId: string; model: string; mode?: string; text: string; latencyFirstToken?: number; latencyTotal?: number; cancelReason?: string }> }>();
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
          setFastModel(settings.llm.fastModel ?? "");
          setNormalModel(settings.llm.normalModel ?? "");
          setDeepModel(settings.llm.deepModel ?? "");
          setVisionModel(settings.llm.visionModel ?? "");
          setLlmBaseUrl(settings.llm.baseUrl);
          setAsrBaseUrl(settings.asr.baseUrl);
          setAsrProviderName(settings.asr.providerName);
          setAsrModel(settings.asr.model);
          setAsrProviderType(settings.asr.providerType ?? (settings.asr.providerName.toLowerCase().includes("custom") ? "custom-gateway" : "deepgram"));
          setAsrLanguage(settings.asr.language ?? "zh-CN");
        }
        let bases = await window.interviewCopilot.knowledge.listBases();
        if (bases.length === 0) {
          const created = await window.interviewCopilot.knowledge.createBase("默认知识库");
          bases = created ? [created] : [];
        }
        setKnowledgeBases(bases);
        setKnowledgeBaseId(bases[0]?.id ?? "");
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
      window.interviewCopilot.events.onRealtimeDiagnostics((diagnostics) => store.setAsrDiagnostics(diagnostics)),
      window.interviewCopilot.events.onRuntimeError((error) => store.setNotice(`${error.code}: ${error.message}${error.recoverable ? " · 可重试" : ""}`)),
      window.interviewCopilot.events.onQuestion(store.applyQuestion),
      window.interviewCopilot.events.onAutomationMode(store.setAutomationMode),
      window.interviewCopilot.events.onAnswerMode((mode) => { store.setAnswerMode(mode); setAnswerMode(mode); }),
      window.interviewCopilot.events.onPreparationEvent((event) => { if (event && typeof event === "object") setPreparationEvents((current) => [...current.slice(-30), event as Record<string, unknown>]); }),
      window.interviewCopilot.events.onShortcut((shortcut) => {
        if (shortcut === "toggle-automation") {
          const next = useAudioStore.getState().automationMode === "MANUAL" ? "AUTO" : "MANUAL";
          void window.interviewCopilot.interview.setAutomationMode(next).then(() => useAudioStore.getState().setNotice(`Automation 已切换为 ${next}`));
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

  useEffect(() => {
    if (knowledgeBaseId) void window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId).then(setKnowledgeDocuments);
  }, [knowledgeBaseId]);

  const startAudio = async () => {
    persistDevice("interview-copilot.input-device", inputDeviceId);
    persistDevice("interview-copilot.output-device", outputDeviceId);
    await window.interviewCopilot.audio.start({ inputDeviceId, outputDeviceId, meterOnly: true });
    store.setNotice("音频诊断已启动；它只显示电平，不会发送 PCM。正式面试请使用“开始面试”。");
  };
  const startInterview = async () => {
    const asrUrl = realtimeUrl.trim() || asrBaseUrl.trim();
    if (asrProviderType === "custom-gateway" && !asrUrl) {
      store.setNotice("Custom Gateway 模式需要配置 Gateway WebSocket URL。");
      setPage("settings");
      return;
    }
    if (asrProviderType === "deepgram" && !providerSettings?.asr.hasApiKey) {
      store.setNotice("请先在设置中保存 Deepgram API Key。");
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
    await window.interviewCopilot.interview.start({ profileId, url: asrProviderType === "custom-gateway" ? asrUrl : undefined, gatewayToken: asrProviderType === "custom-gateway" ? realtimeTicket.trim() || undefined : undefined, language: selectedProfile?.language, inputDeviceId, outputDeviceId, automationMode: store.automationMode, answerMode, providerType: asrProviderType });
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
    await window.interviewCopilot.realtime.connect({ url: realtimeUrl.trim(), gatewayToken: realtimeTicket.trim() || undefined });
  };
  const disconnectRealtime = async () => { await window.interviewCopilot.realtime.disconnect(); };
  const saveProviderSettings = async () => {
    try {
      const llm = await window.interviewCopilot.settings.update("llm", { providerName: "OpenAI-compatible", baseUrl: llmBaseUrl.trim(), model: llmModel.trim(), fastModel: fastModel.trim() || undefined, normalModel: normalModel.trim() || undefined, deepModel: deepModel.trim() || undefined, visionModel: visionModel.trim() || undefined, apiKey: llmApiKey || undefined, timeoutMs: 30_000, maxRetries: 2 });
      const asr = await window.interviewCopilot.settings.update("asr", { providerName: asrProviderType === "deepgram" ? "Deepgram" : "Custom WebSocket ASR Gateway", providerType: asrProviderType, baseUrl: asrBaseUrl.trim(), model: asrModel.trim() || "nova-3", language: asrLanguage, apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
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
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const refreshProfiles = async () => { const next = await window.interviewCopilot.profiles.list(); setProfiles(next); };
  const renameProfile = async () => { if (!selectedProfile) return; const name = window.prompt("新的 Profile 名称", selectedProfile.name); if (name?.trim()) { await window.interviewCopilot.profiles.save({ ...selectedProfile, name: name.trim() }); await refreshProfiles(); } };
  const cloneProfile = async () => { if (!selectedProfile) return; const clone = await window.interviewCopilot.profiles.clone(selectedProfile.id, `${selectedProfile.name} 副本`); if (clone) { await refreshProfiles(); setProfileId(clone.id); } };
  const deleteProfile = async () => { if (!selectedProfile || profiles.length <= 1) { store.setNotice("至少保留一个 Profile"); return; } if (window.confirm(`删除 ${selectedProfile.name}？`)) { await window.interviewCopilot.profiles.delete(selectedProfile.id); const next = (await window.interviewCopilot.profiles.list()); setProfiles(next); setProfileId(next[0]?.id ?? ""); if (next[0]) await window.interviewCopilot.profiles.selectActive(next[0].id); } };
  const editInstructions = async () => { if (!selectedProfile) return; const instructions = window.prompt("Custom Instructions", selectedProfile.instructions ?? ""); if (instructions !== null) { const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, instructions }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); } };
  const addSkill = async () => { if (!selectedProfile) return; const name = window.prompt("Skill 名称"); if (!name?.trim()) return; const content = window.prompt("Skill 内容", ""); const skill = { id: `skill-${Date.now()}`, name: name.trim(), description: "", content: content ?? "", tags: [] }; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: [...selectedProfile.skills, skill] }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const deleteSkill = async (skillId: string) => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.filter((skill) => skill.id !== skillId) }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const toggleKnowledgeBase = async (baseId: string, linked: boolean) => { if (!selectedProfile) return; const ids = linked ? selectedProfile.knowledgeBaseIds.filter((id) => id !== baseId) : [...selectedProfile.knowledgeBaseIds, baseId]; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, knowledgeBaseIds: ids }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };

  const beginNewConversation = () => { setPage("home"); setConversationStarted(false); setComposerText(""); };
  const submitComposer = () => {
    if (!composerText.trim()) {
      void window.interviewCopilot.interview.answerLatest();
      store.setNotice("已发送最新面试官问题");
      return;
    }
    setConversationStarted(true);
    store.setNotice("问题已记录，可继续补充面试背景");
    setComposerText("");
  };
  const createProject = () => {
    const name = window.prompt("项目名称", "新面试项目");
    if (name?.trim()) { setProjects((current) => [...current, name.trim()]); store.setNotice(`项目“${name.trim()}”已创建`); }
  };
  const startPreparation = () => { setPage("preparation"); store.setNotice("已打开面试准备 Agent"); };
  const polishResume = () => { setPreparationGoal("润色当前 Resume 中的项目描述，保留真实技术细节和量化结果"); setPage("preparation"); };
  const selectLanguage = () => setPage("settings");
  const modernPageContent = (() => {
    if (page === "home") return conversationStarted ? <section className="conversation-view"><div className="page-heading"><div><span className="page-kicker">NEW CONVERSATION</span><h1>新对话</h1></div><span className="conversation-status">独立对话</span></div><div className="conversation-empty"><span className="conversation-avatar">IC</span><h2>开始整理你的面试准备</h2><p>把 Resume、JD 或具体问题告诉我，我会结合当前档案帮你梳理。</p></div></section> : <WelcomeScreen onPrepare={startPreparation} onPolish={polishResume} onLanguage={selectLanguage} onRefresh={beginNewConversation} />;
    if (page === "interview") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">INTERVIEW</span><h1>开始面试</h1></div><button className="dark-pill" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div><div className="interview-placeholder"><h2>准备好开始了吗？</h2><p>选择档案和音频设备后，Interview Copilot 会启动实时转录与回答辅助。</p><button className="outline-pill" onClick={() => setSetupOpen(true)}>打开面试设置</button></div></section>;
    if (page === "preparation") return <section className="simple-page preparation-page"><div className="page-heading"><div><span className="page-kicker">PREPARATION AGENT</span><h1>面试准备</h1></div><span className="page-note">最多 40 步 · 写入需审批</span></div><label className="clean-field"><span>准备目标</span><textarea value={preparationGoal} onChange={(event) => setPreparationGoal(event.target.value)} rows={4} /></label><button className="dark-pill" onClick={async () => { setPreparationEvents([]); try { await window.interviewCopilot.preparation.start(preparationGoal); } catch (error) { store.setNotice(`Preparation 启动失败：${String(error)}`); } }}>开始准备</button><div className="preparation-events">{preparationEvents.map((event, index) => <div className="event-row" key={`${String(event.type)}-${index}`}><strong>{String(event.type ?? "event")}</strong><span>{typeof event.summary === "string" ? event.summary : typeof event.tool === "string" ? event.tool : ""}</span></div>)}</div></section>;
    if (page === "profiles") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">PROFILES</span><h1>档案</h1></div><button className="dark-pill" onClick={async () => { const created = await window.interviewCopilot.profiles.save({ name: `面试档案 ${profiles.length + 1}`, language: "zh-CN", skills: [], knowledgeBaseIds: knowledgeBases[0] ? [knowledgeBases[0].id] : [] }); if (created) { setProfiles((current) => [created, ...current]); setProfileId(created.id); } }}>新建档案</button></div><div className="profile-layout"><div className="clean-list">{profiles.map((profile) => <button className={`clean-list-row ${profile.id === profileId ? "selected" : ""}`} key={profile.id} onClick={() => { setProfileId(profile.id); void window.interviewCopilot.profiles.selectActive(profile.id); }}><span>{profile.name}</span><small>{profile.language} · {profile.skills.length} skills</small></button>)}</div>{selectedProfile && <div className="detail-sheet"><h2>{selectedProfile.name}</h2><p className="page-note">{selectedProfile.language} · 当前档案</p><label className="clean-field"><span>Resume</span><label className="upload-row">{selectedProfile.resume?.summary ?? "未上传 Resume"}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void attachProfileMaterial("resume", event)} /></label></label><label className="clean-field"><span>职位描述</span><label className="upload-row">{selectedProfile.jobDescription?.summary ?? "未上传 JD"}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void attachProfileMaterial("jobDescription", event)} /></label></label><div className="detail-actions"><button className="outline-pill" onClick={() => void editInstructions()}>编辑 Instructions</button><button className="outline-pill" onClick={() => void renameProfile()}>重命名</button></div></div>}</div></section>;
    if (page === "knowledge") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">KNOWLEDGE</span><h1>知识库</h1></div><button className="dark-pill" onClick={async () => { const name = window.prompt("知识库名称", "新知识库"); if (name?.trim()) { const created = await window.interviewCopilot.knowledge.createBase(name.trim()); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); } } }}>新建知识库</button></div><div className="clean-list knowledge-list">{knowledgeBases.map((base) => <button className={`clean-list-row ${base.id === knowledgeBaseId ? "selected" : ""}`} key={base.id} onClick={() => setKnowledgeBaseId(base.id)}><span>{base.name}</span><small>{base.id === knowledgeBaseId ? `${knowledgeDocuments.length} 个文档` : "查看文档"}</small></button>)}</div><label className="upload-document">＋ 导入 PDF / DOCX / TXT / MD<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void uploadKnowledge(event)} /></label><div className="clean-list document-list">{knowledgeDocuments.map((document) => <div className="clean-list-row" key={document.id}><span>{document.filename}</span><small>{document.status}</small></div>)}</div></section>;
    if (page === "history") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">HISTORY</span><h1>面试记录</h1></div><input className="inline-search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="搜索记录" /></div><div className="history-layout"><div className="clean-list">{historyRecords.filter((record) => `${record.profileId} ${record.status}`.toLowerCase().includes(historySearch.toLowerCase())).map((record) => <button className="clean-list-row" key={record.id} onClick={async () => { const [metrics, detail] = await Promise.all([window.interviewCopilot.history.analyze(record.id), window.interviewCopilot.history.get(record.id)]); if (metrics) setHistoryMetrics({ id: record.id, ...metrics }); if (detail) setHistoryDetail(detail as typeof historyDetail); }}><span>{new Date(record.startedAt).toLocaleString()}</span><small>{record.status} · {record.profileId}</small></button>)}{historyRecords.length === 0 && <p className="page-note">完成一次面试后，记录会显示在这里。</p>}</div>{historyDetail && <div className="detail-sheet"><h2>面试详情</h2><p className="page-note">{historyDetail.interview.profileId} · {historyDetail.interview.automationMode}</p><div className="detail-metrics"><span>问题数 <strong>{historyMetrics?.questionCount ?? historyDetail.questions.length}</strong></span><span>已回答 <strong>{historyMetrics?.answeredQuestionCount ?? historyDetail.answers.length}</strong></span><span>回答率 <strong>{historyMetrics ? `${Math.round(historyMetrics.answerRate * 100)}%` : "—"}</strong></span></div><div className="transcript-detail">{historyDetail.transcripts.map((item) => <p key={item.id}><b>{item.source === "remote" ? "REMOTE" : "MIC"}</b>{item.text}</p>)}</div></div>}</div></section>;
    return <section className="simple-page settings-page"><div className="page-heading"><div><span className="page-kicker">SETTINGS</span><h1>设置</h1></div><button className="dark-pill" onClick={() => void saveProviderSettings()}>保存设置</button></div><div className="settings-columns"><div><h2>语言与回答</h2><label className="clean-field"><span>回答模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><label className="clean-field"><span>LLM Model</span><input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} /></label><label className="clean-field"><span>LLM Base URL</span><input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} /></label></div><div><h2>ASR</h2><label className="clean-field"><span>Provider</span><select value={asrProviderType} onChange={(event) => setAsrProviderType(event.target.value as typeof asrProviderType)}><option value="deepgram">Deepgram Direct</option><option value="custom-gateway">Custom Gateway</option></select></label><label className="clean-field"><span>语言</span><select value={asrLanguage} onChange={(event) => setAsrLanguage(event.target.value as typeof asrLanguage)}><option value="zh-CN">简体中文</option><option value="en-US">English</option><option value="multi">多语言</option></select></label><details className="advanced-settings"><summary>高级诊断</summary><p>Realtime、音频设备和问题判断诊断已迁移到这里。</p></details></div></div></section>;
  })();

  if (isOverlay) return <OverlayRoot mic={store.mic} system={store.system} state={store.state} overlayMode={store.overlayMode} answerMode={store.answerMode} question={store.question} answerText={store.answerText} answerStreaming={store.answerStreaming} remoteTranscript={store.remoteTranscript} micTranscript={store.micTranscript} onToggleMode={() => void window.interviewCopilot.overlay.setMode(store.overlayMode === "interactive" ? "passive" : "interactive")} />;

  return (
    <main className="app-shell modern-shell">
      <Sidebar page={page} profileName={selectedProfile?.name} onNavigate={setPage} onNewConversation={beginNewConversation} />
      <section className="content-shell">
        <div className="modern-topbar"><button className="dark-pill start-interview" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div>
        <div className="modern-main">{modernPageContent}</div>
        {(page === "home" || page === "interview") && <ChatComposer value={composerText} onChange={setComposerText} onSubmit={submitComposer} onCreateProject={createProject} />}
        {projects.length > 0 && <div className="project-toast">项目：{projects.join("、")}</div>}
        {store.notice && <button className="notice-toast" onClick={() => store.setNotice(undefined)}>{store.notice} <span>×</span></button>}
      </section>
      {setupOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetupOpen(false); }}><section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title"><header><div><span className="page-kicker">INTERVIEW SETUP</span><h2 id="setup-title">开始面试</h2></div><button onClick={() => setSetupOpen(false)} aria-label="关闭">×</button></header><label className="clean-field"><span>面试档案</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><label className="clean-field"><span>回答模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><div className="probe-summary"><span>MIC <b>✓</b></span><span>SYSTEM <b>✓</b></span></div><footer><button className="outline-pill" onClick={() => setSetupOpen(false)}>取消</button><button className="dark-pill" onClick={async () => { setSetupOpen(false); await startInterview(); }}>开始面试</button></footer></section></div>}
    </main>
  );

}
