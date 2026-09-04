import { useEffect, useMemo, useState, type ChangeEvent, type JSX } from "react";
import type { Profile } from "@interview-copilot/shared";
import type { ProfileSelfIntroductionRecord } from "../../main/database";
import "./self-introduction.css";

interface SelfIntroductionPanelProps {
  profile: Profile;
  record?: ProfileSelfIntroductionRecord;
  onSave: (text: string, targetDurationSeconds: number, language: string) => void;
  onUpload: (file: File) => void;
  onGenerate: (targetDurationSeconds: number, language: string) => void;
  onApprove: () => void;
  onContinueUsing: () => void;
}

export function SelfIntroductionPanel(props: SelfIntroductionPanelProps): JSX.Element {
  const [text, setText] = useState(props.record?.text ?? "");
  const [duration, setDuration] = useState(props.record?.targetDurationSeconds ?? 50);
  const [language, setLanguage] = useState(props.record?.language ?? (props.profile.language === "en-US" ? "en-US" : "zh-CN"));
  useEffect(() => {
    setText(props.record?.text ?? "");
    setDuration(props.record?.targetDurationSeconds ?? 50);
    setLanguage(props.record?.language ?? (props.profile.language === "en-US" ? "en-US" : "zh-CN"));
  }, [props.record?.id, props.record?.updatedAt, props.profile.language]);
  const estimatedSeconds = useMemo(() => language === "en-US" ? Math.round(text.trim().split(/\s+/).filter(Boolean).length / 2.2) : Math.round(text.trim().length / 5), [language, text]);
  const usable = Boolean(props.record?.text.trim() && (props.record.source !== "ai_generated" || props.record.approved));
  const dirty = text !== (props.record?.text ?? "") || duration !== (props.record?.targetDurationSeconds ?? 50) || language !== (props.record?.language ?? "zh-CN");
  const upload = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) props.onUpload(file); event.target.value = ""; };
  return <section className="profile-subsection self-introduction-panel">
    <div className="profile-builder-heading"><div><span className="page-kicker">SELF INTRODUCTION</span><h3>自我介绍</h3><p className="page-note">填写或上传后保存，面试中优先原文展示，不会自动改写。留空并保存时，才根据简历生成。仅用于自我介绍，不会套用到技术或项目问题。</p></div><span className="profile-builder-status">{dirty ? "有未保存的修改" : usable ? "原稿优先 · 已生效" : props.record?.text.trim() ? "AI 草稿 · 尚未选用" : "未设置 · 使用模型生成"}</span></div>
    {props.record?.status === "stale" && <div className="profile-builder-warning">简历已更新；已保存的原稿仍会优先使用。请检查学校、经历等内容是否需要同步修改。</div>}
    <div className="detail-actions"><label className="clean-field"><span>参考时长</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={45}>45 秒</option><option value={50}>50 秒</option><option value={60}>60 秒</option></select></label><label className="clean-field"><span>语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-CN">中文</option><option value="en-US">English</option></select></label><button className="dark-pill" onClick={() => props.onSave(text, duration, language)}>{text.trim() ? "保存并使用" : "保存为空 · 使用模型生成"}</button><button className="outline-pill" onClick={() => { if (!text.trim() || window.confirm("生成的新草稿会替换当前编辑内容，是否继续？")) props.onGenerate(duration, language); }}>AI 生成草稿</button><label className="outline-pill upload-project-action">上传稿件<input type="file" accept=".txt,.md,.docx,.pdf" onChange={upload} /></label></div>
    <textarea className="self-introduction-editor" value={text} onChange={(event) => setText(event.target.value)} placeholder="输入或上传一段可直接口述的自我介绍…" rows={10} />
    <div className="detail-metrics"><span>字数<strong>{text.trim().length}</strong></span><span>估算时长<strong>{estimatedSeconds} 秒</strong></span><span>来源<strong>{props.record?.source === "ai_generated" ? "AI 草稿" : props.record?.source === "uploaded" ? "上传" : "手动"}</strong></span><span>状态<strong>{dirty ? "未保存" : usable ? "已生效" : "未设置原稿"}</strong></span></div>
    <p className="page-note">修改后请点“保存并使用”。AI 草稿也需检查后保存，才会成为面试原稿。</p>
  </section>;
}
