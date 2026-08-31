import { useState, type ChangeEvent, type JSX } from "react";
import type { Profile, SkillSuggestion, SkillSuggestionStatus } from "@interview-copilot/shared";
import type { ProfileBuilderArtifactRecord } from "../../main/database";
import type { ProfileSelfIntroductionRecord, ResumeAnalysisRecord, ResumeProjectLinkRecord, ProjectRecord } from "../../main/database";
import { ProfileAnalysisPanel } from "./ProfileAnalysisPanel";
import { ResumeAnalysisPanel } from "./ResumeAnalysisPanel";
import { SelfIntroductionPanel } from "./SelfIntroductionPanel";

type MaterialKind = "resume" | "jobDescription";

interface ProfileWorkspacePageProps {
  profiles: Profile[];
  profileId: string;
  selectedProfile?: Profile;
  knowledgeBases: Array<{ id: string; name: string }>;
  artifact?: ProfileBuilderArtifactRecord;
  resumeAnalysis?: ResumeAnalysisRecord;
  suggestions: SkillSuggestion[];
  analysisRunning: boolean;
  resumeAnalysisRunning: boolean;
  onSelectProfile: (id: string) => void;
  onCreateProfile: () => void;
  onAttachMaterial: (kind: MaterialKind, event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveMaterial: (kind: MaterialKind) => void;
  onEditInstructions: () => void;
  onEditCompanyContext: () => void;
  onEditSalaryExpectation: () => void;
  onAddSkill: () => void;
  onEditSkill: (id: string) => void;
  onDeleteSkill: (id: string) => void;
  onCloneProfile: () => void;
  onRenameProfile: () => void;
  onDeleteProfile: () => void;
  onToggleKnowledgeBase: (id: string, linked: boolean) => void;
  onReviewSuggestion: (id: string, status: SkillSuggestionStatus) => void;
  onRebuildAnalysis: () => void;
  onAnalyzeResume: () => void;
  onUpdateExpression: (patch: Partial<Pick<Profile, "expressionLevel" | "explainAdvancedTerms">>) => void;
  projects: ProjectRecord[];
  resumeProjectLinks: ResumeProjectLinkRecord[];
  selfIntroduction?: ProfileSelfIntroductionRecord;
  onSaveResumeProjectLink: (resumeProjectId: string, projectId: string) => void;
  onCreateProjectForResume: (resumeProjectId: string, name: string) => void;
  onSaveSelfIntroduction: (text: string, targetDurationSeconds: number, language: string) => void;
  onUploadSelfIntroduction: (file: File) => void;
  onGenerateSelfIntroduction: (targetDurationSeconds: number, language: string) => void;
  onApproveSelfIntroduction: () => void;
  onContinueUsingSelfIntroduction: () => void;
}

function materialStatus(material: Profile["resume"]): string {
  if (!material) return "未上传";
  const parse = material.parseStatus === "failed" ? "解析失败" : material.parseStatus === "pending" ? "解析中" : "已解析";
  const analysis = material.analysisStatus === "stale" ? "分析已过期" : material.analysisStatus === "completed" ? "已分析" : material.analysisStatus === "in_progress" ? "分析中" : "待分析";
  return `${parse} · ${analysis}`;
}

function materialCard(label: string, material: Profile["resume"], kind: MaterialKind, onAttach: ProfileWorkspacePageProps["onAttachMaterial"], onRemove: ProfileWorkspacePageProps["onRemoveMaterial"]): JSX.Element {
  return <article className="profile-material-card"><div className="profile-material-heading"><strong>{label}</strong><span>{materialStatus(material)}</span></div>{material ? <><div className="profile-material-meta"><strong>{material.filename ?? `历史${label}`}</strong><small>{material.mimeType ?? "文本资料"} · {material.uploadedAt ? new Date(material.uploadedAt).toLocaleDateString("zh-CN") : "历史资料"}</small><small>原文 {material.rawContent.length.toLocaleString()} 字 · 解析摘要仅供预览</small></div><details><summary>查看原文</summary><pre>{material.rawContent}</pre></details><button className="text-button danger-text" onClick={() => onRemove(kind)}>移除资料</button></> : <p className="page-note">还没有{label}。上传后会保留原文，并等待你手动开始 AI 分析。</p>}<label className="upload-row">{material ? "替换文件" : `上传${label}`}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => onAttach(kind, event)} /></label></article>;
}

export function ProfileWorkspacePage(props: ProfileWorkspacePageProps): JSX.Element {
  const [tab, setTab] = useState<"resume" | "skills" | "target" | "interview" | "introduction">("resume");
  const selected = props.selectedProfile;
  return <section className="simple-page profile-workspace-page">
    <div className="page-heading"><div><span className="page-kicker">INTERVIEW PROFILES</span><h1>面试档案</h1><p className="page-note">候选人证据、岗位目标和面试表达设置分开管理，AI 只通过审核后的内容进入正式档案。</p></div><button className="dark-pill" onClick={props.onCreateProfile}>新建档案</button></div>
    <div className="profile-layout"><div className="clean-list profile-list">{props.profiles.map((profile) => <button className={`clean-list-row ${profile.id === props.profileId ? "selected" : ""}`} key={profile.id} onClick={() => props.onSelectProfile(profile.id)}><span>{profile.name}</span><small>{profile.language} · {profile.skills.length} 项正式技能</small></button>)}{props.profiles.length === 0 && <div className="knowledge-empty"><strong>还没有面试档案</strong><span>新建一个档案开始准备。</span></div>}</div>{selected ? <div className="detail-sheet profile-workspace-detail"><div className="profile-detail-heading"><div><span className="page-kicker">CANDIDATE PROFILE</span><h2>{selected.name}</h2><p className="page-note">{selected.language} · 最近更新 {new Date(selected.updatedAt).toLocaleString("zh-CN")}</p></div><div className="detail-actions"><button className="text-button" onClick={props.onCloneProfile}>复制</button><button className="text-button" onClick={props.onRenameProfile}>重命名</button><button className="text-button danger-text" onClick={props.onDeleteProfile}>删除</button></div></div>
      <nav className="profile-tabs" aria-label="档案分区">{([["resume", "简历资料"], ["introduction", "自我介绍"], ["skills", "技能与证据"], ["target", "岗位目标"], ["interview", "面试配置"]] as const).map(([value, label]) => <button className={tab === value ? "active" : ""} key={value} onClick={() => setTab(value)}>{label}</button>)}</nav>
      {tab === "resume" && <div className="profile-tab-content"><div className="profile-material-grid">{materialCard("简历", selected.resume, "resume", props.onAttachMaterial, props.onRemoveMaterial)}{materialCard("岗位 JD", selected.jobDescription, "jobDescription", props.onAttachMaterial, props.onRemoveMaterial)}</div><ResumeAnalysisPanel material={selected.resume} analysis={props.resumeAnalysis} running={props.resumeAnalysisRunning} onAnalyze={props.onAnalyzeResume} projects={props.projects} links={props.resumeProjectLinks} onSaveLink={props.onSaveResumeProjectLink} onCreateProject={props.onCreateProjectForResume} /><ProfileAnalysisPanel artifact={props.artifact} suggestions={props.suggestions} running={props.analysisRunning} canBuildProfile={!selected.resume || props.resumeAnalysis?.status === "current"} onRebuild={props.onRebuildAnalysis} onReviewSuggestion={props.onReviewSuggestion} /></div>}
      {tab === "introduction" && <div className="profile-tab-content"><SelfIntroductionPanel profile={selected} record={props.selfIntroduction} onSave={props.onSaveSelfIntroduction} onUpload={props.onUploadSelfIntroduction} onGenerate={props.onGenerateSelfIntroduction} onApprove={props.onApproveSelfIntroduction} onContinueUsing={props.onContinueUsingSelfIntroduction} /></div>}
      {tab === "skills" && <div className="profile-tab-content"><div className="profile-section-heading"><div><h3>正式技能</h3><p className="page-note">只有手动新增或确认后的技能会进入正式档案。</p></div><button className="outline-pill" onClick={props.onAddSkill}>新增技能</button></div>{selected.skills.length === 0 && <p className="page-note">尚未添加正式技能</p>}{selected.skills.map((skill) => <div className="skill-row" key={skill.id}><span><strong>{skill.name}</strong><small>{skill.source ? `来源：${skill.source}` : "手动维护"}{skill.evidenceRefs?.length ? ` · 证据 ${skill.evidenceRefs.length} 条` : ""}</small><small>{skill.content.slice(0, 120)}</small></span><span><button className="text-button" onClick={() => props.onEditSkill(skill.id)}>编辑</button><button className="text-button danger-text" onClick={() => props.onDeleteSkill(skill.id)}>删除</button></span></div>)}<div className="profile-section-heading"><div><h3>审核历史</h3><p className="page-note">AI 建议保留审核状态和证据，不会因重新分析而复活已拒绝项。</p></div></div>{props.suggestions.map((suggestion) => <article className="profile-suggestion-card" key={suggestion.id}><div className="profile-suggestion-heading"><strong>{suggestion.name}</strong><span>{suggestion.status === "confirmed" ? "已确认" : suggestion.status === "rejected" ? "已拒绝" : "待审核"}</span></div><p>{suggestion.description || "未提供描述"}</p><small>证据：{suggestion.evidenceQuotes.join("；") || "暂无"}</small>{suggestion.status !== "pending" && <button className="text-button" onClick={() => props.onReviewSuggestion(suggestion.id, "pending")}>恢复待审核</button>}</article>)}</div>}
      {tab === "target" && <div className="profile-tab-content"><div className="profile-section-heading"><div><h3>目标岗位上下文</h3><p className="page-note">岗位要求用于匹配和准备，不会被当作候选人经历或技能。</p></div><label className="outline-pill upload-project-action">上传 JD<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => props.onAttachMaterial("jobDescription", event)} /></label></div>{selected.jobDescription ? <div className="profile-target-summary"><strong>{selected.jobDescription.filename ?? "历史岗位 JD"}</strong><span>{materialStatus(selected.jobDescription)}</span><p>原文已保存。岗位要求会同步到岗位目标库，并在分析时作为独立上下文参与匹配。</p><details><summary>查看岗位原文</summary><pre>{selected.jobDescription.rawContent}</pre></details></div> : <p className="page-note">尚未上传岗位 JD。请在“简历资料”页上传。</p>}</div>}
      {tab === "interview" && <div className="profile-tab-content"><div className="profile-section-heading"><div><h3>回答表达</h3><p className="page-note">只影响表达难度，不改变事实和技术结论。</p></div></div><label className="clean-field"><span>表达级别</span><select value={selected.expressionLevel ?? "plain"} onChange={(event) => props.onUpdateExpression({ expressionLevel: event.target.value as Profile["expressionLevel"] })}><option value="plain">易懂 · 推荐</option><option value="standard">标准 · 常见技术表达</option><option value="expert">专家 · 保留行业术语</option></select></label><label className="check-row"><input type="checkbox" checked={selected.explainAdvancedTerms ?? true} onChange={(event) => props.onUpdateExpression({ explainAdvancedTerms: event.target.checked })} />首次出现较难术语时附一句通俗解释</label><div className="detail-actions"><button className="outline-pill" onClick={props.onEditInstructions}>回答偏好</button><button className="outline-pill" onClick={props.onEditCompanyContext}>公司与业务资料</button><button className="outline-pill" onClick={props.onEditSalaryExpectation}>薪资期望</button></div><div className="profile-subsection"><h3>关联资料库</h3>{props.knowledgeBases.map((base) => <label className="check-row" key={base.id}><input type="checkbox" checked={selected.knowledgeBaseIds.includes(base.id)} onChange={() => props.onToggleKnowledgeBase(base.id, selected.knowledgeBaseIds.includes(base.id))} />{base.name}</label>)}</div></div>}
    </div> : <div className="detail-sheet history-empty-detail"><strong>选择一个面试档案</strong><span>候选人资料和岗位目标会显示在这里。</span></div>}</div>
  </section>;
}
