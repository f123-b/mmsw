import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { JSX } from "react";
import { create } from "zustand";
import type { AudioDevices, AudioDrift, AudioSidecarEvent, ProbeResult, RealtimeServerMessage } from "@interview-copilot/protocol";
import type { QuestionCandidate, QuestionEvent, SessionState, TranscriptSnapshot } from "@interview-copilot/shared";
import type { Profile } from "@interview-copilot/shared";
import type { ProviderCenterPublicConfig, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import { normalizeMeter, StableAnswerStateMachine } from "@interview-copilot/shared";
import type { CaptureProtectionState, OverlayMode } from "../main/overlay-manager";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import { selectDeviceId } from "./device-selection";
import type { AppPage } from "./app/routes";
import { Sidebar } from "./layout/Sidebar";
import { WelcomeScreen } from "./chat/WelcomeScreen";
import { ChatComposer } from "./chat/ChatComposer";
import { OverlayRoot } from "./overlay/OverlayRoot";
import { AppDialog, type DialogState } from "./dialogs/AppDialog";

interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: string;
  model?: string;
  createdAt: number;
}

interface ProjectItem { id: string; name: string; profileId?: string; createdAt: number; updatedAt: number; }
interface ConversationItem { id: string; projectId?: string; profileId?: string; title: string; createdAt: number; updatedAt: number; }

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
  probeError?: string;
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
  clearProbe: () => void;
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
  automationMode: "AUTO",
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
    if (event.type === "probe_result") return { probeResult: event, probeError: undefined, state: event.mic.ok && event.system.ok ? "READY" : "FAILED" };
    if (event.type === "audio_buffer") return { bufferStats: event };
    if (event.type === "audio_drift") return { drift: event };
    return { state: event.recoverable ? "DEGRADED" : "FAILED", notice: event.reason, probeError: event.reason };
  }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setSessionState: (sessionState) => set({ sessionState }),
  setAutomationMode: (automationMode) => set({ automationMode }),
  setAnswerMode: (answerMode) => set({ answerMode }),
  clearProbe: () => set({ probeResult: undefined, probeError: undefined, state: "STOPPED" }),
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

function verificationLabel(value: boolean | null): string {
  return value === true ? "PASS" : value === false ? "FAIL" : "未测试";
}

function tencentLabel(value: TencentValidationStatus): string {
  return value === "verified" ? "已验证" : value === "failed" ? "失败" : "未验证";
}

function CaptureProtectionSettings({ status, validation = { desktopShare: "unverified", windowShare: "unverified" }, onToggle, onValidate = () => undefined }: { status: CaptureProtectionState; validation?: TencentValidationState; onToggle: (enabled: boolean) => void; onValidate?: (mode: "desktopShare" | "windowShare", status: TencentValidationStatus) => void }): JSX.Element {
  const [validationState, setValidationState] = useState<TencentValidationState>(validation);
  useEffect(() => { void window.interviewCopilot.overlay.getTencentValidation().then(setValidationState).catch(() => undefined); }, []);
  const recordValidation = (mode: "desktopShare" | "windowShare", nextStatus: TencentValidationStatus) => { setValidationState((current) => ({ ...current, [mode]: nextStatus })); onValidate(mode, nextStatus); };
  const windowsLabel = !status.supported ? "当前平台不支持 Windows Capture Protection" : status.lastError ? "Windows protection flag 失败" : status.requested && status.osFlagApplied ? "Windows protection enabled" : "Windows protection disabled";
  return <section className="capture-protection-settings"><div className="settings-subheading"><div><h2>共享保护 <small>Capture Protection</small></h2><p>在受支持的 Windows 屏幕捕获方式中隐藏面试悬浮窗。</p></div><label className="switch-control"><input type="checkbox" checked={status.requested} disabled={!status.supported} onChange={(event) => onToggle(event.target.checked)} /><span /></label></div><div className="capture-protection-meta"><strong className={!status.supported ? "unsupported" : status.lastError ? "failed" : status.requested && status.osFlagApplied ? "enabled" : "disabled"}>{windowsLabel}</strong><span>{status.platform}</span></div><div className="capture-protection-layers"><div><span>Windows protection</span><strong>{windowsLabel}</strong></div><div><span>Automatic capture validation · Window</span><strong>{verificationLabel(status.windowCaptureVerified)}</strong></div><div><span>Automatic capture validation · Display</span><strong>{verificationLabel(status.displayCaptureVerified)}</strong></div><div><span>Tencent Meeting · Desktop Share</span><strong>{tencentLabel(validationState.desktopShare)}</strong></div><div><span>Tencent Meeting · Window Share</span><strong>{tencentLabel(validationState.windowShare)}</strong></div></div><button className="outline-pill tencent-validation-button" onClick={() => recordValidation("desktopShare", "unverified")}>开始腾讯会议共享验证</button><div className="tencent-validation-panel"><h3>腾讯会议共享保护验证</h3><p>请在腾讯会议中分别验证“共享整个桌面”和“共享窗口”；预览不能替代另一台设备上的远端观察。</p><div className="test-marker-label">TEST MARKER · 仅在验证模式 / INTERVIEW_COPILOT_CAPTURE_TEST=1 显示</div><div className="tencent-validation-row"><span>腾讯会议共享整个桌面：{tencentLabel(validationState.desktopShare)}</span><button className="text-button" onClick={() => recordValidation("desktopShare", "verified")}>远端看不到</button><button className="text-button danger-text" onClick={() => recordValidation("desktopShare", "failed")}>远端可以看到</button></div><div className="tencent-validation-row"><span>腾讯会议共享窗口：{tencentLabel(validationState.windowShare)}</span><button className="text-button" onClick={() => recordValidation("windowShare", "verified")}>远端看不到</button><button className="text-button danger-text" onClick={() => recordValidation("windowShare", "failed")}>远端可以看到</button></div></div><p className="capture-protection-warning">不同会议软件、录屏方式和 Windows 版本行为可能不同，无法保证所有捕获方式都排除。</p>{status.lastError && <p className="capture-protection-error">共享保护启用失败：Windows 标志未确认，悬浮窗仍可正常使用。</p>}</section>;
}

export function App(): JSX.Element {
  const isOverlay = useMemo(() => new URLSearchParams(window.location.search).get("window") === "overlay", []);
  const captureTest = useMemo(() => new URLSearchParams(window.location.search).get("capture-test") === "1", []);
  const store = useAudioStore();
  const [page, setPage] = useState<AppPage>("home");
  const [setupOpen, setSetupOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSending, setChatSending] = useState(false);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderCenterPublicConfig>();
  const [llmProviderName, setLlmProviderName] = useState("OpenAI-compatible");
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
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("https://api.openai.com");
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [providerTests, setProviderTests] = useState<Record<string, string>>({});
  const [captureProtection, setCaptureProtection] = useState<CaptureProtectionState>({ platform: "win32", supported: false, requested: true, osFlagApplied: false, enabled: true, applied: false, externalCaptureVerified: null, displayCaptureVerified: null, windowCaptureVerified: null });
  const [tencentValidation, setTencentValidation] = useState<TencentValidationState>({ desktopShare: "unverified", windowShare: "unverified" });
  const [knowledgeBases, setKnowledgeBases] = useState<Array<{ id: string; name: string }>>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<Array<{ id: string; filename: string; status: string; error?: string }>>([]);
  const [historyRecords, setHistoryRecords] = useState<Array<{ id: string; profileId: string; startedAt: number; endedAt?: number; status: string; automationMode: string }>>([]);
  const [historyMetrics, setHistoryMetrics] = useState<{ id: string; answerRate: number; questionCount: number; answeredQuestionCount: number; averageAnswerLatencyMs?: number }>();
  const [historySearch, setHistorySearch] = useState("");
  const [historyDetail, setHistoryDetail] = useState<{ interview: { id: string; startedAt: number; endedAt?: number; profileId: string; automationMode: string }; transcripts: Array<{ id: string; source: string; text: string }>; questions: Array<{ id: string; text: string; confidence: string; status: string }>; answers: Array<{ id: string; questionId: string; model: string; mode?: string; text: string; latencyFirstToken?: number; latencyTotal?: number; cancelReason?: string }> }>();
  const [preparationGoal, setPreparationGoal] = useState("根据当前 Resume 和 JD 生成面试准备清单");
  const [preparationEvents, setPreparationEvents] = useState<Array<Record<string, unknown>>>([]);
  const [preparationRunning, setPreparationRunning] = useState(false);
  const [devices, setDevices] = useState<AudioDevices>(DEFAULT_DEVICES);
  const [inputDeviceId, setInputDeviceId] = useState("");
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [probeDeviceKey, setProbeDeviceKey] = useState("");
  const [realtimeUrl, setRealtimeUrl] = useState(() => storedDevice("interview-copilot.realtime-url") ?? "");
  const [realtimeTicket, setRealtimeTicket] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const dialogResolver = useRef<((value: string | boolean | undefined) => void) | undefined>(undefined);

  const requestDialog = (next: DialogState): Promise<string | boolean | undefined> => new Promise((resolve) => {
    dialogResolver.current = resolve;
    setDialog(next);
  });
  const closeDialog = (value: string | boolean | undefined) => {
    dialogResolver.current?.(value);
    dialogResolver.current = undefined;
    setDialog(null);
  };

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
          setLlmProviderName(settings.llm.providerName);
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
          setEmbeddingBaseUrl(settings.embedding.baseUrl);
          setEmbeddingModel(settings.embedding.model);
        }
        const [captureCapabilities, captureState, validation, interviewState] = await Promise.all([window.interviewCopilot.overlay.getCapabilities(), window.interviewCopilot.overlay.getCaptureProtection(), window.interviewCopilot.overlay.getTencentValidation(), window.interviewCopilot.interview.getState()]);
        setCaptureProtection({ ...captureState, platform: captureCapabilities.platform, supported: captureCapabilities.captureProtectionSupported });
        setTencentValidation(validation);
        store.setAutomationMode(interviewState.automationMode);
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
        const storedProjects = await window.interviewCopilot.projects.list();
        setProjects(storedProjects);
        const storedConversations = await window.interviewCopilot.chat.listConversations(active?.id ?? storedProfiles[0]?.id);
        setConversations(storedConversations);
      } catch (error) {
        store.setNotice(`工作区初始化失败：${String(error)}`);
      }
    })();

    const cleanups = [
      window.interviewCopilot.events.onAudio(store.applyEvent),
      window.interviewCopilot.events.onSessionState((state) => { store.setSessionState(state); if (state === "ENDED") void window.interviewCopilot.history.list().then(setHistoryRecords); }),
      window.interviewCopilot.events.onOverlayMode(store.setOverlayMode),
      window.interviewCopilot.events.onOverlayCaptureProtection(setCaptureProtection),
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
      window.interviewCopilot.events.onPreparationEvent((event) => { if (event && typeof event === "object") { const next = event as Record<string, unknown>; setPreparationEvents((current) => [...current.slice(-30), next]); if (["completed", "error", "stopped"].includes(String(next.type))) setPreparationRunning(false); } }),
      window.interviewCopilot.events.onChatMessageStart((event) => {
        if (!event || typeof event !== "object") return;
        const payload = event as { conversationId?: string; userMessage?: ChatMessage; assistantMessage?: ChatMessage };
        if (!payload.conversationId || !payload.userMessage || !payload.assistantMessage) return;
        setActiveConversationId(payload.conversationId);
        setChatSending(true);
        setChatMessages((current) => [...current.filter((message) => message.id !== payload.userMessage?.id && message.id !== payload.assistantMessage?.id), payload.userMessage as ChatMessage, payload.assistantMessage as ChatMessage]);
      }),
      window.interviewCopilot.events.onChatMessageDelta((event) => {
        if (!event || typeof event !== "object") return;
        const payload = event as { conversationId?: string; messageId?: string; text?: string };
        if (!payload.messageId) return;
        setChatMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, content: payload.text ?? message.content, status: "streaming" } : message));
      }),
      window.interviewCopilot.events.onChatMessageEnd((event) => {
        if (!event || typeof event !== "object") return;
        const payload = event as { conversationId?: string; message?: ChatMessage };
        if (!payload.message) return;
        setChatSending(false);
        setChatMessages((current) => current.map((message) => message.id === payload.message?.id ? payload.message as ChatMessage : message));
        void window.interviewCopilot.chat.listConversations().then(setConversations);
      }),
      window.interviewCopilot.events.onChatError((event) => {
        const payload = event && typeof event === "object" ? event as { message?: string; code?: string } : {};
        setChatSending(false);
        store.setNotice(`${payload.code ?? "CHAT_ERROR"}：${payload.message ?? "聊天请求失败"}`);
      }),
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
    try {
      const asrUrl = realtimeUrl.trim() || asrBaseUrl.trim();
      if (!profileId) throw new Error("PROFILE_NOT_FOUND: 请先创建或选择一个面试档案。");
      const preflight = await window.interviewCopilot.settings.preflight(true);
      if (!preflight.llm.configured) throw new Error("LLM_NOT_CONFIGURED: 未配置 LLM API Key");
      if (!preflight.llm.reachable) throw new Error(`LLM_CONNECT_FAILED: ${preflight.llm.message ?? preflight.llm.status}`);
      if (asrProviderType === "custom-gateway" && !asrUrl) throw new Error("ASR_CONNECT_FAILED: Custom Gateway 需要配置 WebSocket URL");
      if (asrProviderType === "deepgram" && !preflight.asr.configured) throw new Error("ASR_AUTH_FAILED: 未配置 Deepgram API Key");
      if (!preflight.asr.reachable) throw new Error(`ASR_CONNECT_FAILED: ${preflight.asr.message ?? preflight.asr.status}`);
      if (!inputDeviceId || !outputDeviceId) throw new Error("AUDIO_DEVICE_FAILED: 未选择可用的音频设备");
      persistDevice("interview-copilot.input-device", inputDeviceId);
      persistDevice("interview-copilot.output-device", outputDeviceId);
      const probe = await window.interviewCopilot.audio.probe({ inputDeviceId, outputDeviceId });
      store.applyEvent(probe);
      setProbeDeviceKey(`${inputDeviceId}::${outputDeviceId}`);
      if (!probe.mic.ok) throw new Error("AUDIO_PROBE_MIC_FAILED: 未检测到有效输入");
      if (!probe.system.ok) throw new Error("AUDIO_PROBE_SYSTEM_FAILED: 未检测到系统音频");
      await window.interviewCopilot.profiles.selectActive(profileId);
      await window.interviewCopilot.interview.start({ profileId, url: asrProviderType === "custom-gateway" ? asrUrl : undefined, gatewayToken: asrProviderType === "custom-gateway" ? realtimeTicket.trim() || undefined : undefined, language: selectedProfile?.language, inputDeviceId, outputDeviceId, automationMode: store.automationMode, answerMode, providerType: asrProviderType });
      setSetupOpen(false);
    } catch (error) {
      const message = String(error);
      store.setNotice(message.includes("LLM_NOT_CONFIGURED") ? "未配置 LLM API Key · 请前往设置" : message.includes("ASR_AUTH_FAILED") ? "未配置 Deepgram API Key · 请前往设置" : `面试启动失败：${message}`);
    }
  };
  const stopAudio = async () => { await window.interviewCopilot.audio.stop(); };
  const probeAudio = async () => {
    try {
      const result = await window.interviewCopilot.audio.probe({ inputDeviceId, outputDeviceId });
      store.applyEvent(result);
      setProbeDeviceKey(`${inputDeviceId}::${outputDeviceId}`);
    }
    catch (error) { store.setNotice(`Audio Probe 失败：${String(error)}`); }
  };
  const openOverlay = async () => { await window.interviewCopilot.overlay.show(); };
  const toggleCaptureProtection = async (enabled: boolean) => {
    try {
      const next = await window.interviewCopilot.overlay.setCaptureProtection(enabled);
      if (next) setCaptureProtection(next);
    } catch (error) {
      setCaptureProtection((current) => ({ ...current, lastError: String(error), osFlagApplied: false }));
    }
  };
  const validateTencent = async (mode: "desktopShare" | "windowShare", status: TencentValidationStatus) => {
    try { setTencentValidation(await window.interviewCopilot.overlay.setTencentValidation(mode, status)); }
    catch (error) { store.setNotice(`腾讯会议验证记录失败：${String(error)}`); }
  };
  const captureScreenshot = async () => {
    try { store.setScreenshot(await window.interviewCopilot.screenshot.capture()); }
    catch (error) { store.setNotice(`截图失败：${String(error)}`); }
  };
  const toggleAutomation = async () => {
    const next = store.automationMode === "AUTO" ? "MANUAL" : "AUTO";
    await window.interviewCopilot.interview.setAutomationMode(next);
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
  const currentProbeReady = Boolean(store.probeResult?.mic.ok && store.probeResult.system.ok && probeDeviceKey === `${inputDeviceId}::${outputDeviceId}`);
  const saveProviderSettings = async () => {
    try {
      const llm = await window.interviewCopilot.settings.update("llm", { providerName: llmProviderName.trim() || "OpenAI-compatible", baseUrl: llmBaseUrl.trim(), model: llmModel.trim(), fastModel: fastModel.trim() || undefined, normalModel: normalModel.trim() || undefined, deepModel: deepModel.trim() || undefined, visionModel: visionModel.trim() || undefined, apiKey: llmApiKey || undefined, timeoutMs: 30_000, maxRetries: 2 });
      const asr = await window.interviewCopilot.settings.update("asr", { providerName: asrProviderType === "deepgram" ? "Deepgram" : "Custom WebSocket ASR Gateway", providerType: asrProviderType, baseUrl: asrBaseUrl.trim(), model: asrModel.trim() || "nova-3", language: asrLanguage, apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      await window.interviewCopilot.settings.update("embedding", { providerName: "OpenAI-compatible", baseUrl: embeddingBaseUrl.trim(), model: embeddingModel.trim() || "text-embedding-3-small", apiKey: embeddingApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      const current = await window.interviewCopilot.settings.get();
      setProviderSettings(current);
      setLlmApiKey("");
      setAsrApiKey("");
      setEmbeddingApiKey("");
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
  const renameProfile = async () => { if (!selectedProfile) return; const name = await requestDialog({ kind: "form", title: "重命名 Profile", label: "Profile 名称", defaultValue: selectedProfile.name, required: true, confirmLabel: "保存" }); if (typeof name === "string" && name.trim()) { await window.interviewCopilot.profiles.save({ ...selectedProfile, name: name.trim() }); await refreshProfiles(); } };
  const cloneProfile = async () => { if (!selectedProfile) return; const clone = await window.interviewCopilot.profiles.clone(selectedProfile.id, `${selectedProfile.name} 副本`); if (clone) { await refreshProfiles(); setProfileId(clone.id); } };
  const deleteProfile = async () => { if (!selectedProfile || profiles.length <= 1) { store.setNotice("至少保留一个 Profile"); return; } const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${selectedProfile.name}？`, description: "删除后该 Profile 的本地配置无法恢复。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.profiles.delete(selectedProfile.id); const next = (await window.interviewCopilot.profiles.list()); setProfiles(next); setProfileId(next[0]?.id ?? ""); if (next[0]) await window.interviewCopilot.profiles.selectActive(next[0].id); } };
  const editInstructions = async () => { if (!selectedProfile) return; const instructions = await requestDialog({ kind: "form", title: "编辑 Instructions", label: "Custom Instructions", defaultValue: selectedProfile.instructions ?? "", multiline: true, confirmLabel: "保存" }); if (typeof instructions === "string") { const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, instructions }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); } };
  const addSkill = async () => { if (!selectedProfile) return; const name = await requestDialog({ kind: "form", title: "新增 Skill", label: "Skill 名称", required: true }); if (typeof name !== "string" || !name.trim()) return; const content = await requestDialog({ kind: "form", title: "Skill 内容", label: "内容", multiline: true, confirmLabel: "保存" }); const skill = { id: `skill-${Date.now()}`, name: name.trim(), description: "", content: typeof content === "string" ? content : "", tags: [] }; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: [...selectedProfile.skills, skill] }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const editSkill = async (skillId: string) => { if (!selectedProfile) return; const skill = selectedProfile.skills.find((item) => item.id === skillId); if (!skill) return; const content = await requestDialog({ kind: "form", title: `编辑 Skill：${skill.name}`, label: "内容", defaultValue: skill.content, multiline: true, confirmLabel: "保存" }); if (typeof content !== "string") return; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.map((item) => item.id === skillId ? { ...item, content } : item) }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const removeProfileMaterial = async (kind: "resume" | "jobDescription") => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.removeMaterial(selectedProfile.id, kind); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const deleteSkill = async (skillId: string) => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.filter((skill) => skill.id !== skillId) }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const toggleKnowledgeBase = async (baseId: string, linked: boolean) => { if (!selectedProfile) return; const ids = linked ? selectedProfile.knowledgeBaseIds.filter((id) => id !== baseId) : [...selectedProfile.knowledgeBaseIds, baseId]; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, knowledgeBaseIds: ids }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };

  const openConversation = async (conversationId: string) => {
    const conversation = await window.interviewCopilot.chat.getConversation(conversationId);
    if (!conversation) return;
    setActiveConversationId(conversationId);
    setChatMessages(conversation.messages as ChatMessage[]);
    setPage("home");
  };
  const openProject = async (projectId: string) => { setSelectedProjectId(projectId); setPage("home"); setActiveConversationId(undefined); setChatMessages([]); setComposerText(""); setConversations((await window.interviewCopilot.chat.listConversations()).filter((conversation) => conversation.projectId === projectId)); };
  const beginNewConversation = () => { setPage("home"); setSelectedProjectId(undefined); setActiveConversationId(undefined); setChatMessages([]); setComposerText(""); };
  const submitComposer = async () => {
    const content = composerText.trim();
    if (!content || chatSending) return;
    setComposerText("");
    try {
      let conversationId = activeConversationId;
      if (!conversationId) {
        const conversation = await window.interviewCopilot.chat.createConversation({ profileId, projectId: selectedProjectId, title: content.slice(0, 36) });
        conversationId = conversation.id;
        setActiveConversationId(conversation.id);
        setConversations((current) => [conversation as ConversationItem, ...current]);
      }
      setChatSending(true);
      await window.interviewCopilot.chat.sendMessage(conversationId, content);
    } catch (error) {
      setChatSending(false);
      store.setNotice(`聊天发送失败：${String(error)}`);
    }
  };
  const createProject = async () => {
    const value = await requestDialog({ kind: "form", title: "创建项目", description: "项目会保存到本地数据库，并可关联当前 Profile。", label: "项目名称", defaultValue: "新面试项目", required: true, confirmLabel: "创建" });
    if (typeof value !== "string" || !value.trim()) return;
    try {
      const project = await window.interviewCopilot.projects.create({ name: value.trim(), profileId });
      if (project) { setProjects((current) => [project, ...current]); setSelectedProjectId(project.id); store.setNotice(`项目“${project.name}”已创建`); }
    } catch (error) { store.setNotice(`项目创建失败：${String(error)}`); }
  };
  const renameProject = async (projectId: string, currentName: string) => { const name = await requestDialog({ kind: "form", title: "重命名项目", label: "项目名称", defaultValue: currentName, required: true, confirmLabel: "保存" }); if (typeof name !== "string") return; const updated = await window.interviewCopilot.projects.rename(projectId, name); if (updated) setProjects((current) => current.map((project) => project.id === updated.id ? updated : project)); };
  const deleteProject = async (projectId: string, currentName: string) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${currentName}？`, description: "项目会被删除，对话内容仍保留。", confirmLabel: "删除" }); if (confirmed !== true) return; await window.interviewCopilot.projects.delete(projectId); setProjects((current) => current.filter((project) => project.id !== projectId)); if (selectedProjectId === projectId) beginNewConversation(); };
  const startPreparation = () => { setPage("preparation"); store.setNotice("已打开面试准备 Agent"); };
  const polishResume = () => { setPreparationGoal("润色当前 Resume 中的项目描述，保留真实技术细节和量化结果"); setPage("preparation"); };
  const selectLanguage = () => setPage("settings");
  const testProvider = async (section: "llm" | "asr" | "embedding") => {
    setProviderTests((current) => ({ ...current, [section]: "正在测试…" }));
    try {
      if (section === "llm") await window.interviewCopilot.settings.update("llm", { providerName: llmProviderName.trim() || "OpenAI-compatible", baseUrl: llmBaseUrl.trim(), model: llmModel.trim(), apiKey: llmApiKey || undefined, timeoutMs: 30_000, maxRetries: 2 });
      if (section === "asr") await window.interviewCopilot.settings.update("asr", { providerName: asrProviderType === "deepgram" ? "Deepgram" : "Custom WebSocket ASR Gateway", providerType: asrProviderType, baseUrl: asrBaseUrl.trim(), model: asrModel.trim() || "nova-3", language: asrLanguage, apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      if (section === "embedding") await window.interviewCopilot.settings.update("embedding", { providerName: "OpenAI-compatible", baseUrl: embeddingBaseUrl.trim(), model: embeddingModel.trim() || "text-embedding-3-small", apiKey: embeddingApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      setProviderSettings(await window.interviewCopilot.settings.get());
      const result = await window.interviewCopilot.settings.testConnection(section);
      setProviderTests((current) => ({ ...current, [section]: result.status === "ready" ? "正常" : `${result.status}${result.message ? ` · ${result.message}` : ""}` }));
    } catch (error) { setProviderTests((current) => ({ ...current, [section]: `网络失败 · ${String(error)}` })); }
  };
  const clearProviderKey = async (section: "llm" | "asr" | "embedding") => { await window.interviewCopilot.settings.update(section, { apiKey: "" }); const current = await window.interviewCopilot.settings.get(); setProviderSettings(current); store.setNotice(`${section.toUpperCase()} API Key 已删除`); };
  const modernPageContent = (() => {
    if (page === "home") return chatMessages.length > 0 ? <section className="conversation-view"><div className="page-heading"><div><span className="page-kicker">CONVERSATION</span><h1>{conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? "新对话"}</h1></div><span className="conversation-status">{chatSending ? "AI 正在生成…" : "已保存到本地"}</span></div><div className="chat-message-list">{chatMessages.map((message) => <article className={`chat-message ${message.role}`} key={message.id}><span className="chat-message-avatar">{message.role === "user" ? "你" : "AI"}</span><div className="chat-message-body"><div className="chat-message-role">{message.role === "user" ? "你" : "Interview Copilot"}{message.status === "streaming" && <span className="streaming-label">正在生成…</span>}</div>{message.role === "assistant" ? <MarkdownAnswer text={message.content || "正在生成…"} /> : <p>{message.content}</p>}</div></article>)}</div>{chatSending && activeConversationId && <button className="outline-pill stop-generation" onClick={() => void window.interviewCopilot.chat.cancel(activeConversationId)}>停止生成</button>}</section> : <WelcomeScreen onPrepare={startPreparation} onPolish={polishResume} onLanguage={selectLanguage} onRefresh={beginNewConversation} />;
    if (page === "interview") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">INTERVIEW</span><h1>开始面试</h1></div><button className="dark-pill" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div><div className="interview-placeholder"><h2>准备好开始了吗？</h2><p>选择档案和音频设备后，Interview Copilot 会启动实时转录与回答辅助。</p><button className="outline-pill" onClick={() => setSetupOpen(true)}>打开面试设置</button></div></section>;
    if (page === "preparation") return <section className="simple-page preparation-page"><div className="page-heading"><div><span className="page-kicker">PREPARATION AGENT</span><h1>面试准备</h1></div><span className="page-note">最多 40 步 · 写入需审批</span></div><label className="clean-field"><span>准备目标</span><textarea value={preparationGoal} onChange={(event) => setPreparationGoal(event.target.value)} rows={4} /></label><div className="detail-actions"><button className="dark-pill" disabled={preparationRunning} onClick={async () => { setPreparationEvents([]); setPreparationRunning(true); try { await window.interviewCopilot.preparation.start(preparationGoal); } catch (error) { setPreparationRunning(false); store.setNotice(`Preparation 启动失败：${String(error)}`); } }}>{preparationRunning ? "准备中…" : "开始准备"}</button>{preparationRunning && <button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.stop()}>停止</button>}</div><div className="preparation-events">{preparationEvents.map((event, index) => <div className={`event-row event-${String(event.type ?? "event")}`} key={`${String(event.type)}-${index}`}><strong>{String(event.type ?? "event")}</strong><span>{typeof event.summary === "string" ? event.summary : typeof event.message === "string" ? event.message : typeof event.tool === "string" ? `${event.tool}${event.rationale ? ` · ${String(event.rationale)}` : ""}` : event.risk ? `风险：${String(event.risk)}` : ""}</span>{event.type === "approval_required" && typeof event.requestId === "string" && <span className="approval-actions"><button className="dark-pill" onClick={() => void window.interviewCopilot.preparation.approve(String(event.requestId))}>允许</button><button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.reject(String(event.requestId))}>拒绝</button></span>}</div>)}</div></section>;
    if (page === "profiles") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">PROFILES</span><h1>档案</h1></div><button className="dark-pill" onClick={async () => { const created = await window.interviewCopilot.profiles.save({ name: `面试档案 ${profiles.length + 1}`, language: "zh-CN", skills: [], knowledgeBaseIds: knowledgeBases[0] ? [knowledgeBases[0].id] : [] }); if (created) { setProfiles((current) => [created, ...current]); setProfileId(created.id); } }}>新建档案</button></div><div className="profile-layout"><div className="clean-list">{profiles.map((profile) => <button className={`clean-list-row ${profile.id === profileId ? "selected" : ""}`} key={profile.id} onClick={() => { setProfileId(profile.id); void window.interviewCopilot.profiles.selectActive(profile.id); }}><span>{profile.name}</span><small>{profile.language} · {profile.skills.length} skills</small></button>)}</div>{selectedProfile && <div className="detail-sheet"><h2>{selectedProfile.name}</h2><p className="page-note">{selectedProfile.language} · 当前档案</p><label className="clean-field"><span>Resume</span><label className="upload-row">{selectedProfile.resume?.summary ?? "未上传 Resume"}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void attachProfileMaterial("resume", event)} /></label>{selectedProfile.resume && <button className="text-button danger-text" onClick={() => void removeProfileMaterial("resume")}>移除 Resume</button>}</label><label className="clean-field"><span>职位描述</span><label className="upload-row">{selectedProfile.jobDescription?.summary ?? "未上传 JD"}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void attachProfileMaterial("jobDescription", event)} /></label>{selectedProfile.jobDescription && <button className="text-button danger-text" onClick={() => void removeProfileMaterial("jobDescription")}>移除 JD</button>}</label><div className="detail-actions"><button className="outline-pill" onClick={() => void editInstructions()}>编辑 Instructions</button><button className="outline-pill" onClick={() => void addSkill()}>新增 Skill</button><button className="outline-pill" onClick={() => void cloneProfile()}>克隆</button><button className="outline-pill" onClick={() => void renameProfile()}>重命名</button><button className="outline-pill danger-outline" onClick={() => void deleteProfile()}>删除</button></div><div className="profile-subsection"><h3>Skills</h3>{selectedProfile.skills.length === 0 && <p className="page-note">尚未添加 Skill</p>}{selectedProfile.skills.map((skill) => <div className="skill-row" key={skill.id}><span><strong>{skill.name}</strong><small>{skill.content.slice(0, 80)}</small></span><span><button className="text-button" onClick={() => void editSkill(skill.id)}>编辑</button><button className="text-button danger-text" onClick={() => void deleteSkill(skill.id)}>删除</button></span></div>)}</div><div className="profile-subsection"><h3>关联知识库</h3>{knowledgeBases.map((base) => <label className="check-row" key={base.id}><input type="checkbox" checked={selectedProfile.knowledgeBaseIds.includes(base.id)} onChange={() => void toggleKnowledgeBase(base.id, selectedProfile.knowledgeBaseIds.includes(base.id))} />{base.name}</label>)}</div></div>}</div></section>;
    if (page === "knowledge") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">KNOWLEDGE</span><h1>知识库</h1></div><button className="dark-pill" onClick={async () => { const name = await requestDialog({ kind: "form", title: "新建知识库", label: "知识库名称", defaultValue: "新知识库", required: true, confirmLabel: "创建" }); if (typeof name === "string" && name.trim()) { const created = await window.interviewCopilot.knowledge.createBase(name.trim()); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); } } }}>新建知识库</button></div><div className="clean-list knowledge-list">{knowledgeBases.map((base) => <div className={`clean-list-row ${base.id === knowledgeBaseId ? "selected" : ""}`} key={base.id}><button className="row-main-button" onClick={() => setKnowledgeBaseId(base.id)}><span>{base.name}</span><small>{base.id === knowledgeBaseId ? `${knowledgeDocuments.length} 个文档` : "查看文档"}</small></button><span className="row-actions"><button className="text-button" onClick={async () => { const name = await requestDialog({ kind: "form", title: "重命名知识库", label: "名称", defaultValue: base.name, required: true, confirmLabel: "保存" }); if (typeof name === "string") { const updated = await window.interviewCopilot.knowledge.renameBase(base.id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); } }}>重命名</button><button className="text-button danger-text" onClick={async () => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${base.name}？`, description: "知识库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(base.id); const next = await window.interviewCopilot.knowledge.listBases(); setKnowledgeBases(next); setKnowledgeBaseId(next[0]?.id ?? ""); } }}>删除</button></span></div>)}</div><label className="upload-document">＋ 导入 PDF / DOCX / TXT / MD<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void uploadKnowledge(event)} /></label><div className="clean-list document-list">{knowledgeDocuments.map((document) => <div className="clean-list-row" key={document.id}><span>{document.filename}</span><span className="row-actions"><small>{document.status}{document.error ? ` · ${document.error}` : ""}</small><button className="text-button" onClick={() => void window.interviewCopilot.knowledge.reindex(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>重建索引</button><button className="text-button danger-text" onClick={() => void window.interviewCopilot.knowledge.delete(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>删除</button></span></div>)}</div></section>;
    if (page === "history") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">HISTORY</span><h1>面试记录</h1></div><input className="inline-search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="搜索记录" /></div><div className="history-layout"><div className="clean-list">{historyRecords.filter((record) => `${record.profileId} ${record.status}`.toLowerCase().includes(historySearch.toLowerCase())).map((record) => <button className="clean-list-row" key={record.id} onClick={async () => { const [metrics, detail] = await Promise.all([window.interviewCopilot.history.analyze(record.id), window.interviewCopilot.history.get(record.id)]); if (metrics) setHistoryMetrics({ id: record.id, ...metrics }); if (detail) setHistoryDetail(detail as typeof historyDetail); }}><span>{new Date(record.startedAt).toLocaleString()}</span><small>{record.status} · {record.profileId}</small></button>)}{historyRecords.length === 0 && <p className="page-note">完成一次面试后，记录会显示在这里。</p>}</div>{historyDetail && <div className="detail-sheet"><h2>面试详情</h2><p className="page-note">{historyDetail.interview.profileId} · {historyDetail.interview.automationMode}</p><div className="detail-metrics"><span>问题数 <strong>{historyMetrics?.questionCount ?? historyDetail.questions.length}</strong></span><span>已回答 <strong>{historyMetrics?.answeredQuestionCount ?? historyDetail.answers.length}</strong></span><span>回答率 <strong>{historyMetrics ? `${Math.round(historyMetrics.answerRate * 100)}%` : "—"}</strong></span></div><div className="transcript-detail">{historyDetail.transcripts.map((item) => <p key={item.id}><b>{item.source === "remote" ? "REMOTE" : "MIC"}</b>{item.text}</p>)}</div></div>}</div></section>;
    return <section className="simple-page settings-page"><div className="page-heading"><div><span className="page-kicker">SETTINGS</span><h1>设置</h1></div><button className="dark-pill" onClick={() => void saveProviderSettings()}>保存设置</button></div><div className="settings-columns"><div><h2>LLM Provider</h2><label className="clean-field"><span>Provider Name</span><input value={llmProviderName} onChange={(event) => setLlmProviderName(event.target.value)} /></label><label className="clean-field"><span>Base URL</span><input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} /></label><label className="clean-field"><span>API Key {providerSettings?.llm.hasApiKey && <em className="configured-label">已配置 · 仅输入修改</em>}</span><input type="password" value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} placeholder={providerSettings?.llm.hasApiKey ? "••••••••••••" : "输入 API Key"} /></label><div className="model-grid"><label className="clean-field"><span>默认 Model</span><input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} /></label><label className="clean-field"><span>FAST Model</span><input value={fastModel} onChange={(event) => setFastModel(event.target.value)} /></label><label className="clean-field"><span>NORMAL Model</span><input value={normalModel} onChange={(event) => setNormalModel(event.target.value)} /></label><label className="clean-field"><span>DEEP Model</span><input value={deepModel} onChange={(event) => setDeepModel(event.target.value)} /></label><label className="clean-field"><span>Vision Model</span><input value={visionModel} onChange={(event) => setVisionModel(event.target.value)} /></label></div><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("llm")}>测试连接</button><span className="provider-status">{providerTests.llm ?? (providerSettings?.llm.hasApiKey ? "已配置 · 未测试" : "未配置")}</span></div><h2 className="settings-section-gap">Embedding</h2><label className="clean-field"><span>Base URL</span><input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} /></label><label className="clean-field"><span>API Key {providerSettings?.embedding.hasApiKey && <em className="configured-label">已配置 · 仅输入修改</em>}</span><input type="password" value={embeddingApiKey} onChange={(event) => setEmbeddingApiKey(event.target.value)} placeholder={providerSettings?.embedding.hasApiKey ? "••••••••••••" : "可选，未配置时使用 Keyword Retrieval"} /></label><label className="clean-field"><span>Embedding Model</span><input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} /></label><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("embedding")}>测试连接</button><span className="provider-status">{providerTests.embedding ?? (providerSettings?.embedding.hasApiKey ? "已配置 · 未测试" : "Keyword Retrieval")}</span></div></div><div><h2>ASR Provider</h2><label className="clean-field"><span>Provider</span><select value={asrProviderType} onChange={(event) => setAsrProviderType(event.target.value as typeof asrProviderType)}><option value="deepgram">Deepgram Direct</option><option value="custom-gateway">Custom Gateway</option></select></label><label className="clean-field"><span>{asrProviderType === "deepgram" ? "Deepgram API Key" : "Token / Ticket（可选）"} {providerSettings?.asr.hasApiKey && <em className="configured-label">已配置</em>}</span><input type="password" value={asrApiKey} onChange={(event) => setAsrApiKey(event.target.value)} placeholder={providerSettings?.asr.hasApiKey ? "••••••••••••" : "输入 API Key"} /></label><label className="clean-field"><span>{asrProviderType === "deepgram" ? "WebSocket URL" : "Gateway WebSocket URL"}</span><input value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} /></label><label className="clean-field"><span>Model</span><input value={asrModel} onChange={(event) => setAsrModel(event.target.value)} /></label><label className="clean-field"><span>Language</span><select value={asrLanguage} onChange={(event) => setAsrLanguage(event.target.value as typeof asrLanguage)}><option value="zh-CN">zh-CN</option><option value="en-US">en-US</option><option value="multi">multi</option></select></label><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("asr")}>测试连接</button><span className="provider-status">{providerTests.asr ?? (providerSettings?.asr.hasApiKey ? "已配置 · 未测试" : "未配置")}</span></div><h2 className="settings-section-gap">回答模式</h2><label className="clean-field"><span>默认模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><div className="rag-status"><strong>RAG Mode</strong><span>{providerSettings?.embedding.hasApiKey ? "Hybrid · Vector + Keyword" : "Keyword Retrieval"}</span></div><details className="advanced-settings"><summary>高级诊断</summary><p>设备列表、Audio Probe 和 Realtime 状态在开始面试设置中显示。</p></details></div></div></section>;
  })();

  if (isOverlay) return <OverlayRoot mic={store.mic} system={store.system} state={store.state} overlayMode={store.overlayMode} automationMode={store.automationMode} answerMode={store.answerMode} question={store.question} answerText={store.answerText} answerStreaming={store.answerStreaming} remoteTranscript={store.remoteTranscript} micTranscript={store.micTranscript} captureProtectionEnabled={captureProtection.requested} captureProtectionSupported={captureProtection.supported} captureProtectionOsFlagApplied={captureProtection.osFlagApplied} captureProtectionDisplayVerified={captureProtection.displayCaptureVerified} captureProtectionLastError={captureProtection.lastError} captureTest={captureTest} onToggleCaptureProtection={() => void toggleCaptureProtection(!captureProtection.requested)} onToggleMode={() => void window.interviewCopilot.overlay.setMode(store.overlayMode === "interactive" ? "passive" : "interactive")} onToggleAutomation={toggleAutomation} onAnswerQuestion={(text) => window.interviewCopilot.interview.answerQuestion(text).catch((error) => { store.setNotice(`发送问题失败：${String(error)}`); throw error; })} onAnswerLatest={() => window.interviewCopilot.interview.answerLatest().catch((error) => { store.setNotice(`回答最新问题失败：${String(error)}`); throw error; })} onAnswerScreenshot={() => window.interviewCopilot.interview.answerScreenshot().catch((error) => { store.setNotice(`SCREENSHOT_FAILED：${String(error)}`); throw error; })} />;

  return (
    <main className="app-shell modern-shell">
      <Sidebar page={page} profileName={selectedProfile?.name} projects={projects} conversations={conversations} onNavigate={setPage} onNewConversation={beginNewConversation} onOpenConversation={(conversationId) => void openConversation(conversationId)} onOpenProject={(projectId) => void openProject(projectId)} onRenameProject={(projectId, name) => void renameProject(projectId, name)} onDeleteProject={(projectId, name) => void deleteProject(projectId, name)} />
      <section className="content-shell">
        <div className="modern-topbar"><button className="dark-pill start-interview" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div>
        <div className="modern-main">{modernPageContent}{page === "settings" && <CaptureProtectionSettings status={captureProtection} onToggle={(enabled) => void toggleCaptureProtection(enabled)} />}</div>
        {(page === "home" || page === "interview") && <ChatComposer value={composerText} onChange={setComposerText} onSubmit={() => void submitComposer()} onCreateProject={() => void createProject()} />}
        {store.notice && <button className="notice-toast" onClick={() => store.setNotice(undefined)}>{store.notice} <span>×</span></button>}
      </section>
      {dialog && <AppDialog dialog={dialog} onConfirm={(value) => closeDialog(dialog.kind === "confirm" ? true : value)} onCancel={() => closeDialog(undefined)} />}
      {setupOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetupOpen(false); }}><section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title"><header><div><span className="page-kicker">INTERVIEW SETUP</span><h2 id="setup-title">开始面试</h2></div><button onClick={() => setSetupOpen(false)} aria-label="关闭">×</button></header><label className="clean-field"><span>面试档案</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><label className="clean-field"><span>回答模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><label className="clean-field"><span>自动回答</span><select value={store.automationMode} onChange={(event) => void window.interviewCopilot.interview.setAutomationMode(event.target.value as "AUTO" | "MANUAL")}><option value="AUTO">AUTO · 听到问题后自动回答</option><option value="MANUAL">MANUAL · 手动触发回答</option></select></label><label className="clean-field"><span>麦克风输入</span><select value={inputDeviceId} onChange={(event) => { setInputDeviceId(event.target.value); setProbeDeviceKey(""); store.clearProbe(); persistDevice("interview-copilot.input-device", event.target.value); }}>{devices.inputs.length === 0 && <option value="">没有检测到输入设备</option>}{devices.inputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><label className="clean-field"><span>系统音频 / Loopback</span><select value={outputDeviceId} onChange={(event) => { setOutputDeviceId(event.target.value); setProbeDeviceKey(""); store.clearProbe(); persistDevice("interview-copilot.output-device", event.target.value); }}>{devices.outputs.length === 0 && <option value="">没有检测到系统音频设备</option>}{devices.outputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><div className="probe-summary"><span>MIC {store.probeResult ? <b className={store.probeResult.mic.ok ? "probe-ok" : "probe-fail"}>{store.probeResult.mic.ok ? "✓ Ready" : "✕ 未检测到有效输入"}</b> : <small>{store.probeError ? `✕ ${store.probeError}` : "未测试"}</small>}</span><span>SYSTEM {store.probeResult ? <b className={store.probeResult.system.ok ? "probe-ok" : "probe-fail"}>{store.probeResult.system.ok ? "✓ Ready" : "✕ 未检测到系统音频"}</b> : <small>{store.probeError ? `✕ ${store.probeError}` : "未测试"}</small>}</span><button className="outline-pill" onClick={() => void probeAudio()}>测试音频</button></div><div className="setup-preflight"><span>LLM · {providerSettings?.llm.hasApiKey ? "✓ 已配置" : "✕ 未配置"}</span><span>ASR · {providerSettings?.asr.hasApiKey || asrProviderType === "custom-gateway" ? "✓ 已配置" : "✕ 未配置"}</span><span>Profile · {selectedProfile ? "✓" : "✕"}</span></div><footer><button className="outline-pill" onClick={() => setSetupOpen(false)}>取消</button><button className="dark-pill" disabled={!currentProbeReady} onClick={() => void startInterview()}>开始面试</button></footer></section></div>}
    </main>
  );

}
