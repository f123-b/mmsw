import type { AnswerProvider, ProjectAnalysisJob, ProjectComprehensionModel, ProjectMemoryAnalysisInput, ProjectMemoryModel, ProjectMemorySource, ProjectMemorySnapshot, ProjectSourceRole, ProjectSourceAssignmentMethod, ProjectMaterialImportFile, ProjectMaterialImportReport } from "@interview-copilot/shared";
import { analyzeCodeFile, chunkText, extractResumeProjectSections, inferProjectSourceRole, languageForFilename, parseMarkdownProjectDocument, ProjectAnalyzerAgent as ProjectAnalyzerAgentClass, PROJECT_COMPREHENSION_SYSTEM_PROMPT, resolveProjectAssignment } from "@interview-copilot/shared";
import { createHash } from "node:crypto";
import { SqliteInterviewHistoryRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectAnalysisJobRepository, SqliteProjectMemoryRepository } from "./database";
import { isZipBytes, normalizeDocumentBytes, parseDocument } from "./document-parsers";
import { parseRepositoryArchiveInWorker } from "./repository-import-worker-client";

async function parsedDocumentChunks(parsed: Awaited<ReturnType<typeof parseDocument>>, projectId: string): Promise<ReturnType<typeof chunkText>> {
  if (!parsed.repositoryFiles?.length) return chunkText(parsed.text, { documentId: parsed.documentId, filename: parsed.filename, documentType: "project", projectId, scope: "project" });
  const chunks: ReturnType<typeof chunkText> = [];
  for (const [index, file] of parsed.repositoryFiles.entries()) {
    if (index > 0 && index % 4 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    // repositoryFiles is the complete source of truth. The retrieval index is
    // intentionally bounded so a large archive cannot duplicate tens of MB of
    // text into thousands of synchronous chunks during the import IPC call.
    const indexedText = file.text.slice(0, 16_000);
    chunks.push(...chunkText(indexedText, { documentId: parsed.documentId, filename: file.path, documentType: "project", projectId, scope: "project", repositoryPath: file.path, sourceId: parsed.documentId, language: file.language, kind: file.kind }).map((chunk, chunkIndex) => ({ ...chunk, id: `${parsed.documentId}-${createHash("sha256").update(file.path).digest("hex").slice(0, 12)}-${chunkIndex}` })));
  }
  return chunks;
}

function projectSourceFromDocument(document: ReturnType<SqliteKnowledgeRepository["getDocument"]>, projectName: string, sourceRole?: ProjectSourceRole, repositoryFiles?: NonNullable<ProjectMemorySource["repositoryFiles"]>): ProjectMemorySource | undefined {
  if (!document || document.status !== "ready") return undefined;
  const isRepository = Boolean(document.repositoryFiles?.length || document.mimeType === "application/zip" || /\.zip$/i.test(document.filename));
  const language = languageForFilename(document.filename);
  const code = isRepository ? undefined : language === "unknown" ? undefined : analyzeCodeFile({ filePath: document.filename, text: document.text, language });
  const codeSummary = code ? `\n代码分析：模块 ${code.modules.map((item) => item.name).join("、") || "未识别"}；函数 ${code.functions.map((item) => item.name).join("、") || "未识别"}；关键词 ${code.keywords.join("、")}` : "";
  return { id: document.id, kind: isRepository ? "repository" : "project-document", sourceType: isRepository ? "repository" : "document", title: document.filename, projectName, text: `${document.text}${codeSummary}`, ...(isRepository ? { repositoryFiles: repositoryFiles ?? document.repositoryFiles, repositoryManifest: document.repositoryManifest, repositorySkippedFiles: document.repositorySkippedFiles } : {}), language, updatedAt: document.updatedAt, ...(sourceRole ? { sourceRole } : {}) } as ProjectMemorySource & { sourceRole?: ProjectSourceRole };
}

export class ProjectMemoryService {
  private readonly pending = new Map<string, Promise<ProjectMemorySnapshot>>();
  private readonly analysisJobs = new Map<string, { job: ProjectAnalysisJob; controller: AbortController }>();
  private readonly analysisQueue: string[] = [];
  private analysisQueueRunning = false;

  constructor(
    private readonly profiles: SqliteProfileRepository,
    private readonly knowledge: SqliteKnowledgeRepository,
    private readonly history: SqliteInterviewHistoryRepository,
    private readonly memories: SqliteProjectMemoryRepository,
    private readonly model?: ProjectMemoryModel,
    private readonly onUpdated?: (profileId: string, projectId?: string) => void,
    private readonly analysisRuns?: SqliteKnowledgeAnalysisRepository,
    private readonly embedFacts?: (profileId: string, projectId?: string, signal?: AbortSignal) => Promise<void>,
    private readonly onTrace?: (event: string, fields: Record<string, unknown>) => void,
    private readonly comprehensionModel?: ProjectComprehensionModel,
    private readonly comprehensionEnabled: boolean = process.env.INTERVIEW_COPILOT_PROJECT_COMPREHENSION !== "0",
    private readonly analysisJobRepository?: SqliteProjectAnalysisJobRepository,
    private readonly onAnalysisJobUpdated?: (job: ProjectAnalysisJob) => void
  ) {}

  get(profileId: string): ProjectMemorySnapshot { return this.memories.getSnapshot(profileId); }

  /** Rebuilds each project independently. No profile-wide analyzer prompt exists anymore. */
  async rebuild(profileId: string): Promise<ProjectMemorySnapshot> {
    const existing = this.pending.get(`profile:${profileId}`);
    if (existing) return existing;
    const task = this.rebuildProfile(profileId).finally(() => this.pending.delete(`profile:${profileId}`));
    this.pending.set(`profile:${profileId}`, task);
    return task;
  }

  async rebuildProfile(profileId: string): Promise<ProjectMemorySnapshot> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    await this.ensureProjectAssignments(profileId);
    for (const project of this.memories.listProjects(profileId)) {
      if (this.memories.listProjectSources(project.id).length > 0) await this.rebuildProject(project.id);
    }
    return this.memories.getSnapshot(profileId);
  }

  async rebuildProject(projectId: string): Promise<ProjectMemorySnapshot> {
    const existing = this.pending.get(`project:${projectId}`);
    if (existing) return existing;
    const task = this.buildProject(projectId).finally(() => this.pending.delete(`project:${projectId}`));
    this.pending.set(`project:${projectId}`, task);
    return task;
  }

  getProjectAnalysisJob(projectId: string): ProjectAnalysisJob | undefined {
    const active = [...this.analysisJobs.values()].find((entry) => entry.job.projectId === projectId);
    return active?.job ?? this.analysisJobRepository?.latestForProject(projectId);
  }

  listProjectAnalysisJobs(profileId: string): ProjectAnalysisJob[] { return this.analysisJobRepository?.list(profileId) ?? [...this.analysisJobs.values()].filter((entry) => entry.job.profileId === profileId).map((entry) => entry.job); }

  queueProjectAnalysis(profileId: string, projectId: string): ProjectAnalysisJob {
    const project = this.memories.getProject(projectId);
    if (!project || project.profileId !== profileId) throw new Error("PROJECT_NOT_FOUND");
    const existing = [...this.analysisJobs.values()].find((entry) => entry.job.projectId === projectId && !["completed", "failed", "cancelled"].includes(entry.job.status));
    if (existing) return existing.job;
    const filesTotal = this.memories.listProjectSources(projectId).filter((source) => source.sourceType === "repository").reduce((total, source) => total + (this.knowledge.getRepositoryManifest(source.sourceId).manifest?.eligibleFileCount ?? 0), 0);
    const now = Date.now();
    const job: ProjectAnalysisJob = { id: `project-analysis-job-${projectId}-${now}-${Math.random().toString(36).slice(2, 8)}`, profileId, projectId, status: "queued", stage: "queued", createdAt: now, updatedAt: now, progress: 0, filesTotal, filesExplored: 0, toolCalls: 0, modelTurns: 0, cancelRequested: false };
    this.analysisJobs.set(job.id, { job, controller: new AbortController() });
    this.analysisJobRepository?.save(job);
    this.onAnalysisJobUpdated?.(job);
    this.onTrace?.("PROJECT_ANALYSIS_QUEUED", { jobId: job.id, projectId, filesTotal });
    this.analysisQueue.push(job.id);
    void this.drainAnalysisQueue();
    return job;
  }

  cancelProjectAnalysis(projectId: string, jobId?: string): ProjectAnalysisJob | undefined {
    const entry = jobId ? this.analysisJobs.get(jobId) : [...this.analysisJobs.values()].find((candidate) => candidate.job.projectId === projectId);
    if (!entry) return this.getProjectAnalysisJob(projectId);
    entry.job.cancelRequested = true;
    if (entry.job.status === "queued") {
      entry.job.status = "cancelled"; entry.job.stage = "cancelled"; entry.job.progress = 0; entry.job.finishedAt = Date.now();
    } else entry.controller.abort();
    this.persistJob(entry.job);
    if (entry.job.status === "cancelled") this.onTrace?.("PROJECT_ANALYSIS_CANCELLED", { jobId: entry.job.id, projectId });
    return entry.job;
  }

  retryProjectAnalysis(profileId: string, projectId: string): ProjectAnalysisJob {
    const existing = this.getProjectAnalysisJob(projectId);
    if (existing && !["completed", "failed", "cancelled"].includes(existing.status)) throw new Error("ANALYSIS_ALREADY_RUNNING");
    return this.queueProjectAnalysis(profileId, projectId);
  }

  cancelAllAnalysisJobs(): void {
    for (const entry of this.analysisJobs.values()) {
      if (["completed", "failed", "cancelled"].includes(entry.job.status)) continue;
      entry.job.cancelRequested = true;
      entry.controller.abort();
      entry.job.status = "cancelled";
      entry.job.stage = "cancelled";
      entry.job.finishedAt = Date.now();
      this.persistJob(entry.job);
    }
    this.analysisQueue.length = 0;
  }

  private persistJob(job: ProjectAnalysisJob): void {
    job.updatedAt = Date.now();
    this.analysisJobRepository?.save(job);
    this.onAnalysisJobUpdated?.({ ...job });
  }

  private async drainAnalysisQueue(): Promise<void> {
    if (this.analysisQueueRunning) return;
    this.analysisQueueRunning = true;
    try {
      while (this.analysisQueue.length > 0) {
        const jobId = this.analysisQueue.shift();
        const entry = jobId ? this.analysisJobs.get(jobId) : undefined;
        if (!entry || entry.job.status === "cancelled") continue;
        await this.runAnalysisJob(entry);
      }
    } finally { this.analysisQueueRunning = false; }
  }

  private async runAnalysisJob(entry: { job: ProjectAnalysisJob; controller: AbortController }): Promise<void> {
    const { job, controller } = entry;
    job.status = "mapping"; job.stage = "mapping"; job.startedAt = Date.now(); job.progress = 0.05;
    this.persistJob(job);
    this.onTrace?.("PROJECT_ANALYSIS_STARTED", { jobId: job.id, projectId: job.projectId });
    try {
      await this.buildProject(job.projectId, { signal: controller.signal, onTrace: (event, fields) => {
        if (event === "PROJECT_REPO_MAPPED") { job.status = "mapping"; job.stage = "mapping"; job.filesTotal = Number(fields.files ?? job.filesTotal); job.progress = 0.12; }
        else if (event === "PROJECT_TOOL_CALL") { job.status = "exploring"; job.stage = "exploring"; job.filesExplored = Number(fields.filesRead ?? job.filesExplored); job.toolCalls = Number(fields.toolCalls ?? job.toolCalls); job.modelTurns = Number(fields.modelTurns ?? job.modelTurns); job.progress = Math.min(0.78, 0.15 + (job.filesTotal ? job.filesExplored / job.filesTotal * 0.55 : 0.15)); }
        else if (event === "PROJECT_SYNTHESIS_COMPLETED") { job.status = "synthesizing"; job.stage = "synthesizing"; job.progress = 0.82; }
        else if (event === "PROJECT_GROUNDING_COMPLETED") { job.status = "grounding"; job.stage = "grounding"; job.progress = 0.94; }
        this.persistJob(job);
        this.onTrace?.(event, { ...fields, jobId: job.id });
      } });
      if (controller.signal.aborted || job.cancelRequested) throw new Error("PROJECT_ANALYSIS_CANCELLED");
      job.status = "completed"; job.stage = "completed"; job.progress = 1; job.finishedAt = Date.now();
      this.persistJob(job);
      this.onTrace?.("PROJECT_ANALYSIS_COMPLETED", { jobId: job.id, projectId: job.projectId, filesExplored: job.filesExplored, toolCalls: job.toolCalls, modelTurns: job.modelTurns });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = controller.signal.aborted || job.cancelRequested || message.includes("PROJECT_ANALYSIS_CANCELLED");
      job.status = cancelled ? "cancelled" : "failed"; job.stage = cancelled ? "cancelled" : "failed"; job.finishedAt = Date.now(); job.errorCode = cancelled ? "PROJECT_ANALYSIS_CANCELLED" : message.split(":")[0] || "PROJECT_ANALYSIS_FAILED"; job.errorMessage = message;
      this.persistJob(job);
      this.onTrace?.(cancelled ? "PROJECT_ANALYSIS_CANCELLED" : "PROJECT_ANALYSIS_FAILED", { jobId: job.id, projectId: job.projectId, errorCode: job.errorCode, error: message });
    }
  }

  /** Binds a ready project document before analysis. Ambiguous input is never silently attached. */
  assignDocument(profileId: string, documentId: string, explicitProjectId?: string, sourceRole?: ProjectSourceRole): { status: "assigned" | "needs_assignment"; projectId?: string; confidence: number; message: string } {
    const document = this.knowledge.getDocument(documentId, { includeRepositoryFiles: false });
    if (!document) throw new Error(`Knowledge document not found: ${documentId}`);
    if (document.documentType === "resume") return { status: "needs_assignment", confidence: 0, message: "RESUME_MUST_BE_SPLIT：整份 Resume 不能直接绑定为项目资料" };
    if (document.documentType !== "project" && document.documentType !== "technical-doc") return { status: "needs_assignment", confidence: 0, message: "PROJECT_SOURCE_TYPE_UNSUPPORTED：只有项目资料或明确绑定的技术文档可进入项目分析" };
    const resolvedSourceRole = sourceRole ?? inferProjectSourceRole(document.filename, document.text);
    const isRepository = Boolean(document.repositoryFiles?.length || document.mimeType === "application/zip" || /\.zip$/i.test(document.filename));
    const source: ProjectMemorySource = { id: document.id, kind: isRepository ? "repository" : "project-document", sourceType: isRepository ? "repository" : "document", sourceRole: resolvedSourceRole, title: document.filename, text: document.text, ...(isRepository ? { repositoryFiles: document.repositoryFiles, repositoryManifest: document.repositoryManifest, repositorySkippedFiles: document.repositorySkippedFiles } : {}), updatedAt: document.updatedAt };
    const projects = this.memories.listProjects(profileId);
    const assignment = resolveProjectAssignment(source, projects, explicitProjectId);
    const projectId = assignment.projectId;
    if (!projectId) return { status: "needs_assignment", confidence: assignment.confidence, message: "NEEDS_PROJECT_ASSIGNMENT：请选择该资料属于哪个项目" };
    this.memories.assignSource({ projectId, sourceType: isRepository ? "repository" : "document", sourceId: documentId, relationship: resolvedSourceRole === "reference" ? "reference" : "primary", confidence: assignment.confidence, verified: Boolean(explicitProjectId), sourceRole: resolvedSourceRole, assignmentMethod: explicitProjectId ? "explicit" : "matched" });
    return { status: "assigned", projectId, confidence: assignment.confidence, message: "项目资料已绑定" };
  }

  assignSource(input: { profileId: string; projectId: string; sourceType: "document" | "repository" | "resume_section" | "user_fact"; sourceId: string; relationship?: "primary" | "supporting" | "reference"; sourceRole?: ProjectSourceRole; assignmentMethod?: ProjectSourceAssignmentMethod; confidence?: number; verified?: boolean }): void {
    const project = this.memories.getProject(input.projectId);
    if (!project || project.profileId !== input.profileId) throw new Error("PROJECT_NOT_FOUND");
    this.memories.assignSource({ projectId: input.projectId, sourceType: input.sourceType, sourceId: input.sourceId, relationship: input.relationship ?? (input.sourceRole === "reference" ? "reference" : "supporting"), sourceRole: input.sourceRole ?? "other", assignmentMethod: input.assignmentMethod ?? "explicit", confidence: input.confidence ?? 1, verified: input.verified ?? true });
  }

  /**
   * Imports a set of project materials without refreshing or rebuilding per
   * file. Each file is isolated so one parser failure does not discard the
   * successfully saved and assigned materials.
   */
  async importProjectMaterials(input: { profileId: string; projectId: string; knowledgeBaseId: string; files: ProjectMaterialImportFile[] }): Promise<ProjectMaterialImportReport> {
    const profile = this.profiles.get(input.profileId);
    if (!profile) throw new Error("PROFILE_NOT_FOUND");
    const project = this.memories.getProject(input.projectId);
    if (!project || project.profileId !== input.profileId) throw new Error("PROJECT_NOT_FOUND");
    if (!this.knowledge.listKnowledgeBases().some((base) => base.id === input.knowledgeBaseId)) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");

    const imported: ProjectMaterialImportReport["imported"] = [];
    let repositoryReport: ProjectMaterialImportReport["repository"];
    for (const [index, file] of input.files.entries()) {
      const documentId = `document-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
      let bytes: Uint8Array;
      try {
        bytes = normalizeDocumentBytes(file.bytes);
      } catch (error) {
        imported.push({ filename: file.filename, sourceRole: inferProjectSourceRole(file.filename), status: "failed", assignmentStatus: "failed", error: String(error) });
        continue;
      }
      const requestedRole = file.sourceRole && file.sourceRole !== "auto" ? file.sourceRole : undefined;
      const isRepositoryArchive = /^application\/(?:x-)?zip$/i.test(file.mimeType || "") || /\.zip$/i.test(file.filename) || isZipBytes(bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const duplicate = isRepositoryArchive ? this.knowledge.findDocumentBySha256(sha256, input.knowledgeBaseId) : undefined;
      if (duplicate?.status === "ready" && duplicate.repositoryManifest) {
        const sourceRole = requestedRole ?? inferProjectSourceRole(duplicate.filename, duplicate.text);
        try {
          const assignment = this.assignDocument(input.profileId, duplicate.id, input.projectId, sourceRole);
          repositoryReport = { ...duplicate.repositoryManifest, documentId: duplicate.id, duplicate: true };
          imported.push({ documentId: duplicate.id, filename: file.filename, sourceRole, status: "ready", assignmentStatus: assignment.status === "assigned" ? "assigned" : "needs_assignment", duplicate: true, ...(assignment.status === "needs_assignment" ? { error: assignment.message } : {}) });
          this.onTrace?.("PROJECT_REPOSITORY_DUPLICATE", { projectId: input.projectId, documentId: duplicate.id, archiveSha256: sha256 });
          continue;
        } catch (error) {
          imported.push({ documentId: duplicate.id, filename: file.filename, sourceRole, status: "failed", assignmentStatus: "failed", duplicate: true, error: String(error) });
          continue;
        }
      }
      let parsed: Awaited<ReturnType<typeof parseDocument>>;
      try {
        const mimeType = file.mimeType || "application/octet-stream";
        const parseStartedAt = performance.now();
        this.onTrace?.(isRepositoryArchive ? "PROJECT_ARCHIVE_VALIDATED" : "PROJECT_DOCUMENT_PARSING", { filename: file.filename, archiveBytes: bytes.byteLength });
        parsed = isRepositoryArchive
          ? await parseRepositoryArchiveInWorker({ documentId, filename: file.filename, bytes, onProgress: (progress) => this.onTrace?.("PROJECT_ARCHIVE_PROGRESS", { filename: file.filename, ...progress }) })
          : await parseDocument({ documentId, filename: file.filename, mimeType, bytes });
        this.onTrace?.("PROJECT_REPOSITORY_STAGE_TIMING", { filename: file.filename, stage: "parse", durationMs: performance.now() - parseStartedAt });
      } catch (error) {
        const sourceRole = requestedRole ?? inferProjectSourceRole(file.filename);
        this.knowledge.saveDocument({ id: documentId, knowledgeBaseId: input.knowledgeBaseId, filename: file.filename, mimeType: file.mimeType || "application/octet-stream", sha256, text: "", sections: [], documentType: "project", status: "error", error: String(error) });
        imported.push({ documentId, filename: file.filename, sourceRole, status: "failed", assignmentStatus: "failed", error: String(error) });
        continue;
      }

      const sourceRole = requestedRole ?? inferProjectSourceRole(parsed.filename, parsed.text);
      if (parsed.repositoryManifest) {
        repositoryReport = { ...parsed.repositoryManifest, documentId: parsed.documentId };
        this.onTrace?.("PROJECT_REPOSITORY_INDEXED", { documentId: parsed.documentId, fileCount: parsed.repositoryManifest.eligibleFileCount, skippedFileCount: parsed.repositoryManifest.skippedFileCount, totalSourceBytes: parsed.repositoryManifest.totalSourceBytes });
      }
      const { repositoryFiles: _repositoryFiles, repositoryManifest: _repositoryManifest, repositorySkippedFiles: _repositorySkippedFiles, ...documentFields } = parsed;
      const processing = this.knowledge.saveDocument({ id: parsed.documentId, ...documentFields, knowledgeBaseId: input.knowledgeBaseId, documentType: "project", status: "processing" });
      try {
        const chunkStartedAt = performance.now();
        const chunks = await parsedDocumentChunks(parsed, input.projectId);
        this.onTrace?.("PROJECT_REPOSITORY_STAGE_TIMING", { filename: file.filename, stage: "chunk", durationMs: performance.now() - chunkStartedAt, chunks: chunks.length });
        await this.knowledge.replaceChunksAsync(processing.id, chunks);
        const saveStartedAt = performance.now();
        await this.knowledge.saveDocumentAsync({ id: processing.id, ...parsed, knowledgeBaseId: input.knowledgeBaseId, documentType: "project", status: "ready" }, Date.now(), { includeRepositoryFiles: false, flushDelayMs: 10_000 });
        this.onTrace?.("PROJECT_REPOSITORY_STAGE_TIMING", { filename: file.filename, stage: "persist", durationMs: performance.now() - saveStartedAt });
        if (parsed.repositoryManifest) this.onTrace?.("PROJECT_REPOSITORY_PERSISTED", { documentId: parsed.documentId, fileCount: parsed.repositoryManifest.eligibleFileCount });
      } catch (error) {
        this.knowledge.saveDocument({ id: processing.id, ...parsed, knowledgeBaseId: input.knowledgeBaseId, documentType: "project", status: "error", error: String(error) });
        imported.push({ documentId: processing.id, filename: file.filename, sourceRole, status: "failed", assignmentStatus: "failed", error: String(error) });
        continue;
      }

      try {
        const assignStartedAt = performance.now();
        const assignment = this.assignDocument(input.profileId, processing.id, input.projectId, sourceRole);
        this.onTrace?.("PROJECT_REPOSITORY_STAGE_TIMING", { filename: file.filename, stage: "assign", durationMs: performance.now() - assignStartedAt });
        if (assignment.status === "assigned") { this.onTrace?.("PROJECT_SOURCE_ASSIGNED", { documentId: processing.id, sourceType: parsed.repositoryManifest ? "repository" : "document" }); imported.push({ documentId: processing.id, filename: file.filename, sourceRole, status: "ready", assignmentStatus: "assigned" }); }
        else imported.push({ documentId: processing.id, filename: file.filename, sourceRole, status: "ready", assignmentStatus: "needs_assignment", error: assignment.message });
      } catch (error) {
        imported.push({ documentId: processing.id, filename: file.filename, sourceRole, status: "ready", assignmentStatus: "failed", error: String(error) });
      }
    }

    const assigned = imported.filter((item) => item.assignmentStatus === "assigned").length;
    let rebuild: ProjectMaterialImportReport["rebuild"] = { status: "skipped" };
    let analysisJob: ProjectAnalysisJob | undefined;
    if (assigned > 0) {
      analysisJob = this.queueProjectAnalysis(input.profileId, input.projectId);
      rebuild = { status: "queued", analysisJobId: analysisJob.id };
      this.onTrace?.("PROJECT_IMPORT_COMPLETED", { projectId: input.projectId, assigned });
    }
    return { projectId: input.projectId, imported, rebuild, ...(repositoryReport ? { repository: repositoryReport } : {}), ...(analysisJob ? { analysisJob } : {}), summary: { files: input.files.length, assigned, failed: imported.filter((item) => item.status === "failed" || item.assignmentStatus !== "assigned").length } };
  }

  private async ensureProjectAssignments(profileId: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    for (const project of this.memories.listProjects(profileId)) {
      if (this.memories.listProjectSources(project.id).length > 0) continue;
      for (const sourceId of project.sourceIds) {
        const documentId = sourceId.match(/^memory-document-(.+)$/)?.[1] ?? sourceId.match(/^memory-code-(.+?)-\d+$/)?.[1];
        const legacyDocument = documentId ? this.knowledge.getDocument(documentId) : undefined;
        if (legacyDocument) {
          const sourceRole = inferProjectSourceRole(legacyDocument.filename, legacyDocument.text);
          this.memories.assignSource({ projectId: project.id, sourceType: "document", sourceId: documentId as string, relationship: sourceRole === "reference" ? "reference" : "primary", sourceRole, assignmentMethod: "imported", confidence: project.name === "待确认项目" ? 0.4 : 0.7, verified: false });
        }
      }
    }
    const documents = this.knowledge.listDocuments().filter((document) => profile.knowledgeBaseIds.includes(document.knowledgeBaseId) && document.status === "ready" && document.documentType === "project");
    for (const document of documents) {
      if (this.memories.sourcesFor("document", document.id).some((item) => item.projectId && this.memories.getProject(item.projectId)?.profileId === profileId)) continue;
      const result = this.assignDocument(profileId, document.id);
      if (result.status === "needs_assignment") this.onTrace?.("PROJECT_ASSIGNMENT_REQUIRED", { profileId, documentId: document.id, message: result.message });
    }
    const projects = this.memories.listProjects(profileId);
    if (profile.resume?.rawContent) {
      for (const section of extractResumeProjectSections(profile.resume.rawContent, `resume-section-${profileId}`)) {
        const source: ProjectMemorySource = { id: section.sourceId, kind: "resume-section", sourceType: "resume_section", title: section.projectName, text: section.text, projectName: section.projectName, locator: section.locator, updatedAt: profile.updatedAt };
        const assignment = resolveProjectAssignment(source, projects);
        if (assignment.status === "assigned" && assignment.projectId) this.memories.assignSource({ projectId: assignment.projectId, sourceType: "resume_section", sourceId: `${section.sourceId}:${section.locator}`, relationship: "supporting", sourceRole: "resume", assignmentMethod: "matched", confidence: assignment.confidence, verified: false });
      }
    }
  }

  private async collectSources(profileId: string, project: { id: string; name: string }): Promise<ProjectMemorySource[]> {
    const profile = this.profiles.get(profileId);
    if (!profile) return [];
    const result: ProjectMemorySource[] = [];
    for (const assignment of this.memories.listProjectSources(project.id)) {
      if (assignment.sourceType === "document" || assignment.sourceType === "repository") {
        const document = this.knowledge.getDocument(assignment.sourceId, { includeRepositoryFiles: false });
        const repositoryFiles = assignment.sourceType === "repository" ? await this.loadRepositoryFiles(assignment.sourceId) : undefined;
        const source = projectSourceFromDocument(document, project.name, assignment.sourceRole, repositoryFiles);
        if (source) result.push({ ...source, sourceType: assignment.sourceType, projectId: project.id });
      } else if (assignment.sourceType === "resume_section" && profile.resume?.rawContent) {
        const sections = extractResumeProjectSections(profile.resume.rawContent, `resume-section-${profileId}`);
        const section = sections.find((item) => `${item.sourceId}:${item.locator}` === assignment.sourceId);
        if (section) result.push({ id: assignment.sourceId, kind: "resume-section", sourceType: "resume_section", sourceRole: "resume", projectId: project.id, title: section.projectName, projectName: project.name, text: section.text, locator: section.locator, updatedAt: profile.updatedAt });
      }
    }
    return result.filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index);
  }

  private async loadRepositoryFiles(documentId: string): Promise<NonNullable<ProjectMemorySource["repositoryFiles"]>> {
    const files: NonNullable<ProjectMemorySource["repositoryFiles"]> = [];
    for (let offset = 0; ; offset += 32) {
      const batch = this.knowledge.listRepositoryFiles(documentId, { limit: 32, offset });
      files.push(...batch);
      if (batch.length < 32) return files;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async buildProject(projectId: string, options: { signal?: AbortSignal; onTrace?: (event: string, fields: Record<string, unknown>) => void } = {}): Promise<ProjectMemorySnapshot> {
    const project = this.memories.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const sources = await this.collectSources(project.profileId, project);
    const input: ProjectMemoryAnalysisInput = { profileId: project.profileId, projectId: project.id, projectName: project.name, sources };
    const inputSnapshot = sources.map((source) => ({ id: source.id, kind: source.kind, title: source.title, locator: source.locator, updatedAt: source.updatedAt, contentHash: createHash("sha256").update(source.repositoryManifest?.archiveSha256 ?? source.text).digest("hex"), sourceRevision: source.repositoryManifest?.archiveSha256 }));
    const inputHash = createHash("sha256").update(JSON.stringify(inputSnapshot)).digest("hex");
    const runId = `project-memory-${project.id}-${inputHash.slice(0, 16)}`;
    const previousState = this.analysisRuns?.getProjectState(project.id);
    const snapshotVersion = (previousState?.snapshotVersion ?? 0) + 1;
    this.analysisRuns?.record({ id: runId, profileId: project.profileId, projectId: project.id, runType: "project-memory", inputHash, status: "running", inputSnapshot, snapshotVersion });
    this.analysisRuns?.setProjectState({ projectId: project.id, latestAnalysisId: runId, status: "running", snapshotVersion });
    try {
      const cachedUnderstanding = this.memories.getUnderstandingSnapshot(project.id, inputHash);
      options.signal?.throwIfAborted?.();
      const snapshot = await new ProjectAnalyzerAgentClass(this.model, this.comprehensionModel, (event, fields) => { this.onTrace?.(event, fields); options.onTrace?.(event, fields); }, this.comprehensionEnabled).analyze(input, { cachedUnderstanding: cachedUnderstanding?.understanding, signal: options.signal });
      options.signal?.throwIfAborted?.();
      this.onTrace?.("PROJECT_PARSE_TRACE", { projectId, sourceCount: sources.length, factCount: snapshot.facts?.length ?? 0, moduleCount: snapshot.modules.length, problemCount: snapshot.problems.length, questionCount: snapshot.interviewQuestions.length, sourceIds: sources.map((source) => source.id) });
      this.memories.replaceSnapshot(project.profileId, snapshot, Date.now(), project.id);
      if (snapshot.understanding && !cachedUnderstanding && snapshot.understanding.status === "completed") {
        const latest = this.memories.getUnderstandingSnapshot(project.id, undefined, false);
        this.memories.saveUnderstandingSnapshot({ projectId: project.id, inputHash, version: (latest?.version ?? 0) + 1, understanding: snapshot.understanding, now: Date.now() });
      }
      // Reclassify legacy rows after each rebuild so old title-based false
      // conflicts are repaired without requiring manual cleanup.
      this.memories.repairProjectTechnicalSemantics(project.id);
      const saved = this.memories.getSnapshot(project.profileId);
      options.signal?.throwIfAborted?.();
      await this.embedFacts?.(project.profileId, project.id, options.signal);
      this.analysisRuns?.record({ id: runId, profileId: project.profileId, projectId: project.id, runType: "project-memory", inputHash, status: "completed", inputSnapshot, output: saved, snapshotVersion });
      this.analysisRuns?.setProjectState({ projectId: project.id, latestAnalysisId: runId, lastSuccessfulAnalysisId: runId, status: "completed", snapshotVersion });
      this.onUpdated?.(project.profileId, project.id);
      return saved;
    } catch (error) {
      this.onTrace?.("PROJECT_PARSE_FAILED", { projectId, sourceCount: sources.length, error: String(error) });
      this.analysisRuns?.record({ id: runId, profileId: project.profileId, projectId: project.id, runType: "project-memory", inputHash, status: "failed", inputSnapshot, error: String(error), snapshotVersion });
      this.analysisRuns?.setProjectState({ projectId: project.id, latestAnalysisId: runId, status: previousState?.lastSuccessfulAnalysisId ? "stale" : "failed", snapshotVersion });
      throw error;
    }
  }
}

export function createProjectMemoryModel(answerProvider: AnswerProvider, settings: { model: string; apiKey?: string }): ProjectMemoryModel {
  return {
    async generate(input) {
      if (!settings.apiKey) throw new Error("LLM_NOT_CONFIGURED");
      let output = "";
      const sources = input.sources.map((source) => {
        const structure = parseMarkdownProjectDocument(source.text);
        const sections = structure.sections.slice(0, 20).map((section) => ({ path: section.path, title: section.title, paragraphs: section.paragraphs.slice(0, 6), bullets: section.bullets.slice(0, 12), tables: section.tables.slice(0, 4) }));
        return { id: source.id, kind: source.kind, sourceRole: source.sourceRole, title: source.title, filePath: source.filePath, language: source.language, locator: source.locator, markdownTitle: structure.title, sections };
      });
      for await (const delta of answerProvider.stream({ model: settings.model, maxOutputTokens: 4_000, sections: [
        { name: "system/base", content: "你是 Project Fact Extractor。输入已经绑定到一个项目，只能提取有 source id、quote 且能在对应资料中逐字定位的原子事实。禁止把 Resume 整体、其他项目、面试 AI 回答或通用技能写入当前项目。项目职责只能来自明确的项目级职责字段；时间只能是日期范围、持续周期或明确未知。不要把‘同步’‘划分’‘平台’等普通句子片段当成字段值。" },
        { name: "profile-context", content: JSON.stringify({ profileId: input.profileId, projectId: input.projectId, projectName: input.projectName, sources }) },
        { name: "output-format", content: "只输出一个 JSON 对象，不要 Markdown，不要解释：{facts:[{id,factType,title,content,confidence,scope,evidenceLevel,experienceRelation,value,sources:[{sourceId,quote,locator}]}]}。factType 必须属于 background/goal/responsibility/hardware/software/architecture/module/technology/technical_decision/challenge/decision/cause/solution/result/metric/parameter/application/timeline/limitation。parameter 只表示配置/设计参数（如控制环频率、采样频率、CAN/UART 速率、限流/限压、极对数、编码器分辨率、任务周期）；metric 只表示实测性能结果。value 只能是 scalar/enum/range/boolean，无法从原文确定时省略。第三方库只能标记为 used/integrated/configured/debugged，不得标记 implemented。scope 只能是 project/module/problem/architecture。项目事实必须原子化；没有逐字 quote 的候选不要输出；不要生成 projects、modules、technicalPoints、problems 或 interviewQuestions。" },
        { name: "question", content: "本轮不生成面试题；题目由已合并且带证据的 Project Facts 在本地生成。" }
      ] }, input.signal)) output += delta;
      return output;
    }
  };
}

export function createProjectComprehensionModel(answerProvider: AnswerProvider, settings: { model: string; apiKey?: string }): ProjectComprehensionModel {
  return {
    async generate(input) {
      if (!settings.apiKey) throw new Error("LLM_NOT_CONFIGURED");
      let output = "";
      if (input.purpose === "plan") {
        for await (const delta of answerProvider.stream({ model: settings.model, maxOutputTokens: 700, sections: [
          { name: "system/base", content: `${PROJECT_COMPREHENSION_SYSTEM_PROMPT}\n可用的语义调查动作还包括 findCallers 和 findCallees；对 relationship hypothesis 必须优先补齐对应的 call/config/data/topic evidence。你现在只负责选择下一步。只输出一个 JSON：{action,reason,target?,query?,hypothesisId?,expectedInformation?,priority}。reason 只能是一句简短的可审计 rationale，不要输出思维过程。一次只选一个工具；如果关键覆盖已足够且没有高优先级缺口，选择 synthesize。` },
          { name: "retrieval-context", content: JSON.stringify(input.plannerState ?? { repoMap: input.repoMap, observations: input.observations.slice(-3) }) },
        ] }, input.signal)) output += delta;
        return output;
      }
      const observations = input.observations.map((observation) => ({
        action: observation.action,
        elapsedMs: observation.elapsedMs,
        files: observation.files?.map((file) => ({ path: file.path, sourceId: file.sourceId, kind: file.kind, language: file.language, lineCount: file.lineCount, text: file.text.slice(0, 1_200) })),
        matches: observation.matches?.map((match) => ({ path: match.path, sourceId: match.sourceId, line: match.line, snippet: match.snippet })),
        history: observation.history,
      }));
      for await (const delta of answerProvider.stream({ model: settings.model, maxOutputTokens: 6_000, sections: [
        { name: "system/base", content: PROJECT_COMPREHENSION_SYSTEM_PROMPT },
        { name: "profile-context", content: JSON.stringify({ projectId: input.input.projectId, projectName: input.input.projectName }) },
        { name: "retrieval-context", content: JSON.stringify({ repoMap: input.repoMap, observations, semanticGraph: input.semanticGraph ?? { nodes: [], edges: [], symbols: [], dataObjects: [], configs: [], interfaces: [] }, verifiedRelationships: "只把与 semanticGraph edge 对应的关系视为已确认", unknownPolicy: "找不到 edge 的模型关系必须进入 unknowns" }) },
        { name: "output-format", content: "只输出一个 JSON 对象，不要 Markdown 或解释。字段包括 identity、summary、architecture(components/relationships)、runtimeFlows、dataFlows、controlFlows、technologies、parameters、decisions、problems、interfaces、protections、tests、results、limitations、unknowns。关系只能输出已探索证据支持的 candidate，填写 evidenceStrength/direct 或 strong、verificationStatus；模型本身不能输出 confirmed，grounding 会依据 semanticGraph edge 决定。两个模块仅共现时不要输出关系。Flow 只能由已验证关系组成，缺失链路用 partial:true 和 missingLinks 表示。所有声明必须使用已探索文件的 evidenceRefs；无法证明的内容放入 unknowns。不要输出 facts、projects、interviewQuestions，也不要补造文件内容。" },
      ] }, input.signal)) output += delta;
      return output;
    }
  };
}

export type { ProjectMemorySource };
