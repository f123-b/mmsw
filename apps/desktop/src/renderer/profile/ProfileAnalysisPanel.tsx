import type { SkillSuggestion, SkillSuggestionStatus } from "@interview-copilot/shared";
import type { JSX } from "react";
import type { ProfileBuilderArtifactRecord } from "../../main/database";

interface ProfileAnalysisPanelProps {
  artifact?: ProfileBuilderArtifactRecord;
  suggestions: SkillSuggestion[];
  running: boolean;
  resumeAnalysisRunning: boolean;
  onRebuild: () => void;
  onAnalyzeResume: () => void;
  onReviewSuggestion: (id: string, status: SkillSuggestionStatus) => void;
}

function statusLabel(artifact: ProfileBuilderArtifactRecord | undefined, running: boolean): string {
  if (running) return "分析中…";
  if (artifact?.status === "stale") return "资料已更新 · 需要重新分析";
  if (artifact?.status === "error") return "分析失败 · 保留上次结果";
  if (artifact?.artifact?.status === "partial") return "部分完成";
  if (artifact?.artifact) return "分析完成";
  return "待分析";
}

export function ProfileAnalysisPanel({ artifact, suggestions, running, resumeAnalysisRunning, onRebuild, onAnalyzeResume, onReviewSuggestion }: ProfileAnalysisPanelProps): JSX.Element {
  const output = artifact?.artifact;
  const pending = suggestions.filter((suggestion) => suggestion.status === "pending");
  return <section className="profile-subsection profile-builder-panel">
    <div className="profile-builder-heading"><div><span className="page-kicker">AI PROFILE ANALYSIS</span><h3>AI 结构化分析</h3><p className="page-note">只把可回溯到候选人资料的内容纳入建议；岗位要求仅作为目标上下文。</p></div><span className="profile-builder-status">{statusLabel(artifact, running)}</span></div>
    <div className="detail-actions"><button className="outline-pill" disabled={running} onClick={onRebuild}>{running ? "分析中…" : artifact?.status === "stale" ? "重新分析" : "开始分析"}</button><button className="outline-pill" disabled={resumeAnalysisRunning} onClick={onAnalyzeResume}>{resumeAnalysisRunning ? "简历解析中…" : "解析简历项目"}</button><span className="page-note">{output ? `技能 ${output.skillGraph.nodes.length} · 项目 ${output.projectGraph.nodes.length} · 回答素材 ${output.answerMaterials.length} · FAQ ${output.faqs.length}` : "先解析简历项目，再生成个人档案；岗位要求只作为独立上下文"}</span></div>
    {artifact?.error && <small className="page-note profile-builder-error">本次分析失败：{artifact.error}；上次结果仍可查看。</small>}
    {output?.warnings.map((warning) => <small className="page-note" key={warning}>{warning}</small>)}
    <div className="profile-builder-grid">
      <div className="profile-builder-card"><h4>技能建议 · 待审核 {pending.length}</h4>{pending.length === 0 && <p className="page-note">暂无待审核技能。分析结果不会自动写入正式技能。</p>}{pending.map((suggestion) => <article className="profile-suggestion-card" key={suggestion.id}><div className="profile-suggestion-heading"><strong>{suggestion.name}</strong><span>{Math.round(suggestion.confidence * 100)}% 可信度</span></div><p>{suggestion.description || "未提供描述"}</p><small>来源：{suggestion.sourceKinds.join("、") || "未标注"}</small><details><summary>查看证据</summary><ul>{suggestion.evidenceQuotes.map((quote, index) => <li key={`${suggestion.id}-evidence-${index}`}>{quote}</li>)}</ul></details><div className="detail-actions"><button className="text-button" onClick={() => onReviewSuggestion(suggestion.id, "confirmed")}>确认加入技能</button><button className="text-button danger-text" onClick={() => onReviewSuggestion(suggestion.id, "rejected")}>拒绝</button></div></article>)}</div>
      <div className="profile-builder-card"><h4>项目经历</h4>{output?.projectGraph.nodes.map((project) => <article className="profile-project-card" key={project.id}><strong>{project.name}</strong><p>{project.summary}</p>{project.skills.length > 0 && <small>{project.skills.join(" · ")}</small>}</article>)}{(!output || output.projectGraph.nodes.length === 0) && <p className="page-note">暂未识别到项目</p>}</div>
    </div>
    {suggestions.some((suggestion) => suggestion.status !== "pending") && <details className="profile-reviewed-suggestions"><summary>已审核建议（{suggestions.filter((suggestion) => suggestion.status !== "pending").length}）</summary>{suggestions.filter((suggestion) => suggestion.status !== "pending").map((suggestion) => <div className="profile-suggestion-reviewed" key={suggestion.id}><span><strong>{suggestion.name}</strong><small>{suggestion.status === "confirmed" ? "已确认" : "已拒绝"}</small></span><button className="text-button" onClick={() => onReviewSuggestion(suggestion.id, "pending")}>恢复待审核</button></div>)}</details>}
  </section>;
}
