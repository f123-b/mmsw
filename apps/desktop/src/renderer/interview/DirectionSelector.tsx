import { useMemo, useState, type JSX } from "react";
import { INTERVIEW_DIRECTION_PRESETS, TECHNICAL_DOMAINS, type InterviewDirectionMode, type InterviewDirectionPreset, type InterviewDirectionSelection, type TechnicalDomain } from "@interview-copilot/shared";

const CATEGORY_LABELS: Record<string, string> = { general: "自动", software: "软件", hardware: "硬件", ai: "AI", custom: "自定义" };
const CUSTOM_DOMAIN_LABELS: Partial<Record<TechnicalDomain, string>> = {
  common_cs: "计算机基础", c_cpp: "C / C++", embedded: "嵌入式", linux: "Linux", network: "网络", database: "数据库", java: "Java", backend: "后端", frontend: "前端", algorithm: "算法", ai_cv: "AI / CV", fpga_ic: "FPGA / IC", devops: "DevOps", motor_control: "电机控制", control_algorithm: "控制算法", robotics: "机器人", ros: "ROS2", ai_application: "AI 应用", llm: "LLM", computer_vision: "计算机视觉", computer_architecture: "计算机体系结构", verification: "验证"
};

export interface DirectionSelectorProps {
  value?: InterviewDirectionSelection;
  onChange: (value?: InterviewDirectionSelection) => void;
  compact?: boolean;
}

function selectedIds(value?: InterviewDirectionSelection): string[] {
  return [...new Set([value?.primaryDirectionId, ...(value?.secondaryDirectionIds ?? []), ...(value?.selectedDirectionIds ?? [])].filter((id): id is string => Boolean(id)))];
}

function updateSelection(value: InterviewDirectionSelection | undefined, patch: Partial<InterviewDirectionSelection>): InterviewDirectionSelection {
  return { mode: value?.mode ?? "hybrid", ...value, ...patch };
}

export function DirectionSelector({ value, onChange, compact = false }: DirectionSelectorProps): JSX.Element {
  const [expanded, setExpanded] = useState(!compact);
  const [query, setQuery] = useState("");
  const mode: InterviewDirectionMode = value?.mode ?? "auto";
  const ids = selectedIds(value);
  const primary = value?.primaryDirectionId;
  const secondary = (value?.secondaryDirectionIds ?? []).filter((id) => id !== primary);
  const selectedPresets = ids.map((id) => INTERVIEW_DIRECTION_PRESETS.find((preset) => preset.id === id)).filter((preset): preset is InterviewDirectionPreset => Boolean(preset));
  const visiblePresets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return INTERVIEW_DIRECTION_PRESETS.filter((preset) => !normalized || `${preset.label} ${preset.description}`.toLocaleLowerCase().includes(normalized));
  }, [query]);

  const chooseMode = (next: InterviewDirectionMode) => {
    if (next === "auto") onChange({ mode: "auto", allowAutoSecondary: true });
    else onChange(updateSelection(value, { mode: next, allowAutoSecondary: next === "hybrid" }));
  };
  const toggle = (id: string) => {
    if (id === "auto") {
      onChange({ mode: "auto", allowAutoSecondary: true });
      return;
    }
    const current = selectedIds(value);
    if (current.includes(id)) {
      const next = current.filter((item) => item !== id);
      const nextPrimary = primary === id ? next[0] : primary;
      const nextSecondary = next.filter((item) => item !== nextPrimary);
      onChange(next.length ? updateSelection(value, { primaryDirectionId: nextPrimary, secondaryDirectionIds: nextSecondary, selectedDirectionIds: next, mode: mode === "auto" ? "hybrid" : mode }) : undefined);
      return;
    }
    const next = [...current, id];
    const nextPrimary = primary ?? id;
    onChange(updateSelection(value, { primaryDirectionId: nextPrimary, secondaryDirectionIds: next.filter((item) => item !== nextPrimary), selectedDirectionIds: next, mode: mode === "auto" ? "hybrid" : mode }));
  };
  const setPrimary = (id: string) => {
    const next = [...new Set([id, ...ids.filter((item) => item !== id)])];
    onChange(updateSelection(value, { primaryDirectionId: id, secondaryDirectionIds: next.slice(1), selectedDirectionIds: next, mode: mode === "auto" ? "hybrid" : mode }));
  };
  const customDomains = value?.customDomains ?? [];
  const toggleCustomDomain = (domain: TechnicalDomain) => {
    const next = customDomains.includes(domain) ? customDomains.filter((item) => item !== domain) : [...customDomains, domain];
    onChange(updateSelection(value, { customDomains: next }));
  };

  return <div className={`direction-selector ${compact ? "direction-selector-compact" : ""}`}>
    <div className="direction-selector-heading"><div><strong>面试方向</strong><small>主要方向优先，辅助方向用于补充；混合模式会保留自动识别。</small></div><button className="text-button" onClick={() => setExpanded((current) => !current)}>{expanded ? "收起" : "选择方向"}</button></div>
    <div className="direction-mode-grid" role="group" aria-label="方向识别模式">
      <button className={mode === "auto" ? "selected" : ""} onClick={() => chooseMode("auto")}><strong>自动</strong><small>兼容当前路由</small></button>
      <button className={mode === "hybrid" ? "selected" : ""} onClick={() => chooseMode("hybrid")}><strong>混合</strong><small>方向 + 自动补充</small></button>
      <button className={mode === "manual" ? "selected" : ""} onClick={() => chooseMode("manual")}><strong>手动</strong><small>只按选择的方向</small></button>
    </div>
    {selectedPresets.length > 0 && <div className="direction-selected-list">{selectedPresets.map((preset) => <button className={`direction-chip ${preset.id === primary ? "primary" : ""}`} key={preset.id} onClick={() => setPrimary(preset.id)} title={preset.id === primary ? "主要方向" : "点击设为主要方向"}><span>{preset.id === primary ? "★" : "＋"}</span>{preset.label}<i onClick={(event) => { event.stopPropagation(); toggle(preset.id); }}>×</i></button>)}</div>}
    {mode === "auto" && selectedPresets.length === 0 && <div className="direction-auto-note">未指定方向，按现有 DomainRouter 自动识别。</div>}
    {expanded && <div className="direction-picker-panel"><input className="inline-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索方向…" aria-label="搜索面试方向" /><div className="direction-preset-grid">{visiblePresets.filter((preset) => preset.id !== "auto").map((preset) => <button className={ids.includes(preset.id) ? "selected" : ""} key={preset.id} onClick={() => toggle(preset.id)}><span>{CATEGORY_LABELS[preset.category] ?? preset.category}</span><strong>{preset.label}</strong><small>{preset.description}</small></button>)}</div>{ids.includes("custom") && <div className="custom-domain-picker"><strong>自定义技术领域</strong><div>{TECHNICAL_DOMAINS.filter((domain) => CUSTOM_DOMAIN_LABELS[domain]).map((domain) => <label key={domain}><input type="checkbox" checked={customDomains.includes(domain)} onChange={() => toggleCustomDomain(domain)} /><span>{CUSTOM_DOMAIN_LABELS[domain]}</span></label>)}</div></div>}<label className="direction-auto-secondary"><input type="checkbox" checked={value?.allowAutoSecondary ?? mode === "hybrid"} onChange={(event) => onChange(updateSelection(value, { allowAutoSecondary: event.target.checked }))} /><span>允许自动补充 JD / 简历 / 项目方向</span></label></div>}
    {secondary.length > 0 && <small className="direction-selection-note">主要：{INTERVIEW_DIRECTION_PRESETS.find((preset) => preset.id === primary)?.label ?? "未指定"} · 辅助：{secondary.map((id) => INTERVIEW_DIRECTION_PRESETS.find((preset) => preset.id === id)?.label ?? id).join("、")}</small>}
  </div>;
}
