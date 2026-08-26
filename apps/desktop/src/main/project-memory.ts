import type { AnswerProvider, ProjectMemoryAnalysisInput, ProjectMemoryModel, ProjectMemorySource, ProjectMemorySnapshot, ProjectSourceRole, ProjectSourceAssignmentMethod } from "@interview-copilot/shared";
import { analyzeCodeFile, extractResumeProjectSections, languageForFilename, parseMarkdownProjectDocument, ProjectAnalyzerAgent as ProjectAnalyzerAgentClass, resolveProjectAssignment } from "@interview-copilot/shared";
import { createHash } from "node:crypto";
import { SqliteInterviewHistoryRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectMemoryRepository } from "./database";

function projectSourceFromDocument(document: ReturnType<SqliteKnowledgeRepository["getDocument"]>, projectName: string, sourceRole?: ProjectSourceRole): ProjectMemorySource | undefined {
  if (!document || document.status !== "ready") return undefined;
  const language = languageForFilename(document.filename);
  const code = language === "unknown" ? undefined : analyzeCodeFile({ filePath: document.filename, text: document.text, language });
  const codeSummary = code ? `\n代码分析：模块 ${code.modules.map((item) => item.name).join("、") || "未识别"}；函数 ${code.functions.map((item) => item.name).join("、") || "未识别"}；关键词 ${code.keywords.join("、")}` : "";
  return { id: document.id, kind: "project-document", sourceType: "document", title: document.filename, projectName, text: `${document.text}${codeSummary}`, language, updatedAt: document.updatedAt, ...(sourceRole ? { sourceRole } : {}) } as ProjectMemorySource & { sourceRole?: ProjectSourceRole };
}

export class ProjectMemoryService {
  private readonly pending = new Map<string, Promise<ProjectMemorySnapshot>>();

  constructor(
    private readonly profiles: SqliteProfileRepository,
    private readonly knowledge: SqliteKnowledgeRepository,
    private readonly history: SqliteInterviewHistoryRepository,
    private readonly memories: SqliteProjectMemoryRepository,
    private readonly model?: ProjectMemoryModel,
    private readonly onUpdated?: (profileId: string, projectId?: string) => void,
    private readonly analysisRuns?: SqliteKnowledgeAnalysisRepository,
    private readonly embedFacts?: (profileId: string, projectId?: string) => Promise<void>,
    private readonly onTrace?: (event: string, fields: Record<string, unknown>) => void
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

  /** Binds a ready project document before analysis. Ambiguous input is never silently attached. */
  assignDocument(profileId: string, documentId: string, explicitProjectId?: string): { status: "assigned" | "needs_assignment"; projectId?: string; confidence: number; message: string } {
    const document = this.knowledge.getDocument(documentId);
    if (!document) throw new Error(`Knowledge document not found: ${documentId}`);
    if (document.documentType === "resume") return { status: "needs_assignment", confidence: 0, message: "RESUME_MUST_BE_SPLIT：整份 Resume 不能直接绑定为项目资料" };
    if (document.documentType !== "project" && document.documentType !== "technical-doc") return { status: "needs_assignment", confidence: 0, message: "PROJECT_SOURCE_TYPE_UNSUPPORTED：只有项目资料或明确绑定的技术文档可进入项目分析" };
    const source: ProjectMemorySource = { id: document.id, kind: "project-document", sourceType: "document", title: document.filename, text: document.text, updatedAt: document.updatedAt };
    const projects = this.memories.listProjects(profileId);
    const assignment = resolveProjectAssignment(source, projects, explicitProjectId);
    const projectId = assignment.projectId;
    if (!projectId) return { status: "needs_assignment", confidence: assignment.confidence, message: "NEEDS_PROJECT_ASSIGNMENT：请选择该资料属于哪个项目" };
    this.memories.assignSource({ projectId, sourceType: "document", sourceId: documentId, relationship: "primary", confidence: assignment.confidence, verified: Boolean(explicitProjectId), sourceRole: "overview", assignmentMethod: explicitProjectId ? "explicit" : "matched" });
    return { status: "assigned", projectId, confidence: assignment.confidence, message: "项目资料已绑定" };
  }

  assignSource(input: { profileId: string; projectId: string; sourceType: "document" | "repository" | "resume_section" | "user_fact"; sourceId: string; relationship?: "primary" | "supporting" | "reference"; sourceRole?: ProjectSourceRole; assignmentMethod?: ProjectSourceAssignmentMethod; confidence?: number; verified?: boolean }): void {
    const project = this.memories.getProject(input.projectId);
    if (!project || project.profileId !== input.profileId) throw new Error("PROJECT_NOT_FOUND");
    this.memories.assignSource({ projectId: input.projectId, sourceType: input.sourceType, sourceId: input.sourceId, relationship: input.relationship ?? (input.sourceRole === "reference" ? "reference" : "supporting"), sourceRole: input.sourceRole ?? "other", assignmentMethod: input.assignmentMethod ?? "explicit", confidence: input.confidence ?? 1, verified: input.verified ?? true });
  }

  private async ensureProjectAssignments(profileId: string): Promise<void> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    for (const project of this.memories.listProjects(profileId)) {
      if (this.memories.listProjectSources(project.id).length > 0) continue;
      for (const sourceId of project.sourceIds) {
        const documentId = sourceId.match(/^memory-document-(.+)$/)?.[1] ?? sourceId.match(/^memory-code-(.+?)-\d+$/)?.[1];
        if (documentId && this.knowledge.getDocument(documentId)) this.memories.assignSource({ projectId: project.id, sourceType: "document", sourceId: documentId, relationship: "primary", sourceRole: "overview", assignmentMethod: "imported", confidence: project.name === "待确认项目" ? 0.4 : 0.7, verified: false });
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

  private collectSources(profileId: string, project: { id: string; name: string }): ProjectMemorySource[] {
    const profile = this.profiles.get(profileId);
    if (!profile) return [];
    const result: ProjectMemorySource[] = [];
    for (const assignment of this.memories.listProjectSources(project.id)) {
      if (assignment.sourceType === "document" || assignment.sourceType === "repository") {
        const source = projectSourceFromDocument(this.knowledge.getDocument(assignment.sourceId), project.name, assignment.sourceRole);
        if (source) result.push({ ...source, sourceType: assignment.sourceType, projectId: project.id });
      } else if (assignment.sourceType === "resume_section" && profile.resume?.rawContent) {
        const sections = extractResumeProjectSections(profile.resume.rawContent, `resume-section-${profileId}`);
        const section = sections.find((item) => `${item.sourceId}:${item.locator}` === assignment.sourceId);
        if (section) result.push({ id: assignment.sourceId, kind: "resume-section", sourceType: "resume_section", sourceRole: "resume", projectId: project.id, title: section.projectName, projectName: project.name, text: section.text, locator: section.locator, updatedAt: profile.updatedAt });
      }
    }
    return result.filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index);
  }

  private async buildProject(projectId: string): Promise<ProjectMemorySnapshot> {
    const project = this.memories.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const sources = this.collectSources(project.profileId, project);
    const input: ProjectMemoryAnalysisInput = { profileId: project.profileId, projectId: project.id, projectName: project.name, sources };
    const inputSnapshot = sources.map((source) => ({ id: source.id, kind: source.kind, title: source.title, locator: source.locator, updatedAt: source.updatedAt, contentHash: createHash("sha256").update(source.text).digest("hex") }));
    const inputHash = createHash("sha256").update(JSON.stringify(inputSnapshot)).digest("hex");
    const runId = `project-memory-${project.id}-${inputHash.slice(0, 16)}`;
    const previousState = this.analysisRuns?.getProjectState(project.id);
    const snapshotVersion = (previousState?.snapshotVersion ?? 0) + 1;
    this.analysisRuns?.record({ id: runId, profileId: project.profileId, projectId: project.id, runType: "project-memory", inputHash, status: "running", inputSnapshot, snapshotVersion });
    this.analysisRuns?.setProjectState({ projectId: project.id, latestAnalysisId: runId, status: "running", snapshotVersion });
    try {
      const snapshot = await new ProjectAnalyzerAgentClass(this.model).analyze(input);
      this.onTrace?.("PROJECT_PARSE_TRACE", { projectId, sourceCount: sources.length, factCount: snapshot.facts?.length ?? 0, moduleCount: snapshot.modules.length, problemCount: snapshot.problems.length, questionCount: snapshot.interviewQuestions.length, sourceIds: sources.map((source) => source.id) });
       this.memories.replaceSnapshot(project.profileId, snapshot, Date.now(), project.id);
       // Reclassify legacy rows after each rebuild so old title-based false
       // conflicts are repaired without requiring manual cleanup.
       this.memories.repairProjectFactSemantics(project.id);
       const saved = this.memories.getSnapshot(project.profileId);
      await this.embedFacts?.(project.profileId, project.id);
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
        { name: "output-format", content: "只输出一个 JSON 对象，不要 Markdown，不要解释：{facts:[{id,factType,title,content,confidence,scope,evidenceLevel,sources:[{sourceId,quote,locator}]}]}。factType 必须属于 background/goal/responsibility/hardware/software/architecture/module/technology/technical_decision/challenge/decision/cause/solution/result/metric/application/timeline/limitation。scope 只能是 project/module/problem/architecture。项目事实必须原子化；没有逐字 quote 的候选不要输出；不要生成 projects、modules、technicalPoints、problems 或 interviewQuestions。" },
        { name: "question", content: "本轮不生成面试题；题目由已合并且带证据的 Project Facts 在本地生成。" }
      ] })) output += delta;
      return output;
    }
  };
}

export type { ProjectMemorySource };
