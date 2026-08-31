import { useState, type JSX } from "react";
import type { InterviewDirectionSelection, TechnicalDomain, TechnicalTerm, TerminologyRolloutMode } from "@interview-copilot/shared";
import { DirectionSelector } from "../interview/DirectionSelector";

const DOMAIN_LABELS: Array<[TechnicalDomain, string]> = [
  ["common_cs", "计算机基础"], ["c_cpp", "C / C++"], ["embedded", "嵌入式"], ["linux", "Linux"], ["network", "网络"], ["database", "数据库"], ["java", "Java"], ["backend", "后端"], ["frontend", "前端"], ["algorithm", "算法"], ["ai_cv", "AI / CV"], ["computer_vision", "计算机视觉"], ["ai_application", "AI 应用"], ["llm", "LLM"], ["motor_control", "电机控制"], ["control_algorithm", "控制算法"], ["robotics", "机器人"], ["ros", "ROS2"], ["fpga_ic", "FPGA / IC"], ["computer_architecture", "计算机体系结构"], ["verification", "验证"], ["devops", "DevOps"], ["project", "项目"]
];

const MODE_LABELS: Array<[TerminologyRolloutMode, string, string]> = [
  ["dynamic", "智能纠错", "会话词典 + 高置信度修正"],
  ["high_confidence", "高置信纠错", "仅高置信度修正"],
  ["shadow", "观察模式", "只记录候选，不改文字"],
  ["legacy", "兼容模式", "保留旧术语规则"]
];

export interface TerminologySettingsProps {
  profileId: string;
  mode: TerminologyRolloutMode;
  terms: TechnicalTerm[];
  directionSelection?: InterviewDirectionSelection;
  effectiveLexiconSize?: number;
  sourceCounts?: Record<string, number>;
  activeDomains?: string[];
  onDirectionSelectionChange?: (selection?: InterviewDirectionSelection) => void;
  onModeChange: (mode: TerminologyRolloutMode) => void;
  onAddTerm: (input: { profileId: string; canonical: string; aliases?: string[]; phoneticAliases?: string[]; domains?: TechnicalDomain[] }) => Promise<void>;
  onDeleteTerm: (canonical: string) => Promise<void>;
  onLearnCorrection: (raw: string, canonical: string) => Promise<void>;
  onTest: (text: string) => Promise<unknown>;
}

export function TerminologySettings(props: TerminologySettingsProps): JSX.Element {
  const [canonical, setCanonical] = useState("");
  const [aliases, setAliases] = useState("");
  const [domain, setDomain] = useState<TechnicalDomain>("common_cs");
  const [testText, setTestText] = useState("I two C 和 U A R T 有什么区别？");
  const [testResult, setTestResult] = useState<unknown>();
  const customTerms = props.terms.filter((term) => term.source === "user");
  const count = (source: string) => props.sourceCounts?.[source] ?? 0;
  const add = async () => {
    if (!canonical.trim()) return;
    await props.onAddTerm({ profileId: props.profileId, canonical: canonical.trim(), aliases: aliases.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean), domains: [domain] });
    setCanonical("");
    setAliases("");
  };
  return <div className="settings-content-stack" data-testid="settings-terminology-page">
    <section className="settings-section-card"><div className="settings-section-heading"><div><span className="page-kicker">INTERVIEW DIRECTIONS</span><h2>默认面试方向</h2><p>仅作为新面试的初始值；启动弹窗可以临时调整，方向最终只进入现有术语上下文。</p></div><span className="settings-section-meta">当前档案</span></div>{props.onDirectionSelectionChange ? <DirectionSelector value={props.directionSelection} onChange={props.onDirectionSelectionChange} /> : <p className="field-note">方向选择器尚未加载。</p>}</section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><span className="page-kicker">CORRECTION STRATEGY</span><h2>纠错策略</h2><p>保留旧内部枚举；这里仅展示更清晰的中文标签。</p></div><span className="settings-section-meta">{MODE_LABELS.find(([id]) => id === props.mode)?.[1]}</span></div><div className="terminology-mode-grid" role="group" aria-label="术语纠错策略">{MODE_LABELS.map(([id, label, description]) => <button className={props.mode === id ? "selected" : ""} key={id} onClick={() => props.onModeChange(id)}><strong>{label}</strong><small>{description}</small></button>)}</div><p className="field-note">建议先用观察模式验证召回、约束覆盖和延迟，再启用高置信纠错或智能纠错。</p></section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><h2>当前有效词典</h2><p>显示本轮有效词典的来源构成，不把空的用户词条误报为零词典。</p></div><span className="settings-section-meta">有效 {props.effectiveLexiconSize ?? props.terms.length} 项</span></div><div className="terminology-source-stats"><span>内置 <strong>{count("builtin")}</strong></span><span>Resume <strong>{count("resume")}</strong></span><span>JD <strong>{count("job")}</strong></span><span>项目 <strong>{count("project")}</strong></span><span>用户 <strong>{count("user")}</strong></span></div><div className="terminology-domain-list">{DOMAIN_LABELS.map(([id, label]) => <span className={props.activeDomains?.includes(id) || props.terms.some((term) => term.domains.includes(id)) ? "active" : ""} key={id}>{label}</span>)}</div></section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><h2>自定义术语</h2><p>仅保存用户主动添加或确认学习的词，不会自动把模糊候选写入数据库。</p></div><span className="settings-section-meta">用户词条 {customTerms.length}</span></div><div className="settings-form-grid"><label className="clean-field"><span>标准写法</span><input value={canonical} onChange={(event) => setCanonical(event.target.value)} placeholder="例如：CountDownLatch" /></label><label className="clean-field"><span>别名 / ASR 写法</span><input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="逗号分隔，例如 count down latch" /></label><label className="clean-field"><span>领域</span><select value={domain} onChange={(event) => setDomain(event.target.value as TechnicalDomain)}>{DOMAIN_LABELS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><div className="settings-form-actions"><button className="dark-pill" onClick={() => void add()}>添加术语</button></div></div>{customTerms.length > 0 && <div className="terminology-custom-list">{customTerms.map((term) => <div key={term.id}><span><strong>{term.canonical}</strong><small>{term.aliases.filter((alias) => alias !== term.canonical).join("、") || "无别名"}</small></span><button className="text-button danger-text" onClick={() => void props.onDeleteTerm(term.canonical)}>删除</button></div>)}</div>}</section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><h2>本地测试</h2><p>测试结果只来自本地确定性逻辑；观察模式不会改变原文。</p></div></div><div className="settings-form-grid"><label className="clean-field settings-field-wide"><span>输入一段 ASR 文本</span><textarea value={testText} onChange={(event) => setTestText(event.target.value)} rows={3} /></label><div className="settings-form-actions"><button className="outline-pill" onClick={() => void props.onTest(testText).then(setTestResult)}>运行测试</button></div></div>{testResult !== undefined && <pre className="terminology-test-result">{JSON.stringify(testResult, null, 2)}</pre>}</section>
  </div>;
}
