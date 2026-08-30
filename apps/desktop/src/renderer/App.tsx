import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { CSSProperties, JSX } from "react";
import "./styles.css";
import "./overlay-simplified.css";
import { create } from "zustand";
import type { AudioCapability, AudioChannelCapability, AudioDevices, AudioDrift, AudioSidecarEvent, ProbeChannelResult, ProbeResult, RealtimeServerMessage } from "@interview-copilot/protocol";
import { AnswerThreadStore, QUESTION_BANK_BANK_LABELS, QUESTION_BANK_BANK_TYPES, QUESTION_BANK_TYPE_LABELS, QUESTION_BANK_TYPES, answerRelationForQuestion, validateLlmModelConfiguration, type AnswerThread, type OverlayAnswerRelation } from "@interview-copilot/shared";
import { QWEN_REALTIME_ASR_MODEL, QWEN_REALTIME_ASR_URL, type AsrProviderType, type ChatAction, type ChatResponse, type ProjectAnalysisJob, type ProjectFact, type ProjectMaterialImportReport, type ProjectMemorySnapshot, type ProjectQaGenerationResult, type ProjectQuestionBankImportReport, type ProjectSourceRole, type QuestionBankBankType, type QuestionBankCoverageResult, type QuestionBankJobProfileRecord, type QuestionBankQuestionRecord, type QuestionBankSkillRecord, type QuestionBankType, type QuestionCandidate, type QuestionEvent, type SessionState, type SkillSuggestion, type SkillSuggestionStatus, type TranscriptSnapshot } from "@interview-copilot/shared";
import type { Profile } from "@interview-copilot/shared";
import type { JobTargetRecord, KnowledgeAnalysisRunRecord, ProfileBuilderArtifactRecord, ProjectMemoryStats, QuestionBankAnswerCardInput, QuestionBankAnswerGenerationResult, QuestionBankBulkPatch, QuestionBankDuplicateCluster, QuestionBankImportResult, QuestionBankListOptions, QuestionBankQuestionInput, QuestionBankSkillInput, RetrievalRunRecord, ResumeAnalysisRecord } from "../main/database";
import type { LlmModelProfileInput, ProviderCenterPublicConfig, PublicProviderSettings, TencentValidationState, TencentValidationStatus } from "../main/settings-store";
import { DEFAULT_OVERLAY_PREFERENCES, type OverlayPreferences } from "../shared/overlay-preferences";
import { chatFailureText } from "../shared/chat-errors";
import type { DiscoveredModel, ModelCatalogResult, ModelCategory } from "../main/model-catalog";
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
  primaryQuestion: string;
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
  sessionState: SessionState;
  operationMode: "IDLE" | "INTERVIEW" | "WRITTEN_TEST";
  writtenTestRunning: boolean;
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
  answerThreads: AnswerThread[];
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
const answerThreadStore = new AnswerThreadStore();
const questionsById = new Map<string, QuestionCandidate>();
const answerQuestionIds = new Map<string, string>();
const questionGroupsById = new Map<string, OverlayQuestionGroupView>();

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
    if (event.type === "audio_state") return { state: event.state };
    if (event.type === "audio_capability") return { capability: event, state: event.captureMode === "dual" ? "READY" : "DEGRADED", probeError: undefined, notice: event.captureMode === "dual" ? current.notice : `音频已降级为 ${event.captureMode}，缺失声道将补零，面试仍可继续` };
    if (event.type === "probe_result") return { probeResult: event, probeError: undefined, state: event.captureMode === "dual" ? "READY" : event.captureMode ? "DEGRADED" : "FAILED" };
    if (event.type === "audio_probe_trace") return current;
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
      answerThreadStore.reset();
      questionGroupsById.clear();
    }
    set((current) => ({
      sessionState,
      operationMode: current.writtenTestRunning ? "WRITTEN_TEST" : sessionState === "IDLE" || sessionState === "ENDED" ? "IDLE" : "INTERVIEW",
      ...(shouldReset ? { question: undefined, answerText: "", answerStreaming: false, answerId: undefined, answerHistory: [], questionGroups: [], activeQuestionGroupId: undefined, answerThreads: [], remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] }, questionDiagnostics: [] } : {})
    }));
  },
  setWrittenTestState: (writtenTest) => {
    stableAnswer.reset();
    questionsById.clear();
    answerQuestionIds.clear();
    answerThreadStore.reset();
    questionGroupsById.clear();
    set((current) => ({ writtenTestRunning: writtenTest.running, operationMode: writtenTest.running ? "WRITTEN_TEST" : current.sessionState === "IDLE" || current.sessionState === "ENDED" ? "IDLE" : "INTERVIEW", answerText: "", answerStreaming: false, answerId: undefined, answerHistory: [], questionGroups: [], activeQuestionGroupId: undefined, answerThreads: [], question: undefined, remoteTranscript: { source: "remote", final: [] }, micTranscript: { source: "mic", final: [] } }));
  },
  setAutomationMode: (automationMode) => set({ automationMode }),
  setAnswerMode: (answerMode) => set({ answerMode }),
  clearProbe: () => set({ probeError: undefined }),
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
    return current.answerStreaming || event.question.answerable === false ? current : { question: event.question, activeQuestionGroupId: event.question.groupId ?? current.activeQuestionGroupId, notice: current.notice };
  }),
  applyRealtimeMessage: (message) => {
    if (message.type === "question_group_updated") {
      const group: OverlayQuestionGroupView = { id: message.groupId, title: message.title, primaryQuestion: message.primaryQuestion, items: message.items, slots: message.slots, updatedAt: message.updatedAt };
      questionGroupsById.set(group.id, group);
      set({ questionGroups: [...questionGroupsById.values()].sort((left, right) => left.updatedAt - right.updatedAt), activeQuestionGroupId: group.id });
      return;
    }
    if (message.type === "runtime_error") { set({ notice: `${message.code}: ${message.message}${message.recoverable ? " · 可重试" : ""}` }); return; }
    if (message.type === "answer_start") answerQuestionIds.set(message.answerId, message.questionId);
    const messageQuestionId = message.type === "answer_start" ? message.questionId : "answerId" in message ? answerQuestionIds.get(message.answerId) : undefined;
    const pairedQuestion = messageQuestionId ? questionsById.get(messageQuestionId) : undefined;
    const answerGroupId = message.type === "answer_start" ? message.groupId ?? pairedQuestion?.groupId : pairedQuestion?.groupId;
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
        ...(answerGroupId ? { activeQuestionGroupId: answerGroupId } : {}),
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

function LlmModelProfilesPanel({ profiles, activeId, selectedId, name, onNameChange, onSelect, onActivate, onNew, onDelete }: { profiles: ProviderCenterPublicConfig["llmProfiles"]; activeId: string; selectedId: string; name: string; onNameChange: (value: string) => void; onSelect: (id: string) => void; onActivate: () => void; onNew: () => void; onDelete: () => void }): JSX.Element {
  const selectedSaved = profiles.some((profile) => profile.id === selectedId);
  return <section className="model-profiles-panel"><div className="model-profiles-heading"><div><span className="page-kicker">MODEL PROFILES</span><h2>模型配置</h2><p>选择只会载入配置供查看和编辑；点击“启用此配置”后，下一次回答才会切换。</p></div><div className="model-profile-actions"><button className="dark-pill" disabled={!selectedSaved || selectedId === activeId} onClick={onActivate}>{selectedId === activeId ? "正在使用" : "启用此配置"}</button><button className="outline-pill" onClick={onNew}>新建配置</button><button className="text-button danger-text" disabled={!selectedSaved || profiles.length <= 1} onClick={onDelete}>删除配置</button></div></div><div className="model-profiles-form"><label className="clean-field"><span>查看 / 编辑配置</span><select value={selectedId} onChange={(event) => onSelect(event.target.value)}>{selectedId && !selectedSaved && <option value={selectedId}>新配置 · 未保存</option>}{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}{profile.id === activeId ? " · 当前使用" : ""}</option>)}</select></label><label className="clean-field"><span>配置名称</span><input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="例如：小米 Mimo、DeepSeek、备用模型" /></label></div></section>;
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

export function App(): JSX.Element {
  const overlaySurface = useMemo(() => { const mode = new URLSearchParams(window.location.search).get("window"); return mode === "overlay-control" ? "control" : mode === "overlay-question" ? "question" : mode === "overlay-answer" ? "answer" : mode === "overlay" ? "content" : undefined; }, []);
  const isOverlay = Boolean(overlaySurface);
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
  const [resumeAnalysis, setResumeAnalysis] = useState<ResumeAnalysisRecord>();
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
      setSkillSuggestions([]);
      setProjectMemory(undefined);
    setProjectMemoryStats({ projects: 0, modules: 0, technicalPoints: 0, problems: 0, interviewQuestions: 0, questions: 0, facts: 0, eligibleFacts: 0, reviewRequiredFacts: 0, userActionRequiredFacts: 0, conflictingFacts: 0, conflictGroups: 0, userActions: 0, staleFacts: 0 });
      setProjectFacts([]);
      setStaleProjectFacts([]);
      setProjectAnalysisJobs([]);
      setJobTargets([]);
      setKnowledgeAnalysisRuns([]);
      setRetrievalRuns([]);
      return;
    }
    void window.interviewCopilot.profileBuilder.get(profileId).then(setProfileBuilderArtifact).catch(() => setProfileBuilderArtifact(undefined));
    void window.interviewCopilot.resumeAnalysis.get(profileId).then(setResumeAnalysis).catch(() => setResumeAnalysis(undefined));
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
      window.interviewCopilot.diagnostics.markStartup("START_BUTTON_CLICK");
      const asrUrl = realtimeUrl.trim() || asrBaseUrl.trim();
      if (!profileId) throw new Error("PROFILE_NOT_FOUND: 请先创建或选择一个面试档案。");
      if (asrProviderType === "custom-gateway" && !asrUrl) throw new Error("ASR_CONNECT_FAILED: Custom Gateway 需要配置 WebSocket URL");
      persistDevice("interview-copilot.input-device", inputDeviceId);
      persistDevice("interview-copilot.output-device", outputDeviceId);
      setSetupOpen(false);
      store.setNotice("面试正在启动，悬浮窗即将显示…");
      await window.interviewCopilot.profiles.selectActive(profileId);
      await window.interviewCopilot.interview.start({ profileId, projectId: interviewProjectId || undefined, jobTargetId: interviewJobTargetId || undefined, url: asrProviderType === "custom-gateway" ? asrUrl : undefined, gatewayToken: asrProviderType === "custom-gateway" ? realtimeTicket.trim() || undefined : undefined, language: selectedProfile?.language, inputDeviceId, outputDeviceId, automationMode: store.automationMode, answerMode, providerType: asrProviderType });
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
      if (kind === "resume") setResumeAnalysis(undefined);
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
  const refreshProjectState = async (profile = profileId): Promise<{ memory: ProjectMemorySnapshot; facts: ProjectFact[] }> => {
    if (!profile) return { memory: projectMemory ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] }, facts: [] };
    const [memory, stats, facts, allFacts, targets, analyses, retrievals] = await Promise.all([
      window.interviewCopilot.projectMemory.get(profile),
      window.interviewCopilot.projectMemory.stats(profile),
      window.interviewCopilot.projectMemory.listFacts(profile),
      window.interviewCopilot.projectMemory.listFacts(profile, undefined, { includeStale: true, includeRejected: true }),
      window.interviewCopilot.jobTargets.list(profile),
      window.interviewCopilot.projectMemory.analysisRuns(profile),
      window.interviewCopilot.retrieval.list(profile, 20)
    ]);
    const resolvedMemory = memory ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] };
    setProjectMemory(memory); setProjectMemoryStats(stats); setProjectFacts(facts); setStaleProjectFacts(allFacts.filter((fact) => fact.stale)); setJobTargets(targets); setKnowledgeAnalysisRuns(analyses); setRetrievalRuns(retrievals);
    return { memory: resolvedMemory, facts };
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
  const removeProfileMaterial = async (kind: "resume" | "jobDescription") => { if (!selectedProfile) return; const updated = await window.interviewCopilot.profiles.removeMaterial(selectedProfile.id, kind); if (updated) setProfiles((current) => current.map((profile) => profile.id === updated.id ? updated : profile)); if (kind === "resume") setResumeAnalysis(undefined); };
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
      ? <ProjectLibraryPage profileId={profileId} memory={projectMemory ?? { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [] }} stats={projectMemoryStats} facts={projectFacts} staleFacts={staleProjectFacts} analysisRuns={knowledgeAnalysisRuns} analysisJobs={projectAnalysisJobs} rebuilding={projectMemoryRunning} selectedProjectId={selectedProjectId} onSelectProject={setSelectedProjectId} onImportProjectMaterials={importProjectMaterials} onImportProjectQuestionBank={importProjectQuestionBank} onGenerateProjectQa={generateProjectQuestionBank} onCreateProject={createProjectMemory} onUpdateProject={updateProjectOwnership} onRebuild={(projectId) => void rebuildProjectMemory(projectId)} onCancelAnalysis={(projectId, jobId) => window.interviewCopilot.projectMemory.cancelAnalysis(projectId, jobId).then((job) => { if (job) setProjectAnalysisJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]); })} onRetryAnalysis={(projectId) => window.interviewCopilot.projectMemory.retryAnalysis(profileId, projectId).then((job) => { if (job) setProjectAnalysisJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]); })} onReviewFact={reviewProjectFact} onResolveConflict={resolveProjectConflict} onUnassignSource={unassignProjectSource} onAddResponsibility={addProjectResponsibility} agentMessages={chatMessages} agentSending={chatSending} agentProjectId={conversations.find((item) => item.id === activeConversationId)?.projectId} onSendAgent={sendProjectAgent} onRetryAgent={retryChatMessage} onOpenSettings={() => setPage("settings")} onApproveAgentAction={approveChatAction} />
      : page === "job-targets"
      ? <JobTargetsPage targets={jobTargets} onUploadJob={uploadJobDescription} onOpenProfile={() => setPage("profiles")} />
      : page === "profiles"
        ? <ProfileWorkspacePage profiles={profiles} profileId={profileId} selectedProfile={selectedProfile} knowledgeBases={knowledgeBases} artifact={profileBuilderArtifact} resumeAnalysis={resumeAnalysis} suggestions={skillSuggestions} analysisRunning={profileBuilderRunning} resumeAnalysisRunning={resumeAnalysisRunning} onSelectProfile={(id) => { setProfileId(id); void window.interviewCopilot.profiles.selectActive(id); }} onCreateProfile={async () => { const created = await window.interviewCopilot.profiles.save({ name: `面试档案 ${profiles.length + 1}`, language: "zh-CN", skills: [], knowledgeBaseIds: knowledgeBases[0] ? [knowledgeBases[0].id] : [] }); if (created) { setProfiles((current) => [created, ...current]); setProfileId(created.id); } }} onAttachMaterial={attachProfileMaterial} onRemoveMaterial={removeProfileMaterial} onEditInstructions={() => void editInstructions()} onEditCompanyContext={() => void editCompanyContext()} onEditSalaryExpectation={() => void editSalaryExpectation()} onAddSkill={() => void addSkill()} onEditSkill={(id) => void editSkill(id)} onDeleteSkill={(id) => void deleteSkill(id)} onCloneProfile={() => void cloneProfile()} onRenameProfile={() => void renameProfile()} onDeleteProfile={() => void deleteProfile()} onToggleKnowledgeBase={(id, linked) => void toggleKnowledgeBase(id, linked)} onReviewSuggestion={(id, status) => void reviewSkillSuggestion(id, status)} onRebuildAnalysis={() => void rebuildProfileBuilder()} onAnalyzeResume={() => void analyzeResume()} onUpdateExpression={(patch) => void updateProfileExpression(patch)} />
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
        <OverlayDesigner value={overlayPreferences} onChange={(patch) => { void window.interviewCopilot.overlay.setPreferences(patch).then(setOverlayPreferences).catch((error) => store.setNotice(`悬浮窗设置保存失败：${userFacingError(error)}`)); }} onReset={() => { void window.interviewCopilot.overlay.resetLayout().then(() => window.interviewCopilot.overlay.getPreferences()).then(setOverlayPreferences).catch((error) => store.setNotice(`悬浮窗布局重置失败：${userFacingError(error)}`)); }} />
      </section>;
    }
    if (String(page) === "personal-memory") return <><PersonalMemoryPage memory={projectMemory} stats={projectMemoryStats} rebuilding={projectMemoryRunning} onRebuild={() => void rebuildProjectMemory()} /><MemoryGovernancePanel memory={projectMemory} facts={projectFacts} jobTargets={jobTargets} analysisRuns={knowledgeAnalysisRuns} retrievalRuns={retrievalRuns} onVerifyFact={verifyProjectFact} /></>;
    if (String(page) === "knowledge") return <KnowledgePage knowledgeBases={knowledgeBases} knowledgeBaseId={knowledgeBaseId} knowledgeDocuments={knowledgeDocuments} requestDialog={requestDialog} onSelectBase={setKnowledgeBaseId} onCreateBase={async (name) => { const created = await window.interviewCopilot.knowledge.createBase(name); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); setKnowledgeDocuments([]); } }} onRenameBase={async (id, name) => { const updated = await window.interviewCopilot.knowledge.renameBase(id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); }} onDeleteBase={async (id, name) => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${name}？`, description: "知识库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(id); const next = await window.interviewCopilot.knowledge.listBases(); setKnowledgeBases(next); const nextId = next[0]?.id ?? ""; setKnowledgeBaseId(nextId); setKnowledgeDocuments(nextId ? await window.interviewCopilot.knowledge.listDocuments(nextId) : []); } }} onUpload={uploadKnowledgeFile} onUpdateType={async (id, type) => { await window.interviewCopilot.knowledge.updateType(id, type); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onReindex={async (id) => { await window.interviewCopilot.knowledge.reindex(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} onDeleteDocument={async (id) => { await window.interviewCopilot.knowledge.delete(id); if (knowledgeBaseId) setKnowledgeDocuments(await window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)); }} />;
    if (String(page) === "question-bank") return <QuestionBankPage questions={questionBankQuestions} total={questionBankTotal} skills={questionBankSkills} jobs={questionBankJobs} projects={projectMemory?.projects ?? []} modules={projectMemory?.modules ?? []} onList={(options) => window.interviewCopilot.questionBank.list(options)} onCount={(options) => window.interviewCopilot.questionBank.count(options)} onBulkUpdate={(ids, patch) => window.interviewCopilot.questionBank.bulkUpdate(ids, patch).then(async (count) => { await refreshQuestionBank(); return count; })} onDuplicates={() => window.interviewCopilot.questionBank.duplicates()} onMergeDuplicates={(canonicalId, duplicateIds) => window.interviewCopilot.questionBank.mergeDuplicates(canonicalId, duplicateIds).then(async (result) => { await refreshQuestionBank(); return result; })} answerGenerationProgress={questionBankAnswerProgress} onSaveQuestion={async (input) => { const saved = await window.interviewCopilot.questionBank.saveQuestion(input); await refreshQuestionBank(); return saved; }} onSaveAnswer={async (input) => { const saved = await window.interviewCopilot.questionBank.saveAnswer(input); await refreshQuestionBank(); return saved; }} onDeleteQuestion={async (id) => { await window.interviewCopilot.questionBank.deleteQuestion(id); await refreshQuestionBank(); store.setNotice("题目已删除"); }} onImport={async (text, filename, options) => { const result = await window.interviewCopilot.questionBank.importText({ text, filename, ...options }); await refreshQuestionBank(); return result; }} onGenerateAnswers={async (questionIds) => { try { store.setNotice("正在生成题库答案…"); return await window.interviewCopilot.questionBank.generateAnswers({ questionIds, onlyUnanswered: true }); } catch (error) { store.setNotice(`答案生成失败：${userFacingError(error)}`); return undefined; } }} onSaveSkill={async (input) => { await window.interviewCopilot.questionBank.saveSkill(input); await refreshQuestionBank(); store.setNotice(`技能“${input.name}”已保存`); }} onLinkSkill={(questionId, skillId) => window.interviewCopilot.questionBank.linkSkill(questionId, skillId)} onCoverage={(jobProfileId) => window.interviewCopilot.questionBank.coverage(jobProfileId)} onNotice={(message) => store.setNotice(message)} />;
    if (page === "home") return chatMessages.length > 0 ? <section className="conversation-view"><div className="page-heading"><div><span className="page-kicker">CONVERSATION</span><h1>{conversations.find((conversation) => conversation.id === activeConversationId)?.title ?? "新对话"}</h1></div><span className="conversation-status">{chatSending ? "AI 正在生成…" : "已保存到本地"}</span></div><div className="chat-message-list">{chatMessages.map((message) => { const recoverable = message.role === "assistant" && (message.status === "cancelled" || message.status === "partial_error"); const retryable = message.role === "assistant" && message.status === "failed"; return <article className={`chat-message ${message.role}`} key={message.id}><span className="chat-message-avatar">{message.role === "user" ? "你" : "AI"}</span><div className="chat-message-body"><div className="chat-message-role">{message.role === "user" ? "你" : "Interview Copilot"}{message.status === "streaming" && <span className="streaming-label">正在生成…</span>}{message.status === "cancelled" && <span className="chat-status-label">已停止生成</span>}{message.status === "partial_error" && <span className="chat-status-label chat-status-warning">回答生成中断，已保留当前内容</span>}{message.status === "failed" && <span className="chat-status-label chat-status-error">生成失败</span>}</div>{message.role === "assistant" ? <MarkdownAnswer text={message.content || (message.status === "streaming" ? "正在生成…" : message.status === "failed" ? "暂无回答内容" : "已保留当前回答内容")} /> : <p>{message.content}</p>}{(recoverable || retryable) && <div className="chat-recovery-actions">{recoverable && <button className="outline-pill" disabled={chatSending} onClick={() => void continueChatMessage(message.id)}>继续回答</button>}<button className="outline-pill" disabled={chatSending} onClick={() => void retryChatMessage(message.id)}>重新生成</button></div>}</div></article>; })}</div>{chatSending && activeConversationId && <button className="outline-pill stop-generation" onClick={() => void window.interviewCopilot.chat.cancel(activeConversationId)}>停止生成</button>}</section> : <WelcomeScreen onPrepare={startPreparation} onPolish={polishResume} onLanguage={selectLanguage} onRefresh={beginNewConversation} />;
    if (page === "interview") return <section className="simple-page interview-page"><div className="page-heading"><div><span className="page-kicker">LIVE INTERVIEW</span><h1>开始面试</h1><p className="page-note">面试官一开口，答案就在屏幕上。</p></div><div className="detail-actions"><button className="outline-pill" onClick={() => void startWrittenTest()}>笔试模式</button><button className="dark-pill" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div></div><div className="interview-hero"><div className="interview-hero-copy"><span className="hero-status"><i /> READY WHEN YOU ARE</span><h2>让 AI 负责听题，<br />你负责表达。</h2><p>连接麦克风和系统音频，选择面试档案后开始。回答会基于本轮准备快照生成，保持真实、简洁、贴合你的经历。需要笔试时，直接进入截图回答模式。</p><div className="detail-actions"><button className="hero-cta" onClick={() => setSetupOpen(true)}>打开面试设置 <span>→</span></button><button className="outline-pill" onClick={() => void startWrittenTest()}>开始笔试模式</button></div></div><div className="interview-orbit" aria-hidden="true"><span className="orbit-ring ring-one" /><span className="orbit-ring ring-two" /><span className="orbit-core"><b>AI</b><small>LISTEN<br />THINK<br />ANSWER</small></span></div></div><div className="interview-steps"><article><span>01</span><strong>冻结准备快照</strong><p>简历、JD、项目和技能卡</p></article><article><span>02</span><strong>实时识别问题</strong><p>支持追问、打断和换方向</p></article><article><span>03</span><strong>截图回答笔试题</strong><p>Ctrl+Alt+S 触发视觉回答</p></article></div></section>;
    if (page === "preparation") return <section className="simple-page preparation-page"><div className="page-heading"><div><span className="page-kicker">PREPARATION AGENT</span><h1>面试准备</h1></div><span className="page-note">最多 40 步 · 写入需审批</span></div><label className="clean-field"><span>准备目标</span><textarea value={preparationGoal} onChange={(event) => setPreparationGoal(event.target.value)} rows={4} /></label><div className="detail-actions"><button className="dark-pill" disabled={preparationRunning} onClick={async () => { setPreparationEvents([]); setPreparationRunning(true); try { await window.interviewCopilot.preparation.start(preparationGoal); } catch (error) { setPreparationRunning(false); store.setNotice(`Preparation 启动失败：${userFacingError(error)}`); } }}>{preparationRunning ? "准备中…" : "开始准备"}</button>{preparationRunning && <button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.stop()}>停止</button>}</div><div className="preparation-events">{preparationEvents.map((event, index) => <div className={`event-row event-${String(event.type ?? "event")}`} key={`${String(event.type)}-${index}`}><strong>{String(event.type ?? "event")}</strong><span>{typeof event.summary === "string" ? event.summary : typeof event.message === "string" ? event.message : typeof event.tool === "string" ? `${event.tool}${event.rationale ? ` · ${String(event.rationale)}` : ""}` : event.risk ? `风险：${String(event.risk)}` : ""}</span>{event.type === "approval_required" && typeof event.requestId === "string" && <span className="approval-actions"><button className="dark-pill" onClick={() => void window.interviewCopilot.preparation.approve(String(event.requestId))}>允许</button><button className="outline-pill" onClick={() => void window.interviewCopilot.preparation.reject(String(event.requestId))}>拒绝</button></span>}</div>)}</div></section>;
    if (page === "profiles") return null;
    if (page === "knowledge") return <section className="simple-page"><div className="page-heading"><div><span className="page-kicker">KNOWLEDGE</span><h1>知识库</h1></div><button className="dark-pill" onClick={async () => { const name = await requestDialog({ kind: "form", title: "新建知识库", label: "知识库名称", defaultValue: "新知识库", required: true, confirmLabel: "创建" }); if (typeof name === "string" && name.trim()) { const created = await window.interviewCopilot.knowledge.createBase(name.trim()); if (created) { setKnowledgeBases((current) => [created, ...current]); setKnowledgeBaseId(created.id); } } }}>新建知识库</button></div><div className="clean-list knowledge-list">{knowledgeBases.map((base) => <div className={`clean-list-row ${base.id === knowledgeBaseId ? "selected" : ""}`} key={base.id}><button className="row-main-button" onClick={() => setKnowledgeBaseId(base.id)}><span>{base.name}</span><small>{base.id === knowledgeBaseId ? `${knowledgeDocuments.length} 个文档` : "查看文档"}</small></button><span className="row-actions"><button className="text-button" onClick={async () => { const name = await requestDialog({ kind: "form", title: "重命名知识库", label: "名称", defaultValue: base.name, required: true, confirmLabel: "保存" }); if (typeof name === "string") { const updated = await window.interviewCopilot.knowledge.renameBase(base.id, name); if (updated) setKnowledgeBases((current) => current.map((item) => item.id === updated.id ? updated : item)); } }}>重命名</button><button className="text-button danger-text" onClick={async () => { const confirmed = await requestDialog({ kind: "confirm", title: `删除 ${base.name}？`, description: "知识库和其中的文档会一起删除。", confirmLabel: "删除" }); if (confirmed === true) { await window.interviewCopilot.knowledge.deleteBase(base.id); const next = await window.interviewCopilot.knowledge.listBases(); setKnowledgeBases(next); setKnowledgeBaseId(next[0]?.id ?? ""); } }}>删除</button></span></div>)}</div><label className="upload-document">＋ 导入 PDF / DOCX / TXT / MD / GitHub ZIP<input type="file" accept=".txt,.md,.pdf,.docx,.zip" onChange={(event) => void uploadKnowledge(event)} /></label><div className="clean-list document-list">{knowledgeDocuments.map((document) => <div className="clean-list-row" key={document.id}><span>{document.filename}</span><span className="row-actions"><small>{document.status}{document.error ? ` · ${document.error}` : ""}</small><button className="text-button" onClick={() => void window.interviewCopilot.knowledge.reindex(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>重建索引</button><button className="text-button danger-text" onClick={() => void window.interviewCopilot.knowledge.delete(document.id).then(() => window.interviewCopilot.knowledge.listDocuments(knowledgeBaseId)).then(setKnowledgeDocuments)}>删除</button></span></div>)}</div></section>;
    if (page === "history") return <HistoryPage records={historyRecords} search={historySearch} onSearch={setHistorySearch} detail={historyDetail} metrics={historyMetrics} onSelect={async (recordId) => { const [metrics, detail] = await Promise.all([window.interviewCopilot.history.analyze(recordId), window.interviewCopilot.history.get(recordId)]); if (metrics) setHistoryMetrics({ id: recordId, ...metrics }); if (detail) setHistoryDetail(detail as HistoryDetail); }} onExport={async (recordId) => { try { const result = await window.interviewCopilot.history.export(recordId); if (!result.canceled && result.path) store.setNotice(`面试记录已导出：${result.path}`); } catch (error) { store.setNotice(`导出失败：${userFacingError(error)}`); } }} onDelete={async (recordId) => { const confirmed = await requestDialog({ kind: "confirm", title: "删除这场面试记录？", description: "这会同时删除该场面试的转写、识别问题和 AI 回答，操作无法撤销。", confirmLabel: "删除记录" }); if (confirmed !== true) return; await window.interviewCopilot.history.delete(recordId); setHistoryRecords((current) => current.filter((record) => record.id !== recordId)); if (historyDetail?.interview.id === recordId) { setHistoryDetail(undefined); setHistoryMetrics(undefined); } store.setNotice("面试记录已删除"); }} />;
    return <section className="simple-page settings-page"><div className="page-heading"><div><span className="page-kicker">SETTINGS</span><h1>设置</h1></div><button className="dark-pill" onClick={() => void saveProviderSettings()}>保存设置</button></div><div className="settings-columns"><div><h2>LLM Provider</h2><label className="clean-field"><span>Provider Name</span><input value={llmProviderName} onChange={(event) => setLlmProviderName(event.target.value)} /></label><label className="clean-field"><span>Base URL</span><input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} /></label><label className="clean-field"><span>API Key {providerSettings?.llm.hasApiKey && <em className="configured-label">已配置 · 仅输入修改</em>}</span><input type="password" value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} placeholder={providerSettings?.llm.hasApiKey ? "••••••••••••" : "输入 API Key"} /></label><div className="model-grid"><label className="clean-field"><span>默认 Model</span><input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} /></label><label className="clean-field"><span>FAST Model</span><input value={fastModel} onChange={(event) => setFastModel(event.target.value)} /></label><label className="clean-field"><span>NORMAL Model</span><input value={normalModel} onChange={(event) => setNormalModel(event.target.value)} /></label><label className="clean-field"><span>DEEP Model</span><input value={deepModel} onChange={(event) => setDeepModel(event.target.value)} /></label><label className="clean-field"><span>Vision Model</span><input value={visionModel} onChange={(event) => setVisionModel(event.target.value)} /></label></div><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("llm")}>测试连接</button><span className="provider-status">{providerTests.llm ?? (providerSettings?.llm.hasApiKey ? "已配置 · 未测试" : "未配置")}</span></div><h2 className="settings-section-gap">Embedding</h2><label className="clean-field"><span>Base URL</span><input value={embeddingBaseUrl} onChange={(event) => setEmbeddingBaseUrl(event.target.value)} /></label><label className="clean-field"><span>API Key {providerSettings?.embedding.hasApiKey && <em className="configured-label">已配置 · 仅输入修改</em>}</span><input type="password" value={embeddingApiKey} onChange={(event) => setEmbeddingApiKey(event.target.value)} placeholder={providerSettings?.embedding.hasApiKey ? "••••••••••••" : "可选，未配置时使用 Keyword Retrieval"} /></label><label className="clean-field"><span>Embedding Model</span><input value={embeddingModel} onChange={(event) => setEmbeddingModel(event.target.value)} /></label><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("embedding")}>测试连接</button><span className="provider-status">{providerTests.embedding ?? (providerSettings?.embedding.hasApiKey ? "已配置 · 未测试" : "Keyword Retrieval")}</span></div></div><div><h2>ASR Provider</h2><label className="clean-field"><span>Provider</span><select value={asrProviderType} onChange={(event) => { const next = event.target.value as AsrProviderType; setAsrProviderType(next); setProviderTests((current) => ({ ...current, asr: "配置已更改 · 请重新测试" })); if (next === "qwen") { setAsrBaseUrl(QWEN_REALTIME_ASR_URL); setAsrModel(QWEN_REALTIME_ASR_MODEL); } else if (next === "deepgram") { setAsrBaseUrl("wss://api.deepgram.com/v1/listen"); setAsrModel("nova-3"); } else if (next === "funasr-local") { setAsrBaseUrl("ws://127.0.0.1:8765"); setAsrModel("funasr-nano:q8"); } }}><option value="deepgram">Deepgram Cloud</option><option value="qwen">Qwen Direct（千问）</option><option value="custom-gateway">Custom Gateway</option><option value="funasr-local">Local Fun-ASR-Nano</option></select></label><label className="clean-field"><span>{asrProviderType === "qwen" ? "千问 API Key" : asrProviderType === "deepgram" ? "Deepgram API Key" : asrProviderType === "funasr-local" ? "本地服务无需 API Key" : "Token / Ticket（可选）"} {providerSettings?.asr.hasApiKey && <em className="configured-label">已配置</em>}</span><input type="password" value={asrApiKey} onChange={(event) => setAsrApiKey(event.target.value)} placeholder={asrProviderType === "funasr-local" ? "本地服务无需填写" : providerSettings?.asr.hasApiKey ? "••••••••••••" : "输入 API Key"} disabled={asrProviderType === "funasr-local"} /></label><label className="clean-field"><span>{asrProviderType === "custom-gateway" ? "Gateway WebSocket URL" : asrProviderType === "funasr-local" ? "Local ASR Server" : "WebSocket URL"}</span><input value={asrBaseUrl} onChange={(event) => setAsrBaseUrl(event.target.value)} /></label><label className="clean-field"><span>Model {asrProviderType === "qwen" ? "· 官方实时模型：qwen3-asr-flash-realtime" : ""}</span><input value={asrModel} onChange={(event) => setAsrModel(event.target.value)} /></label><label className="clean-field"><span>Language</span><select value={asrLanguage} onChange={(event) => setAsrLanguage(event.target.value as typeof asrLanguage)}><option value="zh-CN">zh-CN</option><option value="en-US">en-US</option><option value="multi">multi</option></select></label><div className="provider-actions"><button className="outline-pill" onClick={() => void testProvider("asr")}>测试连接</button><span className="provider-status">{providerTests.asr ?? (asrProviderType === "funasr-local" ? "本地服务 · 未测试" : providerSettings?.asr.hasApiKey ? "已配置 · 未测试" : "未配置")}</span></div><h2 className="settings-section-gap">回答模式</h2><label className="clean-field"><span>默认模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><div className="rag-status"><strong>RAG Mode</strong><span>{providerSettings?.embedding.hasApiKey ? "Hybrid · Vector + Keyword" : "Keyword Retrieval"}</span></div><details className="advanced-settings"><summary>高级诊断</summary><p>设备列表、Audio Probe 和 Realtime 状态在开始面试设置中显示。</p></details></div></div></section>;
  })();

  const pageTitle = page === "home" ? "工作台" : page === "interview" ? "实时面试" : page === "preparation" ? "面试准备" : page === "profiles" ? "面试档案" : page === "project-library" ? "项目详情" : page === "knowledge" ? "资料库" : page === "personal-memory" ? "项目知识审核" : page === "question-bank" ? "通用题库" : page === "job-targets" ? "岗位要求" : page === "history" ? "面试历史" : "设置";
  if (isOverlay) return <OverlayRoot surface={overlaySurface} mic={store.mic} system={store.system} state={store.state} sessionState={store.sessionState} realtimeState={store.realtimeState} operationMode={store.operationMode} overlayMode={store.overlayMode} hudState={store.hudState} automationMode={store.automationMode} answerMode={store.answerMode} question={store.question} answerText={store.answerText} answerStreaming={store.answerStreaming} questionGroups={store.questionGroups} activeQuestionGroupId={store.activeQuestionGroupId} answerThreads={store.answerThreads} captureProtectionEnabled={captureProtection.requested} captureProtectionSupported={captureProtection.supported} captureProtectionOsFlagApplied={captureProtection.osFlagApplied} captureProtectionDisplayVerified={captureProtection.displayCaptureVerified} captureProtectionLastError={captureProtection.lastError} captureTest={captureTest} onToggleCaptureProtection={() => void toggleCaptureProtection(!captureProtection.requested)} onToggleMode={() => void window.interviewCopilot.overlay.setMode(store.overlayMode === "interactive" ? "passive" : "interactive")} onToggleAutomation={toggleAutomation} onAnswerLatest={() => window.interviewCopilot.interview.answerLatest().catch((error) => { store.setNotice(`回答最新问题失败：${userFacingError(error)}`); })} onAnswerScreenshot={async () => { try { await (store.writtenTestRunning ? window.interviewCopilot.writtenTest.answerScreenshot() : window.interviewCopilot.interview.answerScreenshot()); } catch (error) { store.setNotice(`截图失败：${userFacingError(error)}`); } }} onEndInterview={() => store.writtenTestRunning ? window.interviewCopilot.writtenTest.stop().then(() => undefined) : window.interviewCopilot.interview.stop()} onHideAll={() => void window.interviewCopilot.overlay.hideAll()} onShowAll={() => void window.interviewCopilot.overlay.showAll()} onTogglePanels={() => void window.interviewCopilot.overlay.toggleAll()} onToggleTranscript={() => void window.interviewCopilot.overlay.toggleTranscript()} onToggleAnswer={() => void window.interviewCopilot.overlay.toggleAnswer()} onToggleShortcuts={() => void window.interviewCopilot.overlay.toggleShortcuts()} onRequestEndInterview={() => void window.interviewCopilot.overlay.requestEndInterview()} onToggleShare={() => void window.interviewCopilot.overlay.toggleShareMode()} />;

  return (
    <main className="app-shell modern-shell">
      <Sidebar page={page} profileName={selectedProfile?.name} projects={projects} conversations={conversations} onNavigate={setPage} onNewConversation={beginNewConversation} onOpenConversation={(conversationId) => void openConversation(conversationId)} onOpenProject={(projectId) => { if (page === "project-library") { setSelectedProjectId(projectId); } else { void openProject(projectId); } }} onRenameProject={(projectId, name) => void renameProject(projectId, name)} onDeleteProject={(projectId, name) => void deleteProject(projectId, name)} />
      <section className="content-shell">
        <div className="modern-topbar"><div className="topbar-context"><span className="topbar-breadcrumb">{page === "project-library" ? "项目库" : "Interview Copilot"}</span><span className="topbar-slash">/</span><strong>{page === "project-library" ? "项目详情" : pageTitle}</strong></div><div className="topbar-actions"><span className="topbar-profile">{selectedProfile ? `当前档案 · ${selectedProfile.name}` : "未选择面试档案"}</span>{page === "project-library" && <button className="topbar-settings-button" aria-label="项目库设置" onClick={() => setPage("settings")}>⚙</button>}<button className="dark-pill start-interview" onClick={() => setSetupOpen(true)}>开始面试 <span>↗</span></button></div></div>
        <div className="modern-main">
          {page === "interview" && <section className="interview-context-panel"><div><span className="page-kicker">ANSWER CONTEXT</span><strong>本轮回答上下文</strong><small>未选择时，系统会根据面试问题自动识别项目和岗位。</small></div><label className="clean-field"><span>目标岗位</span><select value={interviewJobTargetId} onChange={(event) => setInterviewJobTargetId(event.target.value)}><option value="">自动使用当前岗位</option>{jobTargets.map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label><label className="clean-field"><span>重点项目</span><select value={interviewProjectId} onChange={(event) => setInterviewProjectId(event.target.value)}><option value="">根据问题自动识别</option>{projectMemory?.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></section>}
          {page === "settings" && <LlmModelProfilesPanel profiles={llmProfiles} activeId={activeLlmProfileId} selectedId={llmProfileId} name={llmProfileName} onNameChange={setLlmProfileName} onSelect={selectLlmProfile} onActivate={() => void activateLlmProfile(llmProfileId)} onNew={startNewLlmProfile} onDelete={() => void deleteLlmProfile()} />}
          <PageErrorBoundary page={page}>{modernPageContent}</PageErrorBoundary>
          {page === "home" && <ChatResponseSupplement messages={chatMessages} onApproveAction={approveChatAction} />}
          {page === "settings" && <TaskModelRoutingPanel values={{ fallbackModel, questionRecognitionModel, profileBuilderModel, projectAnalyzerModel, questionBankModel, chatModel, postInterviewModel, preparationModel }} onChange={(key, value) => { const setters: Record<TaskModelKey, (next: string) => void> = { fallbackModel: setFallbackModel, questionRecognitionModel: setQuestionRecognitionModel, profileBuilderModel: setProfileBuilderModel, projectAnalyzerModel: setProjectAnalyzerModel, questionBankModel: setQuestionBankModel, chatModel: setChatModel, postInterviewModel: setPostInterviewModel, preparationModel: setPreparationModel }; setters[key](value); }} />}
          {page === "settings" && <CaptureProtectionSettings status={captureProtection} onToggle={(enabled) => void toggleCaptureProtection(enabled)} />}
        </div>
        {(page === "home" || page === "interview") && <><div className="chat-context-capsules chat-context-capsules-composer"><span>档案：{selectedProfile?.name ?? "未选择"}</span><span>项目：{selectedProjectId ? projects.find((project) => project.id === selectedProjectId)?.name ?? "当前项目" : "自动"}</span><span>知识：自动检索</span><span>事实策略：仅已确认</span></div><ChatComposer value={composerText} onChange={setComposerText} onSubmit={() => void submitComposer()} onCreateProject={() => void createProject()} /></>}
        {store.notice && <button className="notice-toast" onClick={() => store.setNotice(undefined)}>{store.notice} <span>×</span></button>}
      </section>
      {dialog && <AppDialog dialog={dialog} onConfirm={(value) => closeDialog(dialog.kind === "confirm" ? true : value)} onCancel={() => closeDialog(undefined)} />}
      {setupOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetupOpen(false); }}><section className="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title"><header><div><span className="page-kicker">INTERVIEW SETUP</span><h2 id="setup-title">开始面试</h2></div><button onClick={() => setSetupOpen(false)} aria-label="关闭">×</button></header><label className="clean-field"><span>面试档案</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label><label className="clean-field"><span>回答模式</span><select value={answerMode} onChange={(event) => setAnswerMode(event.target.value as typeof answerMode)}><option value="FAST">FAST · 快速</option><option value="NORMAL">NORMAL · 平衡</option><option value="DEEP">DEEP · 深度</option></select></label><label className="clean-field"><span>自动回答</span><select value={store.automationMode} onChange={(event) => void window.interviewCopilot.interview.setAutomationMode(event.target.value as "AUTO" | "MANUAL")}><option value="AUTO">AUTO · 听到问题后自动回答</option><option value="MANUAL">MANUAL · 手动触发回答</option></select></label><label className="clean-field"><span>麦克风输入</span><select value={inputDeviceId} onChange={(event) => { setInputDeviceId(event.target.value); persistDevice("interview-copilot.input-device", event.target.value); }}><option value="">自动选择（推荐）</option>{devices.inputs.length === 0 && <option value="" disabled>没有检测到输入设备</option>}{devices.inputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><label className="clean-field"><span>系统音频 / Loopback</span><select value={outputDeviceId} onChange={(event) => { setOutputDeviceId(event.target.value); persistDevice("interview-copilot.output-device", event.target.value); }}><option value="">自动选择（推荐）</option>{devices.outputs.length === 0 && <option value="" disabled>没有检测到系统音频设备</option>}{devices.outputs.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select></label><div className="probe-summary"><span>MIC <b className={audioChannelAvailable(store.capability?.mic ?? store.probeResult?.mic) ? "probe-ok" : "probe-fail"}>{audioChannelLabel(store.capability?.mic ?? store.probeResult?.mic)}</b></span><span>SYSTEM <b className={audioChannelAvailable(store.capability?.system ?? store.probeResult?.system) ? "probe-ok" : "probe-fail"}>{audioChannelLabel(store.capability?.system ?? store.probeResult?.system)}</b></span><button className="outline-pill" disabled={probing} onClick={() => void probeAudio()}>{probing ? "测试中…" : "可选：测试音频"}</button><button className="text-button" onClick={() => void copyAudioDiagnostics()}>复制诊断</button></div><small className="page-note">音频测试仅用于诊断，不是开始面试的前置条件。若一个声道不可用，系统会自动以 system_only 或 mic_only 模式继续，并在 PCM 缺失声道补零。</small><div className="setup-preflight"><span>LLM · {providerSettings?.llm.hasApiKey ? "✓ 已配置" : "✕ 未配置"}</span><span>ASR · {asrProviderType === "funasr-local" ? "✓ 本地服务自动启动" : providerSettings?.asr.hasApiKey || asrProviderType === "custom-gateway" ? "✓ 已配置" : "✕ 未配置"}</span><span>Profile · {selectedProfile ? "✓" : "✕"}</span></div><footer><button className="outline-pill" onClick={() => setSetupOpen(false)}>取消</button><button className="dark-pill" onClick={() => void startInterview()}>开始面试</button></footer></section></div>}
    </main>
  );

}
