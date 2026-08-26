import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { JSX } from "react";
import { create } from "zustand";
import type { AudioDevices, AudioDrift, AudioSidecarEvent, ProbeResult, RealtimeServerMessage } from "@interview-copilot/protocol";
import { QUESTION_BANK_TYPE_LABELS, QUESTION_BANK_TYPES, validateLlmModelConfiguration } from "@interview-copilot/shared";
import { QWEN_REALTIME_ASR_MODEL, QWEN_REALTIME_ASR_URL, type AsrProviderType, type ChatAction, type ChatResponse, type ProjectFact, type ProjectMemorySnapshot, type QuestionBankCoverageResult, type QuestionBankJobProfileRecord, type QuestionBankQuestionRecord, type QuestionBankSkillRecord, type QuestionBankType, type QuestionCandidate, type QuestionEvent, type SessionState, type TranscriptSnapshot } from "@interview-copilot/shared";
import type { Profile } from "@interview-copilot/shared";
import type { JobTargetRecord, KnowledgeAnalysisRunRecord, ProfileBuilderArtifactRecord, ProjectMemoryStats, QuestionBankAnswerCardInput, QuestionBankAnswerGenerationResult, QuestionBankBulkPatch, QuestionBankDuplicateCluster, QuestionBankImportResult, QuestionBankListOptions, QuestionBankQuestionInput, QuestionBankSkillInput, RetrievalRunRecord } from "../main/database";
import type { LlmModelProfileInput, ProviderCenterPublicConfig, PublicProviderSettings, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../shared/overlay-preferences";
import { chatFailureText } from "../shared/chat-errors";
import type { DiscoveredModel, ModelCatalogResult, ModelCategory } from "../main/model-catalog";
import { normalizeMeter, StableAnswerStateMachine } from "@interview-copilot/shared";
import type { CaptureProtectionState, HUDState, OverlayMode } from "../main/overlay-manager";
import type { WrittenTestState } from "../main/written-test-controller";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import { selectDeviceId } from "./device-selection";
import type { AppPage } from "./app/routes";
import { Sidebar } from "./layout/Sidebar";
import { WelcomeScreen } from "./chat/WelcomeScreen";
import { ChatComposer } from "./chat/ChatComposer";
import { OverlayRoot } from "./overlay/OverlayRoot";
import { AppDialog, type DialogState } from "./dialogs/AppDialog";
import { PageErrorBoundary } from "./components/ErrorBoundary";
import { KNOWLEDGE_DOCUMENT_TYPES, KNOWLEDGE_DOCUMENT_TYPE_LABELS, type KnowledgeDocumentType, type KnowledgeDocumentTypeOption } from "@interview-copilot/shared";

interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: string;
  model?: string;
  cancelReason?: string;
  errorCode?: string;
  charactersGenerated?: number;
  durationMs?: number;
  structuredResponse?: ChatResponse;
  createdAt: number;
}

interface ProjectItem { id: string; name: string; profileId?: string; createdAt: number; updatedAt: number; }
interface ConversationItem { id: string; projectId?: string; profileId?: string; title: string; createdAt: number; updatedAt: number; }

interface HistoryDetail {
  interview: { id: string; startedAt: number; endedAt?: number; profileId: string; projectId?: string; jobTargetId?: string; automationMode: string };
  transcripts: Array<{ id: string; source: "mic" | "remote"; text: string; createdAt: number; startMs: number; endMs: number }>;
  questions: Array<{ id: string; text: string; confidence: string; status: string; detectedAt: number }>;
  answers: Array<{ id: string; questionId: string; model: string; mode?: string; text: string; latencyFirstToken?: number; latencyTotal?: number; cancelReason?: string; createdAt: number; startedAt?: number; finishedAt?: number }>;
}

interface KnowledgeDocumentItem { id: string; filename: string; documentType: KnowledgeDocumentType; status: string; error?: string; }

interface KnowledgePageProps {
  knowledgeBases: Array<{ id: string; name: string }>;
  knowledgeBaseId: string;
  knowledgeDocuments: KnowledgeDocumentItem[];
  requestDialog: (dialog: DialogState) => Promise<string | boolean | undefined>;
  onSelectBase: (id: string) => void;
  onCreateBase: (name: string) => Promise<void>;
  onRenameBase: (id: string, name: string) => Promise<void>;
  onDeleteBase: (id: string, name: string) => Promise<void>;
  onUpload: (file: File, documentType: KnowledgeDocumentTypeOption) => Promise<void>;
  onUpdateType: (documentId: string, documentType: KnowledgeDocumentType) => Promise<void>;
  onReindex: (documentId: string) => Promise<void>;
  onDeleteDocument: (documentId: string) => Promise<void>;
}

function KnowledgePage(props: KnowledgePageProps): JSX.Element {
  const [uploadType, setUploadType] = useState<KnowledgeDocumentTypeOption>("auto");
  const [filterType, setFilterType] = useState<"all" | KnowledgeDocumentType>("all");
  const visibleDocuments = filterType === "all" ? props.knowledgeDocuments : props.knowledgeDocuments.filter((document) => document.documentType === filterType);
  const counts = props.knowledgeDocuments.reduce<Record<string, number>>((result, document) => { result[document.documentType] = (result[document.documentType] ?? 0) + 1; return result; }, {});
  return <section className="simple-page knowledge-page">
    <div className="page-heading"><div><span className="page-kicker">SOURCE LIBRARY</span><h1>资料库</h1><p className="page-note">保存原始简历、项目文档、代码压缩包和技术资料；项目库会基于这里的资料生成结构化知识。</p></div><button className="dark-pill" onClick={async () => { const name = await props.requestDialog({ kind: "form", title: "新建资料库", label: "资料库名称", defaultValue: "新资料库", required: true, confirmLabel: "创建" }); if (typeof name === "string" && name.trim()) await props.onCreateBase(name.trim()); }}>新建资料库</button></div>
    <div className="clean-list knowledge-list">{props.knowledgeBases.map((base) => <div className={`clean-list-row ${base.id === props.knowledgeBaseId ? "selected" : ""}`} key={base.id}><button className="row-main-button" onClick={() => props.onSelectBase(base.id)}><span>{base.name}</span><small>{base.id === props.knowledgeBaseId ? `${props.knowledgeDocuments.length} 个文档` : "查看文档"}</small></button><span className="row-actions"><button className="text-button" onClick={async () => { const name = await props.requestDialog({ kind: "form", title: "重命名知识库", label: "名称", defaultValue: base.name, required: true, confirmLabel: "保存" }); if (typeof name === "string") await props.onRenameBase(base.id, name); }}>重命名</button><button className="text-button danger-text" onClick={() => void props.onDeleteBase(base.id, base.name)}>删除</button></span></div>)}</div>
    <div className="knowledge-toolbar"><label className="knowledge-type-field"><span>上传文档类型</span><select value={uploadType} onChange={(event) => setUploadType(event.target.value as KnowledgeDocumentTypeOption)}><option value="auto">自动识别</option>{KNOWLEDGE_DOCUMENT_TYPES.map((type) => <option value={type} key={type}>{KNOWLEDGE_DOCUMENT_TYPE_LABELS[type]}</option>)}</select></label><label className="upload-document">＋ 导入 PDF / DOCX / TXT / MD / GitHub ZIP<input type="file" accept=".txt,.md,.pdf,.docx,.zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.onUpload(file, uploadType); event.target.value = ""; }} /></label></div>
    <div className="knowledge-filter-bar"><button className={filterType === "all" ? "active" : ""} onClick={() => setFilterType("all")}>全部 <small>{props.knowledgeDocuments.length}</small></button>{KNOWLEDGE_DOCUMENT_TYPES.map((type) => <button className={filterType === type ? "active" : ""} key={type} onClick={() => setFilterType(type)}>{KNOWLEDGE_DOCUMENT_TYPE_LABELS[type]} <small>{counts[type] ?? 0}</small></button>)}</div>
    <div className="clean-list document-list">{visibleDocuments.map((document) => <div className="clean-list-row knowledge-document-row" key={document.id}><div className="knowledge-document-main"><strong>{document.filename}</strong><span className={`knowledge-type-badge knowledge-type-${document.documentType}`}>{KNOWLEDGE_DOCUMENT_TYPE_LABELS[document.documentType]}</span></div><span className="row-actions"><select className="knowledge-document-type-select" value={document.documentType} onChange={(event) => void props.onUpdateType(document.id, event.target.value as KnowledgeDocumentType)} aria-label={`${document.filename} 文档类型`}>{KNOWLEDGE_DOCUMENT_TYPES.map((type) => <option value={type} key={type}>{KNOWLEDGE_DOCUMENT_TYPE_LABELS[type]}</option>)}</select><small className={`knowledge-status knowledge-status-${document.status}`}>{document.status === "ready" ? "已就绪" : document.status === "processing" ? "处理中" : "失败"}{document.error ? ` · ${document.error}` : ""}</small><button className="text-button" onClick={() => void props.onReindex(document.id)}>重建索引</button><button className="text-button danger-text" onClick={() => void props.onDeleteDocument(document.id)}>删除</button></span></div>)}{visibleDocuments.length === 0 && <div className="knowledge-empty"><strong>{filterType === "all" ? "还没有文档" : `暂无${KNOWLEDGE_DOCUMENT_TYPE_LABELS[filterType]}文档`}</strong><span>上传后系统会自动解析、分类并建立索引。</span></div>}</div>
  </section>;
}

interface ProjectLibraryPageProps {
  memory: ProjectMemorySnapshot;
  stats: ProjectMemoryStats;
  facts: ProjectFact[];
  documents: KnowledgeDocumentItem[];
  analysisRuns: KnowledgeAnalysisRunRecord[];
  rebuilding: boolean;
  onUploadProject: (file: File) => Promise<void>;
  onRebuild: () => void;
  onVerifyFact: (factId: string, verified: boolean) => Promise<void>;
  onOpenSources: () => void;
}

function ProjectLibraryPage(props: ProjectLibraryPageProps): JSX.Element {
  const [projectFilter, setProjectFilter] = useState("all");
  const visibleFacts = props.facts.filter((fact) => projectFilter === "all" || fact.projectId === projectFilter);
  const latestAnalysis = props.analysisRuns[0];
  const projectDocuments = props.documents.filter((document) => document.documentType === "project" || document.documentType === "technical-doc");
  const projectName = (projectId: string) => props.memory?.projects.find((project) => project.id === projectId)?.name ?? projectId;
  const projectAnalysis = (projectId: string) => { const runs = props.analysisRuns.filter((run) => run.projectId === projectId); const latest = runs[0]; const hasSuccess = runs.some((run) => run.status === "completed"); return latest?.status === "failed" && hasSuccess ? "旧数据" : latest?.status === "failed" ? "分析失败" : latest?.status === "running" ? "分析中" : latest?.status === "completed" ? "已分析" : "待分析"; };
  return <section className="simple-page project-library-page">
    <div className="page-heading"><div><span className="page-kicker">PROJECT KNOWLEDGE</span><h1>项目库</h1><p className="page-note">一个项目对应一组原始资料、结构化事实和项目面试问题；确认后的事实才会用于第一人称回答。</p><p className="page-note">导入资料只做本地解析和索引；点击“重新分析项目”后才会调用大模型。</p></div><div className="detail-actions"><label className="dark-pill upload-project-action">导入项目代码 / 文档<input type="file" accept=".zip,.txt,.md,.pdf,.docx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.onUploadProject(file); event.target.value = ""; }} /></label><button className="outline-pill" onClick={props.onOpenSources}>查看资料库</button><button className="outline-pill" disabled={props.rebuilding} onClick={props.onRebuild}>{props.rebuilding ? "分析中…" : "重新分析项目"}</button></div></div>
    <div className="detail-metrics personal-memory-stats project-library-stats"><span>项目 <strong>{props.stats.projects}</strong></span><span>模块 <strong>{props.stats.modules}</strong></span><span>技术点 <strong>{props.stats.technicalPoints}</strong></span><span>问题 <strong>{props.stats.problems}</strong></span><span>项目题 <strong>{props.stats.interviewQuestions}</strong></span><span>已确认事实 <strong>{props.facts.filter((fact) => fact.verified).length}</strong></span></div>
    <div className="project-library-status-grid"><article className="detail-sheet project-library-status-card"><h2>项目分析</h2><div className="governance-status-row"><span>状态</span><strong className={`governance-status-${latestAnalysis?.status ?? "empty"}`}>{latestAnalysis ? latestAnalysis.status === "completed" ? "已完成" : latestAnalysis.status === "running" ? "进行中" : "失败" : "未运行"}</strong></div><div className="governance-status-row"><span>最近更新</span><span>{latestAnalysis ? new Date(latestAnalysis.updatedAt).toLocaleString() : "—"}</span></div><p className="page-note">上传代码或文档后只建立本地索引；点击“重新分析项目”后，系统才会提取项目、模块、技术点、难点和面试问题。</p></article><article className="detail-sheet project-library-status-card"><h2>项目资料</h2>{projectDocuments.length === 0 ? <p className="page-note">暂无项目资料。建议上传项目技术文档或 GitHub ZIP。</p> : <div className="project-source-list">{projectDocuments.slice(0, 6).map((document) => <div className="project-source-row" key={document.id}><span>{document.filename}</span><small className={`knowledge-status knowledge-status-${document.status}`}>{document.status === "ready" ? "已就绪" : document.status === "processing" ? "处理中" : "失败"}</small></div>)}</div>}</article></div>
    {props.memory?.projects.length ? <div className="project-library-projects">{props.memory.projects.map((project) => <article className="detail-sheet project-library-project-card" key={project.id}><header><div><span className="page-kicker">PROJECT</span><h2>{project.name}</h2><p>{project.description || "项目背景待补充"}</p><small className={`knowledge-status knowledge-status-${projectAnalysis(project.id)}`}>{projectAnalysis(project.id)}{projectAnalysis(project.id) === "旧数据" ? "：当前显示为上一次成功分析结果" : ""}</small></div><span className="knowledge-type-badge">来源 {project.sourceIds.length}</span></header><div className="project-library-project-meta"><span><b>我的职责</b>{project.role || "待本人确认"}</span><span><b>技术栈</b>{project.technologyStack.join(" · ") || "待补充"}</span><span><b>硬件 / 软件</b>{[...project.hardware, ...project.software].join(" · ") || "待补充"}</span></div><div className="project-library-columns"><div><h3>模块与技术点</h3>{props.memory.modules.filter((item) => item.projectId === project.id).slice(0, 5).map((item) => <p key={item.id}><strong>{item.moduleName}</strong> {item.description}</p>)}{props.memory.technicalPoints.filter((item) => item.projectId === project.id).slice(0, 5).map((item) => <p key={item.id}><strong>{item.topic}</strong> {item.content}</p>)}</div><div><h3>问题与面试题</h3>{props.memory.problems.filter((item) => item.projectId === project.id).slice(0, 3).map((item) => <p key={item.id}><strong>{item.problem}</strong><br />解决：{item.solution}</p>)}{props.memory.interviewQuestions.filter((item) => item.projectId === project.id).slice(0, 4).map((item) => <p key={item.id}><strong>{item.question}</strong><br />{item.answerPoints.join("；")}</p>)}</div></div></article>)}</div> : <div className="knowledge-empty"><strong>还没有结构化项目</strong><span>从右上角导入项目代码或项目技术文档，系统会自动分析。</span></div>}
    <article className="detail-sheet project-facts-card"><div className="governance-facts-heading"><div><h2>项目事实审核</h2><p className="page-note">只有确认后的项目事实才会进入候选人的第一人称项目回答。</p></div><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">全部项目</option>{props.memory?.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></div><div className="clean-list governance-fact-list">{visibleFacts.slice(0, 30).map((fact) => <div className={`clean-list-row governance-fact-row ${fact.verified ? "verified" : ""}`} key={fact.id}><div><div className="governance-fact-title"><strong>{fact.title}</strong><span className="knowledge-type-badge">{PROJECT_FACT_LABELS[fact.type]}</span><small>{projectName(fact.projectId)}</small></div><p>{fact.content}</p><small>状态 {fact.verified ? "已确认" : fact.status === "conflicting" ? "冲突待审核" : fact.status === "pending_review" ? "待审核" : "待确认"} · 来源 {fact.sourceIds.length} · 置信度 {Math.round(fact.confidence * 100)}%</small></div><button className={fact.verified ? "outline-pill" : "dark-pill"} onClick={() => void props.onVerifyFact(fact.id, !fact.verified)}>{fact.verified ? "取消确认" : "确认事实"}</button></div>)}{visibleFacts.length === 0 && <div className="knowledge-empty"><strong>暂无事实</strong><span>分析项目后，这里会显示待确认的事实。</span></div>}</div></article>
  </section>;
}

interface JobTargetsPageProps {
  targets: JobTargetRecord[];
  onUploadJob: (file: File) => Promise<void>;
  onOpenProfile: () => void;
}

interface ProjectLibraryManagerProps extends ProjectLibraryPageProps {
  profileId: string;
  onReviewFact: (factId: string, status: "active" | "pending_review" | "rejected" | "conflicting") => Promise<void>;
  agentMessages: ChatMessage[];
  agentSending: boolean;
  agentProjectId?: string;
  onSendAgent: (projectId: string, content: string) => Promise<void>;
  onRetryAgent: (messageId: string) => Promise<void>;
  onOpenSettings: () => void;
  onApproveAgentAction: (messageId: string, action: ChatAction) => Promise<void>;
}

function ProjectLibraryManager(props: ProjectLibraryManagerProps): JSX.Element {
  const [selectedProjectId, setSelectedProjectId] = useState<string>(props.memory.projects[0]?.id ?? "");
  const [tab, setTab] = useState<"overview" | "facts" | "sources" | "questions">("overview");
  const [completeness, setCompleteness] = useState<Record<string, unknown>>();
  const [sources, setSources] = useState<Array<Record<string, unknown>>>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<ProjectFact>();
  const [agentInput, setAgentInput] = useState("");
  const selectedProject = props.memory.projects.find((project) => project.id === selectedProjectId) ?? props.memory.projects[0];
  useEffect(() => {
    if (!selectedProject) return;
    setSelectedProjectId(selectedProject.id);
    void window.interviewCopilot.projectMemory.completeness(props.profileId, selectedProject.id).then((value) => setCompleteness(value as Record<string, unknown> | undefined)).catch(() => setCompleteness(undefined));
    void window.interviewCopilot.projectMemory.sources(selectedProject.id).then((value) => setSources(value as Array<Record<string, unknown>>)).catch(() => setSources([]));
  }, [props.profileId, selectedProject?.id]);
  const projectFacts = selectedProject ? props.facts.filter((fact) => fact.projectId === selectedProject.id) : [];
  const dimensions = Array.isArray(completeness?.dimensions) ? completeness.dimensions as Array<Record<string, unknown>> : [];
  const projectQuestions = selectedProject ? props.memory.interviewQuestions.filter((question) => question.projectId === selectedProject.id) : [];
  const health = completeness?.dataHealth as Record<string, unknown> | undefined;
  const healthIssues = Array.isArray(health?.issues) ? health.issues as Array<Record<string, unknown>> : [];
  const timelineEvidence = projectFacts.find((fact) => fact.type === "timeline" && fact.title === "Git开发窗口");
  const score = (key: string): string => completeness?.[key] === undefined ? "—" : `${String(completeness[key])}%`;
  const statusText = (fact: ProjectFact): string => fact.status === "rejected" ? "已拒绝" : fact.status === "conflicting" ? "冲突" : fact.verified ? "已确认" : "待确认";
  const sourceTitle = (sourceId: string): string => String(sources.find((source) => source.sourceId === sourceId)?.title ?? sourceId);
  const visibleAgentMessages = props.agentProjectId === selectedProject?.id ? props.agentMessages.slice(-10) : [];
  const sendToAgent = async (): Promise<void> => {
    if (!selectedProject || !agentInput.trim() || props.agentSending) return;
    const content = agentInput.trim();
    setAgentInput("");
    await props.onSendAgent(selectedProject.id, content);
  };
  return <section className="simple-page project-library-manager">
    <div className="page-heading"><div><span className="page-kicker">PROJECT LIBRARY</span><h1>项目库</h1><p className="page-note">围绕项目背景、职责、证据和面试准备管理个人工程经验。</p></div><div className="detail-actions"><label className="dark-pill upload-project-action">导入项目资料<input type="file" accept=".zip,.txt,.md,.pdf,.docx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.onUploadProject(file); event.target.value = ""; }} /></label><button className="outline-pill" disabled={props.rebuilding} onClick={props.onRebuild}>{props.rebuilding ? "分析中…" : "重新分析"}</button></div></div>
    <div className="project-library-summary"><span>项目 <strong>{props.memory.projects.length}</strong></span><span>待确认事实 <strong>{props.facts.filter((fact) => !fact.verified && fact.status !== "rejected").length}</strong></span><span>冲突 <strong>{props.facts.filter((fact) => fact.status === "conflicting").length}</strong></span><span>项目题 <strong>{props.stats.interviewQuestions}</strong></span></div>
    <div className="project-library-switcher">{props.memory.projects.map((project) => <button className={project.id === selectedProject?.id ? "selected" : ""} key={project.id} onClick={() => { setSelectedProjectId(project.id); setTab("overview"); }}><strong>{project.name}</strong><small>{project.description || "项目背景待补充"}</small></button>)}{props.memory.projects.length === 0 && <div className="knowledge-empty"><strong>还没有结构化项目</strong><span>上传项目文档后重新分析。</span></div>}</div>
    {selectedProject && <>
      <header className="project-detail-heading"><div><span className="page-kicker">PROJECT DETAIL</span><h2>{selectedProject.name}</h2><p>{selectedProject.description || "项目背景待补充"}</p></div><span className="project-completeness-score">{score("interviewReadinessScore")}<small>面试准备度</small></span></header>
      <div className="project-memory-metrics"><div><span>资料覆盖</span><strong>{score("sourceCoverageScore")}</strong></div><div><span>人工确认</span><strong>{score("verificationScore")}</strong></div><div><span>面试准备</span><strong>{score("interviewReadinessScore")}</strong></div>{health?.needsReanalysis === true && <p className="page-note">项目资料需重新分析：{healthIssues.map((item) => String(item.message)).join("；")}</p>}</div>
      <nav className="project-detail-tabs" aria-label="项目详情"><button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>项目概览</button><button className={tab === "facts" ? "active" : ""} onClick={() => setTab("facts")}>项目事实 <small>{projectFacts.length}</small></button><button className={tab === "sources" ? "active" : ""} onClick={() => setTab("sources")}>资料与证据 <small>{sources.length}</small></button><button className={tab === "questions" ? "active" : ""} onClick={() => setTab("questions")}>项目面试题 <small>{projectQuestions.length}</small></button></nav>
      {tab === "overview" && <div className="project-overview-grid"><article className="detail-sheet"><h3>项目背景</h3><p>{selectedProject.description || "待补充"}</p><h3>个人职责</h3><p>{selectedProject.role || "待确认"}</p><h3>项目时间</h3><p>{selectedProject.time || "待补充"}</p>{!selectedProject.time && timelineEvidence && <small>辅助代码窗口：{timelineEvidence.content}</small>}</article><article className="detail-sheet"><h3>技术栈</h3><div className="tag-list">{selectedProject.technologyStack.map((item) => <span key={item}>{item}</span>)}{selectedProject.technologyStack.length === 0 && <small>待补充</small>}</div><h3>硬件</h3><div className="tag-list">{selectedProject.hardware.map((item) => <span key={item}>{item}</span>)}{selectedProject.hardware.length === 0 && <small>待补充</small>}</div><h3>软件</h3><div className="tag-list">{selectedProject.software.map((item) => <span key={item}>{item}</span>)}{selectedProject.software.length === 0 && <small>待补充</small>}</div></article><article className="detail-sheet completeness-card"><h3>项目资料状态</h3>{dimensions.map((dimension) => <div className="completeness-row" key={String(dimension.key)}><span>{String(dimension.label)}</span><strong className={`completeness-${String(dimension.sourceStatus ?? dimension.status)}`}>{dimension.sourceStatus === "covered" ? "已覆盖" : dimension.sourceStatus === "weak" ? "证据较弱" : dimension.sourceStatus === "conflicting" ? "有冲突" : dimension.missingKind === "not_measured" ? "未测量" : "待补充"}</strong></div>)}{dimensions.length === 0 && <p className="page-note">分析完成后显示资料状态。</p>}</article></div>}
      {tab === "facts" && <div className="fact-review-grid"><div className="project-fact-cards">{projectFacts.map((fact) => <article className={`fact-review-card fact-review-${fact.status ?? "active"}`} key={fact.id}><header><div><span className="fact-type-label">{PROJECT_FACT_LABELS[fact.type]}</span><h3>{fact.title}</h3></div><strong>{statusText(fact)}</strong></header><p>{fact.content}</p><div className="fact-evidence-line"><span>来源：{fact.sourceIds.map(sourceTitle).join("、") || "未关联"}</span><span>置信度：{Math.round(fact.confidence * 100)}%</span></div>{fact.evidence?.[0] && <button className="evidence-link" onClick={() => setSelectedEvidence(fact)}>查看证据：“{fact.evidence[0].quote.slice(0, 80)}”</button>}<footer>{fact.status !== "rejected" && <button className="dark-pill" onClick={() => void props.onReviewFact(fact.id, "active")}>{fact.verified ? "已确认" : fact.status === "conflicting" ? "采用此版本" : "确认"}</button>}{fact.status !== "rejected" && <button className="outline-pill" onClick={() => void props.onReviewFact(fact.id, "rejected")}>{fact.status === "conflicting" ? "排除此版本" : "不正确"}</button>}{fact.status === "rejected" && <button className="outline-pill" onClick={() => void props.onReviewFact(fact.id, "pending_review")}>恢复待确认</button>}</footer></article>)}{projectFacts.length === 0 && <div className="knowledge-empty"><strong>暂无项目事实</strong><span>重新分析或补充项目资料。</span></div>}</div><aside className="fact-review-summary"><strong>事实待办箱</strong><span>待确认 {projectFacts.filter((fact) => !fact.verified && fact.status !== "rejected").length}</span><span>冲突 {projectFacts.filter((fact) => fact.status === "conflicting").length}</span><span>已确认 {projectFacts.filter((fact) => fact.verified).length}</span><span>已拒绝 {projectFacts.filter((fact) => fact.status === "rejected").length}</span></aside></div>}
      {tab === "sources" && <div className="source-evidence-layout"><div className="source-detail-list">{sources.map((source) => <article className="source-detail-card" key={String(source.id)}><strong>{String(source.title)}</strong><span>{String(source.documentType ?? source.sourceType)} · {String(source.relationship ?? "supporting")}</span><small>{String(source.status ?? "未验证")} · {new Date(Number(source.updatedAt ?? Date.now())).toLocaleString()}</small></article>)}{sources.length === 0 && <div className="knowledge-empty"><strong>暂无绑定资料</strong><span>从资料库导入并绑定到项目。</span></div>}</div><aside className="evidence-drawer-placeholder"><h3>Evidence Drawer</h3>{selectedEvidence ? <><strong>{selectedEvidence.title}</strong>{selectedEvidence.evidence?.map((item) => <div className="evidence-quote" key={`${item.sourceId}-${item.quote}`}><small>{sourceTitle(item.sourceId)}</small><p>“{item.quote}”</p><span>confidence {Math.round(selectedEvidence.confidence * 100)}%</span></div>)}</> : <p className="page-note">在“项目事实”中点击证据即可查看来源引用。</p>}</aside></div>}
      {tab === "questions" && <div className="project-question-list">{projectQuestions.map((question) => <article className="project-question-card" key={question.id}><div><span className="fact-type-label">项目题</span><h3>{question.question}</h3><p>{question.answerPoints.join("；")}</p></div><aside><span>{question.factIds?.length ?? 0} 个关联事实</span><span>{question.stale ? "已过期" : "当前"}</span></aside></article>)}{projectQuestions.length === 0 && <div className="knowledge-empty"><strong>暂无项目面试题</strong><span>项目事实确认后重新生成。</span></div>}</div>}
      <section className="project-agent-panel" aria-label="项目资料 AI Agent">
        <header><div><span className="page-kicker">PROJECT AGENT</span><h3>项目资料整理助手</h3><p>基于当前项目资料找缺口、冲突和不确定项；任何写入都需要你确认。</p></div><span className="agent-scope-chip">当前项目 · {selectedProject.name}</span></header>
        <div className="project-agent-quick-actions"><button onClick={() => setAgentInput("检查当前项目资料中的冲突、缺失和不确定项，按优先级告诉我需要确认什么。")}>检查冲突与缺口</button><button onClick={() => setAgentInput("根据现有资料整理一份可以直接用于面试的项目介绍，并标出所有没有证据的说法。")}>整理面试项目介绍</button><button onClick={() => setAgentInput("基于已确认事实生成这个项目最可能被追问的问题和答题要点。")}>生成追问题库</button></div>
        <div className="project-agent-conversation">{visibleAgentMessages.length ? visibleAgentMessages.map((message) => { const failed = message.role === "assistant" && message.status === "failed"; return <article className={`project-agent-message ${message.role} ${failed ? "failed" : ""}`} key={message.id}><strong>{message.role === "user" ? "我" : "项目 Agent"}{failed ? " · 生成失败" : ""}</strong><MarkdownAnswer text={message.content || (message.status === "streaming" ? "正在分析项目资料…" : failed ? chatFailureText(message.errorCode, message.model) : "未返回内容")} />{failed && <div className="project-agent-recovery"><button className="outline-pill" disabled={props.agentSending} onClick={() => void props.onRetryAgent(message.id)}>重新生成</button><button className="outline-pill" onClick={props.onOpenSettings}>检查模型设置</button></div>}</article>; }) : <div className="knowledge-empty"><strong>从资料到可信项目库</strong><span>可以直接问“哪些地方冲突”“我的职责还缺什么证据”，也可以让 Agent 提议补充事实。它不会未经确认写入。</span></div>}</div>
        <ChatResponseSupplement messages={visibleAgentMessages} onApproveAction={props.onApproveAgentAction} />
        <div className="project-agent-composer"><textarea rows={3} value={agentInput} onChange={(event) => setAgentInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendToAgent(); } }} placeholder="告诉 Agent 你的真实职责、实现细节，或让它检查资料冲突…" /><button className="dark-pill" disabled={!agentInput.trim() || props.agentSending} onClick={() => void sendToAgent()}>{props.agentSending ? "分析中…" : "发送"}</button></div>
      </section>
    </>}
  </section>;
}

function JobTargetsPage(props: JobTargetsPageProps): JSX.Element {
  const activeTarget = props.targets.find((target) => target.status === "active") ?? props.targets[0];
  return <section className="simple-page job-targets-page">
    <div className="page-heading"><div><span className="page-kicker">JOB TARGETS</span><h1>岗位要求</h1><p className="page-note">岗位 JD 会被拆成可检索的岗位要求，并参与面试问题和答案生成。</p></div><div className="detail-actions"><label className="dark-pill upload-project-action">导入岗位 JD<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.onUploadJob(file); event.target.value = ""; }} /></label><button className="outline-pill" onClick={props.onOpenProfile}>管理档案 / 简历</button></div></div>
    <div className="detail-metrics personal-memory-stats"><span>岗位 <strong>{props.targets.length}</strong></span><span>当前要求 <strong>{activeTarget?.requirements.length ?? 0}</strong></span><span>高优先级 <strong>{activeTarget?.requirements.filter((item) => item.importance === "high").length ?? 0}</strong></span></div>
    {!activeTarget ? <div className="knowledge-empty"><strong>还没有岗位</strong><span>从右上角导入 JD，或在档案页面上传职位描述。</span></div> : <div className="job-target-layout"><article className="detail-sheet job-target-summary"><span className="page-kicker">ACTIVE TARGET</span><h2>{activeTarget.name}</h2><p>{activeTarget.description}</p><div className="governance-status-row"><span>状态</span><strong className="governance-status-completed">{activeTarget.status === "active" ? "当前使用" : "已停用"}</strong></div><p className="page-note">当前档案的 JD 会自动同步到这里。开始面试时可以选择具体岗位。</p></article><article className="detail-sheet job-requirements-card"><h2>岗位要求</h2><div className="governance-requirements job-requirement-list">{activeTarget.requirements.map((item) => <div className={`job-requirement-item governance-requirement-${item.importance}`} key={item.id}><span>{item.requirement}</span><small>{item.importance === "high" ? "重点" : item.importance === "low" ? "加分" : "常规"}</small></div>)}</div></article></div>}
  </section>;
}

function PersonalMemoryPage({ memory, stats, rebuilding, onRebuild }: { memory?: ProjectMemorySnapshot; stats: ProjectMemoryStats; rebuilding: boolean; onRebuild: () => void }): JSX.Element {
  return <section className="simple-page personal-memory-page">
    <div className="page-heading"><div><span className="page-kicker">PERSONAL ENGINEERING MEMORY</span><h1>个人知识</h1><p className="page-note">把简历、项目资料和面试记录整理成可追溯的工程经验，面试项目题优先使用这里的内容。</p></div><button className="dark-pill" disabled={rebuilding} onClick={onRebuild}>{rebuilding ? "分析中…" : "重新分析资料"}</button></div>
    <div className="detail-metrics personal-memory-stats"><span>项目 <strong>{stats.projects}</strong></span><span>模块 <strong>{stats.modules}</strong></span><span>技术点 <strong>{stats.technicalPoints}</strong></span><span>问题 <strong>{stats.problems}</strong></span><span>面试问题 <strong>{stats.interviewQuestions}</strong></span></div>
    {!memory || stats.projects === 0 ? <div className="knowledge-empty"><strong>还没有项目记忆</strong><span>先上传 Resume 或项目文档，系统会自动提取项目背景、职责、实现和问题解决过程。</span></div> : <div className="personal-memory-projects">{memory.projects.map((project) => <article className="personal-memory-project" key={project.id}><header><div><h2>{project.name}</h2><p>{project.description || "项目背景待补充"}</p></div><span className="knowledge-type-badge">证据 {project.sourceIds.length}</span></header><div className="personal-memory-meta"><span><b>我的职责</b>{project.role || "资料未明确记录"}</span><span><b>技术栈</b>{project.technologyStack.join(" · ") || "待补充"}</span><span><b>硬件 / 软件</b>{[...project.hardware, ...project.software].join(" · ") || "待补充"}</span></div><div className="personal-memory-columns"><div><h3>模块</h3>{memory.modules.filter((item) => item.projectId === project.id).map((item) => <p key={item.id}><strong>{item.moduleName}</strong> {item.description}</p>)}{memory.modules.filter((item) => item.projectId === project.id).length === 0 && <small>暂无结构化模块</small>}</div><div><h3>技术点</h3>{memory.technicalPoints.filter((item) => item.projectId === project.id).map((item) => <p key={item.id}><strong>{item.topic}</strong> {item.content}</p>)}{memory.technicalPoints.filter((item) => item.projectId === project.id).length === 0 && <small>暂无技术点</small>}</div><div><h3>遇到的问题</h3>{memory.problems.filter((item) => item.projectId === project.id).map((item) => <p key={item.id}><strong>{item.problem}</strong><br />原因：{item.cause}<br />解决：{item.solution}</p>)}{memory.problems.filter((item) => item.projectId === project.id).length === 0 && <small>暂无问题记录</small>}</div></div><details><summary>项目面试问题（{memory.interviewQuestions.filter((item) => item.projectId === project.id).length}）</summary>{memory.interviewQuestions.filter((item) => item.projectId === project.id).map((item) => <p key={item.id}><strong>{item.question}</strong><br />{item.answerPoints.join("；")}</p>)}</details></article>)}</div>}
  </section>;
}

const PROJECT_FACT_LABELS: Record<ProjectFact["type"], string> = {
  background: "项目背景",
  application: "应用场景",
  goal: "项目目标",
  responsibility: "个人职责",
  hardware: "硬件",
  software: "软件",
  architecture: "系统架构",
  module: "功能模块",
  technology: "技术实现",
  technical_decision: "技术方案",
  challenge: "问题与难点",
  decision: "设计取舍",
  cause: "问题原因",
  solution: "解决方案",
  result: "项目结果",
  metric: "量化指标",
  timeline: "项目时间",
  limitation: "限制与不足"
};

interface MemoryGovernancePanelProps {
  memory?: ProjectMemorySnapshot;
  facts: ProjectFact[];
  jobTargets: JobTargetRecord[];
  analysisRuns: KnowledgeAnalysisRunRecord[];
  retrievalRuns: RetrievalRunRecord[];
  onVerifyFact: (factId: string, verified: boolean) => Promise<void>;
}

function MemoryGovernancePanel(props: MemoryGovernancePanelProps): JSX.Element {
  const [projectFilter, setProjectFilter] = useState("all");
  const [busyFactId, setBusyFactId] = useState<string>();
  const activeJob = props.jobTargets.find((target) => target.status === "active") ?? props.jobTargets[0];
  const visibleFacts = props.facts.filter((fact) => projectFilter === "all" || fact.projectId === projectFilter);
  const verifiedCount = props.facts.filter((fact) => fact.verified).length;
  const latestAnalysis = props.analysisRuns[0];
  const latestRetrieval = props.retrievalRuns[0];
  const projectName = (projectId: string) => props.memory?.projects.find((project) => project.id === projectId)?.name ?? projectId;
  const verify = async (fact: ProjectFact) => {
    setBusyFactId(fact.id);
    try { await props.onVerifyFact(fact.id, !fact.verified); } finally { setBusyFactId(undefined); }
  };
  return <section className="simple-page memory-governance-panel">
    <div className="page-heading"><div><span className="page-kicker">KNOWLEDGE GOVERNANCE</span><h1>知识审核</h1><p className="page-note">AI 提取的事实先在这里确认；已确认事实才适合用于候选人的第一人称项目回答。</p></div></div>
    <div className="detail-metrics personal-memory-stats"><span>项目事实 <strong>{props.facts.length}</strong></span><span>已确认 <strong>{verifiedCount}</strong></span><span>岗位要求 <strong>{activeJob?.requirements.length ?? 0}</strong></span><span>检索记录 <strong>{props.retrievalRuns.length}</strong></span></div>
    <div className="memory-governance-grid">
      <article className="detail-sheet governance-card"><h2>当前岗位</h2>{activeJob ? <><strong>{activeJob.name}</strong><p>{activeJob.description.slice(0, 280)}</p><div className="governance-requirements">{activeJob.requirements.slice(0, 8).map((item) => <span className={`governance-requirement governance-requirement-${item.importance}`} key={item.id}>{item.requirement}</span>)}{activeJob.requirements.length > 8 && <small>还有 {activeJob.requirements.length - 8} 条</small>}</div></> : <p className="page-note">尚未上传岗位描述。</p>}</article>
      <article className="detail-sheet governance-card"><h2>分析与检索状态</h2><div className="governance-status-row"><span>项目分析</span><strong className={`governance-status-${latestAnalysis?.status ?? "empty"}`}>{latestAnalysis ? latestAnalysis.status === "completed" ? "已完成" : latestAnalysis.status === "running" ? "进行中" : "失败" : "未运行"}</strong></div><div className="governance-status-row"><span>最近分析</span><span>{latestAnalysis ? new Date(latestAnalysis.updatedAt).toLocaleString() : "—"}</span></div><div className="governance-status-row"><span>最近问题</span><span>{latestRetrieval?.query || "—"}</span></div><div className="governance-status-row"><span>最近命中</span><span>{latestRetrieval ? `${latestRetrieval.hits.length} 条 · ${latestRetrieval.route}` : "—"}</span></div></article>
    </div>
    <article className="detail-sheet governance-facts"><div className="governance-facts-heading"><div><h2>项目事实</h2><p className="page-note">确认后会提高检索可信度；取消确认不会删除原始资料。</p></div><select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">全部项目</option>{props.memory?.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></div><div className="clean-list governance-fact-list">{visibleFacts.map((fact) => <div className={`clean-list-row governance-fact-row ${fact.verified ? "verified" : ""}`} key={fact.id}><div><div className="governance-fact-title"><strong>{fact.title}</strong><span className="knowledge-type-badge">{PROJECT_FACT_LABELS[fact.type]}</span><small>{projectName(fact.projectId)}</small></div><p>{fact.content}</p><small>状态 {fact.verified ? "已确认" : fact.status === "conflicting" ? "冲突待审核" : fact.status === "pending_review" ? "待审核" : "待确认"} · 来源 {fact.sourceIds.length} · 置信度 {Math.round(fact.confidence * 100)}%</small></div><button className={fact.verified ? "outline-pill" : "dark-pill"} disabled={busyFactId === fact.id} onClick={() => void verify(fact)}>{busyFactId === fact.id ? "保存中…" : fact.verified ? "取消确认" : "确认事实"}</button></div>)}{visibleFacts.length === 0 && <div className="knowledge-empty"><strong>暂无结构化事实</strong><span>先重新分析 Resume 或项目文档。</span></div>}</div></article>
  </section>;
}

function ChatResponseSupplement({ messages, onApproveAction }: { messages: ChatMessage[]; onApproveAction: (messageId: string, action: ChatAction) => Promise<void> }): JSX.Element | null {
  const latest = [...messages].reverse().find((message) => message.role === "assistant" && message.structuredResponse);
  const response = latest?.structuredResponse;
  if (!latest || !response || (!response.cards?.length && !response.actions?.length && !response.sources?.length)) return null;
  return <section className="chat-response-supplement" aria-label="结构化回答补充">
    {response.sources && response.sources.length > 0 && <div className="chat-response-sources"><span className="page-kicker">SOURCES</span>{response.sources.map((source) => <span className="chat-source-chip" key={source.id}>{source.label}</span>)}</div>}
    {response.cards && response.cards.length > 0 && <div className="chat-response-cards">{response.cards.map((card) => <article className={`chat-response-card chat-response-card-${card.kind}`} key={card.id}><span className="page-kicker">{card.kind.toUpperCase()}</span><strong>{card.title}</strong>{card.body && <p>{card.body}</p>}{card.data && <div className="chat-response-card-data">{Object.entries(card.data).slice(0, 8).map(([key, value]) => <span key={key}><small>{key}</small>{typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}</span>)}</div>}</article>)}</div>}
    {response.actions && response.actions.length > 0 && <div className="chat-response-actions"><div className="chat-response-actions-heading"><span className="page-kicker">REVIEW REQUIRED</span><strong>以下操作需要你确认后才会写入本地数据</strong></div>{response.actions.map((action) => <div className="chat-response-action" key={action.id}><div><strong>{action.label}</strong>{action.rationale && <p>{action.rationale}</p>}</div>{action.status === "approved" ? <span className="chat-action-status approved">已确认</span> : action.status === "failed" ? <span className="chat-action-status failed">执行失败</span> : <button className="dark-pill" onClick={() => void onApproveAction(latest.id, action)}>确认并执行</button>}</div>)}</div>}
  </section>;
}

interface QuestionBankPageProps {
  questions: QuestionBankQuestionRecord[];
  total: number;
  skills: QuestionBankSkillRecord[];
  jobs: QuestionBankJobProfileRecord[];
  onList: (options: QuestionBankListOptions) => Promise<QuestionBankQuestionRecord[]>;
  onCount: (options: Omit<QuestionBankListOptions, "limit" | "offset" | "sort">) => Promise<number>;
  onBulkUpdate: (questionIds: string[], patch: QuestionBankBulkPatch) => Promise<number>;
  onDuplicates: () => Promise<QuestionBankDuplicateCluster[]>;
  onMergeDuplicates: (canonicalId: string, duplicateIds: string[]) => Promise<QuestionBankQuestionRecord | undefined>;
  onSaveQuestion: (input: QuestionBankQuestionInput) => Promise<QuestionBankQuestionRecord | undefined>;
  onSaveAnswer: (input: QuestionBankAnswerCardInput) => Promise<unknown>;
  onDeleteQuestion: (questionId: string) => Promise<void>;
  onImport: (text: string, filename: string, options: { includeProject: boolean; includeBehavioral: boolean }) => Promise<QuestionBankImportResult | undefined>;
  onGenerateAnswers: (questionIds?: string[]) => Promise<QuestionBankAnswerGenerationResult | undefined>;
  answerGenerationProgress?: { status: "started" | "running" | "completed"; total: number; completed: number; generated: number; skipped: number; failed: number; questionId?: string; error?: string };
  onSaveSkill: (input: QuestionBankSkillInput) => Promise<void>;
  onLinkSkill: (questionId: string, skillId: string) => Promise<boolean>;
  onCoverage: (jobProfileId?: string) => Promise<QuestionBankCoverageResult>;
  onNotice: (message: string) => void;
}

function QuestionBankCoveragePanel({ result, jobs, jobProfileId, onJobProfileChange }: { result: QuestionBankCoverageResult; jobs: QuestionBankJobProfileRecord[]; jobProfileId: string; onJobProfileChange: (jobProfileId: string) => void }): JSX.Element {
  return <div className="question-bank-coverage detail-sheet"><div className="question-bank-editor-heading"><div><span className="page-kicker">SKILL COVERAGE</span><h2>题库技能覆盖分析</h2><p className="page-note">按岗位技能和技能知识点检查题目、答案卡与人工核验状态；缺口只作为补题建议，不会自动生成答案。</p></div><label className="clean-field"><span>分析范围</span><select value={jobProfileId} onChange={(event) => onJobProfileChange(event.target.value)}><option value="">全部技能</option>{jobs.map((job) => <option value={job.id} key={job.id}>{job.name}</option>)}</select></label></div><div className="detail-metrics question-bank-coverage-metrics"><span>整体覆盖 <strong>{result.overallCoverage}%</strong></span><span>待补技能 <strong>{result.missingSkills.length}</strong></span><span>技能主题 <strong>{result.topics.length}</strong></span></div><div className="question-bank-coverage-list">{result.topics.map((topic) => <article className="question-bank-coverage-row" key={topic.skillId}><div className="question-bank-coverage-row-heading"><strong>{topic.skill}</strong><b>{topic.coverage}%</b></div><div className="coverage-progress"><i style={{ width: `${Math.min(100, Math.max(0, topic.coverage))}%` }} /></div><small>题目 {topic.totalQuestions} · 有答案 {topic.answeredQuestions} · 已核验 {topic.verifiedQuestions}{topic.staleQuestions ? ` · 待复核 ${topic.staleQuestions}` : ""}</small>{topic.missingAreas.length > 0 && <p>缺口：{topic.missingAreas.join("、")}</p>}</article>)}{result.topics.length === 0 && <div className="knowledge-empty"><strong>暂无可分析技能</strong><span>先在技能资料中登记技能和知识点，再把题目挂接到技能。</span></div>}</div></div>;
}

function QuestionBankPage(props: QuestionBankPageProps): JSX.Element {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | QuestionBankType>("all");
  const [scopeFilter, setScopeFilter] = useState<"global" | "all">("global");
  const [selectedId, setSelectedId] = useState("");
  const [question, setQuestion] = useState("");
  const [type, setType] = useState<QuestionBankType>("technical");
  const [difficulty, setDifficulty] = useState("medium");
  const [jobRole, setJobRole] = useState("");
  const [variants, setVariants] = useState("");
  const [answer, setAnswer] = useState("");
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [includeProject, setIncludeProject] = useState(false);
  const [includeBehavioral, setIncludeBehavioral] = useState(true);
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<QuestionBankQuestionRecord[]>(props.questions);
  const [total, setTotal] = useState(props.total);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<QuestionBankDuplicateCluster[]>([]);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [coverage, setCoverage] = useState<QuestionBankCoverageResult>();
  const [coverageJobId, setCoverageJobId] = useState("");
  const [coverageLoading, setCoverageLoading] = useState(false);
  const pageSize = 60;
  const selected = rows.find((item) => item.id === selectedId) ?? props.questions.find((item) => item.id === selectedId);
  const visibleQuestions = rows;

  useEffect(() => {
    setRows(props.questions);
    setTotal(props.total);
  }, [props.questions, props.total]);

  useEffect(() => {
    let cancelled = false;
    const options: QuestionBankListOptions = { search: search.trim() || undefined, type: typeFilter === "all" ? undefined : typeFilter, scope: scopeFilter === "all" ? undefined : "global", status: "active", limit: pageSize, offset: page * pageSize, sort: "updated" };
    void Promise.all([props.onList(options), props.onCount(options)]).then(([nextRows, nextTotal]) => {
      if (!cancelled) { setRows(nextRows); setTotal(nextTotal); }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [page, scopeFilter, search, typeFilter]);

  const resetForm = () => {
    setSelectedId(""); setQuestion(""); setType("technical"); setDifficulty("medium"); setJobRole(""); setVariants(""); setAnswer(""); setCode(""); setVerified(false); setSelectedSkillIds([]);
  };
  const selectQuestion = (item: QuestionBankQuestionRecord) => {
    const card = item.answerCards[0];
    setSelectedId(item.id); setQuestion(item.canonicalText); setType(item.type); setDifficulty(item.difficulty); setJobRole(item.jobRole ?? ""); setVariants(item.variants.join("\n")); setAnswer(card?.content ?? ""); setCode(card?.codeContent ?? ""); setVerified(card?.verified ?? false); setSelectedSkillIds(item.skillIds);
  };
  const toggleSelection = (questionId: string) => setSelectedIds((current) => current.includes(questionId) ? current.filter((id) => id !== questionId) : [...current, questionId]);
  const bulkUpdate = async (patch: QuestionBankBulkPatch) => {
    if (selectedIds.length === 0) { props.onNotice("请先选择题目"); return; }
    const count = await props.onBulkUpdate(selectedIds, patch);
    setSelectedIds([]);
    props.onNotice(`已批量更新 ${count} 道题目`);
    const next = await props.onList({ search: search.trim() || undefined, type: typeFilter === "all" ? undefined : typeFilter, scope: scopeFilter === "all" ? undefined : "global", status: "active", limit: pageSize, offset: page * pageSize, sort: "updated" });
    setRows(next);
  };
  const loadDuplicates = async () => {
    const next = await props.onDuplicates();
    setDuplicates(next);
    setShowDuplicates(true);
  };
  const loadCoverage = async (jobProfileId = coverageJobId) => {
    setCoverageLoading(true);
    try { setCoverage(await props.onCoverage(jobProfileId || undefined)); }
    catch (error) { props.onNotice(`技能覆盖分析失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setCoverageLoading(false); }
  };
  const save = async () => {
    if (!question.trim()) { props.onNotice("题目不能为空"); return; }
    try {
      const saved = await props.onSaveQuestion({ id: selectedId || undefined, canonicalText: question, type, difficulty, jobRole, variants: variants.split("\n").map((item) => item.trim()).filter(Boolean) });
      if (!saved) throw new Error("题目保存失败");
      if (answer.trim() || code.trim()) await props.onSaveAnswer({ id: selected?.answerCards[0]?.id, questionId: saved.id, mode: type === "code" ? "code" : "standard", content: answer, codeContent: code || undefined, verified, sourceType: selected?.answerCards[0]?.sourceType ?? "manual" });
      await Promise.all(selectedSkillIds.map((skillId) => props.onLinkSkill(saved.id, skillId)));
      setSelectedId(saved.id);
      props.onNotice("题目和答案卡已保存");
    } catch (error) { props.onNotice(`题库保存失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const result = await props.onImport(await file.text(), file.name, { includeProject, includeBehavioral });
      if (result) {
        props.onNotice(`识别 ${result.recognizedQuestions} 条 · 导入 ${result.importedQuestions} 条 · 过滤项目题 ${result.filteredProjectQuestions} 条 · 合并重复 ${result.duplicatesMerged} 条；答案不会自动生成，请点击“生成缺失答案”`);
      }
    } catch (error) { props.onNotice(`题库导入失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const saveSkill = async () => {
    if (!skillName.trim()) { props.onNotice("技能名称不能为空"); return; }
    await props.onSaveSkill({ name: skillName, description: skillDescription });
    setSkillName(""); setSkillDescription("");
  };

  return <section className="simple-page question-bank-page">
    <div className="page-heading"><div><span className="page-kicker">QUESTION BANK</span><h1>题库</h1><p className="page-note">经典问题优先本地命中；代码题保留完整代码、复杂度和边界；技能资料可作为岗位准备素材。</p></div><div className="detail-actions"><label className="outline-pill question-bank-import">导入题库文件<input type="file" accept=".txt,.md,.json" onChange={(event) => void importFile(event)} /></label><button className="dark-pill" onClick={resetForm}>新增问题</button></div></div>
    <div className="question-bank-import-options"><label className="check-row"><input type="checkbox" checked={!includeProject} onChange={(event) => setIncludeProject(!event.target.checked)} />只导入非项目题</label><label className="check-row"><input type="checkbox" checked={includeBehavioral} onChange={(event) => setIncludeBehavioral(event.target.checked)} />保留行为题</label></div>
    <div className="question-bank-analysis-toolbar"><button className="outline-pill" disabled={coverageLoading} onClick={() => void loadCoverage()}>{coverageLoading ? "分析中…" : coverage ? "刷新技能覆盖分析" : "技能覆盖分析"}</button>{coverage && <span className="page-note">当前整体覆盖 {coverage.overallCoverage}%</span>}</div>
    {coverage && <QuestionBankCoveragePanel result={coverage} jobs={props.jobs} jobProfileId={coverageJobId} onJobProfileChange={(next) => { setCoverageJobId(next); void loadCoverage(next); }} />}
    <div className="question-bank-toolbar"><input className="inline-search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="搜索问题、岗位或关键词" /><select value={scopeFilter} onChange={(event) => { setScopeFilter(event.target.value as "global" | "all"); setPage(0); }}><option value="global">通用题库</option><option value="all">全部题目</option></select><select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value as "all" | QuestionBankType); setPage(0); }}><option value="all">全部题型</option>{QUESTION_BANK_TYPES.map((item) => <option value={item} key={item}>{QUESTION_BANK_TYPE_LABELS[item]}</option>)}</select><button className="outline-pill" disabled={props.answerGenerationProgress?.status === "running" || props.answerGenerationProgress?.status === "started"} onClick={() => void props.onGenerateAnswers(selectedIds.length ? selectedIds : undefined)}>{props.answerGenerationProgress?.status === "running" || props.answerGenerationProgress?.status === "started" ? `生成答案 ${props.answerGenerationProgress.completed}/${props.answerGenerationProgress.total}` : selectedIds.length ? `生成选中答案（${selectedIds.length}）` : "生成缺失答案"}</button><button className="outline-pill" onClick={() => void loadDuplicates()}>检查重复题</button><span className="page-note">{total} 题 · 第 {page + 1} / {Math.max(1, Math.ceil(total / pageSize))} 页</span></div>
    <div className="question-bank-bulk-toolbar"><span>{selectedIds.length ? `已选择 ${selectedIds.length} 道` : "可勾选题目进行批量操作"}</span><button className="text-button" onClick={() => void bulkUpdate({ verified: true, stale: false })} disabled={!selectedIds.length}>标记已验证</button><button className="text-button" onClick={() => void bulkUpdate({ stale: true })} disabled={!selectedIds.length}>标记待复核</button><button className="text-button danger-text" onClick={() => void bulkUpdate({ status: "archived" })} disabled={!selectedIds.length}>归档</button><button className="text-button" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>清除选择</button></div>
    <div className="question-bank-layout"><div className="clean-list question-bank-list">{visibleQuestions.map((item) => <button className={`clean-list-row question-bank-row ${item.id === selectedId ? "selected" : ""}`} key={item.id} onClick={() => selectQuestion(item)}><input type="checkbox" checked={selectedIds.includes(item.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelection(item.id)} /><span><strong>{item.canonicalText}</strong><small>{QUESTION_BANK_TYPE_LABELS[item.type]} · {item.jobRole || "通用岗位"} · {item.answerCards.length ? "已有答案卡" : "待补答案"}{item.skillIds.length ? ` · ${item.skillIds.length} 个技能` : ""}{item.stale ? " · 待复核" : ""}</small></span><em>{item.answerCards.some((card) => card.verified) ? "已验证" : "草稿"}</em></button>)}{visibleQuestions.length === 0 && <div className="knowledge-empty"><strong>还没有匹配题目</strong><span>可以新增问题，或导入包含“问题：/答案：”的 TXT、MD 文件。</span></div>}<div className="question-bank-pagination"><button className="outline-pill" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button><button className="outline-pill" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((current) => current + 1)}>下一页</button></div></div><div className="detail-sheet question-bank-editor question-bank-editor-drawer"><div className="question-bank-editor-heading"><div><span className="page-kicker">ANSWER CARD</span><h2>{selected ? "编辑题目" : "新增题目"}</h2></div><div className="detail-actions">{selected && <button className="text-button danger-text" onClick={async () => { await props.onDeleteQuestion(selected.id); resetForm(); }}>删除</button>}{selected && <button className="text-button" onClick={resetForm}>关闭</button>}</div></div><label className="clean-field"><span>问题</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} placeholder="例如：IIC 通讯读不到数据时，如何定位？" /></label><div className="question-bank-form-grid"><label className="clean-field"><span>题型</span><select value={type} onChange={(event) => setType(event.target.value as QuestionBankType)}>{QUESTION_BANK_TYPES.map((item) => <option value={item} key={item}>{QUESTION_BANK_TYPE_LABELS[item]}</option>)}</select></label><label className="clean-field"><span>难度</span><select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label></div><div className="question-bank-form-grid"><label className="clean-field"><span>适用岗位</span><input value={jobRole} onChange={(event) => setJobRole(event.target.value)} placeholder="嵌入式 / 电机控制 / 通用" /></label><label className="clean-field"><span>问题变体（每行一个）</span><input value={variants} onChange={(event) => setVariants(event.target.value)} placeholder="同义问法，增强召回" /></label></div><div className="question-bank-skill-selector"><span>关联技能（用于覆盖分析）</span><div>{props.skills.length ? props.skills.map((skill) => <label className="check-row" key={skill.id}><input type="checkbox" checked={selectedSkillIds.includes(skill.id)} onChange={() => setSelectedSkillIds((current) => current.includes(skill.id) ? current.filter((id) => id !== skill.id) : [...current, skill.id])} />{skill.name}</label>) : <small>暂无技能，请先在下方技能资料中新增。</small>}</div></div><label className="clean-field"><span>标准回答</span><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={7} placeholder="按当前题型整理回答；项目题只填写真实经历素材。" /></label>{type === "code" && <label className="clean-field"><span>完整代码</span><textarea className="code-editor" value={code} onChange={(event) => setCode(event.target.value)} rows={8} placeholder="保留可运行代码、边界处理和复杂度说明。" /></label>}<label className="check-row"><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} />答案已人工核验，允许作为优先参考答案</label><div className="detail-actions"><button className="dark-pill" onClick={() => void save()}>保存题目</button><button className="outline-pill" onClick={resetForm}>清空</button></div></div></div>
    {showDuplicates && <div className="question-bank-duplicates detail-sheet"><div className="question-bank-editor-heading"><div><span className="page-kicker">DUPLICATE REVIEW</span><h2>重复题审核</h2><p className="page-note">相似度达到 82% 的题目会聚类展示；合并后保留变体、技能、事实关联和已验证答案卡。</p></div><button className="text-button" onClick={() => setShowDuplicates(false)}>关闭</button></div>{duplicates.length === 0 ? <div className="knowledge-empty"><strong>未发现高相似题目</strong><span>可以继续导入或手动维护题库。</span></div> : duplicates.map((cluster) => <div className="duplicate-cluster" key={cluster.canonical.id}><div><strong>{cluster.canonical.canonicalText}</strong><span>相似度 {Math.round(cluster.score * 100)}%</span></div>{cluster.variants.map((variant) => <label className="duplicate-variant" key={variant.id}><input type="checkbox" defaultChecked value={variant.id} /><span>{variant.canonicalText}</span></label>)}<button className="outline-pill" onClick={async (event) => { const container = (event.currentTarget.parentElement); const ids = Array.from(container?.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked") ?? []).map((input) => input.value); await props.onMergeDuplicates(cluster.canonical.id, ids); props.onNotice("重复题已合并并归档变体"); await loadDuplicates(); }}>合并选中变体</button></div>)}</div>}
    <div className="question-bank-skills"><div><span className="page-kicker">SKILL LIBRARY</span><h2>技能资料</h2><p className="page-note">先登记技能名称和说明，后续可继续挂接知识点、岗位和题目。</p></div><div className="question-bank-skill-form"><input value={skillName} onChange={(event) => setSkillName(event.target.value)} placeholder="技能名称，例如 IIC / FreeRTOS" /><input value={skillDescription} onChange={(event) => setSkillDescription(event.target.value)} placeholder="技能说明或使用边界" /><button className="outline-pill" onClick={() => void saveSkill()}>新增技能</button></div>{props.skills.length > 0 && <div className="skill-chip-list">{props.skills.map((skill) => <span className="knowledge-type-badge" key={skill.id}>{skill.name}</span>)}</div>}</div>
  </section>;
}

const DETECT_THRESHOLD = 0.08;
const DEFAULT_DEVICES: AudioDevices = { inputs: [], outputs: [] };

function asrProviderLabel(providerType: AsrProviderType): string {
  if (providerType === "qwen") return "Qwen Realtime ASR";
  if (providerType === "deepgram") return "Deepgram";
  if (providerType === "funasr-local") return "Local Fun-ASR-Nano";
  return "Custom WebSocket ASR Gateway";
}

function asrDefaultModel(providerType: AsrProviderType): string {
  return providerType === "qwen" ? QWEN_REALTIME_ASR_MODEL : providerType === "funasr-local" ? "funasr-nano:q8" : "nova-3";
}

interface AudioStore {
  mic: number;
  system: number;
  state: "STARTING" | "READY" | "DEGRADED" | "RECOVERING" | "FAILED" | "STOPPED";
  micHealth: "ok" | "degraded" | "failed" | "unknown";
  loopbackHealth: "ok" | "degraded" | "failed" | "unknown";
  micDetected: boolean;
  systemDetected: boolean;
  overlayMode: OverlayMode;
  hudState: HUDState;
  sessionState: SessionState;
  operationMode: "IDLE" | "INTERVIEW" | "WRITTEN_TEST";
  writtenTestRunning: boolean;
  automationMode: "MANUAL" | "AUTO";
  answerMode: "FAST" | "NORMAL" | "DEEP";
  probeResult?: ProbeResult;
  probeError?: string;
  drift?: AudioDrift;
  bufferStats?: { queuedFrames: number; droppedFrames: number; bufferDurationMs: number };
  realtimeState: string;
  asrDiagnostics: AsrRuntimeDiagnostics;
  remoteTranscript: TranscriptSnapshot;
  micTranscript: TranscriptSnapshot;
  question?: QuestionCandidate;
  questionDiagnostics: Array<Extract<QuestionEvent, { type: "question_diagnostic" }>>;
  answerText: string;
  answerStreaming: boolean;
  answerId?: string;
  answerHistory: Array<{ answerId: string; question: string; text: string }>;
  screenshot?: ScreenshotResult;
  notice?: string;
  applyEvent: (event: AudioSidecarEvent) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setHUDState: (state: HUDState) => void;
  setSessionState: (state: SessionState) => void;
  setWrittenTestState: (state: WrittenTestState) => void;
  setAutomationMode: (mode: "MANUAL" | "AUTO") => void;
  setAnswerMode: (mode: "FAST" | "NORMAL" | "DEEP") => void;
  clearProbe: () => void;
  setScreenshot: (screenshot: ScreenshotResult) => void;
  setNotice: (notice?: string) => void;
  setRealtimeState: (state: string) => void;
  setAsrDiagnostics: (diagnostics: AsrRuntimeDiagnostics) => void;
  applyTranscript: (snapshot: TranscriptSnapshot) => void;
  applyQuestion: (event: QuestionEvent) => void;
  applyRealtimeMessage: (message: RealtimeServerMessage) => void;
}

const stableAnswer = new StableAnswerStateMachine();
const questionsById = new Map<string, QuestionCandidate>();
const answerQuestionIds = new Map<string, string>();

const useAudioStore = create<AudioStore>((set) => ({
  mic: 0,
  system: 0,
  state: "STOPPED",
  micHealth: "unknown",
  loopbackHealth: "unknown",
  micDetected: false,
  systemDetected: false,
  overlayMode: "interactive",
  hudState: { running: false, panelVisible: false, transcriptVisible: false, answerVisible: false, shortcutVisible: false, shareMode: false, topBarVisible: false, mouseMode: "passthrough", mode: "HIDDEN" },
  sessionState: "IDLE",
  operationMode: "IDLE",
  writtenTestRunning: false,
  automationMode: "AUTO",
  answerMode: "NORMAL",
  realtimeState: "disconnected",
  asrDiagnostics: { provider: "unknown", model: "", language: "", micState: "stopped", remoteState: "stopped", reconnectCount: 0, droppedPcmPackets: 0, vadProvider: "unknown", speechProbability: { mic: 0, remote: 0 }, micSpeech: false, remoteSpeech: false, fallback: false, vadReady: false, vadReason: "not-initialized", lastSpeechStart: {}, lastSpeechEnd: {} },
  remoteTranscript: { source: "remote", final: [] },
  micTranscript: { source: "mic", final: [] },
  questionDiagnostics: [],
  answerText: "",
  answerStreaming: false,
  answerHistory: [],
  applyEvent: (event) => set((current) => {
    if (event.type === "meter") {
      return {
        mic: normalizeMeter(event.mic),
        system: normalizeMeter(event.system),
        micDetected: event.mic >= DETECT_THRESHOLD,
        systemDetected: event.system >= DETECT_THRESHOLD
      };
    }
    if (event.type === "audio_health") {
      return {
        micHealth: event.mic,
        loopbackHealth: event.loopback,
        state: event.mic === "ok" && event.loopback === "ok" ? "READY" : "DEGRADED"
      };
    }
    if (event.type === "audio_state") return { state: event.state };
    if (event.type === "probe_result") return { probeResult: event, probeError: undefined, state: event.mic.streamOk && event.system.streamOk ? "READY" : "FAILED" };
    if (event.type === "audio_buffer") return { bufferStats: event };
    if (event.type === "audio_drift") return { drift: event };
    return { state: event.recoverable ? "DEGRADED" : "FAILED", notice: event.reason, probeError: event.reason };
  }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setHUDState: (hudState) => set({ hudState }),
  setSessionState: (sessionState) => {
    const shouldReset = sessionState === "CREATING" || sessionState === "IDLE" || sessionState === "ENDED";
    if (shouldReset) {
      stableAnswer.reset();
      questionsById.clear();
      answerQuestionIds.clear();
    }
    set((current) => ({
      sessionState,
      operationMode: current.writtenTestRunning ? "WRITTEN_TEST" : sessionState === "IDLE" || sessionState === "ENDED" ? "IDLE" : "INTERVIEW",
      ...(shouldReset ? { question: undefined, answerText: "", answerStreaming: false, answerId: undefined, answerHistory: [], remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] }, questionDiagnostics: [] } : {})
    }));
  },
  setWrittenTestState: (writtenTest) => {
    stableAnswer.reset();
    questionsById.clear();
    answerQuestionIds.clear();
    set((current) => ({ writtenTestRunning: writtenTest.running, operationMode: writtenTest.running ? "WRITTEN_TEST" : current.sessionState === "IDLE" || current.sessionState === "ENDED" ? "IDLE" : "INTERVIEW", answerText: "", answerStreaming: false, answerId: undefined, answerHistory: [], question: undefined, remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] } }));
  },
  setAutomationMode: (automationMode) => set({ automationMode }),
  setAnswerMode: (answerMode) => set({ answerMode }),
  clearProbe: () => set({ probeResult: undefined, probeError: undefined, state: "STOPPED" }),
  setScreenshot: (screenshot) => set({ screenshot }),
  setNotice: (notice) => set({ notice }),
  setRealtimeState: (realtimeState) => set({ realtimeState }),
  setAsrDiagnostics: (asrDiagnostics) => set({ asrDiagnostics }),
  applyTranscript: (snapshot) => set(snapshot.source === "remote" ? { remoteTranscript: snapshot } : { micTranscript: snapshot }),
  applyQuestion: (event) => set((current) => {
    if (event.type === "question_diagnostic") return { questionDiagnostics: [...current.questionDiagnostics.slice(-19), event] };
    if (event.type !== "question_confirmed" && event.type !== "question_superseded") return current;
    questionsById.set(event.question.id, event.question);
    // Keep the displayed question paired with the answer currently being
    // generated. A queued question becomes visible on its answer_start.
    return current.answerStreaming ? current : { question: event.question, notice: current.notice };
  }),
  applyRealtimeMessage: (message) => {
    if (message.type === "runtime_error") { set({ notice: `${message.code}: ${message.message}${message.recoverable ? " · 可重试" : ""}` }); return; }
    if (message.type === "answer_start") answerQuestionIds.set(message.answerId, message.questionId);
    const snapshot = message.type === "answer_start"
      ? stableAnswer.start(message.answerId)
      : message.type === "answer_delta"
        ? stableAnswer.delta(message.answerId, message.delta)
        : message.type === "answer_end"
          ? stableAnswer.end(message.answerId, message.text)
        : message.type === "answer_cancelled"
            ? stableAnswer.cancel(message.answerId)
            : message.type === "answer_reset"
              ? stableAnswer.snapshot
            : stableAnswer.snapshot;
    set((current) => {
      const questionId = message.type === "answer_start" ? message.questionId : "answerId" in message ? answerQuestionIds.get(message.answerId) : undefined;
      const pairedQuestion = questionId ? questionsById.get(questionId) : undefined;
      const completed = message.type === "answer_end" && message.text.trim()
        ? { answerId: message.answerId, question: pairedQuestion?.text ?? current.question?.text ?? "未记录问题", text: message.text }
        : undefined;
      return {
        answerText: snapshot.displayedText,
        answerStreaming: snapshot.streaming,
        answerId: snapshot.displayedAnswerId,
        answerHistory: completed ? [...current.answerHistory.filter((entry) => entry.answerId !== completed.answerId), completed].slice(-8) : current.answerHistory,
        ...(pairedQuestion ? { question: pairedQuestion } : {}),
        ...(message.type === "answer_start" ? { answerMode: message.mode } : {})
      };
    });
  }
}));

function Meter({ label, value, accent }: { label: string; value: number; accent: string }): JSX.Element {
  return (
    <div className="meter-row">
      <div className="meter-label"><span>{label}</span><span>{Math.round(value * 100)}%</span></div>
      <div className="meter-track"><div className="meter-fill" style={{ width: `${value * 100}%`, background: accent }} /></div>
    </div>
  );
}

function DetectionBadge({ label, detected }: { label: string; detected: boolean }): JSX.Element {
  return <span className={`detection-badge ${detected ? "detected" : "waiting"}`}><span />{label}: {detected ? "detected" : "waiting"}</span>;
}

function StatusPill({ state }: { state: string }): JSX.Element {
  const tone = state === "READY" || state === "RUNNING" ? "success" : state === "FAILED" ? "danger" : "warning";
  return <span className={`status-pill ${tone}`}><span className="status-dot" />{state}</span>;
}

function inlineMarkdown(text: string): JSX.Element[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function MarkdownAnswer({ text }: { text: string }): JSX.Element {
  const lines = text.split(/\r?\n/);
  const blocks: JSX.Element[] = [];
  let code = false;
  let codeLines: string[] = [];
  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (code) blocks.push(<pre key={`code-${index}`}><code>{codeLines.join("\n")}</code></pre>);
      code = !code;
      codeLines = [];
    } else if (code) codeLines.push(line);
    else if (/^\s*[-*]\s+/.test(line)) blocks.push(<div className="markdown-bullet" key={index}>• {inlineMarkdown(line.replace(/^\s*[-*]\s+/, ""))}</div>);
    else if (line.trim()) blocks.push(<div key={index}>{inlineMarkdown(line)}</div>);
  });
  if (code && codeLines.length) blocks.push(<pre key="code-tail"><code>{codeLines.join("\n")}</code></pre>);
  return <div className="markdown-answer">{blocks}</div>;
}

function historySpeaker(source: "mic" | "remote"): string {
  return source === "remote" ? "面试官" : "我";
}

function historyAnswerState(reason?: string): string {
  if (!reason) return "AI回答";
  if (reason === "user") return "AI回答（手动停止）";
  if (reason === "superseded") return "AI回答（被下一题替换）";
  if (reason === "timeout") return "AI回答（超时中断）";
  return "AI回答（未完成）";
}

function HistoryDetailPanel({ detail, metrics }: { detail: HistoryDetail; metrics?: { questionCount: number; answeredQuestionCount: number; answerRate: number } }): JSX.Element {
  const questions = new Map(detail.questions.map((question) => [question.id, question]));
  const entries = [
    ...detail.transcripts.filter((item) => item.text.trim()).map((item) => ({ id: item.id, at: item.createdAt, role: historySpeaker(item.source), text: item.text, question: undefined })),
    ...detail.answers.filter((item) => item.text.trim() || item.cancelReason).map((item) => ({ id: item.id, at: item.finishedAt ?? item.createdAt, role: historyAnswerState(item.cancelReason), text: item.text.trim() || "未生成完整回答", question: questions.get(item.questionId)?.text }))
  ].sort((left, right) => left.at - right.at);
  return <div className="history-detail-content">
    <h2>面试详情</h2>
    <p className="page-note">{detail.interview.profileId} · {detail.interview.automationMode}</p>
    <div className="detail-metrics"><span>问题数 <strong>{metrics?.questionCount ?? detail.questions.length}</strong></span><span>已回答 <strong>{metrics?.answeredQuestionCount ?? detail.answers.filter((answer) => Boolean(answer.text.trim())).length}</strong></span><span>回答率 <strong>{metrics ? `${Math.round(metrics.answerRate * 100)}%` : "—"}</strong></span></div>
    <div className="history-record-note">下面按时间展示三类内容：面试官的提问、你的回答，以及 AI 针对当时问题生成的回答。</div>
    <div className="history-timeline">{entries.length > 0 ? entries.map((entry) => <article className={`history-entry ${entry.role === "AI回答" || entry.role.startsWith("AI回答（") ? "history-entry-ai" : entry.role === "我" ? "history-entry-me" : "history-entry-interviewer"}`} key={entry.id}>
      <div className="history-entry-heading"><b>{entry.role}</b><time>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>
      {entry.question && <small className="history-entry-question">针对问题：{entry.question}</small>}
      <div className="history-entry-text">{entry.text}</div>
    </article>) : <p className="page-note">这场面试还没有可展示的对话内容。</p>}</div>
  </div>;
}

function OverlayView(): JSX.Element {
  const { mic, system, state, overlayMode, question, answerText, answerStreaming, answerMode } = useAudioStore();
  const toggleMode = async () => {
    await window.interviewCopilot.overlay.setMode(overlayMode === "interactive" ? "passive" : "interactive");
  };
  return (
    <main className="overlay-shell">
      <div className="overlay-bar"><span>Interview Copilot · {answerMode}</span><StatusPill state={state} /></div>
      <section className="overlay-card">
        <div className="eyebrow">CURRENT QUESTION</div>
        <h1>{question?.text}</h1>
        <div className="answer-surface">{answerText && <MarkdownAnswer text={answerText} />}{answerStreaming && <span className="answer-cursor">▌</span>}</div>
        <div className="overlay-meters"><Meter label="MIC" value={mic} accent="#8b5cf6" /><Meter label="SYSTEM" value={system} accent="#22d3ee" /></div>
      </section>
      <button className="overlay-mode" onClick={() => void toggleMode()}>
        {overlayMode === "interactive" ? "切换 Passive 模式" : "切换 Interactive 模式"}
      </button>
    </main>
  );
}

function TranscriptColumn({ label, snapshot }: { label: string; snapshot: TranscriptSnapshot }): JSX.Element {
  const latest = snapshot.final.slice(-4);
  return (
    <div className="transcript-column">
      <div className="transcript-label">{label}</div>
      <div className="transcript-lines">
        {latest.map((segment) => <div className="transcript-line" key={segment.id}>{segment.text}</div>)}
        {snapshot.partial && <div className="transcript-line partial" key={snapshot.partial.id}>{snapshot.partial.text}</div>}
      </div>
    </div>
  );
}

function storedDevice(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

function persistDevice(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* localStorage can be unavailable in hardened environments */ }
}

function verificationLabel(value: boolean | null): string {
  return value === true ? "PASS" : value === false ? "FAIL" : "未测试";
}

function tencentLabel(value: TencentValidationStatus): string {
  return value === "verified" ? "已验证" : value === "failed" ? "失败" : "未验证";
}

function userFacingError(error: unknown): string {
  const raw = String(error);
  const mappings: Array<[string, string]> = [
    ["AUDIO_PROBE_BUSY", "音频检测正在进行，请等待当前检测完成"],
    ["AUDIO_PROBE_STOPPED", "音频检测已取消"],
    ["AUDIO_PROBE_TIMEOUT", "音频检测超时，请检查设备后重试"],
    ["AUDIO_PROBE_MIC_FAILED", "麦克风输入不可用"],
    ["AUDIO_PROBE_SYSTEM_FAILED", "系统音频回采不可用"],
    ["AUDIO_PROBE_PROCESS_EXIT_WITHOUT_RESULT", "音频检测程序未返回结果，请重试"],
    ["AUDIO_PROBE_PROCESS_CRASHED", "音频检测程序异常退出"],
    ["AUDIO_PROBE_PROCESS_FAILED", "音频检测程序失败"],
    ["AUDIO_PROBE_FAILED", "麦克风和系统音频都不可用"],
    ["AUDIO_PROBE_REQUIRED", "请先完成一次音频检测"],
    ["LLM_NOT_CONFIGURED", "未配置 LLM API Key，请前往设置"],
    ["ASR_AUTH_FAILED", "当前语音供应商的 API Key 未配置或未授权，请前往模型与服务设置"],
    ["LLM_CONNECT_FAILED", "LLM 连接失败，请检查测试结果和网络"],
    ["ASR_CONNECT_FAILED", "语音识别连接失败，请检查当前语音供应商、模型和网络"],
    ["auth_failed", "认证失败：API Key 无效或未授权"],
    ["model_not_found", "模型不存在，请检查 Model 名称"],
    ["bad_request", "请求参数不兼容，请检查 Provider 配置"],
    ["rate_limited", "Provider 限流，请稍后重试"],
    ["server_error", "Provider 服务端错误，请稍后重试"],
    ["invalid_response", "服务已连接，但返回格式不兼容"],
    ["timeout", "请求超时，请检查网络后重试"],
    ["network_failed", "网络连接失败，请检查 Base URL 和网络"]
  ];
  const match = mappings.find(([code]) => raw.includes(code));
  return match?.[1] ?? (raw.includes("Error invoking remote method") ? "操作失败，请查看设置或重试" : raw.replace(/^Error:\s*/i, ""));
}

function CaptureProtectionSettings({ status, validation = { desktopShare: "unverified", windowShare: "unverified" }, onToggle, onValidate = () => undefined }: { status: CaptureProtectionState; validation?: TencentValidationState; onToggle: (enabled: boolean) => void; onValidate?: (mode: "desktopShare" | "windowShare", status: TencentValidationStatus) => void }): JSX.Element {
  const [validationState, setValidationState] = useState<TencentValidationState>(validation);
  useEffect(() => { void window.interviewCopilot.overlay.getTencentValidation().then(setValidationState).catch(() => undefined); }, []);
  const recordValidation = (mode: "desktopShare" | "windowShare", nextStatus: TencentValidationStatus) => { setValidationState((current) => ({ ...current, [mode]: nextStatus })); onValidate(mode, nextStatus); };
  const windowsLabel = !status.supported ? "当前平台不支持 Windows Capture Protection" : status.lastError ? "Windows protection flag 失败" : status.requested && status.osFlagApplied ? "Windows protection enabled" : "Windows protection disabled";
  return <section className="capture-protection-settings"><div className="settings-subheading"><div><h2>共享保护 <small>Capture Protection</small></h2><p>在受支持的 Windows 屏幕捕获方式中隐藏面试悬浮窗。</p></div><label className="switch-control"><input type="checkbox" checked={status.requested} disabled={!status.supported} onChange={(event) => onToggle(event.target.checked)} /><span /></label></div><div className="capture-protection-meta"><strong className={!status.supported ? "unsupported" : status.lastError ? "failed" : status.requested && status.osFlagApplied ? "enabled" : "disabled"}>{windowsLabel}</strong><span>{status.platform}</span></div><div className="capture-protection-layers"><div><span>Windows protection</span><strong>{windowsLabel}</strong></div><div><span>Automatic capture validation · Window</span><strong>{verificationLabel(status.windowCaptureVerified)}</strong></div><div><span>Automatic capture validation · Display</span><strong>{verificationLabel(status.displayCaptureVerified)}</strong></div><div><span>Tencent Meeting · Desktop Share</span><strong>{tencentLabel(validationState.desktopShare)}</strong></div><div><span>Tencent Meeting · Window Share</span><strong>{tencentLabel(validationState.windowShare)}</strong></div></div><button className="outline-pill tencent-validation-button" onClick={() => recordValidation("desktopShare", "unverified")}>开始腾讯会议共享验证</button><div className="tencent-validation-panel"><h3>腾讯会议共享保护验证</h3><p>请在腾讯会议中分别验证“共享整个桌面”和“共享窗口”；预览不能替代另一台设备上的远端观察。</p><div className="test-marker-label">TEST MARKER · 仅在验证模式 / INTERVIEW_COPILOT_CAPTURE_TEST=1 显示</div><div className="tencent-validation-row"><span>腾讯会议共享整个桌面：{tencentLabel(validationState.desktopShare)}</span><button className="text-button" onClick={() => recordValidation("desktopShare", "verified")}>远端看不到</button><button className="text-button danger-text" onClick={() => recordValidation("desktopShare", "failed")}>远端可以看到</button></div><div className="tencent-validation-row"><span>腾讯会议共享窗口：{tencentLabel(validationState.windowShare)}</span><button className="text-button" onClick={() => recordValidation("windowShare", "verified")}>远端看不到</button><button className="text-button danger-text" onClick={() => recordValidation("windowShare", "failed")}>远端可以看到</button></div></div><p className="capture-protection-warning">不同会议软件、录屏方式和 Windows 版本行为可能不同，无法保证所有捕获方式都排除。</p>{status.lastError && <p className="capture-protection-error">共享保护启用失败：Windows 标志未确认，悬浮窗仍可正常使用。</p>}</section>;
}

function LlmModelProfilesPanel({ profiles, activeId, selectedId, name, onNameChange, onSelect, onActivate, onNew, onDelete }: { profiles: ProviderCenterPublicConfig["llmProfiles"]; activeId: string; selectedId: string; name: string; onNameChange: (value: string) => void; onSelect: (id: string) => void; onActivate: () => void; onNew: () => void; onDelete: () => void }): JSX.Element {
  const selectedSaved = profiles.some((profile) => profile.id === selectedId);
  return <section className="model-profiles-panel"><div className="model-profiles-heading"><div><span className="page-kicker">MODEL PROFILES</span><h2>模型配置</h2><p>选择只会载入配置供查看和编辑；点击“启用此配置”后，下一次回答才会切换。</p></div><div className="model-profile-actions"><button className="dark-pill" disabled={!selectedSaved || selectedId === activeId} onClick={onActivate}>{selectedId === activeId ? "正在使用" : "启用此配置"}</button><button className="outline-pill" onClick={onNew}>新建配置</button><button className="text-button danger-text" disabled={!selectedSaved || profiles.length <= 1} onClick={onDelete}>删除配置</button></div></div><div className="model-profiles-form"><label className="clean-field"><span>查看 / 编辑配置</span><select value={selectedId} onChange={(event) => onSelect(event.target.value)}>{selectedId && !selectedSaved && <option value={selectedId}>新配置 · 未保存</option>}{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}{profile.id === activeId ? " · 当前使用" : ""}</option>)}</select></label><label className="clean-field"><span>配置名称</span><input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：小米 Mimo、DeepSeek、备用模型" /></label></div></section>;
}

function HistoryPage({ records, search, onSearch, detail, metrics, onSelect, onDelete }: {
  records: Array<{ id: string; profileId: string; startedAt: number; endedAt?: number; status: string; automationMode: string }>;
  search: string;
  onSearch: (value: string) => void;
  detail?: HistoryDetail;
  metrics?: { id: string; questionCount: number; answeredQuestionCount: number; answerRate: number };
  onSelect: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}): JSX.Element {
  const visible = records.filter((record) => `${record.profileId} ${record.status} ${new Date(record.startedAt).toLocaleString()}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="simple-page history-page">
    <div className="page-heading"><div><span className="page-kicker">INTERVIEW HISTORY</span><h1>面试记录</h1><p className="page-note">搜索、查看和删除历史记录；删除会同时清理这场面试的转写、问题和回答。</p></div><input className="inline-search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索日期、档案或状态" /></div>
    <div className="history-summary"><span>全部 <strong>{records.length}</strong></span><span>已完成 <strong>{records.filter((record) => record.status === "ended").length}</strong></span><span>异常中断 <strong>{records.filter((record) => record.status === "error").length}</strong></span></div>
    <div className="history-layout"><div className="clean-list history-record-list">{visible.map((record) => <div className={`clean-list-row history-record-row ${detail?.interview.id === record.id ? "selected" : ""}`} key={record.id}><button className="row-main-button" onClick={() => void onSelect(record.id)}><strong>{new Date(record.startedAt).toLocaleString()}</strong><small>{record.status === "ended" ? "已完成" : record.status === "error" ? "异常中断" : "进行中"} · {record.automationMode} · {record.profileId}</small></button><button className="history-delete-button" onClick={() => void onDelete(record.id)} aria-label="删除这条面试记录">删除</button></div>)}{visible.length === 0 && <div className="knowledge-empty"><strong>{records.length ? "没有匹配记录" : "还没有面试记录"}</strong><span>{records.length ? "换一个搜索词试试。" : "完成一次面试后，记录会显示在这里。"}</span></div>}</div>{detail ? <div className="detail-sheet history-detail-sheet"><div className="history-detail-actions"><span>记录 ID · {detail.interview.id.slice(0, 8)}</span><button className="outline-pill danger-outline" onClick={() => void onDelete(detail.interview.id)}>删除本场记录</button></div><HistoryDetailPanel detail={detail} metrics={metrics?.id === detail.interview.id ? metrics : undefined} /></div> : <div className="detail-sheet history-empty-detail"><strong>选择一场面试</strong><span>这里会按时间还原面试官、候选人和 AI 回答。</span></div>}</div>
  </section>;
}

function CatalogModelSelect({ label, value, models, category, onChange, optional = false }: { label: string; value: string; models: DiscoveredModel[]; category: ModelCategory; onChange: (value: string) => void; optional?: boolean }): JSX.Element {
  const options = models.filter((model) => model.categories.includes(category));
  const hasCurrent = Boolean(value && options.some((model) => model.id === value));
  const family = (model: DiscoveredModel): string => /^qwen3-asr/i.test(model.id) ? "Qwen3 Realtime（低延迟）" : /^qwen-audio/i.test(model.id) ? "Qwen Audio Streaming（推荐）" : /^fun-asr/i.test(model.id) ? "Fun-ASR（通用/电话）" : /^paraformer/i.test(model.id) ? "Paraformer（中文）" : "供应商返回";
  const groups = category === "realtime-asr" ? [...new Set(options.map(family))] : [];
  return <label className="clean-field model-catalog-field"><span>{label}<small>{options.length > 0 ? `${options.length} 个可用` : "等待获取"}</small></span><select value={value} onChange={(event) => onChange(event.target.value)} disabled={options.length === 0 && !value}>{optional && <option value="">不配置</option>}{value && !hasCurrent && <option value={value}>{value} · 当前手动值</option>}{groups.length ? groups.map((group) => <optgroup label={group} key={group}>{options.filter((model) => family(model) === group).map((model) => <option value={model.id} key={model.id}>{model.name}{model.description ? ` · ${model.description}` : ""}</option>)}</optgroup>) : options.map((model) => <option value={model.id} key={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}</select>{category === "realtime-asr" && value && <small className="model-protocol-hint">{/^qwen3-asr-flash-realtime/i.test(value) ? "Realtime Session 协议" : "DashScope Streaming Task 协议"} · 已选模型会原样保存</small>}</label>;
}

type TaskModelKey = "fallbackModel" | "questionRecognitionModel" | "profileBuilderModel" | "projectAnalyzerModel" | "questionBankModel" | "chatModel" | "postInterviewModel" | "preparationModel";
function TaskModelRoutingPanel({ values, onChange }: { values: Record<TaskModelKey, string>; onChange: (key: TaskModelKey, value: string) => void }): JSX.Element {
  const fields: Array<[TaskModelKey, string, string]> = [
    ["fallbackModel", "备用模型", "主模型失败时使用"],
    ["questionRecognitionModel", "问题识别（仅歧义）", "为空时使用 FAST；只处理低置信度"],
    ["profileBuilderModel", "简历/档案整理", "为空时使用 NORMAL"],
    ["projectAnalyzerModel", "项目记忆分析", "为空时使用 NORMAL；提取职责、实现和问题解决"],
    ["questionBankModel", "题库答案生成", "批量生成可使用 FAST"],
    ["chatModel", "普通对话", "工作台聊天模型"],
    ["postInterviewModel", "面试复盘", "面试结束后的分析模型"],
    ["preparationModel", "面试准备", "Preparation Agent 模型"]
  ];
  return <details className="model-profiles-panel task-routing-panel"><summary><span><span className="page-kicker">ADVANCED ROUTING</span><strong>任务模型路由</strong><small>高级设置 · 默认无需修改</small></span></summary><p>为空时按任务推荐的模式模型回退；正在进行的面试使用启动时的模型快照。</p><div className="model-grid">{fields.map(([key, label, placeholder]) => <label className="clean-field" key={key}><span>{label}</span><input value={values[key]} onChange={(event) => onChange(key, event.target.value)} placeholder={placeholder} /></label>)}</div></details>;
}

function OverlayPreferencesPanel({ value, onChange, onReset }: { value: OverlayPreferences; onChange: (patch: Partial<OverlayPreferences>) => void; onReset: () => void }): JSX.Element {
  const toggles: Array<[keyof Pick<OverlayPreferences, "showToolbar" | "showTranscript" | "showAnswer" | "showTimestamps">, string, string]> = [
    ["showToolbar", "顶部控制栏", "计时、状态、模式切换和结束按钮"],
    ["showTranscript", "对话记录", "显示面试官和自己的实时转写"],
    ["showAnswer", "AI 回答", "显示当前问题、答案和本场历史"],
    ["showTimestamps", "转写时间", "在每段对话旁显示时间"]
  ];
  return <section className="settings-service-card overlay-preferences-card">
    <header><div><span className="step-number">04</span><div><h2>面试悬浮窗</h2><p>修改后立即应用；输入框已从小窗移除，手动提问保留在主窗口。</p></div></div><button className="outline-pill" onClick={onReset}>恢复默认</button></header>
    <div className="overlay-preferences-layout"><div className="overlay-preferences-controls"><p className="page-note">鼠标中键已设为截图识别键，仅在“实时面试 + 手动回答”时生效，自动模式和笔试模式不会触发。</p>
      <div className="overlay-function-grid">{toggles.map(([key, label, description]) => <label className="overlay-function-toggle" key={key}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" checked={value[key]} onChange={(event) => onChange({ [key]: event.target.checked })} /></label>)}</div>
      <div className="overlay-appearance-grid"><label className="clean-field"><span>背景透明度 <small>{Math.round(value.backgroundOpacity * 100)}%</small></span><input type="range" min="20" max="100" step="1" value={Math.round(value.backgroundOpacity * 100)} onChange={(event) => onChange({ backgroundOpacity: Number(event.target.value) / 100 })} /></label><label className="clean-field"><span>字体大小 <small>{value.fontSize}px</small></span><input type="range" min="12" max="28" step="1" value={value.fontSize} onChange={(event) => onChange({ fontSize: Number(event.target.value) })} /></label><label className="clean-field color-field"><span>背景颜色</span><input type="color" value={value.backgroundColor} onChange={(event) => onChange({ backgroundColor: event.target.value })} /></label><label className="clean-field color-field"><span>字体颜色</span><input type="color" value={value.fontColor} onChange={(event) => onChange({ fontColor: event.target.value })} /></label></div>
    </div><div className="overlay-settings-preview" style={{ background: `color-mix(in srgb, ${value.backgroundColor} ${Math.round(value.backgroundOpacity * 100)}%, transparent)`, color: value.fontColor }}><small>当前问题</small><strong style={{ fontSize: value.fontSize }}>简述一下 TCP 和 UDP 的核心区别。</strong><p style={{ fontSize: value.fontSize }}>TCP 可靠、有连接；UDP 更轻量、无连接。选择时主要看可靠性和实时性要求。</p></div></div>
  </section>;
}

export function App(): JSX.Element {
  const isOverlay = useMemo(() => new URLSearchParams(window.location.search).get("window") === "overlay", []);
  const captureTest = useMemo(() => new URLSearchParams(window.location.search).get("capture-test") === "1", []);
  const store = useAudioStore();
  useEffect(() => {
    // The initial mode event can be emitted before the overlay renderer has
    // finished mounting. Mirror the native OverlayManager default locally so
    // the DOM hit-test model starts passive on the first rendered frame.
    if (isOverlay) store.setOverlayMode("passive");
  }, [isOverlay]);
  useEffect(() => {
    if (!isOverlay) return;
    void window.interviewCopilot.overlay.getState().then((state) => { if (state) store.setHUDState(state); }).catch(() => undefined);
  }, [isOverlay]);
  useEffect(() => {
    let disposed = false;
    void window.interviewCopilot.realtime.getTranscript().then((snapshots) => {
      if (disposed) return;
      if (snapshots.remote) store.applyTranscript(snapshots.remote);
      if (snapshots.mic) store.applyTranscript(snapshots.mic);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);
  const [page, setPage] = useState<AppPage>("home");
  const [setupOpen, setSetupOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSending, setChatSending] = useState(false);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [profileBuilderArtifact, setProfileBuilderArtifact] = useState<ProfileBuilderArtifactRecord>();
  const [profileBuilderRunning, setProfileBuilderRunning] = useState(false);
  const [projectMemory, setProjectMemory] = useState<ProjectMemorySnapshot>();
  const [projectMemoryStats, setProjectMemoryStats] = useState<ProjectMemoryStats>({ projects: 0, modules: 0, technicalPoints: 0, problems: 0, interviewQuestions: 0 });
  const [projectMemoryRunning, setProjectMemoryRunning] = useState(false);
  const [projectFacts, setProjectFacts] = useState<ProjectFact[]>([]);
  const [jobTargets, setJobTargets] = useState<JobTargetRecord[]>([]);
  const [knowledgeAnalysisRuns, setKnowledgeAnalysisRuns] = useState<KnowledgeAnalysisRunRecord[]>([]);
  const [retrievalRuns, setRetrievalRuns] = useState<RetrievalRunRecord[]>([]);
  const [providerSettings, setProviderSettings] = useState<ProviderCenterPublicConfig>();
  const [llmProfiles, setLlmProfiles] = useState<ProviderCenterPublicConfig["llmProfiles"]>([]);
  const [activeLlmProfileId, setActiveLlmProfileId] = useState("");
  const [llmProfileId, setLlmProfileId] = useState("");
  const [llmProfileName, setLlmProfileName] = useState("");
  const [llmProviderName, setLlmProviderName] = useState("OpenAI-compatible");
  const [llmModel, setLlmModel] = useState("gpt-4o-mini");
  const [llmBaseUrl, setLlmBaseUrl] = useState("https://api.openai.com");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [fastModel, setFastModel] = useState("");
  const [normalModel, setNormalModel] = useState("");
  const [deepModel, setDeepModel] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [questionRecognitionModel, setQuestionRecognitionModel] = useState("");
  const [profileBuilderModel, setProfileBuilderModel] = useState("");
  const [projectAnalyzerModel, setProjectAnalyzerModel] = useState("");
  const [questionBankModel, setQuestionBankModel] = useState("");
  const [chatModel, setChatModel] = useState("");
  const [postInterviewModel, setPostInterviewModel] = useState("");
  const [preparationModel, setPreparationModel] = useState("");
  const [answerMode, setAnswerMode] = useState<"FAST" | "NORMAL" | "DEEP">("NORMAL");
  const [interviewProjectId, setInterviewProjectId] = useState("");
  const [interviewJobTargetId, setInterviewJobTargetId] = useState("");
  const [asrProviderType, setAsrProviderType] = useState<AsrProviderType>("deepgram");
  const [asrBaseUrl, setAsrBaseUrl] = useState("wss://api.deepgram.com/v1/listen");
  const [asrModel, setAsrModel] = useState("nova-3");
  const [asrLanguage, setAsrLanguage] = useState<"zh-CN" | "en-US" | "multi">("zh-CN");
  const [asrApiKey, setAsrApiKey] = useState("");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("https://api.openai.com");
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [providerTests, setProviderTests] = useState<Record<string, string>>({});
  const [modelCatalogs, setModelCatalogs] = useState<Partial<Record<"llm" | "asr" | "embedding", ModelCatalogResult>>>({});
  const [modelCatalogLoading, setModelCatalogLoading] = useState<Partial<Record<"llm" | "asr" | "embedding", boolean>>>({});
  const [captureProtection, setCaptureProtection] = useState<CaptureProtectionState>({ platform: "win32", supported: false, requested: true, osFlagApplied: false, enabled: true, applied: false, externalCaptureVerified: null, displayCaptureVerified: null, windowCaptureVerified: null });
  const [overlayPreferences, setOverlayPreferences] = useState<OverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const [tencentValidation, setTencentValidation] = useState<TencentValidationState>({ desktopShare: "unverified", windowShare: "unverified" });
  const [knowledgeBases, setKnowledgeBases] = useState<Array<{ id: string; name: string }>>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocumentItem[]>([]);
  const [questionBankQuestions, setQuestionBankQuestions] = useState<QuestionBankQuestionRecord[]>([]);
  const [questionBankTotal, setQuestionBankTotal] = useState(0);
  const [questionBankSkills, setQuestionBankSkills] = useState<QuestionBankSkillRecord[]>([]);
  const [questionBankJobs, setQuestionBankJobs] = useState<QuestionBankJobProfileRecord[]>([]);
  const [questionBankAnswerProgress, setQuestionBankAnswerProgress] = useState<{ status: "started" | "running" | "completed"; total: number; completed: number; generated: number; skipped: number; failed: number; questionId?: string; error?: string }>();
  const [historyRecords, setHistoryRecords] = useState<Array<{ id: string; profileId: string; projectId?: string; jobTargetId?: string; startedAt: number; endedAt?: number; status: string; automationMode: string }>>([]);
  const [historyMetrics, setHistoryMetrics] = useState<{ id: string; answerRate: number; questionCount: number; answeredQuestionCount: number; averageAnswerLatencyMs?: number }>();
  const [historySearch, setHistorySearch] = useState("");
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail>();
  const [preparationGoal, setPreparationGoal] = useState("根据当前 Resume 和 JD 生成面试准备清单");
  const [preparationEvents, setPreparationEvents] = useState<Array<Record<string, unknown>>>([]);
  const [preparationRunning, setPreparationRunning] = useState(false);
  const [devices, setDevices] = useState<AudioDevices>(DEFAULT_DEVICES);
  const [inputDeviceId, setInputDeviceId] = useState("");
  const [outputDeviceId, setOutputDeviceId] = useState("");
  const [probeDeviceKey, setProbeDeviceKey] = useState("");
  const [probing, setProbing] = useState(false);
  const [realtimeUrl, setRealtimeUrl] = useState(() => storedDevice("interview-copilot.realtime-url") ?? "");
  const [realtimeTicket, setRealtimeTicket] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const dialogResolver = useRef<((value: string | boolean | undefined) => void) | undefined>(undefined);

  const applyLlmSettings = (settings: PublicProviderSettings): void => {
    setLlmProviderName(settings.providerName);
    setLlmModel(settings.model);
    setFastModel(settings.fastModel ?? "");
    setNormalModel(settings.normalModel ?? "");
    setDeepModel(settings.deepModel ?? "");
    setVisionModel(settings.visionModel ?? "");
    setFallbackModel(settings.fallbackModel ?? "");
    setQuestionRecognitionModel(settings.questionRecognitionModel ?? "");
    setProfileBuilderModel(settings.profileBuilderModel ?? "");
    setProjectAnalyzerModel(settings.projectAnalyzerModel ?? "");
    setQuestionBankModel(settings.questionBankModel ?? "");
    setChatModel(settings.chatModel ?? "");
    setPostInterviewModel(settings.postInterviewModel ?? "");
    setPreparationModel(settings.preparationModel ?? "");
    setLlmBaseUrl(settings.baseUrl);
  };

  const applyProviderSettings = (settings: ProviderCenterPublicConfig | undefined): void => {
    if (!settings) return;
    setProviderSettings(settings);
    setLlmProfiles(settings.llmProfiles);
    setActiveLlmProfileId(settings.activeLlmProfileId);
    setLlmProfileId(settings.activeLlmProfileId);
    setLlmProfileName(settings.llmProfiles.find((profile) => profile.id === settings.activeLlmProfileId)?.name ?? "");
    applyLlmSettings(settings.llm);
    setAsrBaseUrl(settings.asr.baseUrl);
    setAsrModel(settings.asr.model);
    setAsrProviderType(settings.asr.providerType ?? (settings.asr.providerName.toLowerCase().includes("custom") ? "custom-gateway" : settings.asr.providerName.toLowerCase().includes("funasr") ? "funasr-local" : "deepgram"));
    setAsrLanguage(settings.asr.language ?? "zh-CN");
    setEmbeddingBaseUrl(settings.embedding.baseUrl);
    setEmbeddingModel(settings.embedding.model);
  };

  const requestDialog = (next: DialogState): Promise<string | boolean | undefined> => new Promise((resolve) => {
    dialogResolver.current = resolve;
    setDialog(next);
  });
  const closeDialog = (value: string | boolean | undefined) => {
    dialogResolver.current?.(value);
    dialogResolver.current = undefined;
    setDialog(null);
  };

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const listed = await window.interviewCopilot.audio.listDevices();
        setDevices(listed);
        const savedInput = storedDevice("interview-copilot.input-device");
        const savedOutput = storedDevice("interview-copilot.output-device");
        const input = selectDeviceId(listed.inputs, savedInput);
        const output = selectDeviceId(listed.outputs, savedOutput);
        setInputDeviceId(input);
        setOutputDeviceId(output);
        if (input) persistDevice("interview-copilot.input-device", input);
        if (output) persistDevice("interview-copilot.output-device", output);
      } catch (error) {
        store.setNotice(`设备枚举失败：${userFacingError(error)}`);
      }
    };
    if (!captureTest) void loadDevices();
    void (async () => {
      try {
        let storedProfiles = await window.interviewCopilot.profiles.list();
        if (storedProfiles.length === 0) {
          const created = await window.interviewCopilot.profiles.save({ name: "默认面试档案", language: "zh-CN", skills: [], knowledgeBaseIds: [] });
          storedProfiles = created ? [created] : [];
        }
        setProfiles(storedProfiles);
        const active = await window.interviewCopilot.profiles.active();
        setProfileId(active?.id ?? storedProfiles[0]?.id ?? "");
         const settings = await window.interviewCopilot.settings.get();
         applyProviderSettings(settings);
        const [captureCapabilities, captureState, validation, interviewState, writtenTestState, initialOverlayPreferences] = await Promise.all([window.interviewCopilot.overlay.getCapabilities(), window.interviewCopilot.overlay.getCaptureProtection(), window.interviewCopilot.overlay.getTencentValidation(), window.interviewCopilot.interview.getState(), window.interviewCopilot.writtenTest.getState(), window.interviewCopilot.overlay.getPreferences()]);
        setCaptureProtection({ ...captureState, platform: captureCapabilities.platform, supported: captureCapabilities.captureProtectionSupported });
        setTencentValidation(validation);
        setOverlayPreferences(initialOverlayPreferences);
        store.setAutomationMode(interviewState.automationMode);
        store.setWrittenTestState(writtenTestState);
        let bases = await window.interviewCopilot.knowledge.listBases();
        if (bases.length === 0) {
          const created = await window.interviewCopilot.knowledge.createBase("默认知识库");
          bases = created ? [created] : [];
        }
        setKnowledgeBases(bases);
        setKnowledgeBaseId(bases[0]?.id ?? "");
        setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(bases[0]?.id));
        const [initialQuestions, initialQuestionTotal] = await Promise.all([window.interviewCopilot.questionBank.list({ status: "active", limit: 60, offset: 0, sort: "updated" }), window.interviewCopilot.questionBank.count({ status: "active" })]);
        setQuestionBankQuestions(initialQuestions);
        setQuestionBankTotal(initialQuestionTotal);
        const [initialSkills, initialJobs] = await Promise.all([window.interviewCopilot.questionBank.listSkills(), window.interviewCopilot.questionBank.listJobs()]);
        setQuestionBankSkills(initialSkills);
        setQuestionBankJobs(initialJobs);
        const selectedProfile = storedProfiles.find((profile) => profile.id === (active?.id ?? storedProfiles[0]?.id));
        if (selectedProfile && selectedProfile.knowledgeBaseIds.length === 0 && bases[0]) {
          const linked = await window.interviewCopilot.profiles.save({ ...selectedProfile, knowledgeBaseIds: [bases[0].id] });
          if (linked) {
            setProfiles((current) => current.map((profile) => profile.id === linked.id ? linked : profile));
            setProfileId(linked.id);
          }
        }
        setHistoryRecords(await window.interviewCopilot.history.list());
        const storedProjects = await window.interviewCopilot.projects.list();
        setProjects(storedProjects);
        const storedConversations = await window.interviewCopilot.chat.listConversations(active?.id ?? storedProfiles[0]?.id);
        setConversations(storedConversations);
      } catch (error) {
        store.setNotice(`工作区初始化失败：${userFacingError(error)}`);
      }
    })();

    const cleanups = [
      window.interviewCopilot.events.onAudio(store.applyEvent),
      window.interviewCopilot.events.onSessionState((state) => { store.setSessionState(state); if (state === "ENDED") void window.interviewCopilot.history.list().then(setHistoryRecords); }),
      window.interviewCopilot.events.onOverlayMode(store.setOverlayMode),
      window.interviewCopilot.events.onOverlayState(store.setHUDState),
      window.interviewCopilot.events.onOverlayCaptureProtection(setCaptureProtection),
      window.interviewCopilot.events.onOverlayPreferences(setOverlayPreferences),
      window.interviewCopilot.events.onScreenshot(store.setScreenshot),
      window.interviewCopilot.events.onScreenshotError(store.setNotice),
      window.interviewCopilot.events.onScreenshotDiagnostic(store.setNotice),
      window.interviewCopilot.events.onRealtimeState(store.setRealtimeState),
      window.interviewCopilot.events.onRealtimeTranscript(store.applyTranscript),
      window.interviewCopilot.events.onRealtimeMessage(store.applyRealtimeMessage),
      window.interviewCopilot.events.onRealtimeDiagnostic(store.setNotice),
      window.interviewCopilot.events.onRealtimeDiagnostics((diagnostics) => store.setAsrDiagnostics(diagnostics)),
      window.interviewCopilot.events.onRuntimeError((error) => store.setNotice(`${error.code}: ${error.message}${error.recoverable ? " · 可重试" : ""}`)),
      window.interviewCopilot.events.onQuestion(store.applyQuestion),
      window.interviewCopilot.events.onAutomationMode(store.setAutomationMode),
      window.interviewCopilot.events.onAnswerMode((mode) => { store.setAnswerMode(mode); setAnswerMode(mode); }),
      window.interviewCopilot.events.onWrittenTestState(store.setWrittenTestState),
      window.interviewCopilot.events.onPreparationEvent((event) => { if (event && typeof event === "object") { const next = event as Record<string, unknown>; setPreparationEvents((current) => [...current.slice(-30), next]); if (["completed", "error", "stopped"].includes(String(next.type))) setPreparationRunning(false); } }),
      window.interviewCopilot.events.onChatMessageStart((event) => {
        if (!event || typeof event !== "object") return;
        const payload = event as { conversationId?: string; userMessage?: ChatMessage; assistantMessage?: ChatMessage };
        if (!payload.conversationId || !payload.userMessage || !payload.assistantMessage) return;
        setActiveConversationId(payload.conversationId);
        setChatSending(true);
        setChatMessages((current) => [...current.filter((message) => message.id !== payload.userMessage?.id && message.id !== payload.assistantMessage?.id), payload.userMessage as ChatMessage, payload.assistantMessage as ChatMessage]);
      }),
      window.interviewCopilot.events.onChatMessageDelta((event) => {
        if (!event || typeof event !== "object") return;
        const payload = event as { conversationId?: string; messageId?: string; text?: string };
        if (!payload.messageId) return;
        setChatMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, content: payload.text ?? message.content, status: "streaming" } : message));
      }),
      window.interviewCopilot.events.onChatMessageEnd((event) => {
        if (!event || typeof event !== "object") return;
        const payload = event as { conversationId?: string; message?: ChatMessage };
        if (!payload.message) return;
        setChatSending(false);
        setChatMessages((current) => current.map((message) => message.id === payload.message?.id ? payload.message as ChatMessage : message));
        void window.interviewCopilot.chat.listConversations().then(setConversations);
      }),
      window.interviewCopilot.events.onChatError((event) => {
        const payload = event && typeof event === "object" ? event as { message?: string; userMessage?: string; code?: string } : {};
        setChatSending(false);
        store.setNotice(payload.userMessage ?? payload.message ?? "AI 服务暂时中断，请重试。");
      }),
      window.interviewCopilot.events.onChatCancelled(() => {
        setChatSending(false);
        store.setNotice("已停止生成，可以继续回答或重新生成。");
      }),
      window.interviewCopilot.events.onQuestionBankAnswerGenerationProgress((progress) => {
        setQuestionBankAnswerProgress(progress);
        if (progress.status === "completed") {
          void Promise.all([window.interviewCopilot.questionBank.list({ status: "active", limit: 60, offset: 0, sort: "updated" }), window.interviewCopilot.questionBank.count({ status: "active" })]).then(([questions, total]) => { setQuestionBankQuestions(questions); setQuestionBankTotal(total); });
          store.setNotice(`答案生成完成：新增 ${progress.generated} 张，跳过 ${progress.skipped} 张，失败 ${progress.failed} 张`);
        }
      }),
      window.interviewCopilot.events.onShortcut((shortcut) => {
        if (shortcut === "toggle-automation") {
          const next = useAudioStore.getState().automationMode === "MANUAL" ? "AUTO" : "MANUAL";
          void window.interviewCopilot.interview.setAutomationMode(next).then(() => useAudioStore.getState().setNotice(`Automation 已切换为 ${next}`));
        } else if (shortcut === "answer-latest") {
          void window.interviewCopilot.interview.answerLatest();
        } else if (shortcut === "screenshot-answer") {
          useAudioStore.getState().setNotice(useAudioStore.getState().writtenTestRunning ? "正在识别截图并回答…" : "Screenshot shortcut received");
        } else if (shortcut === "end-interview") {
          void window.interviewCopilot.interview.stop();
        }
      })
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  useEffect(() => {
    if (!profileId) {
      setProfileBuilderArtifact(undefined);
      setProjectMemory(undefined);
      setProjectMemoryStats({ projects: 0, modules: 0, technicalPoints: 0, problems: 0, interviewQuestions: 0 });
      setProjectFacts([]);
      setJobTargets([]);
      setKnowledgeAnalysisRuns([]);
      setRetrievalRuns([]);
      return;
    }
    void window.interviewCopilot.profileBuilder.get(profileId).then(setProfileBuilderArtifact).catch(() => setProfileBuilderArtifact(undefined));
    void Promise.all([window.interviewCopilot.projectMemory.get(profileId), window.interviewCopilot.projectMemory.stats(profileId)]).then(([memory, stats]) => { setProjectMemory(memory); setProjectMemoryStats(stats); }).catch(() => undefined);
    void Promise.all([window.interviewCopilot.projectMemory.listFacts(profileId), window.interviewCopilot.jobTargets.list(profileId), window.interviewCopilot.projectMemory.analysisRuns(profileId), window.interviewCopilot.retrieval.list(profileId, 20)]).then(([facts, targets, analyses, retrievals]) => { setProjectFacts(facts); setJobTargets(targets); setKnowledgeAnalysisRuns(analyses); setRetrievalRuns(retrievals); }).catch(() => undefined);
    return window.interviewCopilot.events.onProfileBuilderUpdated((record) => {
      if (record.profileId === profileId) {
        setProfileBuilderArtifact(record);
        void Promise.all([window.interviewCopilot.projectMemory.get(profileId), window.interviewCopilot.projectMemory.stats(profileId)]).then(([memory, stats]) => { setProjectMemory(memory); setProjectMemoryStats(stats); }).catch(() => undefined);
        void Promise.all([window.interviewCopilot.projectMemory.listFacts(profileId), window.interviewCopilot.jobTargets.list(profileId), window.interviewCopilot.projectMemory.analysisRuns(profileId), window.interviewCopilot.retrieval.list(profileId, 20)]).then(([facts, targets, analyses, retrievals]) => { setProjectFacts(facts); setJobTargets(targets); setKnowledgeAnalysisRuns(analyses); setRetrievalRuns(retrievals); }).catch(() => undefined);
        void window.interviewCopilot.profiles.get(profileId).then((updated) => {
          if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
        });
      }
    });
  }, [profileId]);

  useEffect(() => {
    if (knowledgeBaseId) void window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId).then(setKnowledgeDocuments);
  }, [knowledgeBaseId]);

  useEffect(() => {
    if (interviewJobTargetId && !jobTargets.some((target) => target.id === interviewJobTargetId)) setInterviewJobTargetId("");
    if (interviewProjectId && !projectMemory?.projects.some((project) => project.id === interviewProjectId)) setInterviewProjectId("");
  }, [interviewJobTargetId, interviewProjectId, jobTargets, projectMemory]);

  const startAudio = async () => {
    persistDevice("interview-copilot.input-device", inputDeviceId);
    persistDevice("interview-copilot.output-device", outputDeviceId);
    await window.interviewCopilot.audio.start({ inputDeviceId, outputDeviceId, meterOnly: true });
    store.setNotice("音频诊断已启动；它只显示电平，不会发送 PCM。正式面试请使用“开始面试”。");
  };
  const startInterview = async () => {
    try {
      const asrUrl = realtimeUrl.trim() || asrBaseUrl.trim();
      if (!profileId) throw new Error("PROFILE_NOT_FOUND: 请先创建或选择一个面试档案。");
      if (!currentProbeReady) throw new Error("AUDIO_PROBE_REQUIRED: 请先完成一次音频检测。");
      const preflight = await window.interviewCopilot.settings.preflight(true);
      if (!preflight.llm.configured) throw new Error("LLM_NOT_CONFIGURED: 未配置 LLM API Key");
      if (!preflight.llm.reachable) throw new Error(`LLM_CONNECT_FAILED: ${preflight.llm.message ?? preflight.llm.status}`);
      if (asrProviderType === "custom-gateway" && !asrUrl) throw new Error("ASR_CONNECT_FAILED: Custom Gateway 需要配置 WebSocket URL");
      if (asrProviderType !== "custom-gateway" && asrProviderType !== "funasr-local" && !preflight.asr.configured) throw new Error(`ASR_AUTH_FAILED: 未配置${asrProviderType === "qwen" ? "千问" : " Deepgram"} API Key`);
      if (!preflight.asr.reachable) throw new Error(`ASR_CONNECT_FAILED: ${preflight.asr.message ?? preflight.asr.status}`);
      if (!inputDeviceId || !outputDeviceId) throw new Error("AUDIO_DEVICE_FAILED: 未选择可用的音频设备");
      persistDevice("interview-copilot.input-device", inputDeviceId);
      persistDevice("interview-copilot.output-device", outputDeviceId);
      await window.interviewCopilot.profiles.selectActive(profileId);
      await window.interviewCopilot.interview.start({ profileId, projectId: interviewProjectId || undefined, jobTargetId: interviewJobTargetId || undefined, url: asrProviderType === "custom-gateway" ? asrUrl : undefined, gatewayToken: asrProviderType === "custom-gateway" ? realtimeTicket.trim() || undefined : undefined, language: selectedProfile?.language, inputDeviceId, outputDeviceId, automationMode: store.automationMode, answerMode, providerType: asrProviderType });
      setSetupOpen(false);
    } catch (error) {
      store.setNotice(`面试启动失败：${userFacingError(error)}`);
    }
  };
  const stopAudio = async () => { await window.interviewCopilot.audio.stop(); };
  const probeAudio = async () => {
    if (probing) return;
    setProbing(true);
    store.clearProbe();
    setProbeDeviceKey("");
    try {
      const result = await window.interviewCopilot.audio.probe({ inputDeviceId, outputDeviceId });
      store.applyEvent(result);
      setProbeDeviceKey(`${inputDeviceId}::${outputDeviceId}`);
    }
    catch (error) { store.setNotice(`音频检测失败：${userFacingError(error)}`); }
    finally { setProbing(false); }
  };
  const openOverlay = async () => { await window.interviewCopilot.overlay.show(); };
  const toggleCaptureProtection = async (enabled: boolean) => {
    try {
      const next = await window.interviewCopilot.overlay.setCaptureProtection(enabled);
      if (next) setCaptureProtection(next);
    } catch (error) {
      setCaptureProtection((current) => ({ ...current, lastError: userFacingError(error), osFlagApplied: false }));
    }
  };
  const validateTencent = async (mode: "desktopShare" | "windowShare", status: TencentValidationStatus) => {
    try { setTencentValidation(await window.interviewCopilot.overlay.setTencentValidation(mode, status)); }
    catch (error) { store.setNotice(`腾讯会议验证记录失败：${userFacingError(error)}`); }
  };
  const captureScreenshot = async () => {
    try { store.setScreenshot(await window.interviewCopilot.screenshot.capture()); }
    catch (error) { store.setNotice(`截图失败：${userFacingError(error)}`); }
  };
  const toggleAutomation = async () => {
    const next = store.automationMode === "AUTO" ? "MANUAL" : "AUTO";
    await window.interviewCopilot.interview.setAutomationMode(next);
  };
  const connectRealtime = async () => {
    if (!realtimeUrl.trim()) {
      store.setNotice("请输入 Realtime WebSocket 地址");
      return;
    }
    persistDevice("interview-copilot.realtime-url", realtimeUrl.trim());
    await window.interviewCopilot.realtime.connect({ url: realtimeUrl.trim(), gatewayToken: realtimeTicket.trim() || undefined });
  };
  const disconnectRealtime = async () => { await window.interviewCopilot.realtime.disconnect(); };
  const currentProbeReady = Boolean(store.probeResult?.mic.streamOk && store.probeResult.system.streamOk && probeDeviceKey === `${inputDeviceId}::${outputDeviceId}`);
  const startNewLlmProfile = () => {
    setLlmProfileId(`llm-profile-${crypto.randomUUID()}`);
    setLlmProfileName("");
    setLlmApiKey("");
    setProviderTests((current) => ({ ...current, llm: "新配置未保存" }));
  };
  const selectLlmProfile = (profileId: string) => {
    const profile = llmProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    setLlmProfileId(profile.id);
    setLlmProfileName(profile.name);
    applyLlmSettings(profile);
    setLlmApiKey("");
    setModelCatalogs((current) => ({ ...current, llm: undefined }));
    setProviderTests((current) => ({ ...current, llm: profile.id === activeLlmProfileId ? "当前使用" : "已载入 · 尚未启用" }));
  };
  const activateLlmProfile = async (profileId: string) => {
    if (!profileId) return;
    try {
      const next = await window.interviewCopilot.settings.activateLlmProfile(profileId);
      applyProviderSettings(next);
      setLlmApiKey("");
      store.setNotice(`已切换模型配置：${next?.llmProfiles.find((profile) => profile.id === profileId)?.name ?? profileId}`);
    } catch (error) {
      store.setNotice(`模型配置切换失败：${userFacingError(error)}`);
    }
  };
  const deleteLlmProfile = async () => {
    if (!llmProfileId || llmProfiles.length <= 1) {
      store.setNotice("至少保留一个模型配置");
      return;
    }
    try {
      const next = await window.interviewCopilot.settings.deleteLlmProfile(llmProfileId);
      applyProviderSettings(next);
      setLlmApiKey("");
      store.setNotice("模型配置已删除");
    } catch (error) {
      store.setNotice(`模型配置删除失败：${userFacingError(error)}`);
    }
  };
  const saveLlmProfile = async (): Promise<{ config: ProviderCenterPublicConfig; profileId: string }> => {
    const input: LlmModelProfileInput = {
      id: llmProfileId || undefined,
      name: llmProfileName.trim() || "默认模型配置",
      providerName: llmProviderName.trim() || "OpenAI-compatible",
      baseUrl: llmBaseUrl.trim(),
      model: llmModel.trim(),
      fastModel: fastModel.trim() || undefined,
      normalModel: normalModel.trim() || undefined,
      deepModel: deepModel.trim() || undefined,
      visionModel: visionModel.trim() || undefined,
      fallbackModel: fallbackModel.trim() || undefined,
      questionRecognitionModel: questionRecognitionModel.trim() || undefined,
      profileBuilderModel: profileBuilderModel.trim() || undefined,
      projectAnalyzerModel: projectAnalyzerModel.trim() || undefined,
      questionBankModel: questionBankModel.trim() || undefined,
      chatModel: chatModel.trim() || undefined,
      postInterviewModel: postInterviewModel.trim() || undefined,
      preparationModel: preparationModel.trim() || undefined,
      apiKey: llmApiKey || undefined,
      timeoutMs: 30_000,
      maxRetries: 2
    };
    const validationIssues = validateLlmModelConfiguration(input);
    if (validationIssues.length) throw new Error(validationIssues.map((issue) => issue.message).join("；"));
    const next = await window.interviewCopilot.settings.saveLlmProfile(input);
    if (!next) throw new Error("模型配置保存后未返回结果");
    setProviderSettings(next);
    setLlmProfiles(next.llmProfiles);
    setActiveLlmProfileId(next.activeLlmProfileId);
    const savedProfile = input.id ? next.llmProfiles.find((profile) => profile.id === input.id) : [...next.llmProfiles].reverse().find((profile) => profile.name === input.name && profile.providerName === input.providerName && profile.baseUrl === input.baseUrl && profile.model === input.model);
    const savedProfileId = savedProfile?.id ?? input.id ?? next.activeLlmProfileId;
    setLlmProfileId(savedProfileId);
    setLlmProfileName(input.name);
    setLlmApiKey("");
    return { config: next, profileId: savedProfileId };
  };
  const saveProviderSettings = async () => {
    try {
      const { config: next } = await saveLlmProfile();
      const asr = await window.interviewCopilot.settings.update("asr", { providerName: asrProviderLabel(asrProviderType), providerType: asrProviderType, baseUrl: asrBaseUrl.trim(), model: asrModel.trim() || asrDefaultModel(asrProviderType), language: asrLanguage, apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      await window.interviewCopilot.settings.update("embedding", { providerName: "OpenAI-compatible", baseUrl: embeddingBaseUrl.trim(), model: embeddingModel.trim() || "text-embedding-3-small", apiKey: embeddingApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      const current = await window.interviewCopilot.settings.get();
      applyProviderSettings(current);
      setAsrApiKey("");
      setEmbeddingApiKey("");
      store.setNotice(`Provider 配置已保存：${next?.llmProfiles.find((profile) => profile.id === next.activeLlmProfileId)?.name ?? "当前模型配置"} · ASR ${asr?.hasApiKey ? "已配置密钥" : "未配置密钥"}`);
    } catch (error) {
      store.setNotice(`Provider 配置保存失败：${userFacingError(error)}`);
    }
  };
  const uploadKnowledgeFile = async (file: File, documentType: KnowledgeDocumentTypeOption = "auto") => {
    if (!knowledgeBaseId) return;
    try {
    const imported = await window.interviewCopilot.knowledge.ingest({ profileId: selectedProfile?.id, knowledgeBaseId, filename: file.name, mimeType: file.type || "application/octet-stream", documentType, bytes: new Uint8Array(await file.arrayBuffer()) }) as { status?: string; error?: string; projectAssignment?: { status?: string; message?: string } };
      if (imported?.status === "error") throw new Error(imported.error || "文件解析或索引失败");
      setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId));
    store.setNotice(`${imported.projectAssignment?.status === "needs_assignment" ? "NEEDS_PROJECT_ASSIGNMENT：请在项目资料中选择所属项目" : `已导入知识文档：${file.name}${documentType === "auto" ? "（已自动分类）" : ""}`}`);
    } catch (error) {
      store.setNotice(`知识文档导入失败：${userFacingError(error)}`);
    }
  };
  const uploadKnowledge = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await uploadKnowledgeFile(file);
    event.target.value = "";
  };
  const refreshQuestionBank = async () => {
    const [questions, total, skills, jobs] = await Promise.all([window.interviewCopilot.questionBank.list({ status: "active", limit: 60, offset: 0, sort: "updated" }), window.interviewCopilot.questionBank.count({ status: "active" }), window.interviewCopilot.questionBank.listSkills(), window.interviewCopilot.questionBank.listJobs()]);
    setQuestionBankQuestions(questions);
    setQuestionBankTotal(total);
    setQuestionBankSkills(skills);
    setQuestionBankJobs(jobs);
  };
  const attachProfileMaterial = async (kind: "resume" | "jobDescription", event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !profileId) return;
    try {
      const updated = await window.interviewCopilot.profiles.attachMaterial({ profileId, kind, filename: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
      if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
      store.setNotice(`${kind === "resume" ? "Resume" : "JD"} 已解析并保存`);
    } catch (error) {
      store.setNotice(`材料解析失败：${userFacingError(error)}`);
    } finally {
      event.target.value = "";
    }
  };
  const uploadJobDescription = async (file: File) => {
    if (!file || !profileId) return;
    try {
      const updated = await window.interviewCopilot.profiles.attachMaterial({ profileId, kind: "jobDescription", filename: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
      if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
      setJobTargets(await window.interviewCopilot.jobTargets.list(profileId));
      store.setNotice("岗位 JD 已解析并同步到岗位要求库");
    } catch (error) {
      store.setNotice(`岗位 JD 导入失败：${userFacingError(error)}`);
    }
  };
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const refreshProfiles = async () => { const next = await window.interviewCopilot.profiles.list(); setProfiles(next); };
  const renameProfile = async () => { if (!selectedProfile) return; const name = await requestDialog({ kind: "form", title: "重命名 Profile", label: "Profile 名称", defaultValue: selectedProfile.name, required: true, confirmLabel: "保存" }); if (typeof name === "string" && name.trim()) { await window.interviewCopilot.profiles.save({ ...selectedProfile, name: name.trim() }); await refreshProfiles(); } };
  const cloneProfile = async () => { if (!selectedProfile) return; const clone = await window.interviewCopilot.profiles.clone(selectedProfile.id, `${selectedProfile.name} 副本`); if (clone) { await refreshProfiles(); setProfileId(clone.id); } };
  const deleteProfile = async () => { if (!selectedProfile || profiles.length <= 1) { store.setNotice("至少保留一个 Profile"); return; } const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${selectedProfile.name}？`, description: "删除后该 Profile 的本地配置无法恢复。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.profiles.delete(selectedProfile.id); const next = (await window.interviewCopilot.profiles.list()); setProfiles(next); setProfileId(next[0]?.id ?? ""); if (next[0]) await window.interviewCopilot.profiles.selectActive(next[0].id); } };
  const editInstructions = async () => { if (!selectedProfile) return; const instructions = await requestDialog({ kind: "form", title: "编辑 Instructions", label: "Custom Instructions", defaultValue: selectedProfile.instructions ?? "", multiline: true, confirmLabel: "保存" }); if (typeof instructions === "string") { const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, instructions }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); } };
  const updateProfileExpression = async (patch: Partial<Pick<Profile, "expressionLevel" | "explainAdvancedTerms">>) => {
    if (!selectedProfile) return;
    const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, ...patch });
    if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
  };
  const addSkill = async () => { if (!selectedProfile) return; const name = await requestDialog({ kind: "form", title: "新增 Skill", label: "Skill 名称", required: true }); if (typeof name !== "string" || !name.trim()) return; const content = await requestDialog({ kind: "form", title: "Skill 内容", label: "内容", multiline: true, confirmLabel: "保存" }); const skill = { id: `skill-${Date.now()}`, name: name.trim(), description: "", content: typeof content === "string" ? content : "", tags: [] }; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: [...selectedProfile.skills, skill] }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const editSkill = async (skillId: string) => { if (!selectedProfile) return; const skill = selectedProfile.skills.find((item) => item.id === skillId); if (!skill) return; const content = await requestDialog({ kind: "form", title: `编辑 Skill：${skill.name}`, label: "内容", defaultValue: skill.content, multiline: true, confirmLabel: "保存" }); if (typeof content !== "string") return; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.map((item) => item.id === skillId ? { ...item, content } : item) }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const removeProfileMaterial = async (kind: "resume" | "jobDescription") => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.removeMaterial(selectedProfile.id, kind); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const rebuildProfileBuilder = async () => {
    if (!selectedProfile || profileBuilderRunning) return;
    setProfileBuilderRunning(true);
    try {
      const artifact = await window.interviewCopilot.profileBuilder.rebuild(selectedProfile.id);
      setProfileBuilderArtifact(artifact);
      store.setNotice("Profile Builder 已完成：技能图谱、项目图谱和回答素材已更新");
    } catch (error) {
      store.setNotice(`Profile Builder 失败：${userFacingError(error)}`);
    } finally {
      setProfileBuilderRunning(false);
    }
  };
  const rebuildProjectMemory = async () => {
    if (!selectedProfile || projectMemoryRunning) return;
    setProjectMemoryRunning(true);
    try {
      const memory = await window.interviewCopilot.projectMemory.rebuild(selectedProfile.id);
      setProjectMemory(memory);
      setProjectMemoryStats(await window.interviewCopilot.projectMemory.stats(selectedProfile.id));
      const [facts, targets, analyses, retrievals] = await Promise.all([window.interviewCopilot.projectMemory.listFacts(selectedProfile.id), window.interviewCopilot.jobTargets.list(selectedProfile.id), window.interviewCopilot.projectMemory.analysisRuns(selectedProfile.id), window.interviewCopilot.retrieval.list(selectedProfile.id, 20)]);
      setProjectFacts(facts); setJobTargets(targets); setKnowledgeAnalysisRuns(analyses); setRetrievalRuns(retrievals);
      store.setNotice("个人工程经验已更新");
    } catch (error) {
      store.setNotice(`项目记忆分析失败：${userFacingError(error)}`);
    } finally { setProjectMemoryRunning(false); }
  };
  const verifyProjectFact = async (factId: string, verified: boolean) => {
    const updated = await window.interviewCopilot.projectMemory.verifyFact(factId, verified);
    if (updated) {
      setProjectFacts((current) => current.map((fact) => fact.id === updated.id ? updated : fact));
      store.setNotice(verified ? "事实已确认，后续项目回答可以优先使用" : "事实已取消确认");
    }
  };
  const startWrittenTest = async () => {
    try {
      if (!profileId) throw new Error("PROFILE_NOT_FOUND: 请先创建或选择一个面试档案。");
      const preflight = await window.interviewCopilot.settings.preflight(true);
      if (!preflight.llm.configured) throw new Error("LLM_NOT_CONFIGURED: 未配置 LLM API Key");
      if (!preflight.llm.reachable) throw new Error(`LLM_CONNECT_FAILED: ${preflight.llm.message ?? preflight.llm.status}`);
      await window.interviewCopilot.profiles.selectActive(profileId);
      await window.interviewCopilot.writtenTest.start({ profileId, answerMode });
      setSetupOpen(false);
      store.setNotice("笔试模式已启动，按 Ctrl+Alt+S 截图并回答");
    } catch (error) {
      store.setNotice(`笔试模式启动失败：${userFacingError(error)}`);
    }
  };
  const deleteSkill = async (skillId: string) => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.filter((skill) => skill.id !== skillId) }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const confirmDetectedSkill = async (skillId: string) => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.map((skill) => skill.id === skillId ? { ...skill, tags: skill.tags.filter((tag) => tag !== "待确认") } : skill) }); if (updated) { setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); store.setNotice("技能已确认"); } };
  const toggleKnowledgeBase = async (baseId: string, linked: boolean) => { if (!selectedProfile) return; const ids = linked ? selectedProfile.knowledgeBaseIds.filter((id) => id !== baseId) : [...selectedProfile.knowledgeBaseIds, baseId]; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, knowledgeBaseIds: ids }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };

  const openConversation = async (conversationId: string) => {
    const conversation = await window.interviewCopilot.chat.getConversation(conversationId);
    if (!conversation) return;
    setActiveConversationId(conversationId);
    setChatMessages(conversation.messages as ChatMessage[]);
    setPage("home");
  };
  const openProject = async (projectId: string) => { setSelectedProjectId(projectId); setPage("home"); setActiveConversationId(undefined); setChatMessages([]); setComposerText(""); setConversations((await window.interviewCopilot.chat.listConversations()).filter((conversation) => conversation.projectId === projectId)); };
  const beginNewConversation = () => { setPage("home"); setSelectedProjectId(undefined); setActiveConversationId(undefined); setChatMessages([]); setComposerText(""); };
  const submitComposer = async () => {
    const content = composerText.trim();
    if (!content || chatSending) return;
    setComposerText("");
    try {
      let conversationId = activeConversationId;
      if (!conversationId) {
        const conversation = await window.interviewCopilot.chat.createConversation({ profileId, projectId: selectedProjectId, title: content.slice(0, 36) });
        conversationId = conversation.id;
        setActiveConversationId(conversation.id);
        setConversations((current) => [conversation as ConversationItem, ...current]);
      }
      setChatSending(true);
      await window.interviewCopilot.chat.sendMessage(conversationId, content);
    } catch (error) {
      setChatSending(false);
      store.setNotice(`聊天发送失败：${userFacingError(error)}`);
    } finally {
      // IPC rejection is also a terminal state. Keep the composer usable even
      // if a provider fails before the main process can emit chat:error.
      setChatSending(false);
    }
  };
  const sendProjectAgent = async (projectId: string, content: string): Promise<void> => {
    if (!content.trim() || chatSending) return;
    setSelectedProjectId(projectId);
    let conversationId = conversations.find((item) => item.projectId === projectId)?.id;
    try {
      if (!conversationId) {
        const project = projectMemory?.projects.find((item) => item.id === projectId);
        const conversation = await window.interviewCopilot.chat.createConversation({ profileId, projectId, title: `${project?.name ?? "项目"} · 资料 Agent` });
        conversationId = conversation.id;
        setConversations((current) => [conversation as ConversationItem, ...current]);
        setChatMessages([]);
      } else if (conversationId !== activeConversationId) {
        const conversation = await window.interviewCopilot.chat.getConversation(conversationId);
        setChatMessages((conversation?.messages ?? []) as ChatMessage[]);
      }
      setActiveConversationId(conversationId);
      setChatSending(true);
      await window.interviewCopilot.chat.sendMessage(conversationId, content.trim());
    } catch (error) {
      setChatSending(false);
      store.setNotice(`项目 Agent 发送失败：${userFacingError(error)}`);
    }
  };
  const reviewProjectFact = async (factId: string, status: "active" | "pending_review" | "rejected" | "conflicting") => {
    const updated = await window.interviewCopilot.projectMemory.reviewFact(factId, status);
    if (updated) {
      setProjectFacts((current) => current.map((fact) => fact.id === updated.id ? updated : fact));
      store.setNotice(status === "rejected" ? "事实已标记为不正确" : status === "active" ? "事实已确认" : "事实状态已更新");
    }
  };
  const continueChatMessage = async (messageId: string) => {
    if (!activeConversationId || chatSending) return;
    setChatSending(true);
    try { await window.interviewCopilot.chat.continueMessage(activeConversationId, messageId); }
    catch (error) { setChatSending(false); store.setNotice(`继续生成失败：${userFacingError(error)}`); }
  };
  const retryChatMessage = async (messageId: string) => {
    if (!activeConversationId || chatSending) return;
    const index = chatMessages.findIndex((message) => message.id === messageId);
    const question = [...chatMessages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (!question) { store.setNotice("找不到原始问题，请重新输入。"); return; }
    setChatSending(true);
    try { await window.interviewCopilot.chat.sendMessage(activeConversationId, question.content); }
    catch (error) { setChatSending(false); store.setNotice(`重新生成失败：${userFacingError(error)}`); }
  };
  const approveChatAction = async (messageId: string, action: ChatAction) => {
    if (!activeConversationId) return;
    try {
      await window.interviewCopilot.chat.approveAction({ conversationId: activeConversationId, messageId, action });
      setChatMessages((current) => current.map((message) => message.id === messageId && message.structuredResponse ? { ...message, structuredResponse: { ...message.structuredResponse, actions: (message.structuredResponse.actions ?? []).map((item) => item.id === action.id ? { ...item, status: "approved" as const } : item) } } : message));
      store.setNotice("操作已确认并写入本地数据");
    } catch (error) {
      store.setNotice(`操作执行失败：${userFacingError(error)}`);
    }
  };
  const createProject = async () => {
    const value = await requestDialog({ kind: "form", title: "创建项目", description: "项目会保存到本地数据库，并可关联当前 Profile。", label: "项目名称", defaultValue: "新面试项目", required: true, confirmLabel: "创建" });
    if (typeof value !== "string" || !value.trim()) return;
    try {
      const project = await window.interviewCopilot.projects.create({ name: value.trim(), profileId });
      if (project) { setProjects((current) => [project, ...current]); setSelectedProjectId(project.id); store.setNotice(`项目“${project.name}”已创建`); }
    } catch (error) { store.setNotice(`项目创建失败：${userFacingError(error)}`); }
  };
  const renameProject = async (projectId: string, currentName: string) => { const name = await requestDialog({ kind: "form", title: "重命名项目", label: "项目名称", defaultValue: currentName, required: true, confirmLabel: "保存" }); if (typeof name !== "string") return; const updated = await window.interviewCopilot.projects.rename(projectId, name); if (updated) setProjects((current) => current.map((project) => project.id === updated.id ? updated : project)); };
  const deleteProject = async (projectId: string, currentName: string) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${currentName}？`, description: "项目会被删除，对话内容仍保留。", confirmLabel: "删除" }); if (confirmed !== true) return; await window.interviewCopilot.projects.delete(projectId); setProjects((current) => current.filter((project) => project.id !== projectId)); if (selectedProjectId === projectId) beginNewConversation(); };
  const startPreparation = () => { setPage("preparation"); store.setNotice("已打开面试准备 Agent"); };
  const polishResume = () => { setPreparationGoal("润色当前 Resume 中的项目描述，保留真实技术细节和量化结果"); setPage("preparation"); };
  const selectLanguage = () => setPage("settings");
  const testProvider = async (section: "llm" | "asr" | "embedding") => {
    setProviderTests((current) => ({ ...current, [section]: "正在测试…" }));
    try {
      let testedProfileId: string | undefined;
      if (section === "llm") testedProfileId = (await saveLlmProfile()).profileId;
      if (section === "asr") await window.interviewCopilot.settings.update("asr", { providerName: asrProviderLabel(asrProviderType), providerType: asrProviderType, baseUrl: asrBaseUrl.trim(), model: asrModel.trim() || asrDefaultModel(asrProviderType), language: asrLanguage, apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      if (section === "embedding") await window.interviewCopilot.settings.update("embedding", { providerName: "OpenAI-compatible", baseUrl: embeddingBaseUrl.trim(), model: embeddingModel.trim() || "text-embedding-3-small", apiKey: embeddingApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      if (section !== "llm") applyProviderSettings(await window.interviewCopilot.settings.get());
      if (section === "asr" && asrProviderType === "funasr-local") {
        const health = await window.interviewCopilot.localAsr.health({ webSocketUrl: asrBaseUrl.trim(), model: asrModel.trim() || asrDefaultModel(asrProviderType) });
        if (health.overall === "not_ready") {
          const failed = [health.serviceRoot, health.python, health.openasr, health.venv, health.dependencies, health.model, health.facadePort, health.backendPort].filter((check) => !check.ok).map((check) => check.reason);
          setProviderTests((current) => ({ ...current, asr: `本地 ASR 未就绪 · ${failed.join("；") || "请检查服务状态"}` }));
          return;
        }
      }
      const result = await window.interviewCopilot.settings.testConnection(section, testedProfileId);
      setProviderTests((current) => ({ ...current, [section]: result.status === "ready" ? "正常" : `${result.status}${result.message ? ` · ${result.message}` : ""}` }));
    } catch (error) { setProviderTests((current) => ({ ...current, [section]: userFacingError(error) })); }
  };
  const fetchProviderModels = async (section: "llm" | "asr" | "embedding") => {
    setModelCatalogLoading((current) => ({ ...current, [section]: true }));
    setProviderTests((current) => ({ ...current, [section]: "正在保存密钥并获取模型…" }));
    try {
      let profileIdForRequest: string | undefined;
      if (section === "llm") profileIdForRequest = (await saveLlmProfile()).profileId;
      if (section === "asr") await window.interviewCopilot.settings.update("asr", { providerName: asrProviderLabel(asrProviderType), providerType: asrProviderType, baseUrl: asrBaseUrl.trim(), model: asrModel.trim() || asrDefaultModel(asrProviderType), language: asrLanguage, apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      if (section === "embedding") await window.interviewCopilot.settings.update("embedding", { providerName: /dashscope|aliyun/i.test(embeddingBaseUrl) ? "Qwen / Bailian" : "OpenAI-compatible", baseUrl: embeddingBaseUrl.trim(), model: embeddingModel.trim() || "text-embedding-v4", apiKey: embeddingApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      const catalog = await window.interviewCopilot.settings.listModels(section, profileIdForRequest);
      setModelCatalogs((current) => ({ ...current, [section]: catalog }));
      if (section === "llm") {
        const has = (value: string, category: ModelCategory) => catalog.models.some((model) => model.id === value && model.categories.includes(category));
        const first = (category: ModelCategory) => catalog.models.find((model) => model.categories.includes(category))?.id ?? "";
        if (!has(llmModel, "general") && !has(llmModel, "fast") && !has(llmModel, "reasoning")) setLlmModel(first("general") || first("fast") || first("reasoning"));
        if (!has(fastModel, "fast")) setFastModel(first("fast") || first("general"));
        if (!has(normalModel, "general")) setNormalModel(first("general") || first("fast"));
        if (!has(deepModel, "reasoning")) setDeepModel(first("reasoning") || first("general"));
        if (visionModel && !has(visionModel, "vision")) setVisionModel(first("vision"));
      } else if (section === "asr" && !asrModel.trim()) setAsrModel(catalog.models[0]?.id ?? asrDefaultModel(asrProviderType));
      else if (section === "embedding" && !catalog.models.some((model) => model.id === embeddingModel)) setEmbeddingModel(catalog.models[0]?.id ?? embeddingModel);
      setProviderSettings(await window.interviewCopilot.settings.get());
      setAsrApiKey("");
      setEmbeddingApiKey("");
      setProviderTests((value) => ({ ...value, [section]: `已获取 ${catalog.models.length} 个模型${catalog.warning ? ` · ${catalog.warning}` : ""}` }));
    } catch (error) {
      setProviderTests((current) => ({ ...current, [section]: userFacingError(error) }));
    } finally {
      setModelCatalogLoading((current) => ({ ...current, [section]: false }));
    }
  };
  const clearProviderKey = async (section: "llm" | "asr" | "embedding") => { await window.interviewCopilot.settings.update(section, { apiKey: "" }); const current = await window.interviewCopilot.settings.get(); setProviderSettings(current); store.setNotice(`${section.toUpperCase()} API Key 已删除`); };
  const specialPageContent = page === "knowledge"
    ? <KnowledgePage knowledgeBases={knowledgeBases} knowledgeBaseId={knowledgeBaseId} knowledgeDocuments={knowledgeDocuments} requestDialog={requestDialog} onSelectBase={setKnowledgeBaseId} onCreateBase={async (name) => { const created = await window.interviewCopilot.knowledge.createBase(name); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); setKnowledgeDocuments([]); } }} onRenameBase={async (id, name) => { const updated = await window.interviewCopilot.knowledge.renameBase(id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); }} onDeleteBase={async (id, name) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${name}？`, description: "删除后资料库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(id); const next = await window.interviewCopilot.knowledge.listBases(); const nextId = next[0]?.id ?? ""; setKnowledgeBases(next); setKnowledgeBaseId(nextId); setKnowledgeDocuments(nextId ? await window.interviewCopilot.knowledge.listDocuments(nextId) : []); } }} onUpload={uploadKnowledgeFile} onUpdateType={async (id, type) => { await window.interviewCopilot.knowledge.updateType(id, type); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onReindex={async (id) => { await window.interviewCopilot.knowledge.reindex(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onDeleteDocument={async (id) => { await window.interviewCopilot.knowledge.delete(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} />
    : page === "project-library"
      ? <ProjectLibraryManager profileId={profileId} memory={projectMemory ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] }} stats={projectMemoryStats} facts={projectFacts} documents={knowledgeDocuments} analysisRuns={knowledgeAnalysisRuns} rebuilding={projectMemoryRunning} onUploadProject={(file) => uploadKnowledgeFile(file, "project")} onRebuild={() => void rebuildProjectMemory()} onVerifyFact={verifyProjectFact} onReviewFact={reviewProjectFact} onOpenSources={() => setPage("knowledge")} agentMessages={chatMessages} agentSending={chatSending} agentProjectId={conversations.find((item) => item.id === activeConversationId)?.projectId} onSendAgent={sendProjectAgent} onRetryAgent={retryChatMessage} onOpenSettings={() => setPage("settings")} onApproveAgentAction={approveChatAction} />
      : page === "job-targets"
      ? <JobTargetsPage targets={jobTargets} onUploadJob={uploadJobDescription} onOpenProfile={() => setPage("profiles")} />
      : undefined;
  const modernPageContent = specialPageContent ?? (() => {
    if (page === "settings") {
      const llmCatalog = modelCatalogs.llm?.models ?? [];
      const asrCatalog = modelCatalogs.asr?.models ?? [];
      const embeddingCatalog = modelCatalogs.embedding?.models ?? [];
      const selectedLlmSettings = llmProfiles.find((profile) => profile.id === llmProfileId);
      const llmHasKey = selectedLlmSettings?.hasApiKey ?? false;
      const llmPreset = /deepseek/i.test(`${llmProviderName} ${llmBaseUrl}`) ? "deepseek" : /qwen|dashscope|千问|百炼/i.test(`${llmProviderName} ${llmBaseUrl}`) ? "qwen" : "custom";
      const chooseLlmPreset = (preset: "deepseek" | "qwen" | "custom") => {
        setModelCatalogs((current) => ({ ...current, llm: undefined }));
        setProviderTests((current) => ({ ...current, llm: "供应商已更改 · 请保存密钥并获取模型" }));
        if (preset === "deepseek") {
          setLlmProviderName("DeepSeek"); setLlmBaseUrl("https://api.deepseek.com"); setLlmModel("deepseek-v4-flash"); setFastModel("deepseek-v4-flash"); setNormalModel("deepseek-v4-flash"); setDeepModel("deepseek-v4-pro"); setVisionModel("");
        } else if (preset === "qwen") {
          setLlmProviderName("Qwen / Bailian"); setLlmBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"); setLlmModel("qwen-plus"); setFastModel("qwen-flash"); setNormalModel("qwen-plus"); setDeepModel("qwen3-max"); setVisionModel("qwen3-vl-plus");
        } else {
          setLlmProviderName("OpenAI-compatible");
        }
      };
      return <section className="simple-page settings-page model-settings-page">
        <div className="page-heading model-settings-heading"><div><span className="page-kicker">MODEL & SERVICES</span><h1>模型与服务</h1><p className="page-note">选择供应商，输入或替换密钥，然后从供应商实时返回的模型中选择。密钥只保存在系统加密存储中。</p></div><button className="dark-pill" onClick={() => void saveProviderSettings()}>保存全部设置</button></div>
        <div className="settings-health-strip"><span><i className={llmHasKey ? "ready" : ""} />生成模型 {llmHasKey ? "已保存密钥" : "未配置"}</span><span><i className={providerSettings?.asr.hasApiKey || asrProviderType === "funasr-local" ? "ready" : ""} />语音识别 {providerSettings?.asr.hasApiKey || asrProviderType === "funasr-local" ? "已配置" : "未配置"}</span><span><i className={providerSettings?.embedding.hasApiKey ? "ready" : ""} />向量模型 {providerSettings?.embedding.hasApiKey ? "已配置" : "可选"}</span></div>

        <section className="settings-service-card primary-service-card">
          <header><div><span className="step-number">01</span><div><h2>回答生成模型</h2><p>当前编辑：{llmProfileName || "未命名配置"}{llmProfileId === activeLlmProfileId ? " · 正在使用" : " · 尚未启用"}</p></div></div><span className={`service-badge ${llmHasKey ? "ready" : ""}`}>{llmHasKey ? "密钥已保存" : "需要密钥"}</span></header>
          <div className="provider-preset-row" role="group" aria-label="生成模型供应商"><button className={llmPreset === "deepseek" ? "selected" : ""} onClick={() => chooseLlmPreset("deepseek")}><strong>DeepSeek</strong><small>官方 API · 推荐</small></button><button className={llmPreset === "qwen" ? "selected" : ""} onClick={() => chooseLlmPreset("qwen")}><strong>阿里云百炼 / 千问</strong><small>文本、视觉模型</small></button><button className={llmPreset === "custom" ? "selected" : ""} onClick={() => chooseLlmPreset("custom")}><strong>OpenAI 兼容</strong><small>自定义服务</small></button></div>
          <div className="credential-row"><label className="clean-field"><span>API Key <em className="configured-label">{llmHasKey ? "已保存 · 输入新值即可替换" : "尚未保存"}</em></span><input type="password" autoComplete="off" value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} placeholder={llmHasKey ? "输入新的 API Key 以替换" : "输入 API Key"} /></label><button className="dark-pill" disabled={modelCatalogLoading.llm} onClick={() => void fetchProviderModels("llm")}>{modelCatalogLoading.llm ? "获取中…" : "保存密钥并获取模型"}</button><button className="outline-pill" onClick={() => void testProvider("llm")}>测试所选配置</button></div>
          <p className={`provider-feedback ${providerTests.llm?.includes("失败") || providerTests.llm?.includes("错误") ? "error" : ""}`}>{providerTests.llm ?? (llmHasKey ? "密钥已保存，建议获取一次最新模型列表" : "输入密钥后即可获取模型")}</p>
          <div className="catalog-heading"><div><h3>按用途选择模型</h3><p>不同任务自动走不同模型；没有对应类别时会回退到默认模型。</p></div>{modelCatalogs.llm && <span>{new Date(modelCatalogs.llm.fetchedAt).toLocaleTimeString()} 更新 · {llmCatalog.length} 个</span>}</div>
          {llmCatalog.length > 0 ? <div className="catalog-grid"><CatalogModelSelect label="默认模型" value={llmModel} models={llmCatalog} category="general" onChange={setLlmModel} /><CatalogModelSelect label="快速模型" value={fastModel} models={llmCatalog} category="fast" onChange={setFastModel} /><CatalogModelSelect label="通用模型" value={normalModel} models={llmCatalog} category="general" onChange={setNormalModel} /><CatalogModelSelect label="推理模型" value={deepModel} models={llmCatalog} category="reasoning" onChange={setDeepModel} /><CatalogModelSelect label="视觉模型" value={visionModel} models={llmCatalog} category="vision" onChange={setVisionModel} optional /></div> : <div className="catalog-empty"><strong>模型列表尚未获取</strong><span>保存密钥后，系统会验证身份并按快速、通用、推理、视觉自动分类。</span></div>}
          <details className="advanced-settings settings-advanced"><summary>高级设置与手动模型</summary><div className="advanced-grid"><label className="clean-field"><span>Provider Name</span><input value={llmProviderName} onChange={(event) => setLlmProviderName(event.target.value)} /></label><label className="clean-field"><span>Base URL</span><input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} /></label><label className="clean-field"><span>默认模型 ID</span><input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} /></label><label className="clean-field"><span>快速 / 通用 / 推理 / 视觉</span><input value={[fastModel, normalModel, deepModel, visionModel].filter(Boolean).join(" · ")} readOnly /></label></div></details>
        </section>

        <div className="secondary-services-grid">
          <section className="settings-service-card"><header><div><span className="step-number">02</span><div><h2>实时语音识别</h2><p>把面试官语音转成问题</p></div></div><span className={`service-badge ${providerSettings?.asr.hasApiKey || asrProviderType === "funasr-local" ? "ready" : ""}`}>{asrProviderType === "qwen" ? "千问" : asrProviderType === "deepgram" ? "Deepgram" : asrProviderType === "funasr-local" ? "本地" : "自定义"}</span></header>
            <label className="clean-field"><span>供应商</span><select value={asrProviderType} onChange={(event) => { const next = event.target.value as AsrProviderType; setAsrProviderType(next); setModelCatalogs((current) => ({ ...current, asr: undefined })); if (next === "qwen") { setAsrBaseUrl(QWEN_REALTIME_ASR_URL); setAsrModel(QWEN_REALTIME_ASR_MODEL); } else if (next === "deepgram") { setAsrBaseUrl("wss://api.deepgram.com/v1/listen"); setAsrModel("nova-3"); } else if (next === "funasr-local") { setAsrBaseUrl("ws://127.0.0.1:8765"); setAsrModel("funasr-nano:q8"); } }}><option value="qwen">千问实时语音</option><option value="deepgram">Deepgram Cloud</option><option value="funasr-local">本地 Fun-ASR-Nano</option><option value="custom-gateway">Custom Gateway</option></select></label>
            {asrProviderType !== "funasr-local" && <label className="clean-field"><span>API Key <em className="configured-label">{providerSettings?.asr.hasApiKey ? "已保存 · 可直接替换" : "未保存"}</em></span><input type="password" autoComplete="off" value={asrApiKey} onChange={(event) => setAsrApiKey(event.target.value)} placeholder={providerSettings?.asr.hasApiKey ? "输入新值以替换" : "输入 API Key"} /></label>}
            {asrProviderType === "qwen" && asrCatalog.length > 0 ? <CatalogModelSelect label="实时语音模型" value={asrModel} models={asrCatalog} category="realtime-asr" onChange={setAsrModel} /> : <label className="clean-field"><span>模型</span><input value={asrModel} onChange={(event) => setAsrModel(event.target.value)} /></label>}
            <label className="clean-field compact-field"><span>语言</span><select value={asrLanguage} onChange={(event) => setAsrLanguage(event.target.value as typeof asrLanguage)}><option value="zh-CN">中文</option><option value="en-US">英文</option><option value="multi">多语言</option></select></label>
            <div className="provider-actions">{asrProviderType === "qwen" && <button className="dark-pill" disabled={modelCatalogLoading.asr} onClick={() => void fetchProviderModels("asr")}>{modelCatalogLoading.asr ? "获取中…" : "保存并获取模型"}</button>}<button className="outline-pill" onClick={() => void testProvider("asr")}>测试连接</button></div><p className="provider-feedback">{providerTests.asr ?? "尚未测试"}</p>
            <details className="advanced-settings settings-advanced"><summary>高级连接地址</summary><label className="clean-field"><span>WebSocket URL</span><input value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} /></label></details>
          </section>

          <section className="settings-service-card"><header><div><span className="step-number">03</span><div><h2>向量检索模型</h2><p>提升项目资料和题库召回，可选</p></div></div><span className={`service-badge ${providerSettings?.embedding.hasApiKey ? "ready" : ""}`}>{providerSettings?.embedding.hasApiKey ? "已启用" : "可选"}</span></header>
            <label className="clean-field"><span>API Key <em className="configured-label">{providerSettings?.embedding.hasApiKey ? "已保存 · 可直接替换" : "可使用千问密钥"}</em></span><input type="password" autoComplete="off" value={embeddingApiKey} onChange={(event) => setEmbeddingApiKey(event.target.value)} placeholder={providerSettings?.embedding.hasApiKey ? "输入新值以替换" : "输入百炼 / 兼容服务密钥"} /></label>
            {embeddingCatalog.length > 0 ? <CatalogModelSelect label="向量模型" value={embeddingModel} models={embeddingCatalog} category="embedding" onChange={setEmbeddingModel} /> : <label className="clean-field"><span>向量模型</span><input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} /></label>}
            <div className="provider-actions"><button className="dark-pill" disabled={modelCatalogLoading.embedding} onClick={() => void fetchProviderModels("embedding")}>{modelCatalogLoading.embedding ? "获取中…" : "保存并获取模型"}</button><button className="outline-pill" onClick={() => void testProvider("embedding")}>测试连接</button></div><p className="provider-feedback">{providerTests.embedding ?? (providerSettings?.embedding.hasApiKey ? "已配置，尚未测试" : "未配置时使用关键词检索")}</p>
            <details className="advanced-settings settings-advanced"><summary>高级连接地址</summary><label className="clean-field"><span>Base URL</span><input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} /></label></details>
          </section>
        </div>
        <section className="answer-mode-card"><div><strong>默认回答模式</strong><span>影响实时面试时的模型路由</span></div><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">快速</option><option value="NORMAL">平衡 · 推荐</option><option value="DEEP">深度推理</option></select></section>
        <OverlayPreferencesPanel value={overlayPreferences} onChange={(patch) => { void window.interviewCopilot.overlay.setPreferences(patch).then(setOverlayPreferences).catch((error) => store.setNotice(`悬浮窗设置保存失败：${userFacingError(error)}`)); }} onReset={() => { void window.interviewCopilot.overlay.setPreferences(DEFAULT_OVERLAY_PREFERENCES).then(setOverlayPreferences); }} />
      </section>;
    }
    if (String(page) === "personal-memory") return <><PersonalMemoryPage memory={projectMemory} stats={projectMemoryStats} rebuilding={projectMemoryRunning} onRebuild={() => void rebuildProjectMemory()} /><MemoryGovernancePanel memory={projectMemory} facts={projectFacts} jobTargets={jobTargets} analysisRuns={knowledgeAnalysisRuns} retrievalRuns={retrievalRuns} onVerifyFact={verifyProjectFact} /></>;
    if (String(page) === "knowledge") return <KnowledgePage knowledgeBases={knowledgeBases} knowledgeBaseId={knowledgeBaseId} knowledgeDocuments={knowledgeDocuments} requestDialog={requestDialog} onSelectBase={setKnowledgeBaseId} onCreateBase={async (name) => { const created = await window.interviewCopilot.knowledge.createBase(name); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); setKnowledgeDocuments([]); } }} onRenameBase={async (id, name) => { const updated = await window.interviewCopilot.knowledge.renameBase(id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); }} onDeleteBase={async (id, name) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${name}？`, description: "知识库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(id); const next = await window.interviewCopilot.knowledge.listBases(); setKnowledgeBases(next); const nextId = next[0]?.id ?? ""; setKnowledgeBaseId(nextId); setKnowledgeDocuments(nextId ? await window.interviewCopilot.knowledge.listDocuments(nextId) : []); } }} onUpload={uploadKnowledgeFile} onUpdateType={async (id, type) => { await window.interviewCopilot.knowledge.updateType(id, type); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onReindex={async (id) => { await window.interviewCopilot.knowledge.reindex(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onDeleteDocument={async (id) => { await window.interviewCopilot.knowledge.delete(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} />;
    if (String(page) === "question-bank") return <QuestionBankPage questions={questionBankQuestions} total={questionBankTotal} skills={questionBankSkills} jobs={questionBankJobs} onList={(options) => window.interviewCopilot.questionBank.list(options)} onCount={(options) => window.interviewCopilot.questionBank.count(options)} onBulkUpdate={(ids, patch) => window.interviewCopilot.questionBank.bulkUpdate(ids, patch).then(async (count) => { await refreshQuestionBank(); return count; })} onDuplicates={() => window.interviewCopilot.questionBank.duplicates()} onMergeDuplicates={(canonicalId, duplicateIds) => window.interviewCopilot.questionBank.mergeDuplicates(canonicalId, duplicateIds).then(async (result) => { await refreshQuestionBank(); return result; })} answerGenerationProgress={questionBankAnswerProgress} onSaveQuestion={async (input) => { const saved = await window.interviewCopilot.questionBank.saveQuestion(input); await refreshQuestionBank(); return saved; }} onSaveAnswer={async (input) => { const saved = await window.interviewCopilot.questionBank.saveAnswer(input); await refreshQuestionBank(); return saved; }} onDeleteQuestion={async (id) => { await window.interviewCopilot.questionBank.deleteQuestion(id); await refreshQuestionBank(); store.setNotice("题目已删除"); }} onImport={async (text, filename, options) => { const result = await window.interviewCopilot.questionBank.importText({ text, filename, ...options }); await refreshQuestionBank(); return result; }} onGenerateAnswers={async (questionIds) => { try { store.setNotice("正在生成题库答案…"); return await window.interviewCopilot.questionBank.generateAnswers({ questionIds, onlyUnanswered: true }); } catch (error) { store.setNotice(`答案生成失败：${userFacingError(error)}`); return undefined; } }} onSaveSkill={async (input) => { await window.interviewCopilot.questionBank.saveSkill(input); await refreshQuestionBank(); store.setNotice(`技能“${input.name}”已保存`); }} onLinkSkill={(questionId, skillId) => window.interviewCopilot.questionBank.linkSkill(questionId, skillId)} onCoverage={(jobProfileId) => window.interviewCopilot.questionBank.coverage(jobProfileId)} onNotice={(message) => store.setNotice(message)} />;
    if (page === "home") return chatMessages.length > 0 ? <section className="conversation-view"><div className="page-heading"><div><span className="page-kicker">CONVERSATION</span><h1>{conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? "新对话"}</h1></div><span className="conversation-status">{chatSending ? "AI 正在生成…" : "已保存到本地"}</span></div><div className="chat-message-list">{chatMessages.map((message) => { const recoverable = message.role === "assistant" && (message.status === "cancelled" || message.status === "partial_error"); const retryable = message.role === "assistant" && message.status === "failed"; return <article className={`chat-message ${message.role}`} key={message.id}><span className="chat-message-avatar">{message.role === "user" ? "你" : "AI"}</span><div className="chat-message-body"><div className="chat-message-role">{message.role === "user" ? "你" : "Interview Copilot"}{message.status === "streaming" && <span className="streaming-label">正在生成…</span>}{message.status === "cancelled" && <span className="chat-status-label">已停止生成</span>}{message.status === "partial_error" && <span className="chat-status-label chat-status-warning">回答生成中断，已保留当前内容</span>}{message.status === "failed" && <span className="chat-status-label chat-status-error">生成失败</span>}</div>{message.role === "assistant" ? <MarkdownAnswer text={message.content || (message.status === "streaming" ? "正在生成…" : message.status === "failed" ? "暂无回答内容" : "已保留当前回答内容")} /> : <p>{message.content}</p>}{(recoverable || retryable) && <div className="chat-recovery-actions">{recoverable && <button className="outline-pill" disabled={chatSending} onClick={() => void continueChatMessage(message.id)}>继续回答</button>}<button className="outline-pill" disabled={chatSending} onClick={() => void retryChatMessage(message.id)}>重新生成</button></div>}</div></article>; })}</div>{chatSending && activeConversationId && <button className="outline-pill stop-generation" onClick={() => void window.interviewCopilot.chat.cancel(activeConversationId)}>停止生成</button>}</section> : <WelcomeScreen onPrepare={startPreparation} onPolish={polishResume} onLanguage={selectLanguage} onRefresh={beginNewConversation} />;
    if (page === "interview") return <section className="simple-page interview-page"><div className="page-heading"><div><span className="page-kicker">LIVE INTERVIEW</span><h1>开始面试</h1><p className="page-note">面试官一开口，答案就在屏幕上。</p></div><div className="detail-actions"><button className="outline-pill" onClick={() => void startWrittenTest()}>笔试模式</button><button className="dark-pill" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div></div><div className="interview-hero"><div className="interview-hero-copy"><span className="hero-status"><i /> READY WHEN YOU ARE</span><h2>让 AI 负责听题，<br />你负责表达。</h2><p>连接麦克风和系统音频，选择面试档案后开始。回答会基于本轮准备快照生成，保持真实、简洁、贴合你的经历。需要笔试时，直接进入截图回答模式。</p><div className="detail-actions"><button className="hero-cta" onClick={() => setSetupOpen(true)}>打开面试设置 <span>→</span></button><button className="outline-pill" onClick={() => void startWrittenTest()}>开始笔试模式</button></div></div><div className="interview-orbit" aria-hidden="true"><span className="orbit-ring ring-one" /><span className="orbit-ring ring-two" /><span className="orbit-core"><b>AI</b><small>LISTEN<br />THINK<br />ANSWER</small></span></div></div><div className="interview-steps"><article><span>01</span><strong>冻结准备快照</strong><p>简历、JD、项目和技能卡</p></article><article><span>02</span><strong>实时识别问题</strong><p>支持追问、打断和换方向</p></article><article><span>03</span><strong>截图回答笔试题</strong><p>Ctrl+Alt+S 触发视觉回答</p></article></div></section>;
    if (page === "preparation") return <section className="simple-page preparation-page"><div className="page-heading"><div><span className="page-kicker">PREPARATION AGENT</span><h1>面试准备</h1></div><span className="page-note">最多 40 步 · 写入需审批</span></div><label className="clean-field"><span>准备目标</span><textarea value={preparationGoal} onChange={(event) => setPreparationGoal(event.target.value)} rows={4} /></label><div className="detail-actions"><button className="dark-pill" disabled={preparationRunning} onClick={async () => { setPreparationEvents([]); setPreparationRunning(true); try { await window.interviewCopilot.preparation.start(preparationGoal); } catch (error) { setPreparationRunning(false); store.setNotice(`Preparation 启动失败：${userFacingError(error)}`); } }}>{preparationRunning ? "准备中…" : "开始准备"}</button>{preparationRunning && <button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.stop()}>停止</button>}</div><div className="preparation-events">{preparationEvents.map((event, index) => <div className={`event-row event-${String(event.type ?? "event")}`} key={`${String(event.type)}-${index}`}><strong>{String(event.type ?? "event")}</strong><span>{typeof event.summary === "string" ? event.summary : typeof event.message === "string" ? event.message : typeof event.tool === "string" ? `${event.tool}${event.rationale ? ` · ${String(event.rationale)}` : ""}` : event.risk ? `风险：${String(event.risk)}` : ""}</span>{event.type === "approval_required" && typeof event.requestId === "string" && <span className="approval-actions"><button className="dark-pill" onClick={() => void window.interviewCopilot.preparation.approve(String(event.requestId))}>允许</button><button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.reject(String(event.requestId))}>拒绝</button></span>}</div>)}</div></section>;
    if (page === "profiles") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">PROFILES</span><h1>档案</h1></div><button className="dark-pill" onClick={async () => { const created = await window.interviewCopilot.profiles.save({ name: `面试档案 ${profiles.length + 1}`, language: "zh-CN", skills: [], knowledgeBaseIds: knowledgeBases[0] ? [knowledgeBases[0].id] : [] }); if (created) { setProfiles((current) => [created, ...current]); setProfileId(created.id); } }}>新建档案</button></div><div className="profile-layout"><div className="clean-list">{profiles.map((profile) => <button className={`clean-list-row ${profile.id === profileId ? "selected" : ""}`} key={profile.id} onClick={() => { setProfileId(profile.id); void window.interviewCopilot.profiles.selectActive(profile.id); }}><span>{profile.name}</span><small>{profile.language} · {profile.skills.length} skills</small></button>)}</div>{selectedProfile && <div className="detail-sheet"><h2>{selectedProfile.name}</h2><p className="page-note">{selectedProfile.language} · 当前档案</p><label className="clean-field"><span>Resume</span><label className="upload-row">{selectedProfile.resume?.summary ?? "未上传 Resume"}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void attachProfileMaterial("resume", event)} /></label>{selectedProfile.resume && <button className="text-button danger-text" onClick={() => void removeProfileMaterial("resume")}>移除 Resume</button>}</label><label className="clean-field"><span>职位描述</span><label className="upload-row">{selectedProfile.jobDescription?.summary ?? "未上传 JD"}<input type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void attachProfileMaterial("jobDescription", event)} /></label>{selectedProfile.jobDescription && <button className="text-button danger-text" onClick={() => void removeProfileMaterial("jobDescription")}>移除 JD</button>}</label><div className="detail-actions"><button className="outline-pill" onClick={() => void editInstructions()}>编辑 Instructions</button><button className="outline-pill" onClick={() => void addSkill()}>新增 Skill</button><button className="outline-pill" onClick={() => void cloneProfile()}>克隆</button><button className="outline-pill" onClick={() => void renameProfile()}>重命名</button><button className="outline-pill danger-outline" onClick={() => void deleteProfile()}>删除</button></div><div className="profile-subsection"><h3>Skills</h3>{selectedProfile.skills.length === 0 && <p className="page-note">尚未添加 Skill</p>}{selectedProfile.skills.map((skill) => <div className="skill-row" key={skill.id}><span><strong>{skill.name}</strong><small>{skill.content.slice(0, 80)}</small></span><span><button className="text-button" onClick={() => void editSkill(skill.id)}>编辑</button><button className="text-button danger-text" onClick={() => void deleteSkill(skill.id)}>删除</button></span></div>)}</div><div className="profile-subsection"><h3>关联知识库</h3>{knowledgeBases.map((base) => <label className="check-row" key={base.id}><input type="checkbox" checked={selectedProfile.knowledgeBaseIds.includes(base.id)} onChange={() => void toggleKnowledgeBase(base.id, selectedProfile.knowledgeBaseIds.includes(base.id))} />{base.name}</label>)}</div></div>}</div></section>;
    if (page === "knowledge") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">KNOWLEDGE</span><h1>知识库</h1></div><button className="dark-pill" onClick={async () => { const name = await requestDialog({ kind: "form", title: "新建知识库", label: "知识库名称", defaultValue: "新知识库", required: true, confirmLabel: "创建" }); if (typeof name === "string" && name.trim()) { const created = await window.interviewCopilot.knowledge.createBase(name.trim()); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); } } }}>新建知识库</button></div><div className="clean-list knowledge-list">{knowledgeBases.map((base) => <div className={`clean-list-row ${base.id === knowledgeBaseId ? "selected" : ""}`} key={base.id}><button className="row-main-button" onClick={() => setKnowledgeBaseId(base.id)}><span>{base.name}</span><small>{base.id === knowledgeBaseId ? `${knowledgeDocuments.length} 个文档` : "查看文档"}</small></button><span className="row-actions"><button className="text-button" onClick={async () => { const name = await requestDialog({ kind: "form", title: "重命名知识库", label: "名称", defaultValue: base.name, required: true, confirmLabel: "保存" }); if (typeof name === "string") { const updated = await window.interviewCopilot.knowledge.renameBase(base.id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); } }}>重命名</button><button className="text-button danger-text" onClick={async () => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${base.name}？`, description: "知识库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(base.id); const next = await window.interviewCopilot.knowledge.listBases(); setKnowledgeBases(next); setKnowledgeBaseId(next[0]?.id ?? ""); } }}>删除</button></span></div>)}</div><label className="upload-document">＋ 导入 PDF / DOCX / TXT / MD / GitHub ZIP<input type="file" accept=".txt,.md,.pdf,.docx,.zip" onChange={(event) => void uploadKnowledge(event)} /></label><div className="clean-list document-list">{knowledgeDocuments.map((document) => <div className="clean-list-row" key={document.id}><span>{document.filename}</span><span className="row-actions"><small>{document.status}{document.error ? ` · ${document.error}` : ""}</small><button className="text-button" onClick={() => void window.interviewCopilot.knowledge.reindex(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>重建索引</button><button className="text-button danger-text" onClick={() => void window.interviewCopilot.knowledge.delete(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>删除</button></span></div>)}</div></section>;
    if (page === "history") return <HistoryPage records={historyRecords} search={historySearch} onSearch={setHistorySearch} detail={historyDetail} metrics={historyMetrics} onSelect={async (recordId) => { const [metrics, detail] = await Promise.all([window.interviewCopilot.history.analyze(recordId), window.interviewCopilot.history.get(recordId)]); if (metrics) setHistoryMetrics({ id: recordId, ...metrics }); if (detail) setHistoryDetail(detail as HistoryDetail); }} onDelete={async (recordId) => { const confirmed = await requestDialog({ kind: "confirm", title: "删除这场面试记录？", description: "这会同时删除该场面试的转写、识别问题和 AI 回答，操作无法撤销。", confirmLabel: "删除记录" }); if (confirmed !== true) return; await window.interviewCopilot.history.delete(recordId); setHistoryRecords((current) => current.filter((record) => record.id !== recordId)); if (historyDetail?.interview.id === recordId) { setHistoryDetail(undefined); setHistoryMetrics(undefined); } store.setNotice("面试记录已删除"); }} />;
    return <section className="simple-page settings-page"><div className="page-heading"><div><span className="page-kicker">SETTINGS</span><h1>设置</h1></div><button className="dark-pill" onClick={() => void saveProviderSettings()}>保存设置</button></div><div className="settings-columns"><div><h2>LLM Provider</h2><label className="clean-field"><span>Provider Name</span><input value={llmProviderName} onChange={(event) => setLlmProviderName(event.target.value)} /></label><label className="clean-field"><span>Base URL</span><input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} /></label><label className="clean-field"><span>API Key {providerSettings?.llm.hasApiKey && <em className="configured-label">已配置 · 仅输入修改</em>}</span><input type="password" value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} placeholder={providerSettings?.llm.hasApiKey ? "••••••••••••" : "输入 API Key"} /></label><div className="model-grid"><label className="clean-field"><span>默认 Model</span><input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} /></label><label className="clean-field"><span>FAST Model</span><input value={fastModel} onChange={(event) => setFastModel(event.target.value)} /></label><label className="clean-field"><span>NORMAL Model</span><input value={normalModel} onChange={(event) => setNormalModel(event.target.value)} /></label><label className="clean-field"><span>DEEP Model</span><input value={deepModel} onChange={(event) => setDeepModel(event.target.value)} /></label><label className="clean-field"><span>Vision Model</span><input value={visionModel} onChange={(event) => setVisionModel(event.target.value)} /></label></div><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("llm")}>测试连接</button><span className="provider-status">{providerTests.llm ?? (providerSettings?.llm.hasApiKey ? "已配置 · 未测试" : "未配置")}</span></div><h2 className="settings-section-gap">Embedding</h2><label className="clean-field"><span>Base URL</span><input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} /></label><label className="clean-field"><span>API Key {providerSettings?.embedding.hasApiKey && <em className="configured-label">已配置 · 仅输入修改</em>}</span><input type="password" value={embeddingApiKey} onChange={(event) => setEmbeddingApiKey(event.target.value)} placeholder={providerSettings?.embedding.hasApiKey ? "••••••••••••" : "可选，未配置时使用 Keyword Retrieval"} /></label><label className="clean-field"><span>Embedding Model</span><input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} /></label><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("embedding")}>测试连接</button><span className="provider-status">{providerTests.embedding ?? (providerSettings?.embedding.hasApiKey ? "已配置 · 未测试" : "Keyword Retrieval")}</span></div></div><div><h2>ASR Provider</h2><label className="clean-field"><span>Provider</span><select value={asrProviderType} onChange={(event) => { const next = event.target.value as AsrProviderType; setAsrProviderType(next); setProviderTests((current) => ({ ...current, asr: "配置已更改 · 请重新测试" })); if (next === "qwen") { setAsrBaseUrl(QWEN_REALTIME_ASR_URL); setAsrModel(QWEN_REALTIME_ASR_MODEL); } else if (next === "deepgram") { setAsrBaseUrl("wss://api.deepgram.com/v1/listen"); setAsrModel("nova-3"); } else if (next === "funasr-local") { setAsrBaseUrl("ws://127.0.0.1:8765"); setAsrModel("funasr-nano:q8"); } }}><option value="deepgram">Deepgram Cloud</option><option value="qwen">Qwen Direct（千问）</option><option value="custom-gateway">Custom Gateway</option><option value="funasr-local">Local Fun-ASR-Nano</option></select></label><label className="clean-field"><span>{asrProviderType === "qwen" ? "千问 API Key" : asrProviderType === "deepgram" ? "Deepgram API Key" : asrProviderType === "funasr-local" ? "本地服务无需 API Key" : "Token / Ticket（可选）"} {providerSettings?.asr.hasApiKey && <em className="configured-label">已配置</em>}</span><input type="password" value={asrApiKey} onChange={(event) => setAsrApiKey(event.target.value)} placeholder={asrProviderType === "funasr-local" ? "本地服务无需填写" : providerSettings?.asr.hasApiKey ? "••••••••••••" : "输入 API Key"} disabled={asrProviderType === "funasr-local"} /></label><label className="clean-field"><span>{asrProviderType === "custom-gateway" ? "Gateway WebSocket URL" : asrProviderType === "funasr-local" ? "Local ASR Server" : "WebSocket URL"}</span><input value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} /></label><label className="clean-field"><span>Model {asrProviderType === "qwen" ? "· 官方实时模型：qwen3-asr-flash-realtime" : ""}</span><input value={asrModel} onChange={(event) => setAsrModel(event.target.value)} /></label><label className="clean-field"><span>Language</span><select value={asrLanguage} onChange={(event) => setAsrLanguage(event.target.value as typeof asrLanguage)}><option value="zh-CN">zh-CN</option><option value="en-US">en-US</option><option value="multi">multi</option></select></label><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("asr")}>测试连接</button><span className="provider-status">{providerTests.asr ?? (asrProviderType === "funasr-local" ? "本地服务 · 未测试" : providerSettings?.asr.hasApiKey ? "已配置 · 未测试" : "未配置")}</span></div><h2 className="settings-section-gap">回答模式</h2><label className="clean-field"><span>默认模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><div className="rag-status"><strong>RAG Mode</strong><span>{providerSettings?.embedding.hasApiKey ? "Hybrid · Vector + Keyword" : "Keyword Retrieval"}</span></div><details className="advanced-settings"><summary>高级诊断</summary><p>设备列表、Audio Probe 和 Realtime 状态在开始面试设置中显示。</p></details></div></div></section>;
  })();

  const pageTitle = page === "home" ? "工作台" : page === "interview" ? "实时面试" : page === "preparation" ? "面试准备" : page === "profiles" ? "档案 / 简历" : page === "project-library" ? "项目库" : page === "knowledge" ? "资料库" : page === "personal-memory" ? "项目知识审核" : page === "question-bank" ? "通用题库" : page === "job-targets" ? "岗位要求" : page === "history" ? "面试历史" : "设置";
  if (isOverlay) return <OverlayRoot mic={store.mic} system={store.system} state={store.state} sessionState={store.sessionState} realtimeState={store.realtimeState} operationMode={store.operationMode} overlayMode={store.overlayMode} hudState={store.hudState} automationMode={store.automationMode} answerMode={store.answerMode} question={store.question} answerText={store.answerText} answerStreaming={store.answerStreaming} answerHistory={store.answerHistory} remoteTranscript={store.remoteTranscript} micTranscript={store.micTranscript} captureProtectionEnabled={captureProtection.requested} captureProtectionSupported={captureProtection.supported} captureProtectionOsFlagApplied={captureProtection.osFlagApplied} captureProtectionDisplayVerified={captureProtection.displayCaptureVerified} captureProtectionLastError={captureProtection.lastError} captureTest={captureTest} onToggleCaptureProtection={() => void toggleCaptureProtection(!captureProtection.requested)} onToggleMode={() => void window.interviewCopilot.overlay.setMode(store.overlayMode === "interactive" ? "passive" : "interactive")} onToggleAutomation={toggleAutomation} onAnswerLatest={() => window.interviewCopilot.interview.answerLatest().catch((error) => { store.setNotice(`回答最新问题失败：${userFacingError(error)}`); throw error; })} onAnswerScreenshot={() => (store.writtenTestRunning ? window.interviewCopilot.writtenTest.answerScreenshot() : window.interviewCopilot.interview.answerScreenshot()).catch((error) => { store.setNotice(`截图失败：${userFacingError(error)}`); throw error; })} onEndInterview={() => store.writtenTestRunning ? window.interviewCopilot.writtenTest.stop().then(() => undefined) : window.interviewCopilot.interview.stop()} onHideAll={() => void window.interviewCopilot.overlay.hideAll()} onShowAll={() => void window.interviewCopilot.overlay.showAll()} onTogglePanels={() => void window.interviewCopilot.overlay.toggleAll()} onToggleTranscript={() => void window.interviewCopilot.overlay.toggleTranscript()} onToggleAnswer={() => void window.interviewCopilot.overlay.toggleAnswer()} onToggleShortcuts={() => void window.interviewCopilot.overlay.toggleShortcuts()} onToggleShare={() => void window.interviewCopilot.overlay.toggleShareMode()} />;

  return (
    <main className="app-shell modern-shell">
      <Sidebar page={page} profileName={selectedProfile?.name} projects={projects} conversations={conversations} onNavigate={setPage} onNewConversation={beginNewConversation} onOpenConversation={(conversationId) => void openConversation(conversationId)} onOpenProject={(projectId) => void openProject(projectId)} onRenameProject={(projectId, name) => void renameProject(projectId, name)} onDeleteProject={(projectId, name) => void deleteProject(projectId, name)} />
      <section className="content-shell">
        <div className="modern-topbar"><div className="topbar-context"><span className="topbar-breadcrumb">Interview Copilot</span><span className="topbar-slash">/</span><strong>{pageTitle}</strong></div><div className="topbar-actions"><span className="topbar-profile">{selectedProfile ? `当前档案 · ${selectedProfile.name}` : "未选择面试档案"}</span><button className="dark-pill start-interview" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div></div>
        <div className="modern-main">
          {page === "interview" && <section className="interview-context-panel"><div><span className="page-kicker">ANSWER CONTEXT</span><strong>本轮回答上下文</strong><small>未选择时，系统会根据面试问题自动识别项目和岗位。</small></div><label className="clean-field"><span>目标岗位</span><select value={interviewJobTargetId} onChange={(event) => setInterviewJobTargetId(event.target.value)}><option value="">自动使用当前岗位</option>{jobTargets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label><label className="clean-field"><span>重点项目</span><select value={interviewProjectId} onChange={(event) => setInterviewProjectId(event.target.value)}><option value="">根据问题自动识别</option>{projectMemory?.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></section>}
          {page === "settings" && <LlmModelProfilesPanel profiles={llmProfiles} activeId={activeLlmProfileId} selectedId={llmProfileId} name={llmProfileName} onNameChange={setLlmProfileName} onSelect={selectLlmProfile} onActivate={() => void activateLlmProfile(llmProfileId)} onNew={startNewLlmProfile} onDelete={() => void deleteLlmProfile()} />}
          <PageErrorBoundary page={page}>{modernPageContent}</PageErrorBoundary>
          {page === "profiles" && selectedProfile && <section className="model-profiles-panel"><div className="model-profiles-heading"><div><span className="page-kicker">ANSWER LANGUAGE</span><h2>回答表达难度</h2><p>控制回答里专业词汇的密度；不会改变事实内容和技术结论。</p></div></div><div className="model-profiles-form"><label className="clean-field"><span>表达级别</span><select value={selectedProfile.expressionLevel ?? "plain"} onChange={(event) => void updateProfileExpression({ expressionLevel: event.target.value as Profile["expressionLevel"] })}><option value="plain">易懂 · 推荐</option><option value="standard">标准 · 常见技术表达</option><option value="expert">专家 · 保留行业术语</option></select></label><label className="check-row"><input type="checkbox" checked={selectedProfile.explainAdvancedTerms ?? true} onChange={(event) => void updateProfileExpression({ explainAdvancedTerms: event.target.checked })} />首次出现较难术语时附一句通俗解释</label></div></section>}
          {page === "home" && <ChatResponseSupplement messages={chatMessages} onApproveAction={approveChatAction} />}
          {page === "settings" && <TaskModelRoutingPanel values={{ fallbackModel, questionRecognitionModel, profileBuilderModel, projectAnalyzerModel, questionBankModel, chatModel, postInterviewModel, preparationModel }} onChange={(key, value) => { const setters: Record<TaskModelKey, (next: string) => void> = { fallbackModel: setFallbackModel, questionRecognitionModel: setQuestionRecognitionModel, profileBuilderModel: setProfileBuilderModel, projectAnalyzerModel: setProjectAnalyzerModel, questionBankModel: setQuestionBankModel, chatModel: setChatModel, postInterviewModel: setPostInterviewModel, preparationModel: setPreparationModel }; setters[key](value); }} />}
          {page === "profiles" && selectedProfile && <div className="profile-subsection profile-builder-panel">
             <div className="profile-builder-heading"><div><h3>简历结构化结果</h3><p className="page-note">上传简历后不会自动调用大模型；点击“重新识别简历”后生成技能、项目和面试素材。</p></div><span className="profile-builder-status">{profileBuilderRunning ? "分析中…" : profileBuilderArtifact?.status === "error" ? "分析失败 · 保留上次结果" : profileBuilderArtifact?.artifact?.status === "partial" ? "部分完成" : profileBuilderArtifact?.artifact ? "分析完成" : "待分析"}</span></div>
             <div className="detail-actions"><button className="outline-pill" disabled={profileBuilderRunning} onClick={() => void rebuildProfileBuilder()}>{profileBuilderRunning ? "构建中…" : "重新识别简历"}</button><span className="page-note">{profileBuilderArtifact?.artifact ? `技能 ${profileBuilderArtifact.artifact.skillGraph.nodes.length} · 项目 ${profileBuilderArtifact.artifact.projectGraph.nodes.length} · 回答素材 ${profileBuilderArtifact.artifact.answerMaterials.length}` : "上传后需手动识别"}</span></div>
             {profileBuilderArtifact?.error && <small className="page-note profile-builder-error">本次分析失败：{profileBuilderArtifact.error}；上次成功结果仍可使用。</small>}
             {profileBuilderArtifact?.artifact?.warnings.map((warning) => <small className="page-note" key={warning}>{warning}</small>)}
            {profileBuilderArtifact?.artifact && <div className="profile-builder-grid">
              <div className="profile-builder-card"><h4>识别到的技能</h4><div className="profile-skill-chip-list">{selectedProfile.skills.filter((skill) => skill.tags.includes("待确认")).map((skill) => <span className="profile-skill-chip" key={skill.id}>{skill.name}<button className="text-button" onClick={() => void confirmDetectedSkill(skill.id)}>确认</button></span>)}{selectedProfile.skills.filter((skill) => !skill.tags.includes("待确认")).map((skill) => <span className="profile-skill-chip" key={skill.id}>{skill.name}<small>已确认</small></span>)}</div>{profileBuilderArtifact.artifact.skillGraph.nodes.length === 0 && <p className="page-note">暂未识别到技能</p>}</div>
              <div className="profile-builder-card"><h4>项目经历</h4>{profileBuilderArtifact.artifact.projectGraph.nodes.map((project) => <article className="profile-project-card" key={project.id}><strong>{project.name}</strong><p>{project.summary}</p>{project.skills.length > 0 && <small>{project.skills.join(" · ")}</small>}</article>)}{profileBuilderArtifact.artifact.projectGraph.nodes.length === 0 && <p className="page-note">暂未识别到项目</p>}</div>
            </div>}
            {selectedProfile.resume && <details className="profile-raw-material"><summary>查看原始 Resume（已折叠）</summary><pre>{selectedProfile.resume.rawContent}</pre></details>}
          </div>}
           {page === "profiles" && selectedProfile && <div className="profile-subsection"><h3>Profile Builder</h3><p className="page-note">上传 Resume、项目资料或完成面试后不会自动调用大模型；所有素材都保留来源证据。</p><div className="detail-actions"><button className="outline-pill" disabled={profileBuilderRunning} onClick={() => void rebuildProfileBuilder()}>{profileBuilderRunning ? "构建中…" : "立即构建画像"}</button><span className="page-note">{profileBuilderArtifact?.artifact ? `技能 ${profileBuilderArtifact.artifact.skillGraph.nodes.length} · 项目 ${profileBuilderArtifact.artifact.projectGraph.nodes.length} · 回答素材 ${profileBuilderArtifact.artifact.answerMaterials.length} · FAQ ${profileBuilderArtifact.artifact.faqs.length}` : "尚未生成"}</span></div>{profileBuilderArtifact?.artifact?.warnings.map((warning) => <small className="page-note" key={warning}>{warning}</small>)}</div>}
          {page === "settings" && <CaptureProtectionSettings status={captureProtection} onToggle={(enabled) => void toggleCaptureProtection(enabled)} />}
        </div>
        {(page === "home" || page === "interview") && <><div className="chat-context-capsules chat-context-capsules-composer"><span>档案：{selectedProfile?.name ?? "未选择"}</span><span>项目：{selectedProjectId ? projects.find((project) => project.id === selectedProjectId)?.name ?? "当前项目" : "自动"}</span><span>知识：自动检索</span><span>事实策略：仅已确认</span></div><ChatComposer value={composerText} onChange={setComposerText} onSubmit={() => void submitComposer()} onCreateProject={() => void createProject()} /></>}
        {store.notice && <button className="notice-toast" onClick={() => store.setNotice(undefined)}>{store.notice} <span>×</span></button>}
      </section>
      {dialog && <AppDialog dialog={dialog} onConfirm={(value) => closeDialog(dialog.kind === "confirm" ? true : value)} onCancel={() => closeDialog(undefined)} />}
      {setupOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetupOpen(false); }}><section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title"><header><div><span className="page-kicker">INTERVIEW SETUP</span><h2 id="setup-title">开始面试</h2></div><button onClick={() => setSetupOpen(false)} aria-label="关闭">×</button></header><label className="clean-field"><span>面试档案</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><label className="clean-field"><span>回答模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><label className="clean-field"><span>自动回答</span><select value={store.automationMode} onChange={(event) => void window.interviewCopilot.interview.setAutomationMode(event.target.value as "AUTO" | "MANUAL")}><option value="AUTO">AUTO · 听到问题后自动回答</option><option value="MANUAL">MANUAL · 手动触发回答</option></select></label><label className="clean-field"><span>麦克风输入</span><select value={inputDeviceId} onChange={(event) => { setInputDeviceId(event.target.value); setProbeDeviceKey(""); store.clearProbe(); persistDevice("interview-copilot.input-device", event.target.value); }}>{devices.inputs.length === 0 && <option value="">没有检测到输入设备</option>}{devices.inputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><label className="clean-field"><span>系统音频 / Loopback</span><select value={outputDeviceId} onChange={(event) => { setOutputDeviceId(event.target.value); setProbeDeviceKey(""); store.clearProbe(); persistDevice("interview-copilot.output-device", event.target.value); }}>{devices.outputs.length === 0 && <option value="">没有检测到系统音频设备</option>}{devices.outputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><div className="probe-summary"><span>MIC {store.probeResult ? <b className={store.probeResult.mic.streamOk ? "probe-ok" : "probe-fail"}>{store.probeResult.mic.streamOk ? (store.probeResult.mic.signalDetected ? "✓ 就绪 · 检测到声音" : "✓ 就绪 · 等待声音") : "✕ 音频流不可用"}</b> : <small>{store.probeError ? `✕ ${store.probeError}` : "未测试"}</small>}</span><span>SYSTEM {store.probeResult ? <b className={store.probeResult.system.streamOk ? "probe-ok" : "probe-fail"}>{store.probeResult.system.streamOk ? (store.probeResult.system.signalDetected ? "✓ 就绪 · 检测到声音" : "✓ 就绪 · 等待声音") : "✕ 系统音频流不可用"}</b> : <small>{store.probeError ? `✕ ${store.probeError}` : "未测试"}</small>}</span><button className="outline-pill" disabled={probing} onClick={() => void probeAudio()}>{probing ? "测试中…" : "测试音频"}</button></div><div className="setup-preflight"><span>LLM · {providerSettings?.llm.hasApiKey ? "✓ 已配置" : "✕ 未配置"}</span><span>ASR · {asrProviderType === "funasr-local" ? "✓ 本地服务自动启动" : providerSettings?.asr.hasApiKey || asrProviderType === "custom-gateway" ? "✓ 已配置" : "✕ 未配置"}</span><span>Profile · {selectedProfile ? "✓" : "✕"}</span></div><footer><button className="outline-pill" onClick={() => setSetupOpen(false)}>取消</button><button className="dark-pill" disabled={!currentProbeReady || probing} onClick={() => void startInterview()}>开始面试</button></footer></section></div>}
    </main>
  );

}
