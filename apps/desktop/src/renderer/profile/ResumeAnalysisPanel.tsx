import type { Profile } from "@interview-copilot/shared";
import type { JSX } from "react";
import type { ProjectRecord, ResumeAnalysisRecord, ResumeProjectLinkRecord } from "../../main/database";

interface ResumeAnalysisPanelProps {
  material?: Profile["resume"];
  analysis?: ResumeAnalysisRecord;
  running: boolean;
  onAnalyze: () => void;
  projects: ProjectRecord[];
  links: ResumeProjectLinkRecord[];
  onSaveLink: (resumeProjectId: string, projectId: string, confirmed?: boolean) => void;
  onCreateProject: (resumeProjectId: string, name: string) => void;
}

function suggestedProject(project: { name: string }, projects: ProjectRecord[]): { item: ProjectRecord; score: number } | undefined {
  const name = project.name.toLocaleLowerCase();
  return projects.map((item) => ({ item, score: item.name.toLocaleLowerCase().includes(name) || name.includes(item.name.toLocaleLowerCase()) ? 0.88 : 0 }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.item.name.localeCompare(right.item.name))[0];
}

export function ResumeAnalysisPanel({ material, analysis, running, onAnalyze, projects, links, onSaveLink, onCreateProject }: ResumeAnalysisPanelProps): JSX.Element {
  const current = analysis?.status === "current" ? analysis.artifact : undefined;
  return <section className="profile-subsection resume-analysis-panel">
    <div className="profile-builder-heading"><div><span className="page-kicker">RESUME PARSING</span><h3>Resume 解析</h3><p className="page-note">只读取当前上传的 Resume 原文；不会把 JD、知识库、项目库或面试记录混入简历事实。</p></div><span className="profile-builder-status">{running ? "解析中…" : current ? "当前版本已解析" : analysis?.status === "stale" ? "简历已更新 · 旧结果未启用" : "待解析"}</span></div>
    <div className="detail-actions"><button className="outline-pill" disabled={!material || running} onClick={onAnalyze}>{running ? "解析中…" : current ? "重新解析这份简历" : "解析这份简历"}</button>{material && <span className="page-note">{current ? `项目 ${current.projects.length} · 技能 ${current.skills.length} · 教育 ${current.education.length}` : "解析完成后才会允许生成 AI 面试画像"}</span>}</div>
    {!material && <p className="page-note">请先上传 Resume。</p>}
    {analysis?.status === "stale" && <p className="page-note profile-builder-warning">检测到旧 hash 或旧 analyzer version；旧结果仅保留在本地，不会显示为当前事实。</p>}
    {current && <div className="resume-analysis-summary">
      <div className="detail-metrics"><span>教育<strong>{current.education.length}</strong></span><span>工作/实习<strong>{current.workExperience.length + current.internships.length}</strong></span><span>项目<strong>{current.projects.length}</strong></span><span>技能<strong>{current.skills.length}</strong></span></div>
      <div className="resume-analysis-projects">{current.projects.map((project) => {
        const link = links.find((item) => item.resumeProjectId === project.id);
        const suggestion = !link ? suggestedProject(project, projects) : undefined;
        return <article className="profile-project-card" key={project.id}>
          <div className="profile-project-heading"><strong>{project.name}</strong><span>{link?.confirmed ? "已确认关联" : link ? `建议关联 · ${Math.round(link.confidence * 100)}%` : suggestion ? `推荐关联 · ${Math.round(suggestion.score * 100)}%` : "未关联"}</span></div>
          <p>{project.description || "项目描述待补充"}</p><small>证据：{project.evidence.rawExcerpt}</small>
          <div className="detail-actions"><select value={link?.projectId ?? ""} onChange={(event) => { if (event.target.value) onSaveLink(project.id, event.target.value, true); }}><option value="">选择已有项目</option>{projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select>{link && !link.confirmed ? <button className="text-button" onClick={() => onSaveLink(project.id, link.projectId, true)}>确认关联</button> : suggestion ? <button className="text-button" onClick={() => onSaveLink(project.id, suggestion.item.id, false)}>保存推荐</button> : null}<button className="text-button" onClick={() => onCreateProject(project.id, project.name)}>新建并关联</button></div>
        </article>;
      })}{current.projects.length === 0 && <p className="page-note">当前 Resume 未找到满足严格标题条件的项目。</p>}</div>
      {current.warnings.map((warning) => <small className="page-note" key={warning}>{warning}</small>)}
    </div>}
  </section>;
}
