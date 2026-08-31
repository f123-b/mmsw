import { useState, type JSX } from "react";
import type { TechnicalDomain, TechnicalTerm, TerminologyRolloutMode } from "@interview-copilot/shared";

const DOMAIN_LABELS: Array<[TechnicalDomain, string]> = [["common_cs", "计算机基础"], ["c_cpp", "C / C++"], ["embedded", "嵌入式"], ["linux", "Linux"], ["network", "网络"], ["database", "数据库"], ["java", "Java"], ["backend", "后端"], ["frontend", "前端"], ["algorithm", "算法"], ["ai_cv", "AI / CV"], ["fpga_ic", "FPGA / IC"], ["devops", "DevOps"], ["project", "项目"]];

export interface TerminologySettingsProps {
  profileId: string;
  mode: TerminologyRolloutMode;
  terms: TechnicalTerm[];
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
  const add = async () => {
    if (!canonical.trim()) return;
    await props.onAddTerm({ profileId: props.profileId, canonical: canonical.trim(), aliases: aliases.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean), domains: [domain] });
    setCanonical("");
    setAliases("");
  };
  return <div className="settings-content-stack" data-testid="settings-terminology-page">
    <section className="settings-section-card"><div className="settings-section-heading"><div><span className="page-kicker">LOCAL TERMINOLOGY</span><h2>技术术语</h2><p>兼容旧术语规则；新词典只在本地候选和高置信度范围内参与识别，不增加远程请求。</p></div><span className="settings-section-meta">当前词典 {props.terms.length} 项</span></div>
      <div className="terminology-mode-grid" role="group" aria-label="术语 rollout 模式">
        <button className={props.mode === "dynamic" ? "selected" : ""} onClick={() => props.onModeChange("dynamic")}><strong>自动</strong><small>会话词典 + 高置信度修正</small></button>
        <button className={props.mode === "high_confidence" ? "selected" : ""} onClick={() => props.onModeChange("high_confidence")}><strong>保守</strong><small>仅高置信度修正</small></button>
        <button className={props.mode === "shadow" ? "selected" : ""} onClick={() => props.onModeChange("shadow")}><strong>Shadow</strong><small>只记录候选，不改文字</small></button>
        <button className={props.mode === "legacy" ? "selected" : ""} onClick={() => props.onModeChange("legacy")}><strong>关闭</strong><small>仅使用兼容旧逻辑</small></button>
      </div>
      <p className="field-note">推荐先用 Shadow 验证召回、约束覆盖和延迟，再启用保守或自动。</p>
    </section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><h2>会话领域</h2><p>领域路由来自当前档案、岗位和项目文本。</p></div></div><div className="terminology-domain-list">{DOMAIN_LABELS.map(([id, label]) => <span className={props.terms.some((term) => term.domains.includes(id)) ? "active" : ""} key={id}>{label}</span>)}</div></section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><h2>自定义术语</h2><p>仅保存用户主动添加或确认学习的词，不会自动把模糊候选写入数据库。</p></div></div><div className="settings-form-grid"><label className="clean-field"><span>标准写法</span><input value={canonical} onChange={(event) => setCanonical(event.target.value)} placeholder="例如：CountDownLatch" /></label><label className="clean-field"><span>别名 / ASR 写法</span><input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="逗号分隔，例如 count down latch" /></label><label className="clean-field"><span>领域</span><select value={domain} onChange={(event) => setDomain(event.target.value as TechnicalDomain)}>{DOMAIN_LABELS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><div className="settings-form-actions"><button className="dark-pill" onClick={() => void add()}>添加术语</button></div></div>{customTerms.length > 0 && <div className="terminology-custom-list">{customTerms.map((term) => <div key={term.id}><span><strong>{term.canonical}</strong><small>{term.aliases.filter((alias) => alias !== term.canonical).join("、") || "无别名"}</small></span><button className="text-button danger-text" onClick={() => void props.onDeleteTerm(term.canonical)}>删除</button></div>)}</div>}</section>
    <section className="settings-section-card"><div className="settings-section-heading"><div><h2>本地测试</h2><p>测试结果只来自本地确定性逻辑；Shadow 模式不会改变原文。</p></div></div><div className="settings-form-grid"><label className="clean-field settings-field-wide"><span>输入一段 ASR 文本</span><textarea value={testText} onChange={(event) => setTestText(event.target.value)} rows={3} /></label><div className="settings-form-actions"><button className="outline-pill" onClick={() => void props.onTest(testText).then(setTestResult)}>运行测试</button></div></div>{testResult !== undefined && <pre className="terminology-test-result">{JSON.stringify(testResult, null, 2)}</pre>}</section>
  </div>;
}

