import type { AudioDevices } from "@interview-copilot/protocol";
import type { JSX } from "react";
import type { AsrRuntimeDiagnostics } from "../../main/realtime-session";
import type { CaptureProtectionState } from "../../main/overlay-manager";
import { GLOBAL_SHORTCUTS } from "../../main/shortcuts";
import type { ProviderCenterPublicConfig } from "../../main/settings-store";
import type { OverlayPreferences } from "../../shared/overlay-preferences";
import type { DiscoveredModel, ModelCatalogResult, ModelCategory } from "../../main/model-catalog";
import type { AsrProviderType } from "@interview-copilot/shared";
import { OverlayDesigner } from "../overlay/OverlayDesigner";
import { TerminologySettings, type TerminologySettingsProps } from "./TerminologySettings";

export type SettingsSection = "general" | "overlay" | "terminology" | "models" | "asr" | "retrieval" | "shortcuts" | "privacy" | "about";

const SETTINGS_NAV: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "general", label: "常规", description: "应用基础行为" },
  { id: "overlay", label: "悬浮窗", description: "面试与笔试窗口" },
  { id: "terminology", label: "技术术语", description: "本地词典与 Shadow" },
  { id: "models", label: "模型与 API", description: "供应商与任务路由" },
  { id: "asr", label: "语音识别", description: "实时语音与设备" },
  { id: "retrieval", label: "检索模型", description: "Embedding 与召回" },
  { id: "shortcuts", label: "快捷键", description: "系统快捷操作" },
  { id: "privacy", label: "隐私保护", description: "捕获与分享" },
  { id: "about", label: "关于", description: "版本与诊断" }
];

type TaskModelKey = "fallbackModel" | "questionRecognitionModel" | "profileBuilderModel" | "projectAnalyzerModel" | "questionBankModel" | "chatModel" | "postInterviewModel" | "preparationModel";

interface SettingsPageProps {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  profiles: Array<{ id: string; name: string }>;
  activeProfileId: string;
  onActiveProfileChange: (profileId: string) => void;
  answerMode: "FAST" | "NORMAL" | "DEEP";
  onAnswerModeChange: (mode: "FAST" | "NORMAL" | "DEEP") => void;
  providerSettings?: ProviderCenterPublicConfig;
  llmProfiles: ProviderCenterPublicConfig["llmProfiles"];
  activeLlmProfileId: string;
  llmProfileId: string;
  llmProfileName: string;
  onLlmProfileNameChange: (value: string) => void;
  onLlmProfileSelect: (profileId: string) => void;
  onLlmProfileActivate: () => void;
  onLlmProfileNew: () => void;
  onLlmProfileDelete: () => void;
  llm: {
    providerName: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    fastModel: string;
    normalModel: string;
    deepModel: string;
    visionModel: string;
    onProviderNameChange: (value: string) => void;
    onBaseUrlChange: (value: string) => void;
    onApiKeyChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onFastModelChange: (value: string) => void;
    onNormalModelChange: (value: string) => void;
    onDeepModelChange: (value: string) => void;
    onVisionModelChange: (value: string) => void;
  };
  routing: { values: Record<TaskModelKey, string>; onChange: (key: TaskModelKey, value: string) => void };
  asr: {
    providerType: AsrProviderType;
    baseUrl: string;
    model: string;
    language: "zh-CN" | "en-US" | "multi";
    apiKey: string;
    onProviderTypeChange: (providerType: AsrProviderType) => void;
    onBaseUrlChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onLanguageChange: (value: "zh-CN" | "en-US" | "multi") => void;
    onApiKeyChange: (value: string) => void;
    diagnostics: AsrRuntimeDiagnostics;
    devices: AudioDevices;
    inputDeviceId: string;
    outputDeviceId: string;
    onInputDeviceChange: (value: string) => void;
    onOutputDeviceChange: (value: string) => void;
    probing: boolean;
    onProbe: () => void;
  };
  embedding: {
    baseUrl: string;
    model: string;
    apiKey: string;
    onBaseUrlChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onApiKeyChange: (value: string) => void;
  };
  modelCatalogs: Partial<Record<"llm" | "asr" | "embedding", ModelCatalogResult>>;
  modelCatalogLoading: Partial<Record<"llm" | "asr" | "embedding", boolean>>;
  providerTests: Record<string, string>;
  onChooseLlmPreset: (preset: "deepseek" | "qwen" | "custom") => void;
  onFetchModels: (section: "llm" | "asr" | "embedding") => void;
  onTestProvider: (section: "llm" | "asr" | "embedding") => void;
  onSaveLlmProfile: () => Promise<{ config: ProviderCenterPublicConfig; profileId: string } | undefined>;
  onSaveAsr: () => Promise<void>;
  onSaveEmbedding: () => Promise<void>;
  overlayPreferences: OverlayPreferences;
  onOverlayPreview: (patch: import("../../shared/overlay-preferences").OverlayPreferencesPatch) => void;
  onOverlayChange: (patch: import("../../shared/overlay-preferences").OverlayPreferencesPatch) => void;
  onOverlayReset: () => void;
  captureProtectionPanel: JSX.Element;
  terminology: TerminologySettingsProps;
}

function CatalogModelSelect({ label, value, models, category, onChange, optional = false }: { label: string; value: string; models: DiscoveredModel[]; category: ModelCategory; onChange: (value: string) => void; optional?: boolean }): JSX.Element {
  const options = models.filter((model) => model.categories.includes(category));
  const hasCurrent = Boolean(value && options.some((model) => model.id === value));
  return <label className="clean-field model-catalog-field"><span>{label}<small>{options.length > 0 ? `${options.length} 个可用 · 可搜索` : "等待获取"}</small></span><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} disabled={options.length === 0 && !value}>{optional && <option value="">不配置</option>}{value && !hasCurrent && <option value={value}>{value} · 当前手动值</option>}{options.map((model) => <option value={model.id} key={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}{model.description ? ` · ${model.description}` : ""}</option>)}</select>{value && hasCurrent && <small className="model-capability-hint">能力：{options.find((model) => model.id === value)?.categories.join(" / ")}</small>}</label>;
}

function LlmModelProfilesPanel(props: Pick<SettingsPageProps, "llmProfiles" | "activeLlmProfileId" | "llmProfileId" | "llmProfileName" | "onLlmProfileNameChange" | "onLlmProfileSelect" | "onLlmProfileActivate" | "onLlmProfileNew" | "onLlmProfileDelete">): JSX.Element {
  const selectedSaved = props.llmProfiles.some((profile) => profile.id === props.llmProfileId);
  return <section className="settings-section-card model-profiles-panel" data-testid="settings-model-profiles"><div className="settings-section-heading"><div><span className="page-kicker">MODEL PROFILES</span><h2>配置档案</h2><p>不同 Provider 可以保存为独立配置，启用后供下一次回答使用。</p></div><div className="settings-inline-actions"><button className="dark-pill" disabled={!selectedSaved || props.llmProfileId === props.activeLlmProfileId} onClick={props.onLlmProfileActivate}>{props.llmProfileId === props.activeLlmProfileId ? "正在使用" : "启用配置"}</button><button className="outline-pill" onClick={props.onLlmProfileNew}>新建配置</button><button className="text-button danger-text" disabled={!selectedSaved || props.llmProfiles.length <= 1} onClick={props.onLlmProfileDelete}>删除</button></div></div><div className="settings-form-grid"><label className="clean-field"><span>配置档案</span><select value={props.llmProfileId} onChange={(event) => props.onLlmProfileSelect(event.target.value)}>{props.llmProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}{profile.id === props.activeLlmProfileId ? " · 正在使用" : ""}</option>)}</select></label><label className="clean-field"><span>配置名称</span><input value={props.llmProfileName} onChange={(event) => props.onLlmProfileNameChange(event.target.value)} placeholder="例如：DeepSeek 主配置" /></label></div></section>;
}

function TaskModelRoutingPanel({ values, onChange }: SettingsPageProps["routing"]): JSX.Element {
  const fields: Array<[TaskModelKey, string, string]> = [
    ["fallbackModel", "失败回退", "主模型失败时使用"],
    ["questionRecognitionModel", "问题识别", "为空时继承快速模型"],
    ["profileBuilderModel", "档案 / 简历分析", "为空时继承通用模型"],
    ["projectAnalyzerModel", "项目分析", "为空时继承通用模型"],
    ["questionBankModel", "题库生成", "为空时继承快速模型"],
    ["chatModel", "AI 对话", "为空时继承通用模型"],
    ["postInterviewModel", "面试后分析", "为空时继承推理模型"],
    ["preparationModel", "面试准备", "为空时继承通用模型"]
  ];
  return <details className="settings-section-card task-routing-panel" data-testid="settings-task-routing"><summary><span><span className="page-kicker">ADVANCED ROUTING</span><strong>高级任务路由</strong><small>普通用户无需单独配置</small></span></summary><p>留空时按任务继承快速、通用或推理模型；只在高级用户需要精细控制时覆盖。</p><div className="settings-form-grid">{fields.map(([key, label, placeholder]) => <label className="clean-field" key={key}><span>{label}</span><input value={values[key]} onChange={(event) => onChange(key, event.target.value)} placeholder={placeholder} /></label>)}</div></details>;
}

function ModelSettings({ props }: { props: SettingsPageProps }): JSX.Element {
  const models = props.modelCatalogs.llm?.models ?? [];
  const selected = props.llmProfiles.find((profile) => profile.id === props.llmProfileId);
  const providerPreset = /deepseek/i.test(`${props.llm.providerName} ${props.llm.baseUrl}`) ? "deepseek" : /qwen|dashscope|千问|百炼/i.test(`${props.llm.providerName} ${props.llm.baseUrl}`) ? "qwen" : "custom";
  return <div className="settings-content-stack" data-testid="settings-models-page">
    <LlmModelProfilesPanel {...props} />
    <section className="settings-section-card" data-testid="settings-llm-provider"><div className="settings-section-heading"><div><h2>模型与 API</h2><p>从 Provider 获取真实模型目录，并按能力分配到回答任务。</p></div><span className={`settings-status-dot ${selected?.hasApiKey ? "ready" : ""}`}>{selected?.hasApiKey ? "已配置" : "未配置"}</span></div><div className="provider-preset-row" role="group" aria-label="LLM 供应商"><button className={providerPreset === "deepseek" ? "selected" : ""} onClick={() => props.onChooseLlmPreset("deepseek")}><strong>DeepSeek</strong><small>官方 API</small></button><button className={providerPreset === "qwen" ? "selected" : ""} onClick={() => props.onChooseLlmPreset("qwen")}><strong>阿里云百炼 / 千问</strong><small>文本与视觉</small></button><button className={providerPreset === "custom" ? "selected" : ""} onClick={() => props.onChooseLlmPreset("custom")}><strong>OpenAI 兼容</strong><small>vLLM / LM Studio / Ollama / Gateway</small></button></div><div className="settings-form-grid"><label className="clean-field"><span>供应商名称</span><input value={props.llm.providerName} onChange={(event) => props.llm.onProviderNameChange(event.target.value)} /></label><label className="clean-field"><span>Base URL</span><input value={props.llm.baseUrl} onChange={(event) => props.llm.onBaseUrlChange(event.target.value)} /></label><label className="clean-field"><span>API Key <em className="configured-label">{selected?.hasApiKey ? "已保存 · 输入新值即可替换" : "仅保存在系统安全存储"}</em></span><input type="password" autoComplete="off" value={props.llm.apiKey} onChange={(event) => props.llm.onApiKeyChange(event.target.value)} placeholder={selected?.hasApiKey ? "输入新的 API Key" : "输入 API Key"} /></label><div className="settings-form-actions"><button className="dark-pill" onClick={() => void props.onSaveLlmProfile()}>{props.modelCatalogLoading.llm ? "保存中…" : "保存配置"}</button><button className="outline-pill" disabled={props.modelCatalogLoading.llm} onClick={() => props.onFetchModels("llm")}>{props.modelCatalogLoading.llm ? "获取中…" : "获取模型"}</button><button className="outline-pill" onClick={() => props.onTestProvider("llm")}>测试连接</button></div></div><p className="provider-feedback">{props.providerTests.llm ?? "使用保存的配置获取模型目录"}</p></section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><h2>核心模型</h2><p>选择器只展示被分类为当前能力的模型，Embedding 不会混入聊天模型。</p></div><span className="settings-section-meta">{props.modelCatalogs.llm ? `${models.length} 个目录模型` : "尚未获取目录"}</span></div>{models.length ? <div className="settings-form-grid model-routing-grid"><CatalogModelSelect label="默认模型" value={props.llm.model} models={models} category="general" onChange={props.llm.onModelChange} /><CatalogModelSelect label="快速模型" value={props.llm.fastModel} models={models} category="fast" onChange={props.llm.onFastModelChange} /><CatalogModelSelect label="标准模型" value={props.llm.normalModel} models={models} category="general" onChange={props.llm.onNormalModelChange} /><CatalogModelSelect label="深度推理" value={props.llm.deepModel} models={models} category="reasoning" onChange={props.llm.onDeepModelChange} /><CatalogModelSelect label="视觉模型" value={props.llm.visionModel} models={models} category="vision" onChange={props.llm.onVisionModelChange} optional /></div> : <div className="settings-form-grid model-routing-grid"><label className="clean-field"><span>默认模型 ID</span><input value={props.llm.model} onChange={(event) => props.llm.onModelChange(event.target.value)} /></label><label className="clean-field"><span>快速模型 ID</span><input value={props.llm.fastModel} onChange={(event) => props.llm.onFastModelChange(event.target.value)} /></label><label className="clean-field"><span>标准模型 ID</span><input value={props.llm.normalModel} onChange={(event) => props.llm.onNormalModelChange(event.target.value)} /></label><label className="clean-field"><span>推理模型 ID</span><input value={props.llm.deepModel} onChange={(event) => props.llm.onDeepModelChange(event.target.value)} /></label><label className="clean-field"><span>视觉模型 ID</span><input value={props.llm.visionModel} onChange={(event) => props.llm.onVisionModelChange(event.target.value)} /></label><p className="settings-empty-note">保存 API 配置后可获取 Provider 的实时模型目录；目录返回前保留这里的手动模型值。</p></div>}</section>
    <TaskModelRoutingPanel {...props.routing} />
    <div className="settings-sticky-actions"><button className="dark-pill" onClick={() => void props.onSaveLlmProfile()}>保存模型配置</button></div>
  </div>;
}

function AsrSettings({ props }: { props: SettingsPageProps }): JSX.Element {
  const diagnostics = props.asr.diagnostics;
  const captureMode = diagnostics.micState !== "stopped" && diagnostics.remoteState !== "stopped" ? "dual" : diagnostics.remoteState !== "stopped" ? "system_only" : diagnostics.micState !== "stopped" ? "mic_only" : "未开始捕获";
  return <div className="settings-content-stack" data-testid="settings-asr-page"><section className="settings-section-card"><div className="settings-section-heading"><div><h2>语音识别</h2><p>ASR 独立于 LLM 配置，支持云端、本地和 Custom Gateway。</p></div><span className={`settings-status-dot ${diagnostics.fallback ? "warning" : ""}`}>{diagnostics.fallback ? "fallback" : "运行时状态"}</span></div><div className="settings-form-grid"><label className="clean-field"><span>供应商</span><select value={props.asr.providerType} onChange={(event) => props.asr.onProviderTypeChange(event.target.value as AsrProviderType)}><option value="qwen">千问实时语音</option><option value="deepgram">Deepgram</option><option value="funasr-local">FunASR Local</option><option value="custom-gateway">Custom Gateway</option></select></label><label className="clean-field"><span>模型</span><input value={props.asr.model} onChange={(event) => props.asr.onModelChange(event.target.value)} /></label><label className="clean-field"><span>语言</span><select value={props.asr.language} onChange={(event) => props.asr.onLanguageChange(event.target.value as SettingsPageProps["asr"]["language"])}><option value="zh-CN">中文</option><option value="en-US">English</option><option value="multi">多语言</option></select></label><label className="clean-field"><span>API Key <em className="configured-label">{props.providerSettings?.asr.hasApiKey ? "已保存" : "未保存"}</em></span><input type="password" autoComplete="off" value={props.asr.apiKey} onChange={(event) => props.asr.onApiKeyChange(event.target.value)} disabled={props.asr.providerType === "funasr-local"} placeholder={props.asr.providerType === "funasr-local" ? "本地服务无需 API Key" : "输入 API Key"} /></label><label className="clean-field settings-field-wide"><span>Base URL / WebSocket</span><input value={props.asr.baseUrl} onChange={(event) => props.asr.onBaseUrlChange(event.target.value)} /></label></div><div className="settings-form-actions"><button className="dark-pill" onClick={() => void props.onSaveAsr()}>保存语音设置</button>{props.asr.providerType === "qwen" && <button className="outline-pill" onClick={() => props.onFetchModels("asr")}>获取模型</button>}<button className="outline-pill" onClick={() => props.onTestProvider("asr")}>测试识别连接</button></div><p className="provider-feedback">{props.providerTests.asr ?? "尚未测试"}</p></section><section className="settings-section-card"><div className="settings-section-heading"><div><h2>捕获设备</h2><p>真实设备选择会复用开始面试时的音频入口。</p></div><span className="settings-section-meta">当前模式：{captureMode}</span></div><div className="settings-form-grid"><label className="clean-field"><span>系统音频设备</span><select value={props.asr.outputDeviceId} onChange={(event) => props.asr.onOutputDeviceChange(event.target.value)}><option value="">自动选择（推荐）</option>{props.asr.devices.outputs.length === 0 && <option value="" disabled>没有检测到系统音频设备</option>}{props.asr.devices.outputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><label className="clean-field"><span>麦克风设备</span><select value={props.asr.inputDeviceId} onChange={(event) => props.asr.onInputDeviceChange(event.target.value)}><option value="">自动选择（推荐）</option>{props.asr.devices.inputs.length === 0 && <option value="" disabled>没有检测到麦克风设备</option>}{props.asr.devices.inputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label></div><div className="settings-runtime-status"><span>系统音频 <strong>{diagnostics.remoteState}</strong></span><span>麦克风 <strong>{diagnostics.micState}</strong></span><span>实际 Provider <strong>{diagnostics.provider}</strong></span><span>当前设备模式 <strong>{captureMode}</strong></span><span>fallback <strong>{diagnostics.fallback ? "已发生" : "未发生"}</strong></span></div><button className="outline-pill" disabled={props.asr.probing} onClick={props.asr.onProbe}>{props.asr.probing ? "测试中…" : "测试识别设备"}</button></section></div>;
}

function RetrievalSettings({ props }: { props: SettingsPageProps }): JSX.Element {
  return <div className="settings-content-stack" data-testid="settings-retrieval-page"><section className="settings-section-card"><div className="settings-section-heading"><div><h2>检索模型</h2><p>Embedding 与 Chat LLM 分离；未配置时后端使用关键词检索，不会静默假装启用向量能力。</p></div><span className={`settings-status-dot ${props.providerSettings?.embedding.hasApiKey ? "ready" : ""}`}>{props.providerSettings?.embedding.hasApiKey ? "已启用" : "可选"}</span></div><div className="settings-form-grid"><label className="clean-field"><span>Provider</span><input value="OpenAI-compatible" readOnly /></label><label className="clean-field"><span>Base URL</span><input value={props.embedding.baseUrl} onChange={(event) => props.embedding.onBaseUrlChange(event.target.value)} /></label><label className="clean-field"><span>Embedding API Key <em className="configured-label">{props.providerSettings?.embedding.hasApiKey ? "已保存" : "可选"}</em></span><input type="password" autoComplete="off" value={props.embedding.apiKey} onChange={(event) => props.embedding.onApiKeyChange(event.target.value)} placeholder="未配置时使用关键词检索" /></label><label className="clean-field"><span>Embedding Model</span><input value={props.embedding.model} onChange={(event) => props.embedding.onModelChange(event.target.value)} /></label></div><div className="settings-form-actions"><button className="dark-pill" onClick={() => void props.onSaveEmbedding()}>保存检索设置</button><button className="outline-pill" onClick={() => props.onFetchModels("embedding")}>获取模型</button><button className="outline-pill" onClick={() => props.onTestProvider("embedding")}>测试连接</button></div><p className="provider-feedback">{props.providerTests.embedding ?? (props.providerSettings?.embedding.hasApiKey ? "已配置，尚未测试" : "当前使用 Keyword Retrieval")}</p></section><section className="settings-section-card settings-capability-note"><h2>当前真实能力</h2><div className="settings-runtime-status"><span>关键词召回 <strong>始终可用</strong></span><span>向量召回 <strong>{props.providerSettings?.embedding.hasApiKey ? "可用" : "未启用"}</strong></span><span>混合检索 <strong>{props.providerSettings?.embedding.hasApiKey ? "Vector + Keyword" : "Keyword only"}</strong></span></div></section></div>;
}

function GeneralSettings({ props }: { props: SettingsPageProps }): JSX.Element {
  return <div className="settings-content-stack" data-testid="settings-general-page"><section className="settings-section-card"><div className="settings-section-heading"><div><h2>常规</h2><p>管理面试工作区的默认选择与基础应用行为。</p></div></div><div className="settings-form-grid"><label className="clean-field"><span>语言</span><select disabled defaultValue="zh-CN"><option value="zh-CN">简体中文</option><option value="en-US">English（暂未持久化）</option></select><small className="field-note">当前版本界面语言固定为简体中文。</small></label><label className="clean-field"><span>默认面试档案</span><select value={props.activeProfileId} onChange={(event) => props.onActiveProfileChange(event.target.value)}>{props.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select><small className="field-note">使用真实的当前活动档案设置。</small></label><label className="clean-field"><span>默认回答模式</span><select value={props.answerMode} onChange={(event) => props.onAnswerModeChange(event.target.value as SettingsPageProps["answerMode"])}><option value="FAST">快速</option><option value="NORMAL">标准 · 推荐</option><option value="DEEP">深度推理</option></select><small className="field-note">用于下一次开始面试；当前版本不额外创建第二份配置。</small></label></div></section><section className="settings-section-card"><h2>应用选项</h2><div className="settings-readonly-list"><div><span>启动行为</span><strong>启动后停留在工作台</strong><small>暂未开放持久化设置</small></div><div><span>关闭行为</span><strong>退出前完成资源清理</strong><small>由主进程 shutdown controller 统一处理</small></div><div><span>自动保存面试记录</span><strong className="ready-text">始终开启</strong><small>每场面试结束后写入本地历史</small></div><div><span>更新</span><strong>由打包版本策略管理</strong><small>当前版本未提供在线更新开关</small></div></div></section></div>;
}

function ShortcutSettings(): JSX.Element {
  const rows: Array<[string, string, string]> = [["回答最新问题", GLOBAL_SHORTCUTS.answerLatest, "INTERVIEW"], ["截图识别", GLOBAL_SHORTCUTS.screenshotAnswer, "INTERVIEW / 笔试"], ["隐藏 / 显示悬浮窗", GLOBAL_SHORTCUTS.toggleOverlay, "运行时"], ["切换交互 / 穿透", GLOBAL_SHORTCUTS.toggleOverlayMode, "运行时"], ["打开快捷操作", GLOBAL_SHORTCUTS.toggleShortcuts, "运行时"], ["结束面试", GLOBAL_SHORTCUTS.endInterview, "运行时"], ["切换自动 / 手动", GLOBAL_SHORTCUTS.toggleAutomation, "面试"]];
  return <div className="settings-content-stack" data-testid="settings-shortcuts-page"><section className="settings-section-card"><div className="settings-section-heading"><div><h2>快捷键</h2><p>当前绑定来自主进程全局注册表；本版本暂不提供录制入口，因此不会显示假保存按钮。</p></div></div><div className="shortcut-settings-list">{rows.map(([label, accelerator, scope]) => <div key={accelerator}><span>{label}<small>{scope}</small></span><kbd>{accelerator.replaceAll("CommandOrControl", "Ctrl")}</kbd></div>)}</div><p className="field-note">如果系统拒绝注册快捷键，主进程会记录失败诊断；请查看应用日志后更换冲突组合。</p></section></div>;
}

function AboutSettings(): JSX.Element {
  return <div className="settings-content-stack" data-testid="settings-about-page"><section className="settings-section-card about-settings"><span className="page-kicker">INTERVIEW COPILOT</span><h2>关于</h2><p>面向 Windows 面试场景的低干扰桌面辅助工具。</p><dl><div><dt>版本</dt><dd>0.1.0</dd></div><div><dt>渲染架构</dt><dd>Electron · React · TypeScript</dd></div><div><dt>本地数据</dt><dd>SQLite + OS secure storage</dd></div></dl></section></div>;
}

export function SettingsPage(props: SettingsPageProps): JSX.Element {
  const current = SETTINGS_NAV.find((item) => item.id === props.section) ?? SETTINGS_NAV[0];
  return <section className="settings-page settings-shell" data-testid="settings-page"><div className="settings-page-heading"><div><span className="page-kicker">SETTINGS</span><h1>设置</h1><p className="page-note">将应用行为、悬浮窗和服务配置分开管理。</p></div><span className="settings-current-label">{current.label}</span></div><div className="settings-layout"><nav className="settings-subnav" aria-label="设置分类">{SETTINGS_NAV.map((item) => <button key={item.id} className={props.section === item.id ? "selected" : ""} data-testid={`settings-nav-${item.id}`} onClick={() => props.onSectionChange(item.id)}><strong>{item.label}</strong><small>{item.description}</small></button>)}</nav><main className="settings-content">{props.section === "general" && <GeneralSettings props={props} />}{props.section === "overlay" && <div className="settings-content-stack" data-testid="settings-overlay-page"><OverlayDesigner value={props.overlayPreferences} onChange={props.onOverlayChange} onPreview={props.onOverlayPreview} onReset={props.onOverlayReset} /></div>}{props.section === "terminology" && <TerminologySettings {...props.terminology} />}{props.section === "models" && <ModelSettings props={props} />}{props.section === "asr" && <AsrSettings props={props} />}{props.section === "retrieval" && <RetrievalSettings props={props} />}{props.section === "shortcuts" && <ShortcutSettings />}{props.section === "privacy" && <div className="settings-content-stack" data-testid="settings-privacy-page">{props.captureProtectionPanel}</div>}{props.section === "about" && <AboutSettings />}</main></div></section>;
}
