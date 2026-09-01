import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { CSSProperties, JSX } from "react";
import "./styles.css";
import "./overlay-simplified.css";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AudioCapability, AudioChannelCapability, AudioDevices, AudioDrift, AudioSidecarEvent, ProbeChannelResult, ProbeResult, RealtimeServerMessage } from "@interview-copilot/protocol";
import { AnswerThreadStore, QUESTION_BANK_BANK_LABELS, QUESTION_BANK_BANK_TYPES, QUESTION_BANK_TYPE_LABELS, QUESTION_BANK_TYPES, answerRelationForQuestion, validateLlmModelConfiguration, type AnswerThread, type OverlayAnswerRelation } from "@interview-copilot/shared";
import { QWEN_REALTIME_ASR_MODEL, QWEN_REALTIME_ASR_URL, type AsrProviderType, type ChatAction, type ChatResponse, type ProjectAnalysisJob, type ProjectFact, type ProjectMaterialImportReport, type ProjectMemorySnapshot, type ProjectQaGenerationResult, type ProjectQuestionBankImportReport, type ProjectSourceRole, type QuestionBankBankType, type QuestionBankCoverageResult, type QuestionBankJobProfileRecord, type QuestionBankQuestionRecord, type QuestionBankSkillRecord, type QuestionBankType, type QuestionCandidate, type QuestionEvent, type SessionState, type SkillSuggestion, type SkillSuggestionStatus, type TechnicalDomain, type TechnicalTerm, type TerminologyRolloutMode, type TranscriptSnapshot } from "@interview-copilot/shared";
import type { Profile } from "@interview-copilot/shared";
import type { JobTargetRecord, KnowledgeAnalysisRunRecord, ProfileBuilderArtifactRecord, ProjectMemoryStats, ProjectRecord, ProfileSelfIntroductionRecord, QuestionBankAnswerCardInput, QuestionBankAnswerGenerationResult, QuestionBankBulkPatch, QuestionBankDuplicateCluster, QuestionBankImportResult, QuestionBankListOptions, QuestionBankQuestionInput, QuestionBankSkillInput, RetrievalRunRecord, ResumeAnalysisRecord, ResumeProjectLinkRecord } from "../main/database";
import type { LlmModelProfileInput, ProviderCenterPublicConfig, PublicProviderSettings, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../shared/overlay-preferences";
import type { RuntimeOperationMode } from "../shared/runtime-operation-mode";
import { chatFailureText } from "../shared/chat-errors";
import type { ModelCatalogResult, ModelCategory } from "../main/model-catalog";
import { normalizeMeter, StableAnswerStateMachine } from "@interview-copilot/shared";
import type { CaptureProtectionState, HUDState, OverlayMode } from "../main/overlay-manager";
import type { WrittenTestState } from "../main/written-test-controller";
import type { ScreenshotResult } from "../main/screenshot-manager";
import type { AsrRuntimeDiagnostics } from "../main/realtime-session";
import type { AppPage } from "./app/routes";
import { Sidebar } from "./layout/Sidebar";
import { WelcomeScreen } from "./chat/WelcomeScreen";
import { ChatComposer } from "./chat/ChatComposer";
import { OverlayWindowRoot as OverlayRoot } from "./overlay/OverlayWindowRoot";
import { OverlayDesigner } from "./overlay/OverlayDesigner";
import { AppDialog, type DialogState } from "./dialogs/AppDialog";
import { PageErrorBoundary } from "./components/ErrorBoundary";
import { ProjectLibraryPage } from "./project-library/ProjectLibraryPage";
import { ProfileWorkspacePage } from "./profile/ProfileWorkspacePage";
import { KNOWLEDGE_DOCUMENT_TYPES, KNOWLEDGE_DOCUMENT_TYPE_LABELS, type KnowledgeDocumentType, type KnowledgeDocumentTypeOption } from "@interview-copilot/shared";
import { initialRuntimePhaseState, isCommittedQuestionGroup, isDisplayableQuestionGroup, reduceRuntimeMessage, reduceRuntimeQuestion, reduceRuntimeTranscript, sessionPhaseFor, type RuntimePhaseState } from "./overlay/runtime-state";
import { answerScreenshotForMode } from "./overlay-runtime-actions";
import { SettingsPage, type SettingsSection } from "./settings/SettingsPage";
import { HelpPage, OnboardingModal } from "./help/HelpPage";
import { InterviewSetupModal } from "./interview/InterviewSetupModal";
import type { InterviewDirectionSelection, InterviewTerminologyPreview } from "@interview-copilot/shared";
import { userFacingRuntimeDiagnostic } from "./runtime-notices";

type AppNoticeKind = "progress" | "success" | "info" | "warning" | "error";
interface AppNotice { kind: AppNoticeKind; text: string; autoDismissMs?: number; }


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

interface OverlayQuestionGroupView {
  id: string;
  title: string;
  primaryQuestion?: string;
  displayable?: boolean;
  hasAnswerableQuestion?: boolean;
  status?: "collecting" | "answering" | "active" | "closed";
  items: Array<{ id: string; questionId: string; text: string; type: string; answerable: boolean; state: string }>;
  slots: Array<{ id: string; text: string; status: string }>;
  updatedAt: number;
}

interface HistoryDetail {
  interview: { id: string; startedAt: number; endedAt?: number; profileId: string; projectId?: string; jobTargetId?: string; automationMode: string };
  transcripts: Array<{ id: string; source: "mic" | "remote"; text: string; rawText?: string; normalizedText?: string; canonicalText?: string; terminologyCorrections?: Array<{ raw: string; canonical: string }>; createdAt: number; startMs: number; endMs: number }>;
  questions: Array<{ id: string; text: string; rawTranscript?: string; normalizedQuestion?: string; canonicalQuestion?: string; contextRelation?: string; inheritedTopic?: string; topic?: string; semanticFrame?: string; terminologyCorrections?: Array<{ raw: string; canonical: string }>; confidence: string; status: string; detectedAt: number }>;
  answers: Array<{ id: string; questionId: string; model: string; mode?: string; text: string; latencyFirstToken?: number; latencyTotal?: number; cancelReason?: string; createdAt: number; startedAt?: number; finishedAt?: number; telemetry?: { rawText?: string; normalizedText?: string; canonicalText?: string; terminologyCorrectionCount?: number; terminologyConfidence?: number; semanticFrame?: string; contextRelation?: string; topicRelation?: string; answerSourceMode?: string; coreQaQuestionId?: string; projectQaQuestionId?: string; technicalGuardDecision?: string; technicalViolationCount?: number; claimGateDecision?: string; blockedPersonalClaimCount?: number; historyRevision?: number } }>;
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

interface JobTargetsPageProps {
  targets: JobTargetRecord[];
  onUploadJob: (file: File) => Promise<void>;
  onOpenProfile: () => void;
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
    <div className="detail-metrics personal-memory-stats"><span>项目 <strong>{stats.projects}</strong></span><span>可信事实 <strong>{stats.eligibleFacts}</strong></span><span>待处理事项 <strong>{stats.userActions}</strong></span><span>冲突组 <strong>{stats.conflictGroups}</strong></span><span>面试问题 <strong>{stats.interviewQuestions}</strong></span></div>
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
  parameter: "关键参数",
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
  projects: ProjectMemorySnapshot["projects"];
  modules: ProjectMemorySnapshot["modules"];
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
  const [bankTypeFilter, setBankTypeFilter] = useState<"all" | QuestionBankBankType>("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState<"global" | "all">("all");
  const [selectedId, setSelectedId] = useState("");
  const [question, setQuestion] = useState("");
  const [type, setType] = useState<QuestionBankType>("technical");
  const [bankType, setBankType] = useState<QuestionBankBankType>("skill");
  const [projectId, setProjectId] = useState("");
  const [moduleId, setModuleId] = useState("");
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
  const listOptions = (): QuestionBankListOptions => ({ search: search.trim() || undefined, type: typeFilter === "all" ? undefined : typeFilter, bankType: bankTypeFilter === "all" ? undefined : bankTypeFilter, scope: scopeFilter === "all" || bankTypeFilter === "project" ? undefined : "global", projectId: projectFilter === "all" ? undefined : projectFilter, status: "active", limit: pageSize, offset: page * pageSize, sort: "updated" });

  useEffect(() => {
    setRows(props.questions);
    setTotal(props.total);
  }, [props.questions, props.total]);

  useEffect(() => {
    let cancelled = false;
    const options = listOptions();
    void Promise.all([props.onList(options), props.onCount(options)]).then(([nextRows, nextTotal]) => {
      if (!cancelled) { setRows(nextRows); setTotal(nextTotal); }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [page, scopeFilter, search, typeFilter, bankTypeFilter, projectFilter]);

  const resetForm = () => {
    setSelectedId(""); setQuestion(""); setType("technical"); setBankType("skill"); setProjectId(""); setModuleId(""); setDifficulty("medium"); setJobRole(""); setVariants(""); setAnswer(""); setCode(""); setVerified(false); setSelectedSkillIds([]);
  };
  const selectQuestion = (item: QuestionBankQuestionRecord) => {
    const card = item.answerCards[0];
    setSelectedId(item.id); setQuestion(item.canonicalText); setType(item.type); setBankType(item.bankType); setProjectId(item.projectId ?? ""); setModuleId(item.moduleId ?? ""); setDifficulty(item.difficulty); setJobRole(item.jobRole ?? ""); setVariants(item.variants.join("\n")); setAnswer(card?.content ?? ""); setCode(card?.codeContent ?? ""); setVerified(card?.verified ?? false); setSelectedSkillIds(item.skillIds);
  };
  const toggleSelection = (questionId: string) => setSelectedIds((current) => current.includes(questionId) ? current.filter((id) => id !== questionId) : [...current, questionId]);
  const bulkUpdate = async (patch: QuestionBankBulkPatch) => {
    if (selectedIds.length === 0) { props.onNotice("请先选择题目"); return; }
    const count = await props.onBulkUpdate(selectedIds, patch);
    setSelectedIds([]);
    props.onNotice(`已批量更新 ${count} 道题目`);
    const next = await props.onList(listOptions());
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
      const saved = await props.onSaveQuestion({ id: selectedId || undefined, canonicalText: question, type, bankType, category: type, scope: bankType === "project" ? "project" : bankType === "job" ? "job" : "global", projectId: projectId || undefined, moduleId: moduleId || undefined, difficulty, jobRole, variants: variants.split("\n").map((item) => item.trim()).filter(Boolean), skillIds: selectedSkillIds });
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
    <div className="question-bank-toolbar"><input className="inline-search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="搜索问题、岗位或关键词" /><select value={bankTypeFilter} onChange={(event) => { setBankTypeFilter(event.target.value as "all" | QuestionBankBankType); setPage(0); }}><option value="all">全部题库</option>{QUESTION_BANK_BANK_TYPES.map((item) => <option value={item} key={item}>{QUESTION_BANK_BANK_LABELS[item]}</option>)}</select><select value={projectFilter} onChange={(event) => { setProjectFilter(event.target.value); setPage(0); }}><option value="all">全部项目</option>{props.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select><select value={scopeFilter} onChange={(event) => { setScopeFilter(event.target.value as "global" | "all"); setPage(0); }}><option value="all">全部范围</option><option value="global">通用范围</option></select><select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value as "all" | QuestionBankType); setPage(0); }}><option value="all">全部题型</option>{QUESTION_BANK_TYPES.map((item) => <option value={item} key={item}>{QUESTION_BANK_TYPE_LABELS[item]}</option>)}</select><button className="outline-pill" disabled={props.answerGenerationProgress?.status === "running" || props.answerGenerationProgress?.status === "started"} onClick={() => void props.onGenerateAnswers(selectedIds.length ? selectedIds : undefined)}>{props.answerGenerationProgress?.status === "running" || props.answerGenerationProgress?.status === "started" ? `生成答案 ${props.answerGenerationProgress.completed}/${props.answerGenerationProgress.total}` : selectedIds.length ? `生成选中答案（${selectedIds.length}）` : "生成缺失答案"}</button><button className="outline-pill" onClick={() => void loadDuplicates()}>检查重复题</button><span className="page-note">{total} 题 · 第 {page + 1} / {Math.max(1, Math.ceil(total / pageSize))} 页</span></div>
    <div className="question-bank-bulk-toolbar"><span>{selectedIds.length ? `已选择 ${selectedIds.length} 道` : "可勾选题目进行批量操作"}</span><button className="text-button" onClick={() => void bulkUpdate({ verified: true, stale: false })} disabled={!selectedIds.length}>标记已验证</button><button className="text-button" onClick={() => void bulkUpdate({ stale: true })} disabled={!selectedIds.length}>标记待复核</button><button className="text-button danger-text" onClick={() => void bulkUpdate({ status: "archived" })} disabled={!selectedIds.length}>归档</button><button className="text-button" onClick={() => setSelectedIds([])} disabled={!selectedIds.length}>清除选择</button></div>
    <div className="question-bank-layout"><div className="clean-list question-bank-list">{visibleQuestions.map((item) => <button className={`clean-list-row question-bank-row ${item.id === selectedId ? "selected" : ""}`} key={item.id} onClick={() => selectQuestion(item)}><input type="checkbox" checked={selectedIds.includes(item.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleSelection(item.id)} /><span><strong>{item.canonicalText}</strong><small>{QUESTION_BANK_BANK_LABELS[item.bankType]} · {QUESTION_BANK_TYPE_LABELS[item.type]} · {item.projectId ? props.projects.find((project) => project.id === item.projectId)?.name ?? "项目" : item.jobRole || "通用岗位"} · {item.answerCards.length ? "已有答案卡" : "待补答案"}{item.skillIds.length ? ` · ${item.skillIds.length} 个技能` : ""}{item.followUps.length ? ` · ${item.followUps.length} 个追问` : ""}{item.stale ? " · 待复核" : ""}</small></span><em>{item.answerCards.some((card) => card.verified) ? "已验证" : "草稿"}</em></button>)}{visibleQuestions.length === 0 && <div className="knowledge-empty"><strong>还没有匹配题目</strong><span>可以新增问题，或导入包含“问题：/答案：”的 TXT、MD 文件。</span></div>}<div className="question-bank-pagination"><button className="outline-pill" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button><button className="outline-pill" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((current) => current + 1)}>下一页</button></div></div><div className="detail-sheet question-bank-editor question-bank-editor-drawer"><div className="question-bank-editor-heading"><div><span className="page-kicker">ANSWER CARD</span><h2>{selected ? "编辑题目" : "新增题目"}</h2></div><div className="detail-actions">{selected && <button className="text-button danger-text" onClick={async () => { await props.onDeleteQuestion(selected.id); resetForm(); }}>删除</button>}{selected && <button className="text-button" onClick={resetForm}>关闭</button>}</div></div><label className="clean-field"><span>问题</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} placeholder="例如：IIC 通讯读不到数据时，如何定位？" /></label><div className="question-bank-form-grid"><label className="clean-field"><span>题库</span><select value={bankType} onChange={(event) => { const next = event.target.value as QuestionBankBankType; setBankType(next); if (next !== "project") { setProjectId(""); setModuleId(""); } }}><option value="project">项目题库</option><option value="skill">技能题库</option><option value="general">通用题库</option><option value="behavioral">行为题库</option><option value="job">岗位题库</option><option value="custom">自定义题库</option></select></label><label className="clean-field"><span>题型</span><select value={type} onChange={(event) => setType(event.target.value as QuestionBankType)}>{QUESTION_BANK_TYPES.map((item) => <option value={item} key={item}>{QUESTION_BANK_TYPE_LABELS[item]}</option>)}</select></label><label className="clean-field"><span>难度</span><select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label></div><div className="question-bank-form-grid"><label className="clean-field"><span>项目</span><select value={projectId} onChange={(event) => { setProjectId(event.target.value); setModuleId(""); }} disabled={bankType !== "project"}><option value="">选择项目</option>{props.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label className="clean-field"><span>项目模块</span><select value={moduleId} onChange={(event) => setModuleId(event.target.value)} disabled={bankType !== "project" || !projectId}><option value="">不指定模块</option>{props.modules.filter((module) => module.projectId === projectId).map((module) => <option value={module.id} key={module.id}>{module.moduleName}</option>)}</select></label><label className="clean-field"><span>适用岗位</span><input value={jobRole} onChange={(event) => setJobRole(event.target.value)} placeholder="嵌入式 / 电机控制 / 通用" /></label></div><div className="question-bank-form-grid"><label className="clean-field"><span>问题变体（每行一个）</span><input value={variants} onChange={(event) => setVariants(event.target.value)} placeholder="同义问法，增强召回" /></label></div><div className="question-bank-skill-selector"><span>关联技能（用于覆盖分析）</span><div>{props.skills.length ? props.skills.map((skill) => <label className="check-row" key={skill.id}><input type="checkbox" checked={selectedSkillIds.includes(skill.id)} onChange={() => setSelectedSkillIds((current) => current.includes(skill.id) ? current.filter((id) => id !== skill.id) : [...current, skill.id])} />{skill.name}</label>) : <small>暂无技能，请先在下方技能资料中新增。</small>}</div></div><label className="clean-field"><span>标准回答</span><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={7} placeholder="按当前题型整理回答；项目题只填写真实经历素材。" /></label>{type === "code" && <label className="clean-field"><span>完整代码</span><textarea className="code-editor" value={code} onChange={(event) => setCode(event.target.value)} rows={8} placeholder="保留可运行代码、边界处理和复杂度说明。" /></label>}<label className="check-row"><input type="checkbox" checked={verified} onChange={(event) => setVerified(event.target.checked)} />答案已人工核验，允许作为优先参考答案</label><div className="detail-actions"><button className="dark-pill" onClick={() => void save()}>保存题目</button><button className="outline-pill" onClick={resetForm}>清空</button></div></div></div>
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

function audioChannelAvailable(channel: AudioChannelCapability | ProbeChannelResult | undefined): boolean {
  if (!channel) return false;
  return "available" in channel ? channel.available : channel.streamOk;
}

function audioChannelLabel(channel: AudioChannelCapability | ProbeChannelResult | undefined): string {
  if (!channel) return "未测试 · 可直接开始";
  const state = "state" in channel ? channel.state : channel.streamOk ? channel.signalDetected ? "READY" : "SILENT" : "OPEN_FAILED";
  if (state === "READY") return "✓ 就绪";
  if (state === "SILENT") return "✓ 流已打开 · 等待声音";
  if (state === "PERMISSION_DENIED") return "✕ 权限被拒绝";
  if (state === "DEVICE_GONE") return "✕ 设备已断开";
  if (state === "TIMEOUT") return "✕ 回调超时";
  return `✕ ${channel.error ?? "音频流不可用"}`;
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
  runtimePhases: RuntimePhaseState;
  sessionState: SessionState;
  operationMode: RuntimeOperationMode;
  automationMode: "MANUAL" | "AUTO";
  answerMode: "FAST" | "NORMAL" | "DEEP";
  capability?: AudioCapability;
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
  questionGroups: OverlayQuestionGroupView[];
  activeQuestionGroupId?: string;
  activeAnswerGroupId?: string;
  answerThreads: AnswerThread[];
  screenshot?: ScreenshotResult;
  notice?: AppNotice;
  applyEvent: (event: AudioSidecarEvent) => void;
  setOverlayMode: (mode: OverlayMode) => void;
  setHUDState: (state: HUDState) => void;
  setSessionState: (state: SessionState) => void;
  setWrittenTestState: (state: WrittenTestState) => void;
  setOperationMode: (mode: RuntimeOperationMode) => void;
  setAutomationMode: (mode: "MANUAL" | "AUTO") => void;
  setAnswerMode: (mode: "FAST" | "NORMAL" | "DEEP") => void;
  clearProbe: () => void;
  setScreenshot: (screenshot: ScreenshotResult) => void;
  setNotice: (notice?: string | AppNotice) => void;
  setRealtimeState: (state: string) => void;
  setAsrDiagnostics: (diagnostics: AsrRuntimeDiagnostics) => void;
  applyTranscript: (snapshot: TranscriptSnapshot) => void;
  applyQuestion: (event: QuestionEvent) => void;
  applyRealtimeMessage: (message: RealtimeServerMessage) => void;
}

type AudioRenderState = Pick<AudioStore, "mic" | "system" | "state" | "overlayMode" | "hudState" | "sessionState" | "realtimeState" | "operationMode" | "runtimePhases" | "automationMode" | "answerMode" | "question" | "answerText" | "answerStreaming" | "questionGroups" | "activeQuestionGroupId" | "activeAnswerGroupId" | "answerThreads" | "remoteTranscript" | "micTranscript" | "capability" | "probeResult" | "asrDiagnostics" | "notice">;

const EMPTY_RENDER_STATE: AudioRenderState = {
  mic: 0,
  system: 0,
  state: "STOPPED",
  overlayMode: "interactive",
  hudState: { running: false, panelVisible: false, transcriptVisible: false, answerVisible: false, transientLayer: "none", shareMode: false, topBarVisible: false, mouseMode: "passthrough", mode: "HIDDEN" },
  sessionState: "IDLE",
  realtimeState: "disconnected",
  operationMode: "IDLE",
  runtimePhases: initialRuntimePhaseState,
  automationMode: "AUTO",
  answerMode: "NORMAL",
  question: undefined,
  answerText: "",
  answerStreaming: false,
  questionGroups: [],
  activeQuestionGroupId: undefined,
  activeAnswerGroupId: undefined,
  answerThreads: [],
  remoteTranscript: { source: "remote", final: [] },
  micTranscript: { source: "mic", final: [] },
  capability: undefined,
  probeResult: undefined,
  asrDiagnostics: { provider: "unknown", model: "", language: "", micState: "stopped", remoteState: "stopped", reconnectCount: 0, droppedPcmPackets: 0, vadProvider: "unknown", speechProbability: { mic: 0, remote: 0 }, micSpeech: false, remoteSpeech: false, fallback: false, vadReady: false, vadReason: "not-initialized", lastSpeechStart: {}, lastSpeechEnd: {} },
  notice: undefined
};

const stableAnswer = new StableAnswerStateMachine();
const answerThreadStore = new AnswerThreadStore();
const questionsById = new Map<string, QuestionCandidate>();
const answerQuestionIds = new Map<string, string>();
const questionGroupsById = new Map<string, OverlayQuestionGroupView>();
let noticeDismissTimer: ReturnType<typeof setTimeout> | undefined;

function putNotice(set: (value: Partial<AudioStore> | ((current: AudioStore) => Partial<AudioStore>)) => void, input?: string | AppNotice): void {
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  noticeDismissTimer = undefined;
  const notice = typeof input === "string" ? (input ? { kind: "info" as const, text: input } : undefined) : input;
  set({ notice });
  if (notice?.autoDismissMs) {
    noticeDismissTimer = setTimeout(() => { noticeDismissTimer = undefined; set((current) => current.notice === notice ? { notice: undefined } : {}); }, notice.autoDismissMs);
  }
}

const useAudioStore = create<AudioStore>((set) => ({
  mic: 0,
  system: 0,
  state: "STOPPED",
  micHealth: "unknown",
  loopbackHealth: "unknown",
  micDetected: false,
  systemDetected: false,
  overlayMode: "interactive",
  hudState: { running: false, panelVisible: false, transcriptVisible: false, answerVisible: false, transientLayer: "none", shareMode: false, topBarVisible: false, mouseMode: "passthrough", mode: "HIDDEN" },
  runtimePhases: initialRuntimePhaseState,
  sessionState: "IDLE",
  operationMode: "IDLE",
  automationMode: "AUTO",
  answerMode: "NORMAL",
  capability: undefined,
  realtimeState: "disconnected",
  asrDiagnostics: { provider: "unknown", model: "", language: "", micState: "stopped", remoteState: "stopped", reconnectCount: 0, droppedPcmPackets: 0, vadProvider: "unknown", speechProbability: { mic: 0, remote: 0 }, micSpeech: false, remoteSpeech: false, fallback: false, vadReady: false, vadReason: "not-initialized", lastSpeechStart: {}, lastSpeechEnd: {} },
  remoteTranscript: { source: "remote", final: [] },
  micTranscript: { source: "mic", final: [] },
  questionDiagnostics: [],
  answerText: "",
  answerStreaming: false,
  answerHistory: [],
  questionGroups: [],
  activeQuestionGroupId: undefined,
  activeAnswerGroupId: undefined,
  answerThreads: [],
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
    if (event.type === "audio_state") return { state: event.state, runtimePhases: { ...current.runtimePhases, sessionPhase: sessionPhaseFor(current.sessionState, event.state, current.realtimeState) } };
    if (event.type === "audio_capability") return { capability: event, state: event.captureMode === "dual" ? "READY" : "DEGRADED", probeError: undefined, notice: event.captureMode === "dual" ? current.notice : { kind: "warning", text: `音频已降级为 ${event.captureMode}，缺失声道将补零，面试仍可继续` }, runtimePhases: { ...current.runtimePhases, sessionPhase: sessionPhaseFor(current.sessionState, event.captureMode === "dual" ? "READY" : "DEGRADED", current.realtimeState) } };
    if (event.type === "probe_result") return { probeResult: event, probeError: undefined, state: event.captureMode === "dual" ? "READY" : event.captureMode ? "DEGRADED" : "FAILED" };
    if (event.type === "audio_probe_trace") return current;
    if (event.type === "audio_buffer") return { bufferStats: event };
    if (event.type === "audio_drift") return { drift: event };
    return { state: event.recoverable ? "DEGRADED" : "FAILED", notice: { kind: event.recoverable ? "warning" : "error", text: event.reason }, probeError: event.reason };
  }),
  setOverlayMode: (overlayMode) => set({ overlayMode }),
  setHUDState: (hudState) => set({ hudState }),
  setSessionState: (sessionState) => {
    const shouldReset = sessionState === "CREATING" || sessionState === "IDLE" || sessionState === "ENDED";
    if (shouldReset) {
      stableAnswer.reset();
      questionsById.clear();
      answerQuestionIds.clear();
      answerThreadStore.reset();
      questionGroupsById.clear();
    }
    set((current) => ({
      sessionState,
      runtimePhases: shouldReset
        ? { ...initialRuntimePhaseState, automationMode: current.automationMode, sessionPhase: sessionPhaseFor(sessionState, current.state, current.realtimeState) }
        : { ...current.runtimePhases, sessionPhase: sessionPhaseFor(sessionState, current.state, current.realtimeState) },
      ...(shouldReset ? { question: undefined, answerText: "", answerStreaming: false, answerId: undefined, answerHistory: [], questionGroups: [], activeQuestionGroupId: undefined, activeAnswerGroupId: undefined, answerThreads: [], remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] }, questionDiagnostics: [] } : {})
    }));
    if (sessionState === "CREATING") putNotice(set, { kind: "progress", text: "面试正在建立音频与识别连接…" });
    if (sessionState === "RUNNING") putNotice(set, { kind: "success", text: "面试已连接，正在监听问题", autoDismissMs: 1_200 });
    if (sessionState === "ERROR") putNotice(set, { kind: "error", text: "面试连接失败，请检查音频和 ASR 设置" });
  },
  setWrittenTestState: (writtenTest) => {
    stableAnswer.reset();
    questionsById.clear();
    answerQuestionIds.clear();
    answerThreadStore.reset();
    questionGroupsById.clear();
    set((current) => ({ runtimePhases: { ...initialRuntimePhaseState, automationMode: current.automationMode, sessionPhase: writtenTest.running ? "LISTENING" : "IDLE" }, answerText: "", answerStreaming: false, answerId: undefined, answerHistory: [], questionGroups: [], activeQuestionGroupId: undefined, activeAnswerGroupId: undefined, answerThreads: [], question: undefined, remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] } }));
  },
  setOperationMode: (operationMode) => set({ operationMode }),
  setAutomationMode: (automationMode) => set((current) => ({ automationMode, runtimePhases: { ...current.runtimePhases, automationMode } })),
  setAnswerMode: (answerMode) => set({ answerMode }),
  clearProbe: () => set({ probeError: undefined }),
  setScreenshot: (screenshot) => set({ screenshot }),
  setNotice: (notice) => putNotice(set, notice),
  setRealtimeState: (realtimeState) => set((current) => ({ realtimeState, runtimePhases: { ...current.runtimePhases, sessionPhase: sessionPhaseFor(current.sessionState, current.state, realtimeState) } })),
  setAsrDiagnostics: (asrDiagnostics) => set({ asrDiagnostics }),
  applyTranscript: (snapshot) => set((current) => snapshot.source === "remote"
    ? { remoteTranscript: snapshot, runtimePhases: reduceRuntimeTranscript(current.runtimePhases, snapshot.source, snapshot.final.length > 0) }
    : { micTranscript: snapshot }),
  applyQuestion: (event) => set((current) => {
    if (event.type === "question_diagnostic") return { questionDiagnostics: [...current.questionDiagnostics.slice(-19), event], runtimePhases: reduceRuntimeQuestion(current.runtimePhases, event) };
    if (event.type !== "question_confirmed" && event.type !== "question_superseded") return current;
    questionsById.set(event.question.id, event.question);
    // Keep the displayed question paired with the answer currently being
    // generated. A queued question becomes visible on its answer_start.
    return current.answerStreaming || event.question.answerable === false
      ? { runtimePhases: reduceRuntimeQuestion(current.runtimePhases, event) }
      : { question: event.question, runtimePhases: reduceRuntimeQuestion(current.runtimePhases, event), notice: current.notice };
  }),
  applyRealtimeMessage: (message) => {
    if (message.type === "question_group_updated") {
      const group: OverlayQuestionGroupView = { id: message.groupId, title: message.title, ...(message.primaryQuestion ? { primaryQuestion: message.primaryQuestion } : {}), displayable: message.displayable, hasAnswerableQuestion: message.hasAnswerableQuestion, status: message.status, items: message.items, slots: message.slots, updatedAt: message.updatedAt };
      if (!isDisplayableQuestionGroup(group)) return;
      questionGroupsById.set(group.id, group);
      set((current) => ({
        ...current,
        questionGroups: [...questionGroupsById.values()].sort((left, right) => left.updatedAt - right.updatedAt),
        ...(isCommittedQuestionGroup(group) ? { activeQuestionGroupId: group.id, activeAnswerGroupId: group.id, runtimePhases: { ...current.runtimePhases, questionPhase: "COMMITTED" as const, activeQuestionGroupId: group.id, activeAnswerGroupId: group.id } } : {})
      }));
      return;
    }
    if (message.type === "runtime_error") { putNotice(set, { kind: message.recoverable ? "warning" : "error", text: `${message.code}: ${message.message}${message.recoverable ? " · 可重试" : ""}` }); set((current) => ({ runtimePhases: reduceRuntimeMessage(current.runtimePhases, message) })); return; }
    if (message.type === "answer_start") answerQuestionIds.set(message.answerId, message.questionId);
    const messageQuestionId = message.type === "answer_start" ? message.questionId : "answerId" in message ? answerQuestionIds.get(message.answerId) : undefined;
    const pairedQuestion = messageQuestionId ? questionsById.get(messageQuestionId) : undefined;
    const answerGroupId = message.type === "answer_start" ? message.groupId ?? pairedQuestion?.groupId : pairedQuestion?.groupId;
    const committedAnswerGroupId = answerGroupId && isCommittedQuestionGroup(questionGroupsById.get(answerGroupId)) ? answerGroupId : undefined;
    if (message.type === "answer_start") {
      answerThreadStore.start({ answerId: message.answerId, questionId: message.questionId, ...(answerGroupId ? { groupId: answerGroupId } : {}), title: answerGroupId ? questionGroupsById.get(answerGroupId)?.title : undefined, questionText: pairedQuestion?.text ?? "截图识别的问题", relation: message.relation ?? (pairedQuestion ? answerRelationForQuestion(pairedQuestion) : "PRIMARY") as OverlayAnswerRelation });
    } else if (message.type === "answer_delta") {
      answerThreadStore.delta(message.answerId, message.delta);
    } else if (message.type === "answer_end") {
      answerThreadStore.complete(message.answerId, message.text);
    } else if (message.type === "answer_cancelled") {
      answerThreadStore.cancel(message.answerId);
    }
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
      const questionId = messageQuestionId;
      const completed = message.type === "answer_end" && message.text.trim()
        ? { answerId: message.answerId, question: pairedQuestion?.text ?? current.question?.text ?? "未记录问题", text: message.text }
        : undefined;
      return {
        answerText: snapshot.displayedText,
        answerStreaming: snapshot.streaming,
        answerId: snapshot.displayedAnswerId,
        answerHistory: completed ? [...current.answerHistory.filter((entry) => entry.answerId !== completed.answerId), completed].slice(-8) : current.answerHistory,
        answerThreads: answerThreadStore.list(),
        ...(committedAnswerGroupId ? { activeQuestionGroupId: committedAnswerGroupId, activeAnswerGroupId: committedAnswerGroupId } : {}),
        runtimePhases: reduceRuntimeMessage({ ...current.runtimePhases, ...(committedAnswerGroupId ? { activeQuestionGroupId: committedAnswerGroupId, activeAnswerGroupId: committedAnswerGroupId } : {}) }, message, committedAnswerGroupId),
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
    {detail.questions.length > 0 && <details className="history-diagnostics"><summary>问题理解诊断（{detail.questions.length}）</summary><div className="history-diagnostics-list">{detail.questions.map((question) => <div className="history-diagnostic-row" key={question.id}><strong>{question.text}</strong><span>{question.semanticFrame ?? "general"} · {question.contextRelation ?? "standalone"}{question.inheritedTopic ? ` · 继承主题：${question.inheritedTopic}` : ""}</span>{(question.rawTranscript || question.normalizedQuestion || question.canonicalQuestion) && <small>raw：{question.rawTranscript ?? "—"} · normalized：{question.normalizedQuestion ?? "—"} · canonical：{question.canonicalQuestion ?? question.text}</small>}{question.terminologyCorrections?.length ? <small>术语修正：{question.terminologyCorrections.map((item) => `${item.raw}→${item.canonical}`).join("、")}</small> : null}</div>)}</div></details>}
    {detail.answers.some((answer) => answer.telemetry) && <details className="history-diagnostics"><summary>答案质量与路由诊断（{detail.answers.filter((answer) => answer.telemetry).length}）</summary><div className="history-diagnostics-list">{detail.answers.filter((answer) => answer.telemetry).map((answer) => { const telemetry = answer.telemetry!; return <div className="history-diagnostic-row" key={`telemetry-${answer.id}`}><strong>{questions.get(answer.questionId)?.text ?? answer.questionId}</strong><span>{telemetry.answerSourceMode ?? "unknown"} · {telemetry.semanticFrame ?? "general"} · Claim Gate {telemetry.claimGateDecision ?? "—"}</span><small>raw：{telemetry.rawText ?? "—"} · normalized：{telemetry.normalizedText ?? "—"} · canonical：{telemetry.canonicalText ?? "—"}</small><small>术语修正：{telemetry.terminologyCorrectionCount ?? 0}（置信度 {telemetry.terminologyConfidence?.toFixed(2) ?? "—"}） · Technical Guard：{telemetry.technicalGuardDecision ?? "—"}（{telemetry.technicalViolationCount ?? 0}） · 历史 revision：{telemetry.historyRevision ?? "—"}</small></div>; })}</div></details>}
    <div className="history-record-note">下面按时间展示三类内容：面试官的提问、你的回答，以及 AI 针对当时问题生成的回答。</div>
    <div className="history-timeline">{entries.length > 0 ? entries.map((entry) => <article className={`history-entry ${entry.role === "AI回答" || entry.role.startsWith("AI回答（") ? "history-entry-ai" : entry.role === "我" ? "history-entry-me" : "history-entry-interviewer"}`} key={entry.id}>
      <div className="history-entry-heading"><b>{entry.role}</b><time>{new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div>
      {entry.question && <small className="history-entry-question">针对问题：{entry.question}</small>}
      <div className="history-entry-text">{entry.text}</div>
    </article>) : <p className="page-note">这场面试还没有可展示的对话内容。</p>}</div>
  </div>;
}

function OverlayView(): JSX.Element {
  const mic = useAudioStore((store) => store.mic);
  const system = useAudioStore((store) => store.system);
  const state = useAudioStore((store) => store.state);
  const overlayMode = useAudioStore((store) => store.overlayMode);
  const question = useAudioStore((store) => store.question);
  const answerText = useAudioStore((store) => store.answerText);
  const answerStreaming = useAudioStore((store) => store.answerStreaming);
  const answerMode = useAudioStore((store) => store.answerMode);
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
    ["AUDIO_CAPTURE_TIMEOUT", "音频初始化超时，请检查设备权限后重试"],
    ["NO_AUDIO_CHANNEL_AVAILABLE", "麦克风和系统音频都不可用，请检查权限或重新选择设备"],
    ["AUDIO_PERMISSION_DENIED", "音频权限被拒绝，请在 Windows 隐私设置中允许麦克风访问"],
    ["AUDIO_DEVICE_GONE", "音频设备已断开，系统将尝试切换到默认设备"],
    ["AUDIO_STREAM_OPEN_FAILED", "音频流打开失败，已保留可用声道并继续尝试"],
    ["PROTOCOL_BROKEN", "音频进程协议异常，请重启应用后重试"],
    ["AUDIO_PROBE_REQUIRED", "音频检测是可选项，正式面试会直接尝试启动采集"],
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

function HistoryPage({ records, search, onSearch, detail, metrics, onSelect, onDelete, onExport }: {
  records: Array<{ id: string; profileId: string; startedAt: number; endedAt?: number; status: string; automationMode: string }>;
  search: string;
  onSearch: (value: string) => void;
  detail?: HistoryDetail;
  metrics?: { id: string; questionCount: number; answeredQuestionCount: number; answerRate: number };
  onSelect: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onExport: (id: string) => Promise<void>;
}): JSX.Element {
  const visible = records.filter((record) => `${record.profileId} ${record.status} ${new Date(record.startedAt).toLocaleString()}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="simple-page history-page">
    <div className="page-heading"><div><span className="page-kicker">INTERVIEW HISTORY</span><h1>面试记录</h1><p className="page-note">搜索、查看和删除历史记录；删除会同时清理这场面试的转写、问题和回答。</p></div><input className="inline-search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索日期、档案或状态" /></div>
    <div className="history-summary"><span>全部 <strong>{records.length}</strong></span><span>已完成 <strong>{records.filter((record) => record.status === "ended").length}</strong></span><span>异常中断 <strong>{records.filter((record) => record.status === "error").length}</strong></span></div>
    <div className="history-layout"><div className="clean-list history-record-list">{visible.map((record) => <div className={`clean-list-row history-record-row ${detail?.interview.id === record.id ? "selected" : ""}`} key={record.id}><button className="row-main-button" onClick={() => void onSelect(record.id)}><strong>{new Date(record.startedAt).toLocaleString()}</strong><small>{record.status === "ended" ? "已完成" : record.status === "error" ? "异常中断" : "进行中"} · {record.automationMode} · {record.profileId}</small></button><button className="history-delete-button" onClick={() => void onDelete(record.id)} aria-label="删除这条面试记录">删除</button></div>)}{visible.length === 0 && <div className="knowledge-empty"><strong>{records.length ? "没有匹配记录" : "还没有面试记录"}</strong><span>{records.length ? "换一个搜索词试试。" : "完成一次面试后，记录会显示在这里。"}</span></div>}</div>{detail ? <div className="detail-sheet history-detail-sheet"><div className="history-detail-actions"><span>记录 ID · {detail.interview.id.slice(0, 8)}</span><div className="history-detail-action-buttons"><button className="outline-pill" onClick={() => void onExport(detail.interview.id)}>导出 Markdown</button><button className="outline-pill danger-outline" onClick={() => void onDelete(detail.interview.id)}>删除本场记录</button></div></div><HistoryDetailPanel detail={detail} metrics={metrics?.id === detail.interview.id ? metrics : undefined} /></div> : <div className="detail-sheet history-empty-detail"><strong>选择一场面试</strong><span>这里会按时间还原面试官、候选人和 AI 回答。</span></div>}</div>
  </section>;
}

export function App(): JSX.Element {
  const overlaySurface = useMemo(() => { const mode = new URLSearchParams(window.location.search).get("window"); return mode === "overlay-control" ? "control" : mode === "overlay-question" ? "question" : mode === "overlay-answer" ? "answer" : undefined; }, []);
  const isOverlay = Boolean(overlaySurface);
  const captureTest = useMemo(() => new URLSearchParams(window.location.search).get("capture-test") === "1", []);
  // Main-window rendering only selects the low-frequency state it displays.
  // Overlay windows opt into the full runtime snapshot because they are the
  // dedicated high-frequency surfaces; audio meter/answer deltas no longer
  // invalidate the whole desktop React tree.
  const renderStore = useAudioStore(useShallow((state): AudioRenderState => isOverlay ? {
    mic: state.mic,
    system: state.system,
    state: state.state,
    overlayMode: state.overlayMode,
    hudState: state.hudState,
    sessionState: state.sessionState,
    realtimeState: state.realtimeState,
    operationMode: state.operationMode,
    runtimePhases: state.runtimePhases,
    automationMode: state.automationMode,
    answerMode: state.answerMode,
    question: state.question,
    answerText: state.answerText,
    answerStreaming: state.answerStreaming,
    questionGroups: state.questionGroups,
    activeQuestionGroupId: state.activeQuestionGroupId,
    activeAnswerGroupId: state.activeAnswerGroupId,
    answerThreads: state.answerThreads,
    remoteTranscript: state.remoteTranscript,
    micTranscript: state.micTranscript,
    capability: state.capability,
    probeResult: state.probeResult,
    asrDiagnostics: state.asrDiagnostics,
    notice: state.notice
  } : {
    ...EMPTY_RENDER_STATE,
    automationMode: state.automationMode,
    answerMode: state.answerMode,
    capability: state.capability,
    probeResult: state.probeResult,
    asrDiagnostics: state.asrDiagnostics,
    notice: state.notice
  }));
  const store = { ...useAudioStore.getState(), ...renderStore };
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
  const [onboardingOpen, setOnboardingOpen] = useState(() => !storedDevice("interview-copilot.onboarding-complete"));
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [setupOpen, setSetupOpen] = useState(false);
  const [defaultDirectionSelection, setDefaultDirectionSelection] = useState<InterviewDirectionSelection>();
  const [directionSelection, setDirectionSelection] = useState<InterviewDirectionSelection>();
  const [directionPreview, setDirectionPreview] = useState<InterviewTerminologyPreview>();
  const [directionPreviewLoading, setDirectionPreviewLoading] = useState(false);
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
  const [resumeAnalysis, setResumeAnalysis] = useState<ResumeAnalysisRecord>();
  const [resumeProjectLinks, setResumeProjectLinks] = useState<ResumeProjectLinkRecord[]>([]);
  const [selfIntroduction, setSelfIntroduction] = useState<ProfileSelfIntroductionRecord>();
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestion[]>([]);
  const [profileBuilderRunning, setProfileBuilderRunning] = useState(false);
  const [resumeAnalysisRunning, setResumeAnalysisRunning] = useState(false);
  const [projectMemory, setProjectMemory] = useState<ProjectMemorySnapshot>();
  const [projectMemoryStats, setProjectMemoryStats] = useState<ProjectMemoryStats>({ projects: 0, modules: 0, technicalPoints: 0, problems: 0, interviewQuestions: 0, questions: 0, facts: 0, eligibleFacts: 0, reviewRequiredFacts: 0, userActionRequiredFacts: 0, conflictingFacts: 0, conflictGroups: 0, userActions: 0, staleFacts: 0 });
  const [projectMemoryRunning, setProjectMemoryRunning] = useState(false);
  const [projectAnalysisJobs, setProjectAnalysisJobs] = useState<ProjectAnalysisJob[]>([]);
  const [projectFacts, setProjectFacts] = useState<ProjectFact[]>([]);
  const [staleProjectFacts, setStaleProjectFacts] = useState<ProjectFact[]>([]);
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
  const [terminologyMode, setTerminologyMode] = useState<TerminologyRolloutMode>("high_confidence");
  const [terminologyTerms, setTerminologyTerms] = useState<TechnicalTerm[]>([]);
  const [terminologySourceCounts, setTerminologySourceCounts] = useState<Record<string, number>>({});
  const [effectiveLexiconSize, setEffectiveLexiconSize] = useState(0);
  const [terminologyActiveDomains, setTerminologyActiveDomains] = useState<string[]>([]);
  const [modelCatalogs, setModelCatalogs] = useState<Partial<Record<"llm" | "asr" | "embedding", ModelCatalogResult>>>({});
  const [modelCatalogLoading, setModelCatalogLoading] = useState<Partial<Record<"llm" | "asr" | "embedding", boolean>>>({});
  const [captureProtection, setCaptureProtection] = useState<CaptureProtectionState>({ platform: "win32", supported: false, requested: true, osFlagApplied: false, enabled: true, applied: false, externalCaptureVerified: null, displayCaptureVerified: null, windowCaptureVerified: null });
  const [overlayPreferences, setOverlayPreferences] = useState<OverlayPreferences>(DEFAULT_OVERLAY_PREFERENCES);
  const overlayPreferenceSaveInFlightRef = useRef(0);
  useEffect(() => {
    if (isOverlay || page !== "settings" || settingsSection !== "overlay") return;
    let disposed = false;
    void window.interviewCopilot.overlay.getPreferences().then((next) => { if (!disposed && next) setOverlayPreferences(next); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [isOverlay, page, settingsSection]);
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

  const openInterviewSetup = () => {
    setDirectionSelection(defaultDirectionSelection);
    setSetupOpen(true);
  };
  const changeSetupProfile = (nextProfileId: string) => {
    setProfileId(nextProfileId);
    void window.interviewCopilot.interviewDirections.getDefault(nextProfileId).then((selection) => {
      setDefaultDirectionSelection(selection);
      setDirectionSelection(selection);
    }).catch(() => {
      setDefaultDirectionSelection(undefined);
      setDirectionSelection(undefined);
    });
  };

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const listed = await window.interviewCopilot.audio.listDevices();
        setDevices(listed);
        const savedInput = storedDevice("interview-copilot.input-device");
        const savedOutput = storedDevice("interview-copilot.output-device");
        const input = savedInput && listed.inputs.some((device) => device.id === savedInput) ? savedInput : "";
        const output = savedOutput && listed.outputs.some((device) => device.id === savedOutput) ? savedOutput : "";
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
        const storedProjects = await window.interviewCopilot.projects.list(active?.id ?? storedProfiles[0]?.id);
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
      window.interviewCopilot.events.onOperationMode(store.setOperationMode),
      window.interviewCopilot.events.onOverlayMode(store.setOverlayMode),
      window.interviewCopilot.events.onOverlayState(store.setHUDState),
      window.interviewCopilot.events.onOverlayCaptureProtection(setCaptureProtection),
      window.interviewCopilot.events.onOverlayPreferences((next) => { if (overlayPreferenceSaveInFlightRef.current === 0) setOverlayPreferences(next); }),
      window.interviewCopilot.events.onScreenshot(store.setScreenshot),
      window.interviewCopilot.events.onScreenshotError(store.setNotice),
      window.interviewCopilot.events.onScreenshotDiagnostic((message) => { const notice = userFacingRuntimeDiagnostic(message); if (notice) store.setNotice(notice); }),
      window.interviewCopilot.events.onRealtimeState(store.setRealtimeState),
      window.interviewCopilot.events.onRealtimeTranscript(store.applyTranscript),
      window.interviewCopilot.events.onRealtimeMessage(store.applyRealtimeMessage),
      window.interviewCopilot.events.onRealtimeDiagnostic((message) => { const notice = userFacingRuntimeDiagnostic(message); if (notice) store.setNotice(notice); }),
      window.interviewCopilot.events.onRealtimeDiagnostics((diagnostics) => store.setAsrDiagnostics(diagnostics)),
      window.interviewCopilot.events.onRuntimeError((error) => {
        const raw = `${error.code}: ${error.message}`;
        if (/^(?:ANSWER_QUEUED|QUESTION_CONFIRMED|REQUEST_SENT|PROVIDER_REQUEST_SENT)\b/i.test(raw)) return;
        const notice = userFacingRuntimeDiagnostic(raw) ?? raw.replace(/\bquestion-[a-z0-9-]+\b/gi, "").replace(/\s{2,}/g, " ").trim();
        store.setNotice(`${notice}${error.recoverable ? " · 可重试" : ""}`);
      }),
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
          useAudioStore.getState().setNotice(useAudioStore.getState().operationMode === "WRITTEN_TEST" ? "正在识别截图并回答…" : "Screenshot shortcut received");
        } else if (shortcut === "end-interview") {
          const operationMode = useAudioStore.getState().operationMode;
          void (operationMode === "WRITTEN_TEST" ? window.interviewCopilot.writtenTest.stop() : window.interviewCopilot.interview.stop());
        }
      })
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingInterviewIds = new Set<string>();
    const cleanup = window.interviewCopilot.events.onHistoryChanged((event) => {
      pendingInterviewIds.add(event.interviewId);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        const interviewIds = [...pendingInterviewIds];
        pendingInterviewIds.clear();
        void window.interviewCopilot.history.list().then(setHistoryRecords);
        const selectedId = historyDetail?.interview.id;
        if (!selectedId || !interviewIds.includes(selectedId)) return;
        void Promise.all([window.interviewCopilot.history.get(selectedId), window.interviewCopilot.history.analyze(selectedId)]).then(([detail, metrics]) => {
          if (detail) setHistoryDetail(detail as HistoryDetail);
          if (metrics) setHistoryMetrics({ id: selectedId, ...metrics });
        }).catch(() => undefined);
      }, 140);
    });
    return () => { cleanup(); if (timer) clearTimeout(timer); };
  }, [historyDetail?.interview.id]);

  useEffect(() => {
    setResumeAnalysisRunning(false);
    if (!profileId) {
      setProfileBuilderArtifact(undefined);
      setResumeAnalysis(undefined);
      setResumeProjectLinks([]);
      setSelfIntroduction(undefined);
      setSkillSuggestions([]);
      setProjectMemory(undefined);
    setProjectMemoryStats({ projects: 0, modules: 0, technicalPoints: 0, problems: 0, interviewQuestions: 0, questions: 0, facts: 0, eligibleFacts: 0, reviewRequiredFacts: 0, userActionRequiredFacts: 0, conflictingFacts: 0, conflictGroups: 0, userActions: 0, staleFacts: 0 });
      setProjectFacts([]);
      setStaleProjectFacts([]);
      setProjectAnalysisJobs([]);
      setJobTargets([]);
      setKnowledgeAnalysisRuns([]);
      setRetrievalRuns([]);
      setProjects([]);
      setSelectedProjectId(undefined);
      return;
    }
    void window.interviewCopilot.projects.list(profileId).then((nextProjects) => {
      setProjects(nextProjects);
      setSelectedProjectId((current) => current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id);
    }).catch(() => setProjects([]));
    void window.interviewCopilot.profileBuilder.get(profileId).then(setProfileBuilderArtifact).catch(() => setProfileBuilderArtifact(undefined));
    void window.interviewCopilot.resumeAnalysis.get(profileId).then(setResumeAnalysis).catch(() => setResumeAnalysis(undefined));
    void window.interviewCopilot.resumeProjectLinks.list(profileId).then(setResumeProjectLinks).catch(() => setResumeProjectLinks([]));
    void window.interviewCopilot.selfIntroduction.get(profileId).then(setSelfIntroduction).catch(() => setSelfIntroduction(undefined));
    void window.interviewCopilot.profileBuilder.listSkillSuggestions(profileId).then(setSkillSuggestions).catch(() => setSkillSuggestions([]));
    void Promise.all([window.interviewCopilot.projectMemory.get(profileId), window.interviewCopilot.projectMemory.stats(profileId)]).then(([memory, stats]) => { setProjectMemory(memory); setProjectMemoryStats(stats); }).catch(() => undefined);
     void Promise.all([window.interviewCopilot.projectMemory.listFacts(profileId), window.interviewCopilot.jobTargets.list(profileId), window.interviewCopilot.projectMemory.analysisRuns(profileId), window.interviewCopilot.retrieval.list(profileId, 20), window.interviewCopilot.projectMemory.analysisJobs(profileId)]).then(([facts, targets, analyses, retrievals, analysisJobs]) => { setProjectFacts(facts); setJobTargets(targets); setKnowledgeAnalysisRuns(analyses); setRetrievalRuns(retrievals); setProjectAnalysisJobs(analysisJobs); }).catch(() => undefined);
    void window.interviewCopilot.projectMemory.listFacts(profileId, undefined, { includeStale: true, includeRejected: true }).then((facts) => setStaleProjectFacts(facts.filter((fact) => fact.stale))).catch(() => setStaleProjectFacts([]));
    const cleanupArtifact = window.interviewCopilot.events.onProfileBuilderUpdated((record) => {
      if (record.profileId === profileId) {
        setProfileBuilderArtifact(record);
        void window.interviewCopilot.profileBuilder.listSkillSuggestions(profileId).then(setSkillSuggestions).catch(() => setSkillSuggestions([]));
        void Promise.all([window.interviewCopilot.projectMemory.get(profileId), window.interviewCopilot.projectMemory.stats(profileId)]).then(([memory, stats]) => { setProjectMemory(memory); setProjectMemoryStats(stats); }).catch(() => undefined);
        void Promise.all([window.interviewCopilot.projectMemory.listFacts(profileId), window.interviewCopilot.jobTargets.list(profileId), window.interviewCopilot.projectMemory.analysisRuns(profileId), window.interviewCopilot.retrieval.list(profileId, 20)]).then(([facts, targets, analyses, retrievals]) => { setProjectFacts(facts); setJobTargets(targets); setKnowledgeAnalysisRuns(analyses); setRetrievalRuns(retrievals); }).catch(() => undefined);
        void window.interviewCopilot.projectMemory.listFacts(profileId, undefined, { includeStale: true, includeRejected: true }).then((facts) => setStaleProjectFacts(facts.filter((fact) => fact.stale))).catch(() => setStaleProjectFacts([]));
        void window.interviewCopilot.profiles.get(profileId).then((updated) => {
          if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
        });
      }
    });
    const cleanupJob = window.interviewCopilot.events.onProfileBuilderJob((job) => {
      if (job.profileId !== profileId) return;
      setProfileBuilderRunning(["queued", "running"].includes(job.status));
      if (job.status === "failed") store.setNotice(`个人档案分析失败：${job.error ?? "Worker 异常"}`);
      if (job.status === "cancelled") store.setNotice("个人档案分析已取消");
      if (job.status === "completed") store.setNotice("个人档案分析已完成：技能、项目和回答素材已更新");
    });
    const cleanupResumeJob = window.interviewCopilot.events.onResumeAnalysisJob((job) => {
      if (job.profileId !== profileId) return;
      setResumeAnalysisRunning(["queued", "running"].includes(job.status));
      if (job.status === "failed") store.setNotice(`简历项目解析失败：${job.error ?? "Worker 异常"}`);
      if (job.status === "cancelled") store.setNotice("简历项目解析已取消");
      if (job.status === "completed") {
        void window.interviewCopilot.resumeAnalysis.get(profileId).then(setResumeAnalysis).catch(() => setResumeAnalysis(undefined));
        store.setNotice("简历项目解析已完成，可继续生成个人档案");
      }
    });
    return () => { cleanupArtifact(); cleanupJob(); cleanupResumeJob(); };
  }, [profileId]);

  useEffect(() => {
    if (!profileId) return;
    return window.interviewCopilot.events.onProjectAnalysisJob((job) => {
      if (job.profileId !== profileId) return;
      setProjectAnalysisJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      if (["completed", "failed", "cancelled"].includes(job.status)) void refreshProjectState(profileId);
      else setProjectMemoryRunning(false);
    });
  }, [profileId]);

  useEffect(() => {
    if (knowledgeBaseId) void window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId).then(setKnowledgeDocuments);
  }, [knowledgeBaseId]);

  useEffect(() => {
    if (interviewJobTargetId && !jobTargets.some((target) => target.id === interviewJobTargetId)) setInterviewJobTargetId("");
    if (interviewProjectId && !projects.some((project) => project.id === interviewProjectId)) setInterviewProjectId("");
  }, [interviewJobTargetId, interviewProjectId, jobTargets, projects]);

  useEffect(() => {
    if (!profileId) return;
    void window.interviewCopilot.terminology.get(profileId).then((config) => { setTerminologyMode(config.mode); setTerminologyTerms(config.terms); setTerminologySourceCounts(config.sourceCounts ?? {}); setEffectiveLexiconSize(config.effectiveLexiconSize ?? config.terms.length); setTerminologyActiveDomains([...(config.primaryDomains ?? []), ...(config.secondaryDomains ?? [])]); }).catch(() => undefined);
    void window.interviewCopilot.interviewDirections.getDefault(profileId).then((selection) => { setDefaultDirectionSelection(selection); setDirectionSelection(selection); }).catch(() => { setDefaultDirectionSelection(undefined); setDirectionSelection(undefined); });
  }, [profileId]);

  useEffect(() => {
    if (!setupOpen || !profileId) return;
    let disposed = false;
    setDirectionPreviewLoading(true);
    void window.interviewCopilot.interviewDirections.preview({ profileId, projectId: interviewProjectId || undefined, jobTargetId: interviewJobTargetId || undefined, selection: directionSelection }).then((preview) => {
      if (!disposed) setDirectionPreview(preview);
    }).catch(() => {
      if (!disposed) setDirectionPreview(undefined);
    }).finally(() => { if (!disposed) setDirectionPreviewLoading(false); });
    return () => { disposed = true; };
  }, [setupOpen, profileId, interviewProjectId, interviewJobTargetId, directionSelection]);

  const changeTerminologyMode = async (mode: TerminologyRolloutMode): Promise<void> => {
    try { const next = await window.interviewCopilot.terminology.setMode(mode); setTerminologyMode(next); store.setNotice({ kind: "success", text: `术语模式已切换为 ${next}` }); }
    catch (error) { store.setNotice(`术语模式保存失败：${userFacingError(error)}`); }
  };
  const changeDefaultDirection = async (selection?: InterviewDirectionSelection): Promise<void> => {
    setDefaultDirectionSelection(selection);
    if (profileId) {
      try {
        await window.interviewCopilot.interviewDirections.setDefault(profileId, selection ?? { mode: "auto" });
        store.setNotice({ kind: "success", text: "默认面试方向已保存", autoDismissMs: 1_800 });
      } catch (error) {
        store.setNotice(`默认方向保存失败：${userFacingError(error)}`);
      }
    }
  };
  const addTerminologyTerm = async (input: { profileId: string; canonical: string; aliases?: string[]; phoneticAliases?: string[]; domains?: TechnicalDomain[] }): Promise<void> => {
    try { const term = await window.interviewCopilot.terminology.addTerm(input); if (term) setTerminologyTerms((current) => [term, ...current.filter((item) => item.canonical !== term.canonical)]); store.setNotice("自定义术语已保存"); }
    catch (error) { store.setNotice(`术语保存失败：${userFacingError(error)}`); }
  };
  const deleteTerminologyTerm = async (canonical: string): Promise<void> => {
    await window.interviewCopilot.terminology.deleteTerm(profileId, canonical);
    setTerminologyTerms((current) => current.filter((term) => term.canonical !== canonical));
    store.setNotice("自定义术语已删除");
  };
  const learnTerminologyCorrection = async (raw: string, canonical: string): Promise<void> => {
    await window.interviewCopilot.terminology.learnCorrection(profileId, raw, canonical, 1);
    const config = await window.interviewCopilot.terminology.get(profileId);
    setTerminologyTerms(config.terms);
  };
  const testTerminology = async (text: string): Promise<unknown> => {
    try { return await window.interviewCopilot.terminology.test(profileId, text); }
    catch (error) { store.setNotice(`术语测试失败：${userFacingError(error)}`); return { error: userFacingError(error) }; }
  };

  const startAudio = async () => {
    persistDevice("interview-copilot.input-device", inputDeviceId);
    persistDevice("interview-copilot.output-device", outputDeviceId);
    await window.interviewCopilot.audio.start({ inputDeviceId, outputDeviceId, meterOnly: true });
    store.setNotice("音频诊断已启动；它只显示电平，不会发送 PCM。正式面试请使用“开始面试”。");
  };
  const startInterview = async (saveDirectionDefault = false) => {
    try {
      window.interviewCopilot.diagnostics.markStartup("START_BUTTON_CLICK");
      const asrUrl = realtimeUrl.trim() || asrBaseUrl.trim();
      if (!profileId) throw new Error("PROFILE_NOT_FOUND: 请先创建或选择一个面试档案。");
      if (asrProviderType === "custom-gateway" && !asrUrl) throw new Error("ASR_CONNECT_FAILED: Custom Gateway 需要配置 WebSocket URL");
      persistDevice("interview-copilot.input-device", inputDeviceId);
      persistDevice("interview-copilot.output-device", outputDeviceId);
      setSetupOpen(false);
      store.setNotice({ kind: "progress", text: "面试正在启动：准备音频、ASR 和悬浮窗…" });
      await window.interviewCopilot.profiles.selectActive(profileId);
      await window.interviewCopilot.interview.start({ profileId, projectId: interviewProjectId || undefined, jobTargetId: interviewJobTargetId || undefined, url: asrProviderType === "custom-gateway" ? asrUrl : undefined, gatewayToken: asrProviderType === "custom-gateway" ? realtimeTicket.trim() || undefined : undefined, language: selectedProfile?.language, inputDeviceId, outputDeviceId, automationMode: store.automationMode, answerMode, providerType: asrProviderType, ...(directionSelection ? { directionSelection } : {}) });
      if (saveDirectionDefault) {
        const saved = directionSelection ?? { mode: "auto" as const };
        await window.interviewCopilot.interviewDirections.setDefault(profileId, saved);
        setDefaultDirectionSelection(saved);
      }
      store.setNotice({ kind: "success", text: "面试已启动，正在等待面试官问题", autoDismissMs: 1_800 });
    } catch (error) {
      setSetupOpen(true);
      store.setNotice(`面试启动失败：${userFacingError(error)}`);
    }
  };
  const stopAudio = async () => { await window.interviewCopilot.audio.stop(); };
  const probeAudio = async () => {
    if (probing) return;
    setProbing(true);
    try {
      const result = await window.interviewCopilot.audio.probe({ inputDeviceId, outputDeviceId });
      store.applyEvent(result);
    }
    catch (error) { store.setNotice(`音频检测失败：${userFacingError(error)}`); }
    finally { setProbing(false); }
  };
  const copyAudioDiagnostics = async () => {
    try {
      const diagnostics = await window.interviewCopilot.audio.getDiagnostics();
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      store.setNotice("音频诊断报告已复制");
    } catch (error) {
      store.setNotice(`复制音频诊断失败：${userFacingError(error)}`);
    }
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
  const uploadKnowledgeFile = async (file: File, documentType: KnowledgeDocumentTypeOption = "auto", projectId?: string, sourceRole?: ProjectSourceRole | "auto") => {
    if (!knowledgeBaseId) return;
    try {
    const imported = await window.interviewCopilot.knowledge.ingest({ profileId: selectedProfile?.id, projectId, sourceRole, knowledgeBaseId, filename: file.name, mimeType: file.type || "application/octet-stream", documentType: projectId ? "project" : documentType, bytes: new Uint8Array(await file.arrayBuffer()) }) as { status?: string; error?: string; projectAssignment?: { status?: string; message?: string } };
      if (imported?.status === "error") throw new Error(imported.error || "文件解析或索引失败");
      setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId));
      await refreshProjectState(profileId);
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
  const importProjectMaterials = async (projectId: string, files: Array<{ file: File; sourceRole: ProjectSourceRole | "auto" }>): Promise<ProjectMaterialImportReport | undefined> => {
    if (!knowledgeBaseId || !profileId || files.length === 0) return undefined;
    setProjectMemoryRunning(true);
    try {
      const report = await window.interviewCopilot.knowledge.ingestProjectMaterials({
        profileId,
        projectId,
        knowledgeBaseId,
        files: await Promise.all(files.map(async ({ file, sourceRole }) => ({ filename: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()), sourceRole })))
      });
      setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId));
      // Import is complete once the source is persisted and assigned. Deep
      // comprehension continues as a separately cancellable background job.
      await refreshProjectState(profileId);
      const failed = report.imported.filter((item) => item.status === "failed" || item.assignmentStatus !== "assigned");
      const successCount = report.imported.length - failed.length;
      if (report.rebuild.status === "skipped") store.setNotice(`项目资料导入完成：${successCount} 成功${failed.length ? `，${failed.length} 失败` : ""}；没有成功绑定的资料，未执行项目分析`);
      else if (report.rebuild.status === "failed") store.setNotice(`项目资料已导入 ${successCount} 份，${failed.length} 份失败；项目分析失败，可点击“重新分析”重试`);
      else {
        const repositoryFiles = report.repository?.eligibleFileCount;
        store.setNotice(`源码已导入 · ${repositoryFiles ?? successCount} 个文件；项目分析已排队${failed.length ? ` · ${failed.length} 份资料失败` : ""}`);
      }
      return report;
    } catch (error) {
      store.setNotice(`项目资料导入失败：${userFacingError(error)}`);
      return undefined;
    } finally {
      setProjectMemoryRunning(false);
    }
  };
  const importProjectQuestionBank = async (projectId: string, file: File): Promise<ProjectQuestionBankImportReport | undefined> => {
    if (!profileId) return undefined;
    try {
      const report = await window.interviewCopilot.knowledge.ingestProjectQuestionBank({
        profileId,
        projectId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes: new Uint8Array(await file.arrayBuffer())
      });
      await refreshProjectState(profileId);
      store.setNotice(`项目题库已导入：识别 ${report.recognizedQuestions} 题，答案 ${report.importedAnswers} 条，已确认`);
      return report;
    } catch (error) {
      store.setNotice(`项目题库导入失败：${userFacingError(error)}`);
      return undefined;
    }
  };
  const generateProjectQuestionBank = async (projectId: string): Promise<ProjectQaGenerationResult | undefined> => {
    try {
      store.setNotice("正在根据当前项目事实生成题库…");
      const result = await window.interviewCopilot.questionBank.generateProjectQa(projectId);
      await refreshProjectState(profileId);
      store.setNotice(`已生成 ${result.generated} 条项目问题，答案卡均待确认`);
      return result;
    } catch (error) {
      store.setNotice(`项目题库生成失败：${userFacingError(error)}`);
      return undefined;
    }
  };
  const createProjectMemory = async (input: { name: string; ownershipMode: "personal" | "team" | "partial" | "reference"; ownershipNote?: string }) => {
    if (!profileId) return;
    const created = await window.interviewCopilot.projects.create({ ...input, profileId });
    if (created) {
      await refreshProjectState(profileId);
      setSelectedProjectId(created.id);
      store.setNotice(`已创建项目“${created.name}”，现在可以添加项目资料`);
    }
  };
  const updateProjectOwnership = async (projectId: string, input: { ownershipMode?: "personal" | "team" | "partial" | "reference"; ownershipNote?: string }) => {
    const updated = await window.interviewCopilot.projects.update(projectId, input);
    if (updated) {
      await refreshProjectState(profileId);
      store.setNotice("项目归属边界已保存");
    }
  };
  const attachProfileMaterial = async (kind: "resume" | "jobDescription", event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !profileId) return;
    try {
      const updated = await window.interviewCopilot.profiles.attachMaterial({ profileId, kind, filename: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
      if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
      if (kind === "resume") { setResumeAnalysis(undefined); void window.interviewCopilot.selfIntroduction.get(profileId).then(setSelfIntroduction).catch(() => setSelfIntroduction(undefined)); }
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
  const refreshProjectState = async (profile = profileId): Promise<{ memory: ProjectMemorySnapshot; facts: ProjectFact[]; projects: ProjectItem[] }> => {
    if (!profile) return { memory: projectMemory ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] }, facts: [], projects: [] };
    const [projects, memory, stats, facts, allFacts, targets, analyses, retrievals] = await Promise.all([
      window.interviewCopilot.projects.list(profile),
      window.interviewCopilot.projectMemory.get(profile),
      window.interviewCopilot.projectMemory.stats(profile),
      window.interviewCopilot.projectMemory.listFacts(profile),
      window.interviewCopilot.projectMemory.listFacts(profile, undefined, { includeStale: true, includeRejected: true }),
      window.interviewCopilot.jobTargets.list(profile),
      window.interviewCopilot.projectMemory.analysisRuns(profile),
      window.interviewCopilot.retrieval.list(profile, 20)
    ]);
    const resolvedMemory = memory ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] };
    setProjects(projects);
    setSelectedProjectId((current) => current && projects.some((project) => project.id === current) ? current : projects[0]?.id);
    setProjectMemory(memory); setProjectMemoryStats(stats); setProjectFacts(facts); setStaleProjectFacts(allFacts.filter((fact) => fact.stale)); setJobTargets(targets); setKnowledgeAnalysisRuns(analyses); setRetrievalRuns(retrievals);
    return { memory: resolvedMemory, facts, projects };
  };
  const refreshProfiles = async () => { const next = await window.interviewCopilot.profiles.list(); setProfiles(next); };
  const renameProfile = async () => { if (!selectedProfile) return; const name = await requestDialog({ kind: "form", title: "重命名 Profile", label: "Profile 名称", defaultValue: selectedProfile.name, required: true, confirmLabel: "保存" }); if (typeof name === "string" && name.trim()) { await window.interviewCopilot.profiles.save({ ...selectedProfile, name: name.trim() }); await refreshProfiles(); } };
  const cloneProfile = async () => { if (!selectedProfile) return; const clone = await window.interviewCopilot.profiles.clone(selectedProfile.id, `${selectedProfile.name} 副本`); if (clone) { await refreshProfiles(); setProfileId(clone.id); } };
  const deleteProfile = async () => { if (!selectedProfile || profiles.length <= 1) { store.setNotice("至少保留一个 Profile"); return; } const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${selectedProfile.name}？`, description: "删除后该 Profile 的本地配置无法恢复。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.profiles.delete(selectedProfile.id); const next = (await window.interviewCopilot.profiles.list()); setProfiles(next); setProfileId(next[0]?.id ?? ""); if (next[0]) await window.interviewCopilot.profiles.selectActive(next[0].id); } };
  const editInstructions = async () => { if (!selectedProfile) return; const instructions = await requestDialog({ kind: "form", title: "编辑 Instructions", label: "Custom Instructions", defaultValue: selectedProfile.instructions ?? "", multiline: true, confirmLabel: "保存" }); if (typeof instructions === "string") { const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, instructions }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); } };
  const editCompanyContext = async () => { if (!selectedProfile) return; const value = await requestDialog({ kind: "form", title: "公司与业务资料", label: "只填写已确认的公司、产品、业务和岗位信息", defaultValue: selectedProfile.companyContext ?? "", multiline: true, confirmLabel: "保存" }); if (typeof value === "string") { const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, companyContext: value.trim() || undefined }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); } };
  const editSalaryExpectation = async () => { if (!selectedProfile) return; const current = selectedProfile.salaryExpectation; const value = await requestDialog({ kind: "form", title: "薪资期望", label: "格式：25-35 K/月；留空表示不配置具体数字", defaultValue: current ? `${current.min ?? ""}-${current.max ?? ""} ${current.currency ?? "K"}/${current.period === "year" ? "年" : "月"}` : "", confirmLabel: "保存" }); if (typeof value !== "string") return; const match = value.match(/(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)/); const single = value.match(/\d+(?:\.\d+)?/); const expectation = match ? { min: Number(match[1]), max: Number(match[2]), currency: value.toUpperCase().includes("USD") ? "USD" : "K", period: /年/.test(value) ? "year" as const : "month" as const, negotiable: true } : single ? { min: Number(single[0]), currency: value.toUpperCase().includes("USD") ? "USD" : "K", period: /年/.test(value) ? "year" as const : "month" as const, negotiable: true } : undefined; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, salaryExpectation: expectation }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const updateProfileExpression = async (patch: Partial<Pick<Profile, "expressionLevel" | "explainAdvancedTerms">>) => {
    if (!selectedProfile) return;
    const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, ...patch });
    if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
  };
  const addSkill = async () => { if (!selectedProfile) return; const name = await requestDialog({ kind: "form", title: "新增 Skill", label: "Skill 名称", required: true }); if (typeof name !== "string" || !name.trim()) return; const content = await requestDialog({ kind: "form", title: "Skill 内容", label: "内容", multiline: true, confirmLabel: "保存" }); const skill = { id: `skill-${Date.now()}`, name: name.trim(), description: "", content: typeof content === "string" ? content : "", tags: [] }; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: [...selectedProfile.skills, skill] }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const editSkill = async (skillId: string) => { if (!selectedProfile) return; const skill = selectedProfile.skills.find((item) => item.id === skillId); if (!skill) return; const content = await requestDialog({ kind: "form", title: `编辑 Skill：${skill.name}`, label: "内容", defaultValue: skill.content, multiline: true, confirmLabel: "保存" }); if (typeof content !== "string") return; const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.map((item) => item.id === skillId ? { ...item, content } : item) }); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); };
  const removeProfileMaterial = async (kind: "resume" | "jobDescription") => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.removeMaterial(selectedProfile.id, kind); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); if (kind === "resume") { setResumeAnalysis(undefined); void window.interviewCopilot.selfIntroduction.get(profileId).then(setSelfIntroduction).catch(() => setSelfIntroduction(undefined)); } };
  const saveResumeProjectLink = async (resumeProjectId: string, projectId: string, confirmed = true) => {
    if (!profileId) return;
    try {
      const saved = await window.interviewCopilot.resumeProjectLinks.save({ profileId, resumeHash: "", resumeProjectId, projectId, source: confirmed ? "manual" : "auto_suggested", confidence: confirmed ? 1 : 0.88, confirmed });
      if (saved) setResumeProjectLinks((current) => [saved, ...current.filter((item) => !(item.resumeProjectId === saved.resumeProjectId && item.projectId === saved.projectId))]);
      store.setNotice(confirmed ? "Resume 项目关联已确认" : "已保存项目关联建议，确认后才会影响路由");
    } catch (error) { store.setNotice(`项目关联失败：${userFacingError(error)}`); }
  };
  const createProjectForResume = async (resumeProjectId: string, name: string) => {
    if (!profileId) return;
    try {
      const created = await window.interviewCopilot.projects.create({ name, profileId });
      if (created) await saveResumeProjectLink(resumeProjectId, created.id);
      await refreshProjectState(profileId);
    } catch (error) { store.setNotice(`创建项目失败：${userFacingError(error)}`); }
  };
  const saveSelfIntroduction = async (text: string, targetDurationSeconds: number, language: string) => {
    if (!profileId) return;
    try {
      const saved = await window.interviewCopilot.selfIntroduction.save({ profileId, resumeHash: "", text, source: "manual", approved: false, targetDurationSeconds, language });
      if (saved) setSelfIntroduction(saved);
      store.setNotice("自我介绍草稿已保存，审核通过后才会进入直接快车道");
    } catch (error) { store.setNotice(`自我介绍保存失败：${userFacingError(error)}`); }
  };
  const uploadSelfIntroduction = async (file: File) => {
    if (!profileId) return;
    try {
      const saved = await window.interviewCopilot.selfIntroduction.upload({ profileId, resumeHash: "", filename: file.name, mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) });
      if (saved) setSelfIntroduction(saved);
      store.setNotice("自我介绍稿件已导入，请审核后使用");
    } catch (error) { store.setNotice(`自我介绍导入失败：${userFacingError(error)}`); }
  };
  const generateSelfIntroduction = async (targetDurationSeconds: number, language: string) => {
    if (!profileId) return;
    try {
      const generated = await window.interviewCopilot.selfIntroduction.generate(profileId, targetDurationSeconds, language);
      if (generated) setSelfIntroduction(generated);
      store.setNotice("自我介绍 AI 草稿已生成，请检查并审核");
    } catch (error) { store.setNotice(`自我介绍生成失败：${userFacingError(error)}`); }
  };
  const approveSelfIntroduction = async () => {
    if (!selfIntroduction) return;
    try {
      const approved = await window.interviewCopilot.selfIntroduction.approve(selfIntroduction.id);
      if (approved) setSelfIntroduction(approved);
      store.setNotice("自我介绍已审核，可在面试中直接使用");
    } catch (error) { store.setNotice(`审核失败：${userFacingError(error)}`); }
  };
  const continueUsingSelfIntroduction = async () => {
    if (!selfIntroduction) return;
    try {
      const rebound = await window.interviewCopilot.selfIntroduction.continueUsing(selfIntroduction.id, "");
      if (rebound) setSelfIntroduction(rebound);
      store.setNotice("已确认继续使用旧自我介绍");
    } catch (error) { store.setNotice(`继续使用失败：${userFacingError(error)}`); }
  };
  const rebuildProfileBuilder = async () => {
    if (!selectedProfile || profileBuilderRunning) return;
    try {
      const job = await window.interviewCopilot.profileBuilder.start(selectedProfile.id);
      setProfileBuilderRunning(["queued", "running"].includes(job.status));
      store.setNotice("个人档案分析已排队，页面仍可继续操作");
    } catch (error) {
      store.setNotice(`个人档案分析失败：${userFacingError(error)}`);
    }
  };
  const analyzeResume = async () => {
    if (!selectedProfile?.resume || resumeAnalysisRunning) return;
    try {
      const job = await window.interviewCopilot.resumeAnalysis.start(selectedProfile.id);
      setResumeAnalysisRunning(["queued", "running"].includes(job.status));
      store.setNotice("简历项目解析已排队，页面仍可继续操作");
    } catch (error) {
      store.setNotice(`简历项目解析失败：${userFacingError(error)}`);
    }
  };
  const rebuildProjectMemory = async (projectId?: string) => {
    if (!selectedProfile || projectMemoryRunning) return;
    setProjectMemoryRunning(true);
    try {
       if (projectId) {
         const job = await window.interviewCopilot.projectMemory.rebuildProject(projectId);
         setProjectAnalysisJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
         store.setNotice("项目分析已排队，可在项目详情中查看进度或取消");
       } else {
         const memory = await window.interviewCopilot.projectMemory.rebuild(selectedProfile.id);
         void memory;
         await refreshProjectState(selectedProfile.id);
         store.setNotice("个人工程经验已更新");
       }
    } catch (error) {
      store.setNotice(`项目记忆分析失败：${userFacingError(error)}`);
    } finally { setProjectMemoryRunning(false); }
  };
  const verifyProjectFact = async (factId: string, verified: boolean) => {
    const updated = await window.interviewCopilot.projectMemory.verifyFact(factId, verified);
    if (updated) {
      await refreshProjectState(profileId);
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
  const reviewSkillSuggestion = async (suggestionId: string, status: SkillSuggestionStatus) => {
    const reviewed = await window.interviewCopilot.profileBuilder.reviewSkillSuggestion(suggestionId, status);
    if (!reviewed) return;
    setSkillSuggestions((current) => current.map((suggestion) => suggestion.id === reviewed.id ? reviewed : suggestion));
    if (status !== "confirmed" || !selectedProfile) {
      store.setNotice(status === "rejected" ? "技能建议已拒绝" : "技能建议已更新");
      return;
    }
    const existing = selectedProfile.skills.some((skill) => skill.name.trim().toLowerCase() === reviewed.name.trim().toLowerCase());
    if (!existing) {
      const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: [...selectedProfile.skills, { id: `skill-${Date.now()}`, name: reviewed.name, description: reviewed.description, content: reviewed.evidenceQuotes.join("；"), tags: ["AI审核"], source: "resume", evidenceRefs: reviewed.evidenceIds, confirmedAt: reviewed.confirmedAt }] });
      if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile));
    }
    store.setNotice("技能建议已确认，并加入正式技能");
  };
  const confirmDetectedSkill = async (skillId: string) => {
    if (!selectedProfile) return;
    const updated = await window.interviewCopilot.profiles.save({ ...selectedProfile, skills: selectedProfile.skills.map((skill) => skill.id === skillId ? { ...skill, tags: skill.tags.filter((tag) => tag !== "待确认"), source: skill.source ?? "resume", confirmedAt: Date.now() } : skill) });
    if (updated) { setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); store.setNotice("技能已确认"); }
  };
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
      await refreshProjectState(profileId);
      store.setNotice(status === "rejected" ? "事实已标记为不正确" : status === "active" ? "事实已确认" : "事实状态已更新");
    }
  };
  const resolveProjectConflict = async (conflictGroupId: string, selectedFactId: string, keepBoth = false, variantContexts?: Record<string, string>): Promise<void> => {
    await window.interviewCopilot.projectMemory.resolveConflict(conflictGroupId, selectedFactId, keepBoth, variantContexts);
    await refreshProjectState(profileId);
    store.setNotice(keepBoth ? "冲突候选已全部保留并确认" : "冲突已解决，已采用所选版本");
  };
  const unassignProjectSource = async (projectId: string, sourceType: string, sourceId: string): Promise<void> => {
    await window.interviewCopilot.projectMemory.unassignSource(projectId, sourceType, sourceId);
    await refreshProjectState(profileId);
    store.setNotice("资料已解除绑定，事实和项目题已按剩余证据重新计算");
  };
  const addProjectResponsibility = async (projectId: string, content: string): Promise<void> => {
    try {
      await window.interviewCopilot.projectMemory.addResponsibility(profileId, projectId, content);
      await refreshProjectState(profileId);
      store.setNotice("个人职责已保存，并已进入可信事实链");
    } catch (error) {
      store.setNotice(`职责保存失败：${userFacingError(error)}`);
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
      await refreshProjectState(profileId);
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
      if (project) { await refreshProjectState(profileId); setSelectedProjectId(project.id); store.setNotice(`项目“${project.name}”已创建`); }
    } catch (error) { store.setNotice(`项目创建失败：${userFacingError(error)}`); }
  };
  const renameProject = async (projectId: string, currentName: string) => { const name = await requestDialog({ kind: "form", title: "重命名项目", label: "项目名称", defaultValue: currentName, required: true, confirmLabel: "保存" }); if (typeof name !== "string" || !name.trim()) return; const updated = await window.interviewCopilot.projects.rename(projectId, name); if (updated) { await refreshProjectState(profileId); store.setNotice(`项目已重命名为“${updated.name}”`); } };
  const deleteProject = async (projectId: string, currentName: string) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${currentName}？`, description: "项目会被删除，对话内容仍保留。删除后会自动切换到剩余项目。", confirmLabel: "删除" }); if (confirmed !== true) return; await window.interviewCopilot.projects.delete(projectId); const refreshed = await refreshProjectState(profileId); if (selectedProjectId === projectId) { const fallback = refreshed.projects[0]?.id; if (fallback) { setSelectedProjectId(fallback); setActiveConversationId(undefined); setChatMessages([]); setComposerText(""); setConversations((await window.interviewCopilot.chat.listConversations(profileId)).filter((conversation) => conversation.projectId === fallback)); } else beginNewConversation(); } store.setNotice(`项目“${currentName}”已删除`); };
  const startPreparation = () => { setPage("preparation"); store.setNotice("已打开面试准备 Agent"); };
  const polishResume = () => { setPreparationGoal("润色当前 Resume 中的项目描述，保留真实技术细节和量化结果"); setPage("preparation"); };
  const selectLanguage = () => { setPage("settings"); setSettingsSection("general"); };
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
  const chooseLlmPreset = (preset: "deepseek" | "qwen" | "custom") => {
    setModelCatalogs((current) => ({ ...current, llm: undefined }));
    setProviderTests((current) => ({ ...current, llm: "供应商已更改 · 请保存配置并获取模型" }));
    if (preset === "deepseek") {
      setLlmProviderName("DeepSeek"); setLlmBaseUrl("https://api.deepseek.com"); setLlmModel("deepseek-chat"); setFastModel("deepseek-chat"); setNormalModel("deepseek-chat"); setDeepModel("deepseek-reasoner"); setVisionModel("");
    } else if (preset === "qwen") {
      setLlmProviderName("Qwen / Bailian"); setLlmBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"); setLlmModel("qwen-plus"); setFastModel("qwen-flash"); setNormalModel("qwen-plus"); setDeepModel("qwen3-max"); setVisionModel("qwen3-vl-plus");
    } else {
      setLlmProviderName("OpenAI-compatible");
    }
  };
  const saveLlmProfileFromSettings = async (): Promise<{ config: ProviderCenterPublicConfig; profileId: string } | undefined> => {
    try {
      const result = await saveLlmProfile();
      store.setNotice("模型配置已保存");
      return result;
    } catch (error) {
      store.setNotice(`模型配置保存失败：${userFacingError(error)}`);
      return undefined;
    }
  };
  const saveAsrSettings = async (): Promise<void> => {
    try {
      await window.interviewCopilot.settings.update("asr", { providerName: asrProviderLabel(asrProviderType), providerType: asrProviderType, baseUrl: asrBaseUrl.trim(), model: asrModel.trim() || asrDefaultModel(asrProviderType), language: asrLanguage, apiKey: asrApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      applyProviderSettings(await window.interviewCopilot.settings.get());
      setAsrApiKey("");
      store.setNotice("语音识别设置已保存");
    } catch (error) { store.setNotice(`语音识别设置保存失败：${userFacingError(error)}`); }
  };
  const saveEmbeddingSettings = async (): Promise<void> => {
    try {
      await window.interviewCopilot.settings.update("embedding", { providerName: /dashscope|aliyun/i.test(embeddingBaseUrl) ? "Qwen / Bailian" : "OpenAI-compatible", baseUrl: embeddingBaseUrl.trim(), model: embeddingModel.trim() || "text-embedding-3-small", apiKey: embeddingApiKey || undefined, timeoutMs: 15_000, maxRetries: 2 });
      applyProviderSettings(await window.interviewCopilot.settings.get());
      setEmbeddingApiKey("");
      store.setNotice("检索模型设置已保存");
    } catch (error) { store.setNotice(`检索模型设置保存失败：${userFacingError(error)}`); }
  };
  const specialPageContent = page === "knowledge"
    ? <KnowledgePage knowledgeBases={knowledgeBases} knowledgeBaseId={knowledgeBaseId} knowledgeDocuments={knowledgeDocuments} requestDialog={requestDialog} onSelectBase={setKnowledgeBaseId} onCreateBase={async (name) => { const created = await window.interviewCopilot.knowledge.createBase(name); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); setKnowledgeDocuments([]); } }} onRenameBase={async (id, name) => { const updated = await window.interviewCopilot.knowledge.renameBase(id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); }} onDeleteBase={async (id, name) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${name}？`, description: "删除后资料库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(id); const next = await window.interviewCopilot.knowledge.listBases(); const nextId = next[0]?.id ?? ""; setKnowledgeBases(next); setKnowledgeBaseId(nextId); setKnowledgeDocuments(nextId ? await window.interviewCopilot.knowledge.listDocuments(nextId) : []); } }} onUpload={uploadKnowledgeFile} onUpdateType={async (id, type) => { await window.interviewCopilot.knowledge.updateType(id, type); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onReindex={async (id) => { await window.interviewCopilot.knowledge.reindex(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onDeleteDocument={async (id) => { await window.interviewCopilot.knowledge.delete(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} />
    : page === "project-library"
      ? <ProjectLibraryPage profileId={profileId} projects={projects} memory={projectMemory ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] }} stats={projectMemoryStats} facts={projectFacts} staleFacts={staleProjectFacts} analysisRuns={knowledgeAnalysisRuns} analysisJobs={projectAnalysisJobs} rebuilding={projectMemoryRunning} selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId} onImportProjectMaterials={importProjectMaterials} onImportProjectQuestionBank={importProjectQuestionBank} onGenerateProjectQa={generateProjectQuestionBank} onCreateProject={createProjectMemory} onRenameProject={renameProject} onDeleteProject={deleteProject} onUpdateProject={updateProjectOwnership} onRebuild={(projectId) => void rebuildProjectMemory(projectId)} onCancelAnalysis={(projectId, jobId) => window.interviewCopilot.projectMemory.cancelAnalysis(projectId, jobId).then((job) => { if (job) setProjectAnalysisJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]); })} onRetryAnalysis={(projectId) => window.interviewCopilot.projectMemory.retryAnalysis(profileId, projectId).then((job) => { if (job) setProjectAnalysisJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]); })} onReviewFact={reviewProjectFact} onResolveConflict={resolveProjectConflict} onUnassignSource={unassignProjectSource} onAddResponsibility={addProjectResponsibility} agentMessages={chatMessages} agentSending={chatSending} agentProjectId={conversations.find((item) => item.id === activeConversationId)?.projectId} onSendAgent={sendProjectAgent} onRetryAgent={retryChatMessage} onOpenSettings={() => setPage("settings")} onApproveAgentAction={approveChatAction} />
      : page === "job-targets"
      ? <JobTargetsPage targets={jobTargets} onUploadJob={uploadJobDescription} onOpenProfile={() => setPage("profiles")} />
      : page === "profiles"
        ? <ProfileWorkspacePage profiles={profiles} profileId={profileId} selectedProfile={selectedProfile} knowledgeBases={knowledgeBases} artifact={profileBuilderArtifact} resumeAnalysis={resumeAnalysis} suggestions={skillSuggestions} analysisRunning={profileBuilderRunning} resumeAnalysisRunning={resumeAnalysisRunning} onSelectProfile={(id) => { setProfileId(id); void window.interviewCopilot.profiles.selectActive(id); }} onCreateProfile={async () => { const created = await window.interviewCopilot.profiles.save({ name: `面试档案 ${profiles.length + 1}`, language: "zh-CN", skills: [], knowledgeBaseIds: knowledgeBases[0] ? [knowledgeBases[0].id] : [] }); if (created) { setProfiles((current) => [created, ...current]); setProfileId(created.id); } }} onAttachMaterial={attachProfileMaterial} onRemoveMaterial={removeProfileMaterial} onEditInstructions={() => void editInstructions()} onEditCompanyContext={() => void editCompanyContext()} onEditSalaryExpectation={() => void editSalaryExpectation()} onAddSkill={() => void addSkill()} onEditSkill={(id) => void editSkill(id)} onDeleteSkill={(id) => void deleteSkill(id)} onCloneProfile={() => void cloneProfile()} onRenameProfile={() => void renameProfile()} onDeleteProfile={() => void deleteProfile()} onToggleKnowledgeBase={(id, linked) => void toggleKnowledgeBase(id, linked)} onReviewSuggestion={(id, status) => void reviewSkillSuggestion(id, status)} onRebuildAnalysis={() => void rebuildProfileBuilder()} onAnalyzeResume={() => void analyzeResume()} onUpdateExpression={(patch) => void updateProfileExpression(patch)} projects={projects} resumeProjectLinks={resumeProjectLinks} selfIntroduction={selfIntroduction} onSaveResumeProjectLink={(resumeProjectId, projectId) => void saveResumeProjectLink(resumeProjectId, projectId)} onCreateProjectForResume={(resumeProjectId, name) => void createProjectForResume(resumeProjectId, name)} onSaveSelfIntroduction={(text, duration, language) => void saveSelfIntroduction(text, duration, language)} onUploadSelfIntroduction={(file) => void uploadSelfIntroduction(file)} onGenerateSelfIntroduction={(duration, language) => void generateSelfIntroduction(duration, language)} onApproveSelfIntroduction={() => void approveSelfIntroduction()} onContinueUsingSelfIntroduction={() => void continueUsingSelfIntroduction()} />
      : page === "help"
        ? <HelpPage onNavigate={setPage} onSettingsSection={setSettingsSection} onOpenSetup={() => { setPage("interview"); openInterviewSetup(); }} />
      : undefined;
  const modernPageContent = specialPageContent ?? (() => {
    if (page === "settings") {
      return <SettingsPage section={settingsSection} onSectionChange={setSettingsSection} profiles={profiles} activeProfileId={profileId} onActiveProfileChange={(next) => { setProfileId(next); void window.interviewCopilot.profiles.selectActive(next); }} answerMode={answerMode} onAnswerModeChange={setAnswerMode} providerSettings={providerSettings} llmProfiles={llmProfiles} activeLlmProfileId={activeLlmProfileId} llmProfileId={llmProfileId} llmProfileName={llmProfileName} onLlmProfileNameChange={setLlmProfileName} onLlmProfileSelect={selectLlmProfile} onLlmProfileActivate={() => void activateLlmProfile(llmProfileId)} onLlmProfileNew={startNewLlmProfile} onLlmProfileDelete={() => void deleteLlmProfile()} llm={{ providerName: llmProviderName, baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModel, fastModel, normalModel, deepModel, visionModel, onProviderNameChange: setLlmProviderName, onBaseUrlChange: setLlmBaseUrl, onApiKeyChange: setLlmApiKey, onModelChange: setLlmModel, onFastModelChange: setFastModel, onNormalModelChange: setNormalModel, onDeepModelChange: setDeepModel, onVisionModelChange: setVisionModel }} routing={{ values: { fallbackModel, questionRecognitionModel, profileBuilderModel, projectAnalyzerModel, questionBankModel, chatModel, postInterviewModel, preparationModel }, onChange: (key, value) => { const setters: Record<string, (next: string) => void> = { fallbackModel: setFallbackModel, questionRecognitionModel: setQuestionRecognitionModel, profileBuilderModel: setProfileBuilderModel, projectAnalyzerModel: setProjectAnalyzerModel, questionBankModel: setQuestionBankModel, chatModel: setChatModel, postInterviewModel: setPostInterviewModel, preparationModel: setPreparationModel }; setters[key]?.(value); } }} asr={{ providerType: asrProviderType, baseUrl: asrBaseUrl, model: asrModel, language: asrLanguage, apiKey: asrApiKey, onProviderTypeChange: (next) => { setAsrProviderType(next); setModelCatalogs((current) => ({ ...current, asr: undefined })); if (next === "qwen") { setAsrBaseUrl(QWEN_REALTIME_ASR_URL); setAsrModel(QWEN_REALTIME_ASR_MODEL); } else if (next === "deepgram") { setAsrBaseUrl("wss://api.deepgram.com/v1/listen"); setAsrModel("nova-3"); } else if (next === "funasr-local") { setAsrBaseUrl("ws://127.0.0.1:8765"); setAsrModel("funasr-nano:q8"); } }, onBaseUrlChange: setAsrBaseUrl, onModelChange: setAsrModel, onLanguageChange: setAsrLanguage, onApiKeyChange: setAsrApiKey, diagnostics: store.asrDiagnostics, devices, inputDeviceId, outputDeviceId, onInputDeviceChange: (next) => { setInputDeviceId(next); persistDevice("interview-copilot.input-device", next); }, onOutputDeviceChange: (next) => { setOutputDeviceId(next); persistDevice("interview-copilot.output-device", next); }, probing, onProbe: () => void probeAudio() }} embedding={{ baseUrl: embeddingBaseUrl, model: embeddingModel, apiKey: embeddingApiKey, onBaseUrlChange: setEmbeddingBaseUrl, onModelChange: setEmbeddingModel, onApiKeyChange: setEmbeddingApiKey }} modelCatalogs={modelCatalogs} modelCatalogLoading={modelCatalogLoading} providerTests={providerTests} onChooseLlmPreset={chooseLlmPreset} onFetchModels={(section) => void fetchProviderModels(section)} onTestProvider={(section) => void testProvider(section)} onSaveLlmProfile={saveLlmProfileFromSettings} onSaveAsr={saveAsrSettings} onSaveEmbedding={saveEmbeddingSettings} overlayPreferences={overlayPreferences} onOverlayPreview={(patch) => window.interviewCopilot.overlay.previewPreferences(patch).catch(() => undefined)} onOverlayChange={(patch) => { overlayPreferenceSaveInFlightRef.current += 1; return window.interviewCopilot.overlay.setPreferences(patch).catch((error) => { store.setNotice(`悬浮窗设置保存失败：${userFacingError(error)}`); throw error; }).finally(() => { overlayPreferenceSaveInFlightRef.current -= 1; }); }} onOverlayReset={() => window.interviewCopilot.overlay.resetLayout().then(() => window.interviewCopilot.overlay.getPreferences()).then(setOverlayPreferences).catch((error) => { store.setNotice(`悬浮窗布局重置失败：${userFacingError(error)}`); throw error; })} terminology={{ profileId, mode: terminologyMode, terms: terminologyTerms, directionSelection: defaultDirectionSelection, effectiveLexiconSize, sourceCounts: terminologySourceCounts, activeDomains: terminologyActiveDomains, onDirectionSelectionChange: changeDefaultDirection, onModeChange: changeTerminologyMode, onAddTerm: addTerminologyTerm, onDeleteTerm: deleteTerminologyTerm, onLearnCorrection: learnTerminologyCorrection, onTest: testTerminology }} captureProtectionPanel={<CaptureProtectionSettings status={captureProtection} validation={tencentValidation} onToggle={(enabled) => void toggleCaptureProtection(enabled)} onValidate={validateTencent} />} />;
    }
   if (String(page) === "personal-memory") return <><PersonalMemoryPage memory={projectMemory} stats={projectMemoryStats} rebuilding={projectMemoryRunning} onRebuild={() => void rebuildProjectMemory()} /><MemoryGovernancePanel memory={projectMemory} facts={projectFacts} jobTargets={jobTargets} analysisRuns={knowledgeAnalysisRuns} retrievalRuns={retrievalRuns} onVerifyFact={verifyProjectFact} /></>;
    if (String(page) === "knowledge") return <KnowledgePage knowledgeBases={knowledgeBases} knowledgeBaseId={knowledgeBaseId} knowledgeDocuments={knowledgeDocuments} requestDialog={requestDialog} onSelectBase={setKnowledgeBaseId} onCreateBase={async (name) => { const created = await window.interviewCopilot.knowledge.createBase(name); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); setKnowledgeDocuments([]); } }} onRenameBase={async (id, name) => { const updated = await window.interviewCopilot.knowledge.renameBase(id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); }} onDeleteBase={async (id, name) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${name}？`, description: "知识库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(id); const next = await window.interviewCopilot.knowledge.listBases(); setKnowledgeBases(next); const nextId = next[0]?.id ?? ""; setKnowledgeBaseId(nextId); setKnowledgeDocuments(nextId ? await window.interviewCopilot.knowledge.listDocuments(nextId) : []); } }} onUpload={uploadKnowledgeFile} onUpdateType={async (id, type) => { await window.interviewCopilot.knowledge.updateType(id, type); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onReindex={async (id) => { await window.interviewCopilot.knowledge.reindex(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onDeleteDocument={async (id) => { await window.interviewCopilot.knowledge.delete(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} />;
    if (String(page) === "question-bank") return <QuestionBankPage questions={questionBankQuestions} total={questionBankTotal} skills={questionBankSkills} jobs={questionBankJobs} projects={projectMemory?.projects ?? []} modules={projectMemory?.modules ?? []} onList={(options) => window.interviewCopilot.questionBank.list(options)} onCount={(options) => window.interviewCopilot.questionBank.count(options)} onBulkUpdate={(ids, patch) => window.interviewCopilot.questionBank.bulkUpdate(ids, patch).then(async (count) => { await refreshQuestionBank(); return count; })} onDuplicates={() => window.interviewCopilot.questionBank.duplicates()} onMergeDuplicates={(canonicalId, duplicateIds) => window.interviewCopilot.questionBank.mergeDuplicates(canonicalId, duplicateIds).then(async (result) => { await refreshQuestionBank(); return result; })} answerGenerationProgress={questionBankAnswerProgress} onSaveQuestion={async (input) => { const saved = await window.interviewCopilot.questionBank.saveQuestion(input); await refreshQuestionBank(); return saved; }} onSaveAnswer={async (input) => { const saved = await window.interviewCopilot.questionBank.saveAnswer(input); await refreshQuestionBank(); return saved; }} onDeleteQuestion={async (id) => { await window.interviewCopilot.questionBank.deleteQuestion(id); await refreshQuestionBank(); store.setNotice("题目已删除"); }} onImport={async (text, filename, options) => { const result = await window.interviewCopilot.questionBank.importText({ text, filename, ...options }); await refreshQuestionBank(); return result; }} onGenerateAnswers={async (questionIds) => { try { store.setNotice("正在生成题库答案…"); return await window.interviewCopilot.questionBank.generateAnswers({ questionIds, onlyUnanswered: true }); } catch (error) { store.setNotice(`答案生成失败：${userFacingError(error)}`); return undefined; } }} onSaveSkill={async (input) => { await window.interviewCopilot.questionBank.saveSkill(input); await refreshQuestionBank(); store.setNotice(`技能“${input.name}”已保存`); }} onLinkSkill={(questionId, skillId) => window.interviewCopilot.questionBank.linkSkill(questionId, skillId)} onCoverage={(jobProfileId) => window.interviewCopilot.questionBank.coverage(jobProfileId)} onNotice={(message) => store.setNotice(message)} />;
    if (page === "home") return chatMessages.length > 0 ? <section className="conversation-view"><div className="page-heading"><div><span className="page-kicker">CONVERSATION</span><h1>{conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? "新对话"}</h1></div><span className="conversation-status">{chatSending ? "AI 正在生成…" : "已保存到本地"}</span></div><div className="chat-message-list">{chatMessages.map((message) => { const recoverable = message.role === "assistant" && (message.status === "cancelled" || message.status === "partial_error"); const retryable = message.role === "assistant" && message.status === "failed"; return <article className={`chat-message ${message.role}`} key={message.id}><span className="chat-message-avatar">{message.role === "user" ? "你" : "AI"}</span><div className="chat-message-body"><div className="chat-message-role">{message.role === "user" ? "你" : "Interview Copilot"}{message.status === "streaming" && <span className="streaming-label">正在生成…</span>}{message.status === "cancelled" && <span className="chat-status-label">已停止生成</span>}{message.status === "partial_error" && <span className="chat-status-label chat-status-warning">回答生成中断，已保留当前内容</span>}{message.status === "failed" && <span className="chat-status-label chat-status-error">生成失败</span>}</div>{message.role === "assistant" ? <MarkdownAnswer text={message.content || (message.status === "streaming" ? "正在生成…" : message.status === "failed" ? "暂无回答内容" : "已保留当前回答内容")} /> : <p>{message.content}</p>}{(recoverable || retryable) && <div className="chat-recovery-actions">{recoverable && <button className="outline-pill" disabled={chatSending} onClick={() => void continueChatMessage(message.id)}>继续回答</button>}<button className="outline-pill" disabled={chatSending} onClick={() => void retryChatMessage(message.id)}>重新生成</button></div>}</div></article>; })}</div>{chatSending && activeConversationId && <button className="outline-pill stop-generation" onClick={() => void window.interviewCopilot.chat.cancel(activeConversationId)}>停止生成</button>}</section> : <WelcomeScreen onPrepare={startPreparation} onPolish={polishResume} onLanguage={selectLanguage} onRefresh={beginNewConversation} />;
    if (page === "interview") return <section className="simple-page interview-page"><div className="page-heading"><div><span className="page-kicker">LIVE INTERVIEW</span><h1>开始面试</h1><p className="page-note">面试官一开口，答案就在屏幕上。</p></div><div className="detail-actions"><button className="outline-pill" onClick={() => void startWrittenTest()}>笔试模式</button><button className="dark-pill" onClick={openInterviewSetup}>开始面试 <span>↗</span></button></div></div><div className="interview-hero"><div className="interview-hero-copy"><span className="hero-status"><i /> READY WHEN YOU ARE</span><h2>让 AI 负责听题，<br />你负责表达。</h2><p>连接麦克风和系统音频，选择面试档案后开始。回答会基于本轮准备快照生成，保持真实、简洁、贴合你的经历。需要笔试时，直接进入截图回答模式。</p><div className="detail-actions"><button className="hero-cta" onClick={openInterviewSetup}>打开面试设置 <span>→</span></button><button className="outline-pill" onClick={() => void startWrittenTest()}>开始笔试模式</button></div></div><div className="interview-orbit" aria-hidden="true"><span className="orbit-ring ring-one" /><span className="orbit-ring ring-two" /><span className="orbit-core"><b>AI</b><small>LISTEN<br />THINK<br />ANSWER</small></span></div></div><div className="interview-steps"><article><span>01</span><strong>冻结准备快照</strong><p>简历、JD、项目和技能卡</p></article><article><span>02</span><strong>实时识别问题</strong><p>支持追问、打断和换方向</p></article><article><span>03</span><strong>截图回答笔试题</strong><p>Ctrl+Alt+S 触发视觉回答</p></article></div></section>;
    if (page === "preparation") return <section className="simple-page preparation-page"><div className="page-heading"><div><span className="page-kicker">PREPARATION AGENT</span><h1>面试准备</h1></div><span className="page-note">最多 40 步 · 写入需审批</span></div><label className="clean-field"><span>准备目标</span><textarea value={preparationGoal} onChange={(event) => setPreparationGoal(event.target.value)} rows={4} /></label><div className="detail-actions"><button className="dark-pill" disabled={preparationRunning} onClick={async () => { setPreparationEvents([]); setPreparationRunning(true); try { await window.interviewCopilot.preparation.start(preparationGoal); } catch (error) { setPreparationRunning(false); store.setNotice(`Preparation 启动失败：${userFacingError(error)}`); } }}>{preparationRunning ? "准备中…" : "开始准备"}</button>{preparationRunning && <button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.stop()}>停止</button>}</div><div className="preparation-events">{preparationEvents.map((event, index) => <div className={`event-row event-${String(event.type ?? "event")}`} key={`${String(event.type)}-${index}`}><strong>{String(event.type ?? "event")}</strong><span>{typeof event.summary === "string" ? event.summary : typeof event.message === "string" ? event.message : typeof event.tool === "string" ? `${event.tool}${event.rationale ? ` · ${String(event.rationale)}` : ""}` : event.risk ? `风险：${String(event.risk)}` : ""}</span>{event.type === "approval_required" && typeof event.requestId === "string" && <span className="approval-actions"><button className="dark-pill" onClick={() => void window.interviewCopilot.preparation.approve(String(event.requestId))}>允许</button><button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.reject(String(event.requestId))}>拒绝</button></span>}</div>)}</div></section>;
    if (page === "profiles") return null;
    if (page === "knowledge") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">KNOWLEDGE</span><h1>知识库</h1></div><button className="dark-pill" onClick={async () => { const name = await requestDialog({ kind: "form", title: "新建知识库", label: "知识库名称", defaultValue: "新知识库", required: true, confirmLabel: "创建" }); if (typeof name === "string" && name.trim()) { const created = await window.interviewCopilot.knowledge.createBase(name.trim()); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); } } }}>新建知识库</button></div><div className="clean-list knowledge-list">{knowledgeBases.map((base) => <div className={`clean-list-row ${base.id === knowledgeBaseId ? "selected" : ""}`} key={base.id}><button className="row-main-button" onClick={() => setKnowledgeBaseId(base.id)}><span>{base.name}</span><small>{base.id === knowledgeBaseId ? `${knowledgeDocuments.length} 个文档` : "查看文档"}</small></button><span className="row-actions"><button className="text-button" onClick={async () => { const name = await requestDialog({ kind: "form", title: "重命名知识库", label: "名称", defaultValue: base.name, required: true, confirmLabel: "保存" }); if (typeof name === "string") { const updated = await window.interviewCopilot.knowledge.renameBase(base.id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); } }}>重命名</button><button className="text-button danger-text" onClick={async () => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${base.name}？`, description: "知识库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(base.id); const next = await window.interviewCopilot.knowledge.listBases(); setKnowledgeBases(next); setKnowledgeBaseId(next[0]?.id ?? ""); } }}>删除</button></span></div>)}</div><label className="upload-document">＋ 导入 PDF / DOCX / TXT / MD / GitHub ZIP<input type="file" accept=".txt,.md,.pdf,.docx,.zip" onChange={(event) => void uploadKnowledge(event)} /></label><div className="clean-list document-list">{knowledgeDocuments.map((document) => <div className="clean-list-row" key={document.id}><span>{document.filename}</span><span className="row-actions"><small>{document.status}{document.error ? ` · ${document.error}` : ""}</small><button className="text-button" onClick={() => void window.interviewCopilot.knowledge.reindex(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>重建索引</button><button className="text-button danger-text" onClick={() => void window.interviewCopilot.knowledge.delete(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>删除</button></span></div>)}</div></section>;
    if (page === "history") return <HistoryPage records={historyRecords} search={historySearch} onSearch={setHistorySearch} detail={historyDetail} metrics={historyMetrics} onSelect={async (recordId) => { const [metrics, detail] = await Promise.all([window.interviewCopilot.history.analyze(recordId), window.interviewCopilot.history.get(recordId)]); if (metrics) setHistoryMetrics({ id: recordId, ...metrics }); if (detail) setHistoryDetail(detail as HistoryDetail); }} onExport={async (recordId) => { try { const result = await window.interviewCopilot.history.export(recordId); if (!result.canceled && result.path) store.setNotice(`面试记录已导出：${result.path}`); } catch (error) { store.setNotice(`导出失败：${userFacingError(error)}`); } }} onDelete={async (recordId) => { const confirmed = await requestDialog({ kind: "confirm", title: "删除这场面试记录？", description: "这会同时删除该场面试的转写、识别问题和 AI 回答，操作无法撤销。", confirmLabel: "删除记录" }); if (confirmed !== true) return; await window.interviewCopilot.history.delete(recordId); setHistoryRecords((current) => current.filter((record) => record.id !== recordId)); if (historyDetail?.interview.id === recordId) { setHistoryDetail(undefined); setHistoryMetrics(undefined); } store.setNotice("面试记录已删除"); }} />;
 })();

  const pageTitle = page === "home" ? "工作台" : page === "interview" ? "实时面试" : page === "preparation" ? "面试准备" : page === "profiles" ? "面试档案" : page === "project-library" ? "项目详情" : page === "knowledge" ? "资料库" : page === "personal-memory" ? "项目知识审核" : page === "question-bank" ? "通用题库" : page === "job-targets" ? "岗位要求" : page === "history" ? "面试历史" : page === "help" ? "帮助与快速开始" : "设置";
    if (isOverlay) return <OverlayRoot surface={overlaySurface} mic={store.mic} system={store.system} state={store.state} sessionState={store.sessionState} realtimeState={store.realtimeState} operationMode={store.operationMode} overlayMode={store.overlayMode} hudState={store.hudState} runtimePhases={store.runtimePhases} automationMode={store.automationMode} answerMode={store.answerMode} question={store.question} answerText={store.answerText} answerStreaming={store.answerStreaming} questionGroups={store.questionGroups} activeQuestionGroupId={store.activeQuestionGroupId} activeAnswerGroupId={store.activeAnswerGroupId} answerThreads={store.answerThreads} remoteTranscript={store.remoteTranscript} micTranscript={store.micTranscript} captureProtectionEnabled={captureProtection.requested} captureProtectionSupported={captureProtection.supported} captureProtectionOsFlagApplied={captureProtection.osFlagApplied} captureProtectionDisplayVerified={captureProtection.displayCaptureVerified} captureProtectionLastError={captureProtection.lastError} captureTest={captureTest} onToggleCaptureProtection={() => void toggleCaptureProtection(!captureProtection.requested)} onToggleMode={() => void window.interviewCopilot.overlay.setMode(store.overlayMode === "interactive" ? "passive" : "interactive")} onToggleAutomation={toggleAutomation} onAnswerLatest={() => window.interviewCopilot.interview.answerLatest().catch((error) => { store.setNotice(`回答最新问题失败：${userFacingError(error)}`); })} onAnswerScreenshot={async () => { try { await answerScreenshotForMode(store.operationMode); } catch (error) { store.setNotice(`截图失败：${userFacingError(error)}`); } }} onEndInterview={() => store.operationMode === "WRITTEN_TEST" ? window.interviewCopilot.writtenTest.stop().then(() => undefined) : window.interviewCopilot.interview.stop()} onHideAll={() => void window.interviewCopilot.overlay.hideAll()} onShowAll={() => void window.interviewCopilot.overlay.showAll()} onTogglePanels={() => void window.interviewCopilot.overlay.toggleAll()} onToggleTranscript={() => void window.interviewCopilot.overlay.toggleTranscript()} onToggleAnswer={() => void window.interviewCopilot.overlay.toggleAnswer()} onToggleShortcuts={() => void window.interviewCopilot.overlay.toggleShortcuts()} onRequestEndInterview={() => void window.interviewCopilot.overlay.requestEndInterview()} onToggleShare={() => void window.interviewCopilot.overlay.toggleShareMode()} />;

  return (
    <main className="app-shell modern-shell">
      <Sidebar page={page} projects={projects} conversations={conversations} onNavigate={setPage} onNewConversation={beginNewConversation} onOpenConversation={(conversationId) => void openConversation(conversationId)} onOpenProject={(projectId) => { if (page === "project-library") { setSelectedProjectId(projectId); } else { void openProject(projectId); } }} onRenameProject={(projectId, name) => void renameProject(projectId, name)} onDeleteProject={(projectId, name) => void deleteProject(projectId, name)} />
      <section className="content-shell">
        <div className="modern-topbar"><div className="topbar-context"><span className="topbar-breadcrumb">{page === "project-library" ? "项目库" : "Interview Copilot"}</span><span className="topbar-slash">/</span><strong>{page === "project-library" ? "项目详情" : pageTitle}</strong></div><div className="topbar-actions"><span className="topbar-profile">{selectedProfile ? `当前档案 · ${selectedProfile.name}` : "未选择面试档案"}</span>{page === "project-library" && <button className="topbar-settings-button" aria-label="项目库设置" onClick={() => setPage("settings")}>⚙</button>}<button className="dark-pill start-interview" onClick={openInterviewSetup}>开始面试 <span>↗</span></button></div></div>
        <div className="content-viewport">
          <div className="modern-main">
          {page === "interview" && <section className="interview-context-panel"><div><span className="page-kicker">ANSWER CONTEXT</span><strong>本轮回答上下文</strong><small>未选择时，系统会根据面试问题自动识别项目和岗位。</small></div><label className="clean-field"><span>目标岗位</span><select value={interviewJobTargetId} onChange={(event) => setInterviewJobTargetId(event.target.value)}><option value="">自动使用当前岗位</option>{jobTargets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label><label className="clean-field"><span>重点项目</span><select value={interviewProjectId} onChange={(event) => setInterviewProjectId(event.target.value)}><option value="">根据问题自动识别</option>{projectMemory?.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></section>}
          <PageErrorBoundary page={page}>{modernPageContent}</PageErrorBoundary>
          {page === "home" && <ChatResponseSupplement messages={chatMessages} onApproveAction={approveChatAction} />}
          </div>
          {(page === "home" || page === "interview") && <div className="composer-dock"><div className="chat-context-capsules chat-context-capsules-composer"><span>档案：{selectedProfile?.name ?? "未选择"}</span><span>项目：{selectedProjectId ? projects.find((project) => project.id === selectedProjectId)?.name ?? "当前项目" : "自动"}</span><span>知识：自动检索</span><span>事实策略：仅已确认</span></div><ChatComposer value={composerText} onChange={setComposerText} onSubmit={() => void submitComposer()} onCreateProject={() => void createProject()} /></div>}
        </div>
        {store.notice && <button className={`notice-toast notice-${store.notice.kind}`} onClick={() => store.setNotice(undefined)}>{store.notice.text} <span>×</span></button>}
      </section>
      {dialog && <AppDialog dialog={dialog} onConfirm={(value) => closeDialog(dialog.kind === "confirm" ? true : value)} onCancel={() => closeDialog(undefined)} />}
      {onboardingOpen && <OnboardingModal onFinish={() => { persistDevice("interview-copilot.onboarding-complete", "1"); setOnboardingOpen(false); }} />}
      {setupOpen && <InterviewSetupModal profiles={profiles} profileId={profileId} selectedProfile={selectedProfile} answerMode={answerMode} automationMode={store.automationMode} inputDeviceId={inputDeviceId} outputDeviceId={outputDeviceId} devices={devices} micLabel={audioChannelLabel(store.capability?.mic ?? store.probeResult?.mic)} systemLabel={audioChannelLabel(store.capability?.system ?? store.probeResult?.system)} micAvailable={audioChannelAvailable(store.capability?.mic ?? store.probeResult?.mic)} systemAvailable={audioChannelAvailable(store.capability?.system ?? store.probeResult?.system)} probing={probing} providerLlmReady={Boolean(providerSettings?.llm.hasApiKey)} providerAsrReady={Boolean(providerSettings?.asr.hasApiKey || asrProviderType === "custom-gateway")} asrProviderType={asrProviderType} directionSelection={directionSelection} directionPreview={directionPreview} directionPreviewLoading={directionPreviewLoading} onClose={() => setSetupOpen(false)} onProfileChange={changeSetupProfile} onAnswerModeChange={setAnswerMode} onAutomationModeChange={(mode) => { void window.interviewCopilot.interview.setAutomationMode(mode); }} onInputDeviceChange={(value) => { setInputDeviceId(value); persistDevice("interview-copilot.input-device", value); }} onOutputDeviceChange={(value) => { setOutputDeviceId(value); persistDevice("interview-copilot.output-device", value); }} onDirectionSelectionChange={setDirectionSelection} onProbe={() => void probeAudio()} onCopyDiagnostics={() => void copyAudioDiagnostics()} onStart={(saveAsDefault) => void startInterview(saveAsDefault)} />}
    </main>
  );

}
