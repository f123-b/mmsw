import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { JSX } from "react";
import {
  deriveProjectLibraryViewModel,
  deriveSourceExtractionSummary,
  formatProjectFactValue,
  inferProjectSourceRole,
  isFactReviewRequired,
  isFactUserActionRequired,
  normalizeProjectOwnershipMode,
  type ProjectAnalysisStatus,
  type ProjectAnalysisJob,
  type ProjectCompletenessResult,
  type ProjectConflictGroup,
  type ProjectFact,
  type ProjectMemoryProject,
  type ProjectMemorySnapshot,
  type ProjectProblem,
  type ProjectQaGenerationResult,
  type ProjectQuestionBankImportReport,
  type ProjectSourceRole
} from "@interview-copilot/shared";
import type { ChatAction } from "@interview-copilot/shared";
import type { KnowledgeAnalysisRunRecord, ProjectMemoryStats } from "../../main/database";
import { chatFailureText } from "../../shared/chat-errors";
import { ProjectQuestionBankPanel } from "./ProjectQuestionBankPanel";

interface ProjectAgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: string;
  errorCode?: string;
  model?: string;
}

type OwnershipMode = "personal" | "team" | "partial" | "reference";
type ProjectSection = "overview" | "parameters" | "architecture" | "decisions" | "problems" | "questions" | "sources" | "advanced";
type AdvancedSection = "facts" | "conflicts" | "review" | "stale" | "analysis";

interface ProjectLibraryPageProps {
  profileId: string;
  memory: ProjectMemorySnapshot;
  stats: ProjectMemoryStats;
  facts: ProjectFact[];
  staleFacts?: ProjectFact[];
  analysisRuns: KnowledgeAnalysisRunRecord[];
  analysisJobs: ProjectAnalysisJob[];
  rebuilding: boolean;
  selectedProjectId?: string;
  onSelectProject?: (projectId: string) => void;
  onImportProjectMaterials: (projectId: string, files: Array<{ file: File; sourceRole: ProjectSourceRole | "auto" }>) => Promise<unknown>;
  onImportProjectQuestionBank: (projectId: string, file: File) => Promise<ProjectQuestionBankImportReport | undefined>;
  onGenerateProjectQa: (projectId: string) => Promise<ProjectQaGenerationResult | undefined>;
  onRebuild: (projectId?: string) => void | Promise<void>;
  onCancelAnalysis: (projectId: string, jobId?: string) => Promise<void>;
  onRetryAnalysis: (projectId: string) => Promise<void>;
  onCreateProject?: (input: { name: string; ownershipMode: OwnershipMode; ownershipNote?: string }) => Promise<void>;
  onUpdateProject: (projectId: string, input: { ownershipMode?: OwnershipMode; ownershipNote?: string }) => Promise<void>;
  onReviewFact: (factId: string, status: "active" | "pending_review" | "rejected" | "conflicting") => Promise<void>;
  onResolveConflict: (conflictGroupId: string, selectedFactId: string, keepBoth?: boolean, variantContexts?: Record<string, string>) => Promise<void>;
  onUnassignSource: (projectId: string, sourceType: string, sourceId: string) => Promise<void>;
  onAddResponsibility: (projectId: string, content: string) => Promise<void>;
  agentMessages: ProjectAgentMessage[];
  agentSending: boolean;
  agentProjectId?: string;
  onSendAgent: (projectId: string, content: string) => Promise<void>;
  onRetryAgent: (messageId: string) => Promise<void>;
  onOpenSettings: () => void;
  onApproveAgentAction?: (messageId: string, action: ChatAction) => Promise<void>;
}

interface SourceRecord {
  id?: unknown;
  sourceId?: unknown;
  sourceType?: unknown;
  sourceRole?: unknown;
  relationship?: unknown;
  title?: unknown;
  documentType?: unknown;
  status?: unknown;
  repositoryFileCount?: unknown;
  updatedAt?: unknown;
}

interface DrawerProps {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: ReactNode;
}

function Drawer({ title, eyebrow, onClose, children }: DrawerProps): JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])");
    firstFocusable?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter((item) => !item.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [onClose]);
  return <div className="project-drawer-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="project-drawer" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="project-drawer-title">
      <header className="project-drawer-header"><div>{eyebrow && <span className="project-eyebrow">{eyebrow}</span>}<h2 id="project-drawer-title">{title}</h2></div><button className="project-drawer-close" onClick={onClose} aria-label="关闭详情">×</button></header>
      <div className="project-drawer-body">{children}</div>
    </aside>
  </div>;
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }): JSX.Element {
  return <div className="project-empty-state"><strong>{title}</strong><p>{description}</p>{action}</div>;
}

function ProjectLoadingSkeleton(): JSX.Element {
  return <div className="project-loading-skeleton" role="status" aria-label="正在加载项目详情"><span className="project-skeleton-line wide" /><span className="project-skeleton-line medium" /><span className="project-skeleton-line short" /></div>;
}

function OwnershipLabel({ mode }: { mode: OwnershipMode }): string {
  return mode === "team" ? "团队项目" : mode === "partial" ? "部分负责" : mode === "reference" ? "参考项目" : "个人项目";
}

function cleanText(value: string): string {
  return value.replace(/[#*_`]/g, "").replace(/\s+/g, " ").trim();
}

function factValue(fact: ProjectFact): string {
  return formatProjectFactValue(fact.value) || cleanText(fact.content);
}

function sourceRoleLabel(value: unknown): string {
  const role = String(value ?? "other");
  return ({ overview: "项目说明", code: "源码", resume: "简历经历", responsibility: "职责说明", debug: "问题排查", test: "测试与指标", architecture: "架构设计", question_bank: "项目题库", reference: "参考资料", other: "项目资料" } as Record<string, string>)[role] ?? "项目资料";
}

function statusLabel(fact: ProjectFact): string {
  if (fact.stale) return "已失效";
  if (fact.status === "rejected") return "已忽略";
  if (fact.status === "conflicting" || fact.conflictStatus === "conflicting") return "有冲突";
  if (isFactReviewRequired(fact)) return "待确认";
  return "已确认";
}

function evidenceCount(fact: ProjectFact): number {
  return fact.evidence?.filter((item) => item.quote.trim()).length ?? 0;
}

function relativeUpdatedAt(value?: number): string {
  if (!value) return "最近更新";
  const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前更新`;
  return `${Math.floor(hours / 24)} 天前更新`;
}

function ProjectHeader(props: {
  project: ProjectMemoryProject;
  summary: string;
  sourceCount: number;
  sourceCoverage: number;
  updatedAt?: number;
  familiarity: ProjectLibraryPageViewModel["familiarity"];
  onEdit: () => void;
}): JSX.Element {
  const mode = normalizeProjectOwnershipMode(props.project.ownershipMode) as OwnershipMode;
  return <header className="project-header-v5">
    <div className="project-header-main"><div className="project-title-line"><h1>{props.project.name}</h1><button className="project-icon-button" onClick={props.onEdit} aria-label="编辑项目设置">✎</button></div><p className="project-header-summary">{props.summary}</p><span className="project-ownership-chip">{OwnershipLabel({ mode })}</span></div>
    <div className="project-header-actions"><button className="outline-pill project-header-edit" onClick={props.onEdit}>项目设置</button></div>
    <div className="project-header-meta" aria-label="项目状态"><span>熟悉度 <strong>{props.familiarity.overall}%</strong></span><span>资料 <strong>{props.sourceCoverage}%</strong></span><span>技术 <strong>{props.familiarity.technical}%</strong></span><span>问题 <strong>{props.familiarity.problems}%</strong></span><span className="project-header-updated">{relativeUpdatedAt(props.updatedAt)} · {props.sourceCount} 份资料</span></div>
  </header>;
}

type ProjectLibraryPageViewModel = ReturnType<typeof deriveProjectLibraryViewModel>;

function ProjectTabs({ section, advancedOpen, onSection, onToggleAdvanced }: { section: ProjectSection; advancedOpen: boolean; onSection: (section: ProjectSection) => void; onToggleAdvanced: () => void }): JSX.Element {
  const tabs: Array<[ProjectSection, string]> = [["overview", "概览"], ["parameters", "关键参数"], ["architecture", "技术架构"], ["decisions", "决策与 Why"], ["problems", "问题排查"], ["questions", "项目题库"], ["sources", "项目资料"]];
  return <nav className="project-tabs-v5" aria-label="项目详情导航">{tabs.map(([value, label]) => <button key={value} className={section === value ? "active" : ""} aria-selected={section === value} onClick={() => onSection(value)}>{label}</button>)}<div className="project-advanced-menu"><button className={section === "advanced" || advancedOpen ? "active" : ""} aria-expanded={advancedOpen} aria-haspopup="menu" onClick={onToggleAdvanced}>···</button>{advancedOpen && <div className="project-advanced-popover" role="menu"><strong>高级数据</strong><button role="menuitem" onClick={() => onSection("advanced")}>事实库与治理</button><small>冲突、待复核、已失效、分析记录</small></div>}</div></nav>;
}

function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }): JSX.Element {
  return <header className="project-section-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</header>;
}

function TechnologyRows({ model }: { model: ProjectLibraryPageViewModel }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const total = model.technologies.reduce((sum, group) => sum + group.items.length, 0);
  let shown = 0;
  return <div className="project-technology-rows">{model.technologies.map((group) => {
    const items = expanded ? group.items : group.items.slice(0, Math.max(0, 20 - shown));
    shown += items.length;
    return <div className="project-technology-row" key={group.category}><strong>{group.label}</strong><span>{items.join(" · ") || "待补充"}</span></div>;
  })}{total === 0 && <p className="project-muted">还没有可靠技术信息。</p>}{total > 20 && <button className="project-inline-link" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起技术列表" : `展开全部技术（+${total - 20}）`}</button>}</div>;
}

function ParameterTable({ parameters, limit, onSelect, emptyAction, analysisStatus }: { parameters: ProjectFact[]; limit?: number; onSelect: (fact: ProjectFact) => void; emptyAction?: ReactNode; analysisStatus?: ProjectAnalysisStatus }): JSX.Element {
  const visible = limit ? parameters.slice(0, limit) : parameters;
  const waitingForAnalysis = analysisStatus === "sources_ready" || analysisStatus === "analyzing";
  return <div className="project-table-wrap"><table className="project-data-table"><thead><tr><th>参数</th><th>当前值</th><th>状态</th></tr></thead><tbody>{visible.map((fact) => <tr key={fact.id} tabIndex={0} onClick={() => onSelect(fact)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(fact); } }}><td><button className="project-table-link" onClick={(event) => { event.stopPropagation(); onSelect(fact); }}>{fact.title}</button></td><td>{factValue(fact)}</td><td><span className={`project-status-text ${statusLabel(fact) === "有冲突" ? "warning" : "success"}`}>{statusLabel(fact)}</span></td></tr>)}</tbody></table>{visible.length === 0 && <EmptyState title={waitingForAnalysis ? "项目资料尚未分析" : "关键参数"} description={waitingForAnalysis ? "已上传项目资料，分析完成后会自动提取控制频率、波特率、限幅等关键参数。" : "还没有可靠关键参数。上传配置文件或手动补充参数，可以减少面试时的回答错误。"} action={emptyAction} />}</div>;
}

function DecisionList({ decisions, onSelect, emptyAction, analysisStatus }: { decisions: ProjectFact[]; onSelect: (fact: ProjectFact) => void; emptyAction?: ReactNode; analysisStatus?: ProjectAnalysisStatus }): JSX.Element {
  const waitingForAnalysis = analysisStatus === "sources_ready" || analysisStatus === "analyzing";
  return <div className="project-decision-list">{decisions.slice(0, 3).map((fact) => <button className="project-decision-row" key={fact.id} onClick={() => onSelect(fact)}><span className="project-decision-question">为什么{fact.title || "采用这个方案"}？</span><span>{cleanText(fact.content)}</span><small>{evidenceCount(fact)} 个来源 <b>→</b></small></button>)}{decisions.length === 0 && <EmptyState title={waitingForAnalysis ? "项目资料尚未分析" : "还没有形成 Why 事实"} description={waitingForAnalysis ? "已上传项目资料，分析完成后会自动整理设计取舍和 Why。" : "补充技术方案的取舍和原因，让面试回答更完整。"} action={emptyAction} />}</div>;
}

function ProblemList({ problems, selectedId, onSelect }: { problems: ProjectProblem[]; selectedId?: string; onSelect: (problem: ProjectProblem) => void }): JSX.Element {
  return <div className="project-problem-list">{problems.map((problem) => <button className={`project-problem-row ${selectedId === problem.id ? "selected" : ""}`} key={problem.id} onClick={() => onSelect(problem)}><span><strong>{problem.problem}</strong><small>{cleanText(problem.cause).slice(0, 80) || "待补充原因"}</small></span><b>→</b></button>)}{problems.length === 0 && <EmptyState title="还没有问题记录" description="在项目资料中补充现象、原因、解决方案和结果。" />}</div>;
}

function ProjectAnalysisNotice({ model, onRebuild, rebuilding, job, onCancel, onRetry }: { model: ProjectLibraryPageViewModel; onRebuild: () => void; rebuilding: boolean; job?: ProjectAnalysisJob; onCancel: () => void; onRetry: () => void }): JSX.Element | null {
  const active = Boolean(job && ["queued", "mapping", "exploring", "synthesizing", "grounding"].includes(job.status));
  const failed = job?.status === "failed" || job?.status === "cancelled" || model.analysisStatus === "failed";
  if ((model.analysisStatus === "ready" || model.understanding?.status === "completed") && !rebuilding && !active && !failed) return null;
  const analyzing = model.analysisStatus === "analyzing" || rebuilding || active;
  const title = active && job?.status === "queued" ? "源码已导入，项目分析排队中" : analyzing ? `正在理解 ${model.status.sourceCount} 份项目资料…` : failed ? (job?.status === "cancelled" ? "项目分析已取消" : "项目分析失败") : "已上传项目资料，等待生成项目技术知识";
  const description = active ? `阶段：${job?.stage ?? "mapping"} · ${Math.round((job?.progress ?? 0) * 100)}%${job?.filesTotal ? ` · 已探索 ${job.filesExplored}/${job.filesTotal} 个文件` : ""}` : failed ? "源码和已有项目知识均已保留，可以重新运行一次分析。" : "完成后会生成项目理解、Project Facts、参数、决策和问题链。";
  return <section className={`project-analysis-notice ${analyzing ? "is-analyzing" : failed ? "is-failed" : ""}`} role="status"><div><strong>{title}</strong><p>{description}</p>{analyzing && <div className="project-analysis-steps"><span>Repo Map</span><span>核心模块</span><span>运行流程</span><span>参数语义</span><span>Grounding</span></div>}</div><div className="project-analysis-actions">{active ? <button className="outline-pill" onClick={onCancel}>取消分析</button> : failed ? <button className="outline-pill" onClick={onRetry}>重新分析</button> : <button className="outline-pill" onClick={onRebuild}>分析项目</button>}</div></section>;
}

function ProjectOverview({ model, onSection, onSelectParameter, onSelectDecision, onSelectProblem, onOpenSources, onOpenQuestions, onRebuild, rebuilding, analysisJob, onCancelAnalysis, onRetryAnalysis, onAddSource, onNextAction }: { model: ProjectLibraryPageViewModel; onSection: (section: ProjectSection) => void; onSelectParameter: (fact: ProjectFact) => void; onSelectDecision: (fact: ProjectFact) => void; onSelectProblem: (problem: ProjectProblem) => void; onOpenSources: () => void; onOpenQuestions: () => void; onRebuild: () => void; rebuilding: boolean; analysisJob?: ProjectAnalysisJob; onCancelAnalysis: () => void; onRetryAnalysis: () => void; onAddSource: () => void; onNextAction: (type: ProjectLibraryPageViewModel["nextActions"][number]["type"]) => void }): JSX.Element {
  const overviewPoints = model.technologies.flatMap((group) => group.items).slice(0, 5);
  return <div className="project-overview-layout-v5"><main className="project-overview-main-v5">
    <ProjectAnalysisNotice model={model} onRebuild={onRebuild} rebuilding={rebuilding} job={analysisJob} onCancel={onCancelAnalysis} onRetry={onRetryAnalysis} />
    <section className="project-section-v5 project-intro-section"><SectionHeader title="项目概览" description="面试前先复习这几件事" action={<button className="project-text-link" onClick={() => onSection("architecture")}>查看完整架构 →</button>} /><p className="project-overview-copy">{model.summary}</p>{overviewPoints.length > 0 && <ul className="project-overview-bullets">{overviewPoints.map((item) => <li key={item}>{item}</li>)}</ul>}</section>
    <section className="project-section-v5"><SectionHeader title="核心技术" description="按主题整理，避免一屏堆满标签" /><TechnologyRows model={model} /></section>
    <section className="project-section-v5"><SectionHeader title="关键参数" description="只显示最常用的 6 项" action={<button className="project-text-link" onClick={() => onSection("parameters")}>查看全部参数 →</button>} /><ParameterTable parameters={model.parameters} limit={6} onSelect={onSelectParameter} analysisStatus={model.analysisStatus} emptyAction={<button className="outline-pill" onClick={() => onSection("parameters")}>补充参数</button>} /></section>
    <section className="project-section-v5"><SectionHeader title="技术决策" description="用 Why 复习取舍和原因" action={<button className="project-text-link" onClick={() => onSection("decisions")}>查看全部 Why →</button>} /><DecisionList decisions={model.decisions} onSelect={onSelectDecision} analysisStatus={model.analysisStatus} emptyAction={<button className="outline-pill" onClick={() => onSection("decisions")}>查看可能决策</button>} /></section>
    <section className="project-section-v5"><SectionHeader title="典型问题" description="先看现象，再进入问题详情" action={<button className="project-text-link" onClick={() => onSection("problems")}>查看全部问题 →</button>} /><ProblemList problems={model.problems} onSelect={onSelectProblem} /></section>
    <section className="project-section-v5 project-outcomes-section"><div className="project-outcomes-column"><SectionHeader title="项目成果" />{model.results.length ? <ul className="project-check-list">{model.results.slice(0, 4).map((fact) => <li key={fact.id}><span>✓</span>{cleanText(fact.content)}</li>)}</ul> : <p className="project-muted">还没有可核验成果。</p>}</div><div className="project-outcomes-column"><SectionHeader title="数据边界" />{model.limitations.length ? <ul className="project-limit-list">{model.limitations.slice(0, 3).map((fact) => <li key={fact.id}><span>○</span>{cleanText(fact.content)}</li>)}</ul> : <p className="project-muted">暂未记录未测量项。</p>}</div></section>
  </main><ProjectStatusSidebar model={model} onAddSource={onAddSource} onOpenSources={onOpenSources} onOpenQuestions={onOpenQuestions} onRebuild={onRebuild} rebuilding={rebuilding} onNextAction={onNextAction} /></div>;
}

function ProjectStatusSidebar({ model, onAddSource, onOpenSources, onOpenQuestions, onRebuild, rebuilding, onNextAction }: { model: ProjectLibraryPageViewModel; onAddSource: () => void; onOpenSources: () => void; onOpenQuestions: () => void; onRebuild: () => void; rebuilding: boolean; onNextAction: (type: ProjectLibraryPageViewModel["nextActions"][number]["type"]) => void }): JSX.Element {
  const analysisLabel: Record<ProjectAnalysisStatus, string> = { empty: "暂无资料", sources_ready: "待分析", analyzing: "分析中", ready: "已完成", failed: "分析失败", stale: "待重新分析" };
  return <aside className="project-status-sidebar"><section className="project-side-section"><div className="project-side-heading"><h2>项目状态</h2><button className="project-text-link" onClick={onOpenSources}>查看详情 →</button></div><dl className="project-status-list"><div><dt>项目分析</dt><dd>{analysisLabel[model.analysisStatus]}</dd></div><div><dt>熟悉度</dt><dd>{model.familiarity.overall}%</dd></div><div><dt>可信信息</dt><dd>{model.status.trustedFacts}</dd></div><div><dt>待处理</dt><dd>{model.status.pendingActions}</dd></div><div><dt>冲突组</dt><dd>{model.status.conflictGroups}</dd></div></dl></section><section className="project-side-section project-next-action"><h2>下一步</h2>{model.nextActions.length ? <div className="project-next-action-list">{model.nextActions.map((action) => <button key={action.type} onClick={() => onNextAction(action.type)}><strong>{action.title}</strong><span>{action.description}</span></button>)}</div> : <p className="project-muted">当前项目没有紧急补全项。</p>}<button className="dark-pill project-continue-button" onClick={() => onNextAction(model.nextActions[0]?.type ?? "missing_sources")}>继续完善项目</button></section><section className="project-side-section"><h2>快捷操作</h2><div className="project-quick-links"><button onClick={onAddSource}>↑ 添加资料</button><button onClick={onRebuild} disabled={rebuilding}>↻ {rebuilding ? "正在重新分析…" : "重新分析"}</button><button onClick={onOpenQuestions}>≡ 生成项目题库</button></div></section></aside>;
}

function ProjectAgentRuntime({ model, messages, agentInput, onInput, onSend, sending, onRetry, onSettings }: { model: ProjectLibraryPageViewModel; messages: ProjectAgentMessage[]; agentInput: string; onInput: (value: string) => void; onSend: () => void; sending: boolean; onRetry: (messageId: string) => void; onSettings: () => void }): JSX.Element {
  const visible = messages.slice(-10);
  return <div className="project-agent-runtime"><div className="project-agent-conversation">{visible.length ? visible.map((message) => { const failed = message.role === "assistant" && message.status === "failed"; return <article className={`project-agent-message ${message.role} ${failed ? "failed" : ""}`} key={message.id}><strong>{message.role === "user" ? "我" : "项目 Agent"}{failed ? " · 生成失败" : ""}</strong><p>{message.content || (message.status === "streaming" ? "正在分析项目资料…" : failed ? chatFailureText(message.errorCode, message.model) : "未返回内容")}</p>{failed && <div className="project-agent-recovery"><button className="outline-pill" disabled={sending} onClick={() => onRetry(message.id)}>重新生成</button><button className="outline-pill" onClick={onSettings}>检查模型设置</button></div>}</article>; }) : <div className="project-empty-state project-agent-empty"><strong>从资料到可信项目库</strong><p>可以问“当前项目还缺哪些技术信息”“有哪些关键参数没有确认”“哪些设计没有记录 Why”“问题链哪里不完整”，也可以让 Agent 整理项目介绍。</p></div>}</div><div className="project-agent-composer"><textarea value={agentInput} onChange={(event) => onInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder="询问项目参数、架构、设计决策、问题排查，或让 Agent 检查资料缺口…" aria-label="项目 Agent 输入" /><button className="dark-pill" disabled={!agentInput.trim() || sending} onClick={onSend}>{sending ? "分析中…" : "发送"}</button></div></div>;
}

function ProjectParameters({ model, search, onSearch, category, onCategory, onSelect }: { model: ProjectLibraryPageViewModel; search: string; onSearch: (value: string) => void; category: string; onCategory: (value: string) => void; onSelect: (fact: ProjectFact) => void }): JSX.Element {
  const categories = [...new Set(model.parameters.map((fact) => fact.subtype || "其他"))];
  const visible = model.parameters.filter((fact) => (!search.trim() || `${fact.title} ${fact.content}`.toLowerCase().includes(search.toLowerCase())) && (category === "全部" || (fact.subtype || "其他") === category));
  return <section className="project-detail-page-v5"><div className="project-detail-intro"><span className="project-eyebrow">PROJECT DETAIL</span><h2>关键参数</h2><p>把面试中最容易被追问的数值集中在一张可读表里。</p></div><div className="project-filter-row"><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索参数..." aria-label="搜索参数" /><select value={category} onChange={(event) => onCategory(event.target.value)} aria-label="参数分类"><option>全部</option>{categories.map((item) => <option key={item}>{item}</option>)}</select></div><ParameterTable parameters={visible} onSelect={onSelect} analysisStatus={model.analysisStatus} /></section>;
}

function ProjectArchitecture({ model }: { model: ProjectLibraryPageViewModel }): JSX.Element {
  return <section className="project-detail-page-v5"><div className="project-detail-intro"><span className="project-eyebrow">PROJECT DETAIL</span><h2>技术架构</h2><p>用层级关系复习系统，不引入复杂图形。</p></div><div className="project-architecture-layout"><div className="project-architecture-tree">{model.components.length > 0 && <section><h3>理解出的核心组件</h3><ul>{model.components.slice(0, 12).map((component) => <li key={component.id}><strong>{component.name}</strong><small>{component.description}{component.files?.length ? ` · ${component.files.slice(0, 3).join("、")}` : ""}</small></li>)}</ul></section>}{model.flows.length > 0 && <section><h3>运行与数据流程</h3><ul>{model.flows.slice(0, 8).map((flow) => <li key={flow.id}><strong>{flow.name}</strong><small>{flow.steps.map((step) => step.action).join(" → ")}</small></li>)}</ul></section>}{model.relationships.length > 0 && <section><h3>组件关系</h3><ul>{model.relationships.slice(0, 10).map((relationship) => <li key={`${relationship.from}-${relationship.to}-${relationship.relation}`}><strong>{relationship.from} → {relationship.to}</strong><small>{relationship.description ?? relationship.relation}</small></li>)}</ul></section>}{model.technologies.map((group) => <section key={group.category}><h3>{group.label}</h3><ul>{group.items.map((item) => <li key={item}>{item}</li>)}</ul></section>)}{model.modules.length > 0 && <section><h3>核心模块</h3><ul>{model.modules.slice(0, 8).map((module) => <li key={module.id}><strong>{module.moduleName}</strong>{module.description && <small>{module.description}</small>}</li>)}</ul></section>}{model.components.length === 0 && model.technologies.length === 0 && model.modules.length === 0 && <EmptyState title="还没有架构信息" description="上传架构说明或源码后重新分析。" />}</div><aside className="project-context-aside"><h3>项目理解状态</h3><p>{model.understanding ? `${model.understanding.status === "completed" ? "已完成 Grounding" : "分析中"} · ${model.understanding.trace.filesRead} 个文件 · ${model.understanding.trace.toolCalls} 次工具调用` : "尚未生成项目理解"}</p><h3>待确认范围</h3><p>{model.unknowns.slice(0, 3).map((unknown) => unknown.claim).join("；") || "暂未发现明确缺口"}</p><h3>相关参数</h3><p>{model.parameters.slice(0, 5).map((fact) => fact.title).join(" · ") || "待补充"}</p><h3>相关资料</h3><p>{model.status.sourceCount} 份项目资料</p></aside></div></section>;
}

function ProjectDecisions({ model, onSelect }: { model: ProjectLibraryPageViewModel; onSelect: (fact: ProjectFact) => void }): JSX.Element {
  return <section className="project-detail-page-v5"><div className="project-detail-intro"><span className="project-eyebrow">PROJECT DETAIL</span><h2>决策与 Why</h2><p>每条决策都回答“为什么这样做”，并保留可追溯证据。</p></div><DecisionList decisions={model.decisions} onSelect={onSelect} analysisStatus={model.analysisStatus} /></section>;
}

function ProjectProblems({ model, selectedId, onSelect }: { model: ProjectLibraryPageViewModel; selectedId?: string; onSelect: (problem: ProjectProblem) => void }): JSX.Element {
  const selected = model.problems.find((problem) => problem.id === selectedId) ?? model.problems[0];
  return <section className="project-detail-page-v5"><div className="project-detail-intro"><span className="project-eyebrow">PROJECT DETAIL</span><h2>问题排查</h2><p>先选问题，再逐步复习现象、原因、解决和结果。</p></div><div className="project-problem-detail-layout"><ProblemList problems={model.problems} selectedId={selected?.id} onSelect={onSelect} />{selected ? <article className="project-problem-detail"><h3>{selected.problem}</h3><dl><div><dt>现象</dt><dd>{selected.problem}</dd></div><div><dt>原因</dt><dd>{selected.cause || "待补充"}</dd></div><div><dt>解决</dt><dd>{selected.solution || "待补充"}</dd></div><div><dt>结果</dt><dd>{selected.result || "待补充"}</dd></div></dl><p className="project-evidence-note">{selected.sourceIds.length} 个来源 · 可在资料证据中查看引用</p></article> : <EmptyState title="选择一个问题" description="问题详情会在这里展开。" />}</div></section>;
}

function sourceSummaryText(role: unknown, summary: ReturnType<typeof deriveSourceExtractionSummary>): string {
  if (summary.totalFacts === 0) return "项目分析未生成信息";
  switch (String(role ?? "other")) {
    case "overview": return `事实 ${summary.totalFacts} · 技术 ${summary.technologies}`;
    case "architecture": return `架构 ${summary.architecture} · 模块 ${summary.modules} · 决策 ${summary.decisions}`;
    case "debug": return `问题 ${summary.challenges} · 原因 ${summary.causes} · 解决 ${summary.solutions}`;
    case "test": return `结果 ${summary.results} · 指标 ${summary.metrics} · 未测量 ${summary.limitations}`;
    case "code": return `事实 ${summary.totalFacts} · 参数 ${summary.parameters} · 技术 ${summary.technologies}`;
    default: return `事实 ${summary.totalFacts} · 参数 ${summary.parameters} · 技术 ${summary.technologies}`;
  }
}

function ProjectSources({ facts, sources, analysisStatus, onSelect, onOpenSources }: { facts: ProjectFact[]; sources: SourceRecord[]; analysisStatus: ProjectAnalysisStatus; onSelect: (source: SourceRecord) => void; onOpenSources: () => void }): JSX.Element {
  const projectAnalysisLabel = analysisStatus === "analyzing" ? "分析中" : analysisStatus === "failed" ? "分析失败" : analysisStatus === "ready" ? "已完成" : analysisStatus === "stale" ? "待重新分析" : "待分析";
  return <section className="project-detail-page-v5"><div className="project-detail-intro"><span className="project-eyebrow">PROJECT DETAIL</span><h2>资料证据</h2><p>{sources.length} 份资料 · 文件读取状态和项目分析状态分开显示。</p></div><div className="project-source-list-v5">{sources.map((source) => { const sourceId = String(source.sourceId ?? source.id ?? ""); const summary = deriveSourceExtractionSummary(sourceId, facts); const repositoryCount = Number(source.repositoryFileCount ?? 0); return <button key={String(source.id ?? source.sourceId)} onClick={() => onSelect(source)}><span className="project-source-file-icon">▤</span><span className="project-source-copy"><strong>{String(source.title ?? source.sourceId ?? "项目资料")}</strong><small>{sourceRoleLabel(source.sourceRole)} · 文件：{source.status === "ready" ? "已读取" : String(source.status ?? "处理中")}</small><small>{source.sourceType === "repository" ? `源码已导入 · ${repositoryCount} 个文件 · ` : ""}项目分析：{projectAnalysisLabel} · {sourceSummaryText(source.sourceRole, summary)}</small></span><span className="project-source-count">{summary.totalFacts ? `${summary.totalFacts} 条信息` : "暂无信息"}</span><span className="project-source-chevron">→</span></button>; })}{sources.length === 0 && <EmptyState title="还没有绑定资料" description="添加 README、代码、排查记录或测试报告，让项目复习有依据。" action={<button className="dark-pill" onClick={onOpenSources}>添加资料</button>} />}</div>{sources.length > 0 && <p className="project-muted project-source-footnote">资料绑定保持在当前项目上下文中，解除绑定不会删除原始文件。</p>}</section>;
}

function ProjectFactTable({ facts, onSelect }: { facts: ProjectFact[]; onSelect: (fact: ProjectFact) => void }): JSX.Element {
  return <div className="project-table-wrap"><table className="project-data-table project-facts-table"><thead><tr><th>类型</th><th>信息</th><th>状态</th><th>证据</th><th>更新时间</th></tr></thead><tbody>{facts.map((fact) => <tr key={fact.id} tabIndex={0} onClick={() => onSelect(fact)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(fact); } }}><td>{fact.title || fact.type}</td><td>{cleanText(fact.content)}</td><td>{statusLabel(fact)}</td><td>{evidenceCount(fact)} 个来源</td><td>{fact.updatedAt ? new Date(fact.updatedAt).toLocaleString() : fact.createdAt ? new Date(fact.createdAt).toLocaleString() : "—"}</td></tr>)}</tbody></table>{facts.length === 0 && <EmptyState title="暂无信息" description="重新分析或补充项目资料。" />}</div>;
}

type ProjectLibraryDisplayModel = ProjectLibraryPageViewModel & { projectFacts: ProjectFact[]; staleFacts: ProjectFact[]; analysisRuns: KnowledgeAnalysisRunRecord[] };

function ProjectAdvanced({ model, advancedSection, onAdvancedSection, onSelectFact, onSelectConflict, onReviewFact }: { model: ProjectLibraryDisplayModel; advancedSection: AdvancedSection; onAdvancedSection: (section: AdvancedSection) => void; onSelectFact: (fact: ProjectFact) => void; onSelectConflict: (group: ProjectConflictGroup) => void; onReviewFact: (factId: string, status: "active" | "pending_review" | "rejected" | "conflicting") => void }): JSX.Element {
  const sections: Array<[AdvancedSection, string]> = [["facts", "事实库"], ["conflicts", "冲突"], ["review", "系统待复核"], ["stale", "已失效"], ["analysis", "分析记录"]];
  const reviewFacts = model.projectFacts.filter((fact) => !fact.stale && fact.status !== "rejected" && !fact.conflictGroupId && (isFactReviewRequired(fact) || fact.evidenceLevel === "pending"));
  return <section className="project-detail-page-v5 project-advanced-page"><div className="project-detail-intro"><span className="project-eyebrow">ADVANCED DATA</span><h2>高级数据</h2><p>这里展示项目治理与诊断信息，普通复习页面不会被这些字段打断。</p></div><div className="project-advanced-tabs" role="tablist">{sections.map(([value, label]) => <button key={value} role="tab" aria-selected={advancedSection === value} className={advancedSection === value ? "active" : ""} onClick={() => onAdvancedSection(value)}>{label}{value === "conflicts" && model.conflicts.length > 0 && <small>{model.conflicts.length}</small>}</button>)}</div>{advancedSection === "facts" && <ProjectFactTable facts={model.projectFacts} onSelect={onSelectFact} />}{advancedSection === "conflicts" && <div className="project-conflict-list-v5">{model.conflicts.map((group) => <button key={group.id} onClick={() => onSelectConflict(group)}><span><strong>{group.label}</strong><small>{group.facts.length} 个候选 · {group.facts.flatMap((fact) => fact.sourceIds).length} 个来源</small></span><em>待处理</em><b>→</b></button>)}{model.conflicts.length === 0 && <EmptyState title="没有待处理冲突" description="新的冲突会按同一信息组归并在这里。" />}</div>}{advancedSection === "review" && <div className="project-review-list-v5">{reviewFacts.map((fact) => <article key={fact.id}><div><strong>{fact.title}</strong><p>{cleanText(fact.content)}</p><small>原因：证据不足或需要本人确认</small></div><div><button className="dark-pill" onClick={() => onReviewFact(fact.id, "active")}>确认</button><button className="outline-pill" onClick={() => onSelectFact(fact)}>查看证据</button></div></article>)}{reviewFacts.length === 0 && <EmptyState title="没有系统待复核信息" description="当前没有需要集中处理的项目治理项。" />}</div>}{advancedSection === "stale" && <ProjectFactTable facts={model.staleFacts} onSelect={onSelectFact} />}{advancedSection === "analysis" && <div className="project-analysis-list-v5">{model.analysisRuns.map((run) => <div key={run.id}><strong>{run.runType}</strong><span>{run.status === "completed" ? "已完成" : run.status === "running" ? "进行中" : "失败"}</span><small>{new Date(run.updatedAt).toLocaleString()}</small></div>)}{model.analysisRuns.length === 0 && <EmptyState title="还没有分析记录" description="重新分析项目资料后会在这里留下记录。" />}</div>}</section>;
}

function ProjectDrawerContent({ drawer, model, sourceTitle, onClose, onResolveConflict, onReviewFact, onUpdateProject, selectedProject, onUnassignSource }: { drawer: DrawerState; model: ProjectLibraryDisplayModel; sourceTitle: (id: string) => string; onClose: () => void; onResolveConflict: (group: ProjectConflictGroup, fact: ProjectFact, keepBoth?: boolean, variantContexts?: Record<string, string>) => void; onReviewFact: (factId: string, status: "active" | "pending_review" | "rejected" | "conflicting") => void; onUpdateProject: (projectId: string, input: { ownershipMode?: OwnershipMode; ownershipNote?: string }) => Promise<void>; selectedProject: ProjectMemoryProject; onUnassignSource: (source: SourceRecord) => void }): JSX.Element {
  if (drawer.kind === "parameter") {
    const fact = drawer.fact;
    const group = model.conflicts.find((item) => item.facts.some((candidate) => candidate.id === fact.id));
    return <Drawer title={fact.title} eyebrow="关键参数" onClose={onClose}><div className="project-drawer-value"><span>当前值</span><strong>{factValue(fact)}</strong></div>{group && <div className="project-drawer-conflict"><strong>这个参数有多个候选值</strong>{group.facts.map((candidate) => <div key={candidate.id}><div><b>{factValue(candidate)}</b><small>来源：{candidate.sourceIds.map(sourceTitle).join("、") || "未关联"}</small></div><button className="outline-pill" onClick={() => onResolveConflict(group, candidate)}>采用此版本</button></div>)}</div>}<dl className="project-drawer-meta"><div><dt>来源</dt><dd>{fact.sourceIds.map(sourceTitle).join("、") || "未关联"}</dd></div><div><dt>证据</dt><dd>{fact.evidence?.[0]?.quote || "暂无引用"}</dd></div><div><dt>更新时间</dt><dd>{fact.updatedAt ? new Date(fact.updatedAt).toLocaleString() : "—"}</dd></div></dl></Drawer>;
  }
  if (drawer.kind === "conflict") return <ConflictDrawer group={drawer.group} sourceTitle={sourceTitle} onClose={onClose} onResolve={(fact, keepBoth, variantContexts) => onResolveConflict(drawer.group, fact, keepBoth, variantContexts)} />;
  if (drawer.kind === "fact") return <Drawer title={drawer.fact.title} eyebrow="高级数据 · 事实库" onClose={onClose}><p className="project-drawer-content">{cleanText(drawer.fact.content)}</p><div className="project-drawer-meta-line">状态：{statusLabel(drawer.fact)} · 证据：{evidenceCount(drawer.fact)} 个来源</div>{drawer.fact.evidence?.map((item) => <blockquote className="project-evidence-quote" key={`${item.sourceId}-${item.quote}`}><small>{sourceTitle(item.sourceId)}</small><p>“{item.quote}”</p></blockquote>)}{isFactUserActionRequired(drawer.fact, selectedProject.ownershipMode) && <button className="dark-pill" onClick={() => onReviewFact(drawer.fact.id, "active")}>确认这条信息</button>}</Drawer>;
  if (drawer.kind === "source") { const source = drawer.source; const id = String(source.sourceId ?? source.id ?? ""); const supported = model.projectFacts.filter((fact) => fact.sourceIds.includes(id)).length; return <Drawer title={String(source.title ?? source.sourceId ?? "项目资料")} eyebrow="资料证据" onClose={onClose}><dl className="project-drawer-meta"><div><dt>文件信息</dt><dd>{String(source.documentType ?? "项目资料")} · {String(source.status ?? "已就绪")}</dd></div><div><dt>绑定角色</dt><dd>{sourceRoleLabel(source.sourceRole)}</dd></div><div><dt>支持信息数</dt><dd>{supported}</dd></div><div><dt>最近分析</dt><dd>{source.updatedAt ? new Date(Number(source.updatedAt)).toLocaleString() : "—"}</dd></div></dl><button className="text-button danger-text" onClick={() => { onUnassignSource(source); onClose(); }}>解除绑定</button></Drawer>; }
  if (drawer.kind === "decision") return <Drawer title={`为什么${drawer.fact.title || "采用这个方案"}？`} eyebrow="决策与 Why" onClose={onClose}><p className="project-drawer-content">{cleanText(drawer.fact.content)}</p><p className="project-drawer-meta-line">{evidenceCount(drawer.fact)} 个来源 · {drawer.fact.experienceRelation === "designed" ? "设计决策" : "技术方案"}</p>{drawer.fact.evidence?.map((item) => <blockquote className="project-evidence-quote" key={`${item.sourceId}-${item.quote}`}><small>{sourceTitle(item.sourceId)}</small><p>“{item.quote}”</p></blockquote>)}</Drawer>;
  return <ProjectSettingsDrawer project={selectedProject} onClose={onClose} onUpdate={onUpdateProject} />;
}

function ConflictDrawer({ group, sourceTitle, onClose, onResolve }: { group: ProjectConflictGroup; sourceTitle: (id: string) => string; onClose: () => void; onResolve: (fact: ProjectFact, keepBoth?: boolean, variantContexts?: Record<string, string>) => void }): JSX.Element {
  const keepBoth = (): void => {
    const contexts: Record<string, string> = {};
    for (const [index, fact] of group.facts.entries()) {
      const answer = window.prompt(`请说明“${fact.content}”的版本关系`, index === 0 ? "early-version" : "later-version");
      if (!answer?.trim()) return;
      contexts[fact.id] = answer.trim();
    }
    onResolve(group.facts[0], true, contexts);
  };
  return <Drawer title={group.label} eyebrow="高级数据 · 冲突" onClose={onClose}><p className="project-drawer-lead">发现 {group.facts.length} 个候选值，请选择当前回答采用的版本。</p><div className="project-candidate-list">{group.facts.map((fact) => <div key={fact.id}><div><strong>{factValue(fact)}</strong><small>来源：{fact.sourceIds.map(sourceTitle).join("、") || "未关联"}</small>{fact.evidence?.[0] && <blockquote>“{fact.evidence[0].quote}”</blockquote>}</div><button className="dark-pill" onClick={() => onResolve(fact)}>采用此版本</button></div>)}</div><button className="outline-pill" onClick={keepBoth}>两个版本都正确</button></Drawer>;
}

function ProjectSettingsDrawer({ project, onClose, onUpdate }: { project: ProjectMemoryProject; onClose: () => void; onUpdate: (projectId: string, input: { ownershipMode?: OwnershipMode; ownershipNote?: string }) => Promise<void> }): JSX.Element {
  const [mode, setMode] = useState<OwnershipMode>(normalizeProjectOwnershipMode(project.ownershipMode) as OwnershipMode);
  const [note, setNote] = useState(project.ownershipNote ?? "");
  return <Drawer title="项目设置" eyebrow="PROJECT" onClose={onClose}><label className="clean-field"><span>项目归属</span><select value={mode} onChange={(event) => setMode(event.target.value as OwnershipMode)}><option value="personal">个人项目</option><option value="team">团队项目</option><option value="partial">我只负责部分</option><option value="reference">参考项目</option></select></label><label className="clean-field"><span>{mode === "partial" ? "我的负责边界" : mode === "personal" ? "项目备注（可选）" : "边界说明"}</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} placeholder={mode === "personal" ? "可记录项目范围或复习备注" : "说明哪些模块由你负责、哪些由团队负责"} /></label><p className="project-muted">项目名称和资料绑定仍由项目库统一管理。</p><button className="dark-pill" onClick={async () => { await onUpdate(project.id, { ownershipMode: mode, ...(note.trim() ? { ownershipNote: note.trim() } : {}) }); onClose(); }}>保存设置</button></Drawer>;
}

function CreateProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate?: (input: { name: string; ownershipMode: OwnershipMode; ownershipNote?: string }) => Promise<void> }): JSX.Element {
  const [name, setName] = useState("新项目");
  const [mode, setMode] = useState<OwnershipMode>("personal");
  const [note, setNote] = useState("");
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="project-create-title"><div className="modal-card project-create-modal"><h2 id="project-create-title">新建项目</h2><p className="page-note">先定义项目归属，后续回答会按这个边界控制第一人称。</p><label className="clean-field"><span>项目名称</span><input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label><label className="clean-field"><span>项目归属</span><select value={mode} onChange={(event) => setMode(event.target.value as OwnershipMode)}><option value="personal">个人项目</option><option value="team">团队项目</option><option value="partial">我只负责部分</option><option value="reference">参考项目</option></select></label>{mode !== "personal" && <label className="clean-field"><span>边界说明</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="哪些部分由你负责，哪些是团队或参考内容" /></label>}<div className="detail-actions"><button className="dark-pill" disabled={!name.trim() || !onCreate} onClick={async () => { await onCreate?.({ name: name.trim(), ownershipMode: mode, ...(note.trim() ? { ownershipNote: note.trim() } : {}) }); onClose(); }}>创建</button><button className="outline-pill" onClick={onClose}>取消</button></div></div></div>;
}

type DrawerState =
  | { kind: "parameter"; fact: ProjectFact }
  | { kind: "decision"; fact: ProjectFact }
  | { kind: "conflict"; group: ProjectConflictGroup }
  | { kind: "fact"; fact: ProjectFact }
  | { kind: "source"; source: SourceRecord }
  | { kind: "settings" };

export function ProjectLibraryPage(props: ProjectLibraryPageProps): JSX.Element {
  const [selectedProjectId, setSelectedProjectId] = useState(props.selectedProjectId ?? props.memory.projects[0]?.id ?? "");
  const [section, setSection] = useState<ProjectSection>("overview");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedSection, setAdvancedSection] = useState<AdvancedSection>("conflicts");
  const [completeness, setCompleteness] = useState<ProjectCompletenessResult>();
  const [projectLoading, setProjectLoading] = useState(true);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>();
  const [selectedProblemId, setSelectedProblemId] = useState<string>();
  const [parameterSearch, setParameterSearch] = useState("");
  const [parameterCategory, setParameterCategory] = useState("全部");
  const [responsibilityInput, setResponsibilityInput] = useState("");
  const [agentInput, setAgentInput] = useState("");
  const [sourceDialog, setSourceDialog] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [selectedSourceRoles, setSelectedSourceRoles] = useState<Array<ProjectSourceRole | "auto">>([]);
  const [sourceImporting, setSourceImporting] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

  const selectedProject = props.memory.projects.find((project) => project.id === selectedProjectId) ?? props.memory.projects[0];
  const analysisJob = selectedProject ? props.analysisJobs.find((job) => job.projectId === selectedProject.id) : undefined;
  const analysisActive = Boolean(analysisJob && ["queued", "mapping", "exploring", "synthesizing", "grounding"].includes(analysisJob.status));
  const analysisRebuilding = props.rebuilding || analysisActive;
  useEffect(() => { if (props.selectedProjectId && props.memory.projects.some((project) => project.id === props.selectedProjectId)) setSelectedProjectId(props.selectedProjectId); }, [props.selectedProjectId, props.memory.projects]);
  useEffect(() => { if (!selectedProject && props.memory.projects[0]) setSelectedProjectId(props.memory.projects[0].id); }, [props.memory.projects, selectedProject]);
  useEffect(() => {
    if (!selectedProject) return;
    let cancelled = false;
    setProjectLoading(true);
    setCompleteness(undefined);
    Promise.all([
      window.interviewCopilot.projectMemory.completeness(props.profileId, selectedProject.id),
      window.interviewCopilot.projectMemory.sources(selectedProject.id)
    ]).then(([nextCompleteness, nextSources]) => {
      if (cancelled) return;
      setCompleteness(nextCompleteness as ProjectCompletenessResult);
      setSources((nextSources ?? []) as SourceRecord[]);
      setProjectLoading(false);
    }).catch(() => { if (!cancelled) { setCompleteness(undefined); setSources([]); setProjectLoading(false); } });
    return () => { cancelled = true; };
  }, [props.profileId, selectedProject?.id, props.stats]);

  const projectFacts = selectedProject ? props.facts.filter((fact) => fact.projectId === selectedProject.id) : [];
  const staleFacts = selectedProject ? (props.staleFacts ?? []).filter((fact) => fact.projectId === selectedProject.id) : [];
  const latestSourceUpdatedAt = sources.reduce((latest, source) => Math.max(latest, Number(source.updatedAt ?? 0)), 0);
  const selectedUnderstanding = selectedProject ? props.memory.understandings?.find((item) => item.projectId === selectedProject.id) ?? (props.memory.understanding?.projectId === selectedProject.id ? props.memory.understanding : undefined) : undefined;
  const model = useMemo(() => selectedProject ? deriveProjectLibraryViewModel({ project: selectedProject, facts: projectFacts, modules: props.memory.modules, problems: props.memory.problems, questions: props.memory.interviewQuestions, understanding: selectedUnderstanding, sourceCount: sources.length, staleFactCount: staleFacts.length, completeness, analysisRuns: props.analysisRuns, analysisRunning: analysisRebuilding, latestSourceUpdatedAt }) : undefined, [selectedProject, projectFacts, props.memory.modules, props.memory.problems, props.memory.interviewQuestions, selectedUnderstanding, sources.length, staleFacts.length, completeness, props.analysisRuns, analysisRebuilding, latestSourceUpdatedAt]);
  const sourceTitle = (sourceId: string): string => String(sources.find((source) => String(source.sourceId ?? source.id) === sourceId)?.title ?? sourceId);
  const currentMessages = props.agentProjectId === selectedProject?.id ? props.agentMessages : [];

  if (!selectedProject || !model) return <section className="simple-page project-library-v5 project-library-empty"><div className="project-library-page-heading"><div><span className="project-eyebrow">PROJECT LIBRARY</span><h1>项目库</h1><p>把项目资料整理成可以快速复习、可以放心回答的工程经验。</p></div><button className="dark-pill" onClick={() => setCreateProjectOpen(true)}>添加项目</button></div><EmptyState title="还没有项目" description="创建一个项目，再上传 README、源码或排查记录。" action={<button className="dark-pill" onClick={() => setCreateProjectOpen(true)}>创建第一个项目</button>} />{createProjectOpen && <CreateProjectModal onClose={() => setCreateProjectOpen(false)} onCreate={props.onCreateProject} />}</section>;
  const displayModel: ProjectLibraryDisplayModel = { ...model, projectFacts, staleFacts, analysisRuns: props.analysisRuns };

  const selectProject = (projectId: string): void => { setSelectedProjectId(projectId); props.onSelectProject?.(projectId); setSection("overview"); setAdvancedOpen(false); setDrawer(undefined); };
  const selectSection = (next: ProjectSection): void => { setSection(next); setAdvancedOpen(false); setDrawer(undefined); };
  const selectProblem = (problem: ProjectProblem): void => { setSelectedProblemId(problem.id); setSection("problems"); };
  const resolveConflict = async (group: ProjectConflictGroup, fact: ProjectFact, keepBoth = false, variantContexts?: Record<string, string>): Promise<void> => { await props.onResolveConflict(group.id, fact.id, keepBoth, variantContexts); setDrawer(undefined); };
  const sendAgent = async (): Promise<void> => { if (!agentInput.trim() || props.agentSending) return; const input = agentInput.trim(); setAgentInput(""); await props.onSendAgent(model.project.id, input); };
  const openAddSource = (): void => { setSelectedFiles([]); setSelectedSourceRoles([]); setSourceDialog(true); };
  const sourceRoleOptions: Array<[ProjectSourceRole | "auto", string]> = [["auto", "自动识别（推荐）"], ["overview", "项目说明 / README"], ["code", "源码 / Repo"], ["architecture", "架构 / 技术设计"], ["debug", "问题排查"], ["test", "测试 / 结果"], ["resume", "简历项目经历"], ["responsibility", "职责说明"], ["reference", "参考资料"], ["other", "其他"]];
  const closeSourceDialog = (): void => { if (sourceImporting) return; setSourceDialog(false); setSelectedFiles([]); setSelectedSourceRoles([]); };
  const startProjectImport = async (): Promise<void> => {
    if (selectedFiles.length === 0 || sourceImporting) return;
    const duplicateNames = selectedFiles.filter((file) => sources.some((source) => String(source.title ?? "") === file.name)).map((file) => file.name);
    if (duplicateNames.length > 0 && !window.confirm(`以下资料已存在：${[...new Set(duplicateNames)].join("、")}。继续导入会按现有策略保存为新版本，是否继续？`)) return;
    setSourceImporting(true);
    try {
      if (!selectedProject) return;
      const result = await props.onImportProjectMaterials(selectedProject.id, selectedFiles.map((file, index) => ({ file, sourceRole: selectedSourceRoles[index] ?? "auto" })));
      if (result) { setSourceDialog(false); setSelectedFiles([]); setSelectedSourceRoles([]); }
    } finally {
      setSourceImporting(false);
    }
  };

  return <section className="project-library-v5">
    <div className="project-library-page-heading"><div><span className="project-eyebrow">PROJECT LIBRARY</span><h2>我的项目</h2></div><div className="project-library-heading-actions"><button className="outline-pill" onClick={() => setCreateProjectOpen(true)}>添加项目</button><button className="dark-pill" onClick={openAddSource}>添加资料</button></div></div>
     <div className="project-workspace-grid"><div className="project-workspace-content">{projectLoading && <ProjectLoadingSkeleton />}<ProjectHeader project={model.project} summary={model.summary} sourceCount={model.status.sourceCount} sourceCoverage={model.completeness.sourceCoverageScore} updatedAt={latestSourceUpdatedAt} familiarity={model.familiarity} onEdit={() => setDrawer({ kind: "settings" })} /><ProjectTabs section={section} advancedOpen={advancedOpen} onSection={selectSection} onToggleAdvanced={() => setAdvancedOpen((value) => !value)} />{section === "overview" && <ProjectOverview model={model} onSection={selectSection} onSelectParameter={(fact) => setDrawer({ kind: "parameter", fact })} onSelectDecision={(fact) => setDrawer({ kind: "decision", fact })} onSelectProblem={selectProblem} onOpenSources={() => selectSection("sources")} onOpenQuestions={() => selectSection("questions")} onRebuild={() => props.onRebuild(model.project.id)} rebuilding={analysisRebuilding} analysisJob={analysisJob} onCancelAnalysis={() => void props.onCancelAnalysis(model.project.id, analysisJob?.id)} onRetryAnalysis={() => void props.onRetryAnalysis(model.project.id)} onAddSource={openAddSource} onNextAction={(type) => { if (type === "analyze_sources") props.onRebuild(model.project.id); else if (type === "missing_parameters") selectSection("parameters"); else if (type === "missing_decisions") selectSection("decisions"); else if (type === "conflict") { setAdvancedSection("conflicts"); selectSection("advanced"); } else openAddSource(); }} />}{section === "parameters" && <ProjectParameters model={model} search={parameterSearch} onSearch={setParameterSearch} category={parameterCategory} onCategory={setParameterCategory} onSelect={(fact) => setDrawer({ kind: "parameter", fact })} />}{section === "architecture" && <ProjectArchitecture model={model} />}{section === "decisions" && <ProjectDecisions model={model} onSelect={(fact) => setDrawer({ kind: "decision", fact })} />}{section === "problems" && <ProjectProblems model={model} selectedId={selectedProblemId} onSelect={(problem) => setSelectedProblemId(problem.id)} />}{section === "questions" && <ProjectQuestionBankPanel profileId={props.profileId} projectId={model.project.id} projectName={model.project.name} onImport={(file) => props.onImportProjectQuestionBank(model.project.id, file)} onGenerate={() => props.onGenerateProjectQa(model.project.id)} />}{section === "sources" && <ProjectSources facts={projectFacts} sources={sources} analysisStatus={model.analysisStatus} onSelect={(source) => setDrawer({ kind: "source", source })} onOpenSources={openAddSource} />}{section === "advanced" && <ProjectAdvanced model={displayModel} advancedSection={advancedSection} onAdvancedSection={setAdvancedSection} onSelectFact={(fact) => setDrawer({ kind: "fact", fact })} onSelectConflict={(group) => setDrawer({ kind: "conflict", group })} onReviewFact={(factId, status) => void props.onReviewFact(factId, status)} />}
      {section === "overview" && ["team", "partial"].includes(normalizeProjectOwnershipMode(model.project.ownershipMode)) && <div className="project-responsibility-inline"><label htmlFor="project-responsibility-v5">补充我的负责范围</label><div><textarea id="project-responsibility-v5" rows={2} value={responsibilityInput} onChange={(event) => setResponsibilityInput(event.target.value)} placeholder="补充你真实负责的模块、实现细节和边界" /><button className="outline-pill" disabled={!responsibilityInput.trim()} onClick={async () => { await props.onAddResponsibility(model.project.id, responsibilityInput.trim()); setResponsibilityInput(""); }}>保存范围</button></div></div>}
      {section === "overview" && <div className="project-agent-runtime-card"><header><div><span className="project-eyebrow">PROJECT AGENT</span><h2>项目资料整理助手</h2><p>问我参数、架构、设计决策、问题链或资料冲突，也可以整理项目介绍。</p></div><span className="project-agent-scope">当前项目 · {model.project.name}</span></header><div className="project-agent-quick-actions"><button onClick={() => setAgentInput("当前项目还缺哪些技术信息？")}>检查技术信息缺口</button><button onClick={() => setAgentInput("有哪些关键参数没有确认，哪些设计没有记录 Why？")}>检查参数与决策</button><button onClick={() => setAgentInput("问题链哪里不完整，当前资料有哪些冲突？")}>检查问题链与冲突</button></div><ProjectAgentRuntime model={model} messages={currentMessages} agentInput={agentInput} onInput={setAgentInput} onSend={() => void sendAgent()} sending={props.agentSending} onRetry={(messageId) => void props.onRetryAgent(messageId)} onSettings={props.onOpenSettings} /></div>}
    </div></div>
    {drawer && <ProjectDrawerContent drawer={drawer} model={displayModel} sourceTitle={sourceTitle} onClose={() => setDrawer(undefined)} onResolveConflict={(group, fact, keepBoth, variantContexts) => void resolveConflict(group, fact, keepBoth, variantContexts)} onReviewFact={(factId, status) => void props.onReviewFact(factId, status)} onUpdateProject={props.onUpdateProject} selectedProject={model.project} onUnassignSource={(source) => { void props.onUnassignSource(model.project.id, String(source.sourceType), String(source.sourceId)); }} />}
    {createProjectOpen && <CreateProjectModal onClose={() => setCreateProjectOpen(false)} onCreate={props.onCreateProject} />}
    {sourceDialog && <div className="modal-backdrop" role="dialog" aria-modal="true"><div className="modal-card project-create-modal project-import-modal"><h2>添加项目资料</h2><p className="page-note">当前项目：{model.project.name}。选择后先预览资料角色，点击“导入并分析”才会开始批量处理。</p><label className="dark-pill upload-project-action">选择文件<input type="file" multiple accept=".zip,.txt,.md,.pdf,.docx" disabled={sourceImporting} onChange={(event) => { const files = Array.from(event.target.files ?? []); setSelectedFiles(files); setSelectedSourceRoles(files.map(() => "auto")); event.target.value = ""; }} /></label>{selectedFiles.length > 0 && <div className="project-import-preview"><strong>已选择 {selectedFiles.length} 个文件</strong>{selectedFiles.map((file, index) => <div className="project-import-preview-row" key={`${file.name}-${index}`}><span><b>{file.name}</b><small>自动识别 → {sourceRoleLabel(inferProjectSourceRole(file.name))}</small></span><select aria-label={`${file.name}资料角色`} value={selectedSourceRoles[index] ?? "auto"} disabled={sourceImporting} onChange={(event) => setSelectedSourceRoles((current) => current.map((role, roleIndex) => roleIndex === index ? event.target.value as ProjectSourceRole | "auto" : role))}>{sourceRoleOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>)}</div>}<div className="detail-actions"><button className="dark-pill" disabled={selectedFiles.length === 0 || sourceImporting} onClick={() => void startProjectImport()}>{sourceImporting ? "导入并分析中…" : "导入并分析"}</button><button className="outline-pill" disabled={sourceImporting} onClick={closeSourceDialog}>取消</button></div></div></div>}
  </section>;
}
