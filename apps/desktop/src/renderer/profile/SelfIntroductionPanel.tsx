import { useEffect, useMemo, useState, type ChangeEvent, type JSX } from "react";
import type { Profile } from "@interview-copilot/shared";
import type { ProfileSelfIntroductionRecord } from "../../main/database";

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
  const upload = (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) props.onUpload(file); event.target.value = ""; };
  return <section className="profile-subsection self-introduction-panel">
    <div className="profile-builder-heading"><div><span className="page-kicker">SELF INTRODUCTION</span><h3>自我介绍</h3><p className="page-note">只在识别到“请做个自我介绍”时走直接快车道；项目、技术和职责问题不会误用这段内容。</p></div><span className="profile-builder-status">{props.record?.status === "stale" ? "简历已更新 · 待确认" : props.record?.approved ? "已审核，可直接使用" : props.record ? "草稿 · 待审核" : "未建立"}</span></div>
    {props.record?.status === "stale" && <div className="profile-builder-warning">当前内容来自旧 Resume hash。可继续使用旧稿，或重新生成后再审核。</div>}
    <div className="detail-actions"><label className="clean-field"><span>时长</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={45}>45 秒</option><option value={50}>50 秒</option><option value={60}>60 秒</option></select></label><label className="clean-field"><span>语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-CN">中文</option><option value="en-US">English</option></select></label><button className="outline-pill" disabled={!text.trim()} onClick={() => props.onSave(text, duration, language)}>保存草稿</button><button className="outline-pill" onClick={() => props.onGenerate(duration, language)}>AI 生成草稿</button><label className="outline-pill upload-project-action">上传稿件<input type="file" accept=".txt,.md,.docx,.pdf" onChange={upload} /></label></div>
    <textarea className="self-introduction-editor" value={text} onChange={(event) => setText(event.target.value)} placeholder="输入或上传一段可直接口述的自我介绍…" rows={10} />
    <div className="detail-metrics"><span>字数<strong>{text.trim().length}</strong></span><span>估算时长<strong>{estimatedSeconds} 秒</strong></span><span>来源<strong>{props.record?.source === "ai_generated" ? "AI 草稿" : props.record?.source === "uploaded" ? "上传" : "手动"}</strong></span><span>状态<strong>{props.record?.approved ? "Approved" : "Draft"}</strong></span></div>
    <div className="detail-actions"><button className="dark-pill" disabled={!props.record || props.record.status === "stale" || props.record.approved} onClick={props.onApprove}>审核通过</button>{props.record?.status === "stale" && <button className="outline-pill" onClick={props.onContinueUsing}>继续使用旧稿</button>}</div>
  </section>;
}
