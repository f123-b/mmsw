import { useState, type JSX } from "react";
import type { AudioDevices } from "@interview-copilot/protocol";
import { TECHNICAL_DOMAIN_LABELS, type InterviewDirectionSelection, type InterviewTerminologyPreview, type Profile } from "@interview-copilot/shared";
import { DirectionSelector } from "./DirectionSelector";

export interface InterviewSetupModalProps {
  profiles: Profile[];
  profileId: string;
  selectedProfile?: Profile;
  answerMode: "FAST" | "NORMAL" | "DEEP";
  automationMode: "AUTO" | "MANUAL";
  inputDeviceId: string;
  outputDeviceId: string;
  devices: AudioDevices;
  micLabel: string;
  systemLabel: string;
  micAvailable: boolean;
  systemAvailable: boolean;
  probing: boolean;
  providerLlmReady: boolean;
  providerAsrReady: boolean;
  asrProviderType: string;
  directionSelection?: InterviewDirectionSelection;
  directionPreview?: InterviewTerminologyPreview;
  directionPreviewLoading?: boolean;
  onClose: () => void;
  onProfileChange: (profileId: string) => void;
  onAnswerModeChange: (mode: "FAST" | "NORMAL" | "DEEP") => void;
  onAutomationModeChange: (mode: "AUTO" | "MANUAL") => void;
  onInputDeviceChange: (deviceId: string) => void;
  onOutputDeviceChange: (deviceId: string) => void;
  onDirectionSelectionChange: (selection?: InterviewDirectionSelection) => void;
  onProbe: () => void;
  onCopyDiagnostics: () => void;
  onStart: (saveAsProfileDefault: boolean) => void;
}

function sourceCount(preview: InterviewTerminologyPreview | undefined, source: string): number {
  return preview?.sourceCounts[source as keyof InterviewTerminologyPreview["sourceCounts"]] ?? 0;
}

export function InterviewSetupModal(props: InterviewSetupModalProps): JSX.Element {
  const [audioDetailsOpen, setAudioDetailsOpen] = useState(false);
  const [saveAsProfileDefault, setSaveAsProfileDefault] = useState(false);
  const preview = props.directionPreview;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section className="setup-modal interview-setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <header className="setup-modal-header"><div><span className="page-kicker">INTERVIEW SETUP</span><h2 id="setup-title">开始面试</h2><p>先锁定本轮方向，再连接音频。方向只影响本轮已有术语候选。</p></div><button onClick={props.onClose} aria-label="关闭">×</button></header>
      <div className="setup-modal-body">
        <div className="setup-section setup-profile-section"><label className="clean-field"><span>面试档案</span><select value={props.profileId} onChange={(event) => props.onProfileChange(event.target.value)}>{props.profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><small>{props.selectedProfile?.resume ? "已加载 Resume" : "未上传 Resume"} · {props.selectedProfile?.jobDescription ? "已加载 JD" : "未上传 JD"}</small></div>
        <div className="setup-section"><DirectionSelector value={props.directionSelection} onChange={props.onDirectionSelectionChange} compact /><div className="direction-preview-summary">{props.directionPreviewLoading ? "正在计算本轮有效词典…" : preview ? <><span>领域：{[...preview.primaryDomains, ...preview.secondaryDomains].slice(0, 5).map((domain) => TECHNICAL_DOMAIN_LABELS[domain] ?? domain).join(" · ") || "自动"}</span><span>有效术语 {preview.lexiconSize} 项</span></> : <span>未选择方向时保持当前自动识别</span>}</div><label className="setup-save-default"><input type="checkbox" checked={saveAsProfileDefault} onChange={(event) => setSaveAsProfileDefault(event.target.checked)} /><span>保存为当前档案默认方向</span></label></div>
        <div className="setup-control-grid setup-section"><label className="clean-field"><span>回答模式</span><select value={props.answerMode} onChange={(event) => props.onAnswerModeChange(event.target.value as "FAST" | "NORMAL" | "DEEP")}><option value="FAST">快速 · 优先低延迟</option><option value="NORMAL">平衡 · 推荐</option><option value="DEEP">深度 · 复杂问题</option></select></label><label className="clean-field"><span>回答方式</span><select value={props.automationMode} onChange={(event) => props.onAutomationModeChange(event.target.value as "AUTO" | "MANUAL")}><option value="AUTO">自动回答</option><option value="MANUAL">手动触发</option></select></label></div>
        <div className="setup-section audio-compact-section"><div className="audio-compact-row"><div><strong>音频输入</strong><small>麦克风 + 系统音频</small></div><div className="audio-compact-status"><span>MIC <b className={props.micAvailable ? "probe-ok" : "probe-fail"}>{props.micLabel}</b></span><span>SYSTEM <b className={props.systemAvailable ? "probe-ok" : "probe-fail"}>{props.systemLabel}</b></span><button className="text-button" onClick={() => setAudioDetailsOpen((current) => !current)}>{audioDetailsOpen ? "收起详情" : "音频详情"}</button></div></div>{audioDetailsOpen && <div className="audio-details"><label className="clean-field"><span>麦克风</span><select value={props.inputDeviceId} onChange={(event) => props.onInputDeviceChange(event.target.value)}><option value="">自动选择（推荐）</option>{props.devices.inputs.length === 0 && <option value="" disabled>没有检测到输入设备</option>}{props.devices.inputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><label className="clean-field"><span>系统音频 / Loopback</span><select value={props.outputDeviceId} onChange={(event) => props.onOutputDeviceChange(event.target.value)}><option value="">自动选择（推荐）</option>{props.devices.outputs.length === 0 && <option value="" disabled>没有检测到系统音频设备</option>}{props.devices.outputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><div className="probe-summary"><button className="outline-pill" disabled={props.probing} onClick={props.onProbe}>{props.probing ? "测试中…" : "可选：测试音频"}</button><button className="text-button" onClick={props.onCopyDiagnostics}>复制诊断</button><small>音频测试仅用于诊断，不是开始面试的前置条件；缺失声道会自动补零。</small></div></div>}</div>
        <div className="setup-preflight setup-section"><span>LLM · {props.providerLlmReady ? "✓ 已配置" : "✕ 未配置"}</span><span>ASR · {props.asrProviderType === "funasr-local" ? "✓ 本地服务自动启动" : props.providerAsrReady ? "✓ 已配置" : "✕ 未配置"}</span><span>Profile · {props.selectedProfile ? "✓" : "✕"}</span><span>词典 · {props.directionPreviewLoading ? "计算中…" : `${preview?.lexiconSize ?? "—"} 项`}</span></div>
        <div className="setup-lexicon-breakdown"><strong>本轮词典构成</strong><span>内置 {sourceCount(preview, "builtin")}</span><span>Resume {sourceCount(preview, "resume")}</span><span>JD {sourceCount(preview, "job")}</span><span>项目 {sourceCount(preview, "project")}</span><span>用户 {sourceCount(preview, "user")}</span></div>
      </div>
      <footer className="setup-modal-footer"><button className="outline-pill" onClick={props.onClose}>取消</button><button className="dark-pill" onClick={() => props.onStart(saveAsProfileDefault)}>开始面试</button></footer>
    </section>
  </div>;
}
