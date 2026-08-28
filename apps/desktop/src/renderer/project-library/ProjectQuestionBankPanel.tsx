import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import type { ProjectQuestionBankImportReport, QuestionBankQuestionRecord } from "@interview-copilot/shared";

interface ProjectQuestionBankPanelProps {
  profileId: string;
  projectId: string;
  projectName: string;
  questionRevision?: string;
  onImport: (file: File) => Promise<ProjectQuestionBankImportReport | undefined>;
  onGenerate: () => void | Promise<unknown>;
}

function preferredAnswer(question: QuestionBankQuestionRecord): string {
  return question.answerCards.find((card) => card.verified && !card.stale)?.content
    ?? question.answerCards.find((card) => !card.stale)?.content
    ?? "";
}

function sourceLabel(question: QuestionBankQuestionRecord): string {
  if (question.source === "ai-generated" || question.source === "generated") return "AI生成 · 待确认";
  if (question.source === "imported") return "用户导入";
  return "手动维护";
}

export function ProjectQuestionBankPanel(props: ProjectQuestionBankPanelProps): JSX.Element {
  const [questions, setQuestions] = useState<QuestionBankQuestionRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [editingCardId, setEditingCardId] = useState<string>();
  const [questionDraft, setQuestionDraft] = useState("");
  const [answerDraft, setAnswerDraft] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualQuestion, setManualQuestion] = useState("");
  const [manualAnswer, setManualAnswer] = useState("");
  const [notice, setNotice] = useState<string>();

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await window.interviewCopilot.questionBank.list({ status: "all", scope: "project", projectId: props.projectId, exactProject: true, limit: 5_000, sort: "updated" });
      setQuestions(next);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [props.projectId, props.questionRevision]);

  const visibleQuestions = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return questions;
    return questions.filter((question) => `${question.canonicalText} ${question.variants.join(" ")} ${preferredAnswer(question)}`.toLowerCase().includes(normalized));
  }, [questions, search]);

  const saveManual = async (): Promise<void> => {
    if (!manualQuestion.trim() || !manualAnswer.trim()) return;
    const question = await window.interviewCopilot.questionBank.saveQuestion({ canonicalText: manualQuestion.trim(), type: "project", bankType: "project", category: "project", scope: "project", profileId: props.profileId, projectId: props.projectId, source: "manual", verified: true, stale: false });
    if (question) await window.interviewCopilot.questionBank.saveAnswer({ questionId: question.id, mode: "standard", content: manualAnswer.trim(), sourceType: "manual", verified: true, stale: false });
    setManualQuestion("");
    setManualAnswer("");
    setManualOpen(false);
    setNotice("项目问题已保存并确认");
    await refresh();
  };

  const beginEdit = (question: QuestionBankQuestionRecord, answerCardId?: string): void => {
    const card = answerCardId ? question.answerCards.find((item) => item.id === answerCardId) : question.answerCards.find((item) => item.verified && !item.stale) ?? question.answerCards.find((item) => !item.stale) ?? question.answerCards[0];
    setEditingId(question.id);
    setEditingCardId(card?.id);
    setQuestionDraft(question.canonicalText);
    setAnswerDraft(card?.content ?? "");
  };

  const saveEdit = async (question: QuestionBankQuestionRecord): Promise<void> => {
    const saved = await window.interviewCopilot.questionBank.saveQuestion({ id: question.id, canonicalText: questionDraft.trim() || question.canonicalText, type: question.type, bankType: "project", category: question.category, scope: "project", profileId: props.profileId, projectId: props.projectId, source: "manual", verified: true, stale: false, variants: question.variants, skillIds: question.skillIds, factIds: question.factIds });
    if (saved && answerDraft.trim()) {
      const card = question.answerCards.find((item) => item.id === editingCardId) ?? question.answerCards.find((item) => item.content.trim() === preferredAnswer(question).trim()) ?? question.answerCards[0];
      await window.interviewCopilot.questionBank.saveAnswer({ id: card?.id, questionId: question.id, mode: card?.mode ?? "standard", content: answerDraft.trim(), keyPoints: card?.keyPoints ?? [], sourceType: "manual", verified: true, stale: false, factIds: question.factIds });
    }
    setEditingId(undefined);
    setEditingCardId(undefined);
    setNotice("项目答案已更新并确认");
    await refresh();
  };

  const toggleQuestionVerified = async (question: QuestionBankQuestionRecord): Promise<void> => {
    const nextVerified = !question.verified;
    await window.interviewCopilot.questionBank.bulkUpdate([question.id], { verified: nextVerified });
    setNotice(nextVerified ? "项目问题已确认；答案卡仍按各自状态处理" : "项目问题已取消确认");
    await refresh();
  };

  const toggleAnswerCardVerified = async (question: QuestionBankQuestionRecord, cardId: string): Promise<void> => {
    const card = question.answerCards.find((item) => item.id === cardId);
    if (!card || card.stale) return;
    await window.interviewCopilot.questionBank.saveAnswer({ id: card.id, questionId: question.id, mode: card.mode, content: card.content, codeContent: card.codeContent, keyPoints: card.keyPoints, complexity: card.complexity, limitations: card.limitations, sourceType: card.sourceType, verified: !card.verified, stale: false, factIds: card.factIds });
    setNotice(card.verified ? "答案卡已取消确认" : "答案卡已确认");
    await refresh();
  };

  const addVariant = async (question: QuestionBankQuestionRecord): Promise<void> => {
    const variant = window.prompt("增加相似问法", "");
    if (!variant?.trim()) return;
    await window.interviewCopilot.questionBank.saveQuestion({ id: question.id, canonicalText: question.canonicalText, type: question.type, bankType: "project", category: question.category, scope: "project", profileId: props.profileId, projectId: props.projectId, source: question.source, verified: question.verified, stale: question.stale, variants: [...question.variants, variant.trim()], factIds: question.factIds, skillIds: question.skillIds });
    await refresh();
  };

  const removeVariant = async (question: QuestionBankQuestionRecord, variant: string): Promise<void> => {
    await window.interviewCopilot.questionBank.saveQuestion({ id: question.id, canonicalText: question.canonicalText, type: question.type, bankType: "project", category: question.category, scope: "project", profileId: props.profileId, projectId: props.projectId, source: question.source, verified: question.verified, stale: question.stale, variants: question.variants.filter((item) => item !== variant), factIds: question.factIds, skillIds: question.skillIds });
    await refresh();
  };

  const addAnswerCard = async (question: QuestionBankQuestionRecord): Promise<void> => {
    const content = window.prompt("新增项目答案卡", "");
    if (!content?.trim()) return;
    await window.interviewCopilot.questionBank.saveAnswer({ questionId: question.id, mode: "standard", content: content.trim(), sourceType: "manual", verified: true, stale: false, factIds: question.factIds });
    setNotice("新的项目答案卡已保存并确认");
    await refresh();
  };

  const deleteAnswerCard = async (question: QuestionBankQuestionRecord, answerCardId: string): Promise<void> => {
    if (question.answerCards.length <= 1 && !window.confirm("删除最后一张答案卡？删除后该问题将不能直接回答。")) return;
    await window.interviewCopilot.questionBank.deleteAnswer(answerCardId);
    setNotice("答案卡已删除");
    await refresh();
  };

  const importFile = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      const report = await props.onImport(file);
      if (report) setNotice(`已导入 ${report.importedAnswers} 条项目答案；${report.duplicatesMerged ? `合并 ${report.duplicatesMerged} 条重复问题` : ""}`);
      await refresh();
    } finally {
      setImporting(false);
    }
  };

  const generateQuestions = async (): Promise<void> => {
    const result = await props.onGenerate();
    if (result) setNotice("项目题库已生成，答案卡待确认");
    await refresh();
  };

  return <section className="project-section project-question-bank-panel">
    <header className="project-section-header"><div><span className="project-eyebrow">PROJECT QA</span><h2>项目题库</h2><p>已确认的项目答案优先用于实时面试；AI 生成内容必须先确认。</p></div><div className="detail-actions"><label className="dark-pill upload-project-action">＋ 上传项目题库<input type="file" accept=".txt,.md,.pdf,.docx" disabled={importing} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} /></label><button className="outline-pill" onClick={() => setManualOpen((value) => !value)}>＋ 手动新增问题</button><button className="outline-pill" onClick={() => void generateQuestions()}>AI 根据项目生成题库</button></div></header>
    <div className="detail-metrics personal-memory-stats"><span>项目问题 <strong>{questions.length}</strong></span><span>已确认 <strong>{questions.filter((question) => question.verified && !question.stale && question.answerCards.some((card) => card.verified && !card.stale)).length}</strong></span><span>待确认 <strong>{questions.filter((question) => !question.verified || Boolean(question.stale) || !question.answerCards.some((card) => card.verified && !card.stale)).length}</strong></span><span>当前项目 <strong>{props.projectName}</strong></span></div>
    {manualOpen && <div className="detail-sheet project-qa-editor"><h3>新增项目标准答案</h3><label className="clean-field"><span>面试问题</span><input value={manualQuestion} onChange={(event) => setManualQuestion(event.target.value)} placeholder="例如：ADC 怎么保证实时性？" /></label><label className="clean-field"><span>标准答案</span><textarea value={manualAnswer} onChange={(event) => setManualAnswer(event.target.value)} rows={5} placeholder="写下你希望面试时直接改写和口述的答案。" /></label><button className="dark-pill" disabled={!manualQuestion.trim() || !manualAnswer.trim()} onClick={() => void saveManual()}>保存并确认</button></div>}
    <label className="project-question-search"><span>搜索项目问题</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索问题、相似问法或答案…" /></label>
    {notice && <p className="project-page-notice">{notice}</p>}
    {loading ? <ProjectQaLoading /> : visibleQuestions.length === 0 ? <div className="knowledge-empty"><strong>{search ? "没有匹配的项目问题" : "还没有项目题库"}</strong><span>上传项目题库、手动新增，或让 AI 根据当前项目生成待确认问题。</span></div> : <div className="project-qa-list">{visibleQuestions.map((question) => {
      const editing = editingId === question.id;
      const stale = Boolean(question.stale);
      const ready = question.verified && question.answerCards.some((card) => card.verified && !card.stale) && !stale;
      return <article className={`project-qa-card ${stale ? "is-stale" : ""}`} key={question.id}><div className="project-qa-card-heading"><span className="project-qa-index">Q</span>{editing ? <input value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} /> : <h3>{question.canonicalText}</h3>}<span className={`project-qa-status ${ready ? "confirmed" : "pending"}`}>{stale ? "⚠ 资料已变化" : ready ? "已确认" : question.verified ? "答案待确认" : "问题待确认"}</span></div>{editing ? <textarea value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} rows={5} /> : <div className="project-qa-answer-cards">{question.answerCards.length > 0 ? question.answerCards.map((card) => <div className={`project-qa-answer-card ${card.stale ? "is-stale" : ""}`} key={card.id}><div><span>{card.mode} · {card.stale ? "旧版本 · 已失效" : card.verified ? "已确认" : "待确认"}</span><p>{card.content}</p></div>{!card.stale && <button className="text-button" onClick={() => void toggleAnswerCardVerified(question, card.id)}>{card.verified ? "取消确认答案" : "确认答案"}</button>}<button className="text-button" onClick={() => beginEdit(question, card.id)}>修改</button><button className="text-button danger-text" onClick={() => void deleteAnswerCard(question, card.id)}>删除</button></div>) : <p className="project-qa-answer">暂无答案，请编辑补充。</p>}</div>}<div className="project-qa-meta"><span>来源：{sourceLabel(question)}</span>{question.variants.length > 0 && <span>相似问法 {question.variants.length}</span>}{question.factIds?.length ? <span>关联事实 {question.factIds.length}</span> : null}</div>{question.variants.length > 0 && <div className="project-qa-variants"><span>相似问法：</span>{question.variants.map((variant) => <span className="project-qa-variant" key={variant}>{variant}<button aria-label={`删除相似问法：${variant}`} onClick={() => void removeVariant(question, variant)}>×</button></span>)}</div>}<div className="project-qa-actions">{editing ? <><button className="dark-pill" onClick={() => void saveEdit(question)}>保存</button><button className="text-button" onClick={() => { setEditingId(undefined); setEditingCardId(undefined); }}>取消</button></> : <><button className="text-button" onClick={() => beginEdit(question)}>修改</button><button className="text-button" onClick={() => void addVariant(question)}>增加相似问法</button><button className="text-button" onClick={() => void addAnswerCard(question)}>新增答案卡</button><button className="text-button" onClick={() => void toggleQuestionVerified(question)}>{question.verified ? "取消确认问题" : "确认问题"}</button><button className="text-button" onClick={() => void window.interviewCopilot.questionBank.bulkUpdate([question.id], { status: question.status === "active" ? "archived" : "active" }).then(refresh)}>{question.status === "active" ? "停用" : "启用"}</button><button className="text-button danger-text" onClick={() => { if (window.confirm("删除这条项目问题？")) void window.interviewCopilot.questionBank.deleteQuestion(question.id).then(refresh); }}>删除</button></>}</div></article>;
    })}</div>}
  </section>;
}

function ProjectQaLoading(): JSX.Element {
  return <div className="project-loading-skeleton" role="status" aria-label="正在加载项目题库"><span className="project-skeleton-line wide" /><span className="project-skeleton-line medium" /><span className="project-skeleton-line wide" /></div>;
}
