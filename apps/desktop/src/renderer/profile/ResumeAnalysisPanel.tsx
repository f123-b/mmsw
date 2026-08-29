import type { Profile } from "@interview-copilot/shared";
import type { JSX } from "react";
import type { ResumeAnalysisRecord } from "../../main/database";

interface ResumeAnalysisPanelProps {
  material?: Profile["resume"];
  analysis?: ResumeAnalysisRecord;
  running: boolean;
  onAnalyze: () => void;
}

export function ResumeAnalysisPanel({ material, analysis, running, onAnalyze }: ResumeAnalysisPanelProps): JSX.Element {
  const current = analysis?.status === "current" ? analysis.artifact : undefined;
  return <section className="profile-subsection resume-analysis-panel">
    <div className="profile-builder-heading"><div><span className="page-kicker">RESUME PARSING</span><h3>Resume 解析</h3><p className="page-note">只读取当前上传的 Resume 原文；不会把 JD、知识库、项目库或面试记录混入简历事实。</p></div><span className="profile-builder-status">{running ? "解析中…" : current ? "当前版本已解析" : analysis?.status === "stale" ? "简历已更新 · 旧结果未启用" : "待解析"}</span></div>
    <div className="detail-actions"><button className="outline-pill" disabled={!material || running} onClick={onAnalyze}>{running ? "解析中…" : current ? "重新解析这份简历" : "解析这份简历"}</button>{material && <span className="page-note">{current ? `项目 ${current.projects.length} · 技能 ${current.skills.length} · 教育 ${current.education.length}` : "解析完成后才会允许生成 AI 面试画像"}</span>}</div>
    {!material && <p className="page-note">请先上传 Resume。</p>}
    {analysis?.status === "stale" && <p className="page-note profile-builder-warning">检测到旧 hash 或旧 analyzer version；旧结果仅保留在本地，不会显示为当前事实。</p>}
    {current && <div className="resume-analysis-summary"><div className="detail-metrics"><span>教育<strong>{current.education.length}</strong></span><span>工作/实习<strong>{current.workExperience.length + current.internships.length}</strong></span><span>项目<strong>{current.projects.length}</strong></span><span>技能<strong>{current.skills.length}</strong></span></div><div className="resume-analysis-projects">{current.projects.map((project) => <article className="profile-project-card" key={project.id}><strong>{project.name}</strong><p>{project.description || "项目描述待补充"}</p><small>证据：{project.evidence.rawExcerpt}</small></article>)}{current.projects.length === 0 && <p className="page-note">当前 Resume 未找到满足严格标题条件的项目。</p>}</div>{current.warnings.map((warning) => <small className="page-note" key={warning}>{warning}</small>)}</div>}
  </section>;
}
