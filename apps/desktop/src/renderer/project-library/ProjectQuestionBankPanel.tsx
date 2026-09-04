import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { auditProjectQaEvidence, isFactEligible, type ProjectFact, type ProjectQaGenerationResult, type ProjectQuestionBankImportReport, type QuestionBankQuestionRecord } from "@interview-copilot/shared";
import { ProjectQaEvidenceReview, ProjectQaMatchCheck } from "./ProjectQaEvidenceReview";

interface ProjectQuestionBankPanelProps {
  profileId: string;
  projectId: string;
  projectName: string;
  questionRevision?: string;
  facts: ProjectFact[];
  sourceTitle?: (sourceId: string) => string;
  onImport: (file: File) => Promise<ProjectQuestionBankImportReport | undefined>;
  onGenerate: () => void | Promise<ProjectQaGenerationResult | undefined>;
}

function preferredAnswer(question: QuestionBankQuestionRecord): string {
  return question.answerCards.find((card) => card.verified && !card.stale)?.content
    ?? question.answerCards.find((card) => !card.stale)?.content
    ?? "";
}

function sourceLabel(question: QuestionBankQuestionRecord): string {
  if (question.source === "ai-generated" || question.source === "generated") return "AI生成";
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
  const [editingFactIds, setEditingFactIds] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualQuestion, setManualQuestion] = useState("");
  const [manualAnswer, setManualAnswer] = useState("");
  const [notice, setNotice] = useState<string>();
  const reportMutationFailure = (error: unknown): void => setNotice(`操作未完成：${String(error)}`);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await window.interviewCopilot.questionBank.list({ status: "all", scope: "project", profileId: props.profileId, projectId: props.projectId, exactProject: true, limit: 5_000, sort: "updated" });
      setQuestions(next);
    } catch (error) {
      setQuestions([]);
      setNotice(`题库加载失败：${String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const factRevision = props.facts.map((fact) => `${fact.id}:${fact.updatedAt ?? 0}:${fact.stale ?? false}:${fact.status ?? ""}`).join("|");
  useEffect(() => { void refresh(); }, [props.profileId, props.projectId, props.questionRevision, factRevision]);

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
    setEditingFactIds(question.factIds ?? []);
  };

  const canConfirm = (answer: string, factIds: string[]): boolean => {
    const audit = auditProjectQaEvidence({ projectId: props.projectId, answer, factIds, facts: props.facts });
    if (audit.blocked) { setNotice(`暂不能确认：${audit.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ")}`); return false; }
    return window.confirm(factIds.length ? "请确认：已逐句核对原文、技术含义、个人职责和数字，答案与真实项目一致。" : "此答案未关联项目事实，系统无法核验。是否按本人已核实的真实经历确认？");
  };

  const saveEdit = async (question: QuestionBankQuestionRecord): Promise<void> => {
    const card = question.answerCards.find((item) => item.id === editingCardId) ?? question.answerCards.find((item) => item.content.trim() === preferredAnswer(question).trim()) ?? question.answerCards[0];
    if (!answerDraft.trim() || !canConfirm([answerDraft, card?.codeContent, card?.complexity, card?.limitations].filter(Boolean).join("\n"), editingFactIds)) return;
    const saved = await window.interviewCopilot.questionBank.saveQuestion({ id: question.id, canonicalText: questionDraft.trim() || question.canonicalText, type: question.type, bankType: "project", category: question.category, scope: "project", profileId: props.profileId, projectId: props.projectId, source: "manual", verified: true, stale: false, variants: question.variants, skillIds: question.skillIds, factIds: editingFactIds });
    if (saved && answerDraft.trim()) {
      await window.interviewCopilot.questionBank.saveAnswer({ id: card?.id, questionId: question.id, mode: card?.mode ?? "standard", content: answerDraft.trim(), codeContent: card?.codeContent, complexity: card?.complexity, limitations: card?.limitations, keyPoints: card?.keyPoints ?? [], sourceType: "manual", verified: true, stale: false, factIds: editingFactIds });
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
    if (!card.verified && !canConfirm([card.content, card.codeContent, card.complexity, card.limitations].filter(Boolean).join("\n"), card.factIds ?? question.factIds ?? [])) return;
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
    if (!canConfirm(content, question.factIds ?? [])) return;
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
      if (report) setNotice(`新增 ${report.importedAnswers} 条项目答案，均待核验；原有确认状态不变${report.duplicatesMerged ? `；合并 ${report.duplicatesMerged} 条重复问题` : ""}`);
      await refresh();
    } finally {
      setImporting(false);
    }
  };

  const generateQuestions = async (): Promise<void> => {
    if (generating) return;
    setGenerating(true);
    try {
      const result = await props.onGenerate();
      if (result) setNotice(`生成 ${result.generated} 条项目问题，待核验；排除 ${result.excludedFactCount ?? 0} 条不可用事实，拦截 ${result.rejected ?? 0} 条风险答案`);
      await refresh();
    } finally { setGenerating(false); }
  };

  return <section className="project-section project-question-bank-panel">
    <header className="project-section-header"><div><span className="project-eyebrow">PROJECT QA</span><h2>项目题库</h2><p>已确认的项目答案优先用于实时面试；新导入和 AI 生成内容需核验后确认。</p></div><div className="detail-actions"><label className="dark-pill upload-project-action">＋ 上传项目题库<input type="file" accept=".txt,.md,.pdf,.docx" disabled={importing} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ""; }} /></label><button className="outline-pill" onClick={() => setManualOpen((value) => !value)}>＋ 手动新增问题</button><button className="outline-pill" disabled={generating} onClick={() => void generateQuestions()}>{generating ? "正在生成…" : "AI 根据项目生成题库"}</button></div></header>
    <div className="detail-metrics personal-memory-stats"><span>项目问题 <strong>{questions.length}</strong></span><span>已确认 <strong>{questions.filter((question) => question.verified && !question.stale && question.answerCards.some((card) => card.verified && !card.stale)).length}</strong></span><span>待确认 <strong>{questions.filter((question) => !question.verified || Boolean(question.stale) || !question.answerCards.some((card) => card.verified && !card.stale)).length}</strong></span><span>当前项目 <strong>{props.projectName}</strong></span></div>
    {manualOpen && <div className="detail-sheet project-qa-editor"><h3>新增项目标准答案</h3><label className="clean-field"><span>面试问题</span><input value={manualQuestion} onChange={(event) => setManualQuestion(event.target.value)} placeholder="例如：ADC 怎么保证实时性？" /></label><label className="clean-field"><span>标准答案</span><textarea value={manualAnswer} onChange={(event) => setManualAnswer(event.target.value)} rows={5} placeholder="写下你希望面试时直接改写和口述的答案。" /></label><button className="dark-pill" disabled={!manualQuestion.trim() || !manualAnswer.trim()} onClick={() => void saveManual().catch(reportMutationFailure)}>保存并确认</button></div>}
    <label className="project-question-search"><span>搜索项目问题</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索问题、相似问法或答案…" /></label>
    {notice && <p className="project-page-notice">{notice}</p>}
    <ProjectQaMatchCheck key={props.projectId} projectId={props.projectId} questions={questions} />
    {loading ? <ProjectQaLoading /> : visibleQuestions.length === 0 ? <div className="knowledge-empty"><strong>{search ? "没有匹配的项目问题" : "还没有项目题库"}</strong><span>上传项目题库、手动新增，或让 AI 根据当前项目生成待确认问题。</span></div> : <div className="project-qa-list">{visibleQuestions.map((question) => {
      const editing = editingId === question.id;
      const stale = Boolean(question.stale);
      const ready = question.verified && question.answerCards.some((card) => card.verified && !card.stale) && !stale;
      return <article className={`project-qa-card ${stale ? "is-stale" : ""}`} key={question.id}><div className="project-qa-card-heading"><span className="project-qa-index">Q</span>{editing ? <input value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} /> : <h3>{question.canonicalText}</h3>}<span className={`project-qa-status ${ready ? "confirmed" : "pending"}`}>{stale ? "⚠ 资料已变化" : ready ? "已确认" : question.verified ? "答案待确认" : "问题待确认"}</span></div>{editing ? <div><textarea value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} rows={5} /><label className="project-qa-fact-picker"><span>关联事实（同题共用；更改后其他答案需复核；按 Ctrl 多选或取消）</span><select multiple size={6} value={editingFactIds} onChange={(event) => setEditingFactIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{[...new Set([...props.facts.map((fact) => fact.id), ...editingFactIds])].map((id) => { const fact = props.facts.find((item) => item.id === id); return <option key={id} value={id}>{fact?.title ?? id}{!fact || !isFactEligible(fact) ? "（不可用，请移除或先处理事实）" : ""}</option>; })}</select></label><ProjectQaEvidenceReview projectId={props.projectId} answer={answerDraft} factIds={editingFactIds} facts={props.facts} sourceTitle={props.sourceTitle} /></div> : <div className="project-qa-answer-cards">{question.answerCards.length > 0 ? question.answerCards.map((card) => <div className={`project-qa-answer-card ${card.stale ? "is-stale" : ""}`} key={card.id}><div><span>{card.mode} · {card.stale ? "旧版本 · 已失效" : card.verified ? "已确认" : "待确认"}</span><p>{card.content}</p><ProjectQaEvidenceReview projectId={props.projectId} answer={card.content} factIds={card.factIds ?? question.factIds ?? []} facts={props.facts} sourceTitle={props.sourceTitle} /></div>{!card.stale && <button className="text-button" onClick={() => void toggleAnswerCardVerified(question, card.id).catch(reportMutationFailure)}>{card.verified ? "取消确认答案" : "确认答案"}</button>}<button className="text-button" onClick={() => beginEdit(question, card.id)}>修改</button><button className="text-button danger-text" onClick={() => void deleteAnswerCard(question, card.id)}>删除</button></div>) : <p className="project-qa-answer">暂无答案，请编辑补充。</p>}</div>}<div className="project-qa-meta"><span>来源：{sourceLabel(question)}</span>{question.variants.length > 0 && <span>相似问法 {question.variants.length}</span>}{question.factIds?.length ? <span>关联事实 {question.factIds.length}</span> : null}</div>{question.variants.length > 0 && <div className="project-qa-variants"><span>相似问法：</span>{question.variants.map((variant) => <span className="project-qa-variant" key={variant}>{variant}<button aria-label={`删除相似问法：${variant}`} onClick={() => void removeVariant(question, variant)}>×</button></span>)}</div>}<div className="project-qa-actions">{editing ? <><button className="dark-pill" onClick={() => void saveEdit(question).catch(reportMutationFailure)}>保存并确认</button><button className="text-button" onClick={() => { setEditingId(undefined); setEditingCardId(undefined); }}>取消</button></> : <><button className="text-button" onClick={() => beginEdit(question)}>修改</button><button className="text-button" onClick={() => void addVariant(question)}>增加相似问法</button><button className="text-button" onClick={() => void addAnswerCard(question).catch(reportMutationFailure)}>新增答案卡</button><button className="text-button" onClick={() => void toggleQuestionVerified(question)}>{question.verified ? "取消确认问题" : "确认问题"}</button><button className="text-button" onClick={() => void window.interviewCopilot.questionBank.bulkUpdate([question.id], { status: question.status === "active" ? "archived" : "active" }).then(refresh)}>{question.status === "active" ? "停用" : "启用"}</button><button className="text-button danger-text" onClick={() => { if (window.confirm("删除这条项目问题？")) void window.interviewCopilot.questionBank.deleteQuestion(question.id).then(refresh); }}>删除</button></>}</div></article>;
    })}</div>}
  </section>;
}

function ProjectQaLoading(): JSX.Element {
  return <div className="project-loading-skeleton" role="status" aria-label="正在加载项目题库"><span className="project-skeleton-line wide" /><span className="project-skeleton-line medium" /><span className="project-skeleton-line wide" /></div>;
}
