import type { AnswerProvider, KnowledgeDocumentType, ProfileBuilderInput, ProfileBuilderModel, ProfileBuilderOutput, ProfileBuilderSource, ProfileBuilderSourceSnapshot, ResumeAnalysis, ResumeAnalysisModel } from "@interview-copilot/shared";
import { ProfileBuilderAgent, RESUME_ANALYSIS_VERSION, ResumeAnalyzer } from "@interview-copilot/shared";
import { createHash } from "node:crypto";
import { SqliteInterviewHistoryRepository, SqliteKnowledgeRepository, SqliteProfileBuilderRepository, SqliteProfileRepository, SqliteProjectRepository, SqliteResumeAnalysisRepository, SqliteSkillSuggestionRepository, type ProfileBuilderArtifactRecord, type ResumeAnalysisRecord } from "./database";
import { ProfileAnalysisJobManager, type ProfileAnalysisJob } from "./profile-analysis-job";

function sourceFingerprint(source: ProfileBuilderSource): string {
  return createHash("sha256").update(`${source.id}\n${source.kind}\n${source.text}`).digest("hex").slice(0, 16);
}

export const MAX_SOURCE_CHARS = 12_000;
export const MAX_TOTAL_CHARS = 48_000;
export const MAX_KNOWLEDGE_DOCS = 6;
export const MAX_INTERVIEW_HISTORY = 4;
export const MAX_PROJECTS = 8;
export const MAX_CONFIRMED_SKILLS = 12;

export function resumeAnalysisHash(rawText: string): string { return createHash("sha256").update(rawText).digest("hex"); }

function sourceText(title: string, raw: string, summary?: string): string {
  return [`标题：${title}`, summary ? `摘要：${summary}` : "", raw].filter(Boolean).join("\n").slice(0, MAX_SOURCE_CHARS);
}

export function boundProfileBuilderSources(sources: ProfileBuilderSource[]): ProfileBuilderSource[] {
  const bounded: ProfileBuilderSource[] = [];
  let totalChars = 0;
  for (const source of sources) {
    if (totalChars >= MAX_TOTAL_CHARS) break;
    const remaining = MAX_TOTAL_CHARS - totalChars;
    const text = source.text.slice(0, Math.min(MAX_SOURCE_CHARS, remaining));
    if (!text.trim()) continue;
    bounded.push({ ...source, text });
    totalChars += text.length;
  }
  return bounded;
}

function profileBuilderSourceKind(documentType: KnowledgeDocumentType): ProfileBuilderSource["kind"] {
  if (documentType === "resume") return "resume";
  if (documentType === "job-description") return "job_target";
  if (documentType === "skill") return "skill";
  if (documentType === "interview-question") return "interview";
  return "knowledge";
}

function sourceSnapshot(sources: ProfileBuilderSource[], generatedAt = Date.now()): ProfileBuilderSourceSnapshot {
  return { generatedAt, sources: sources.map((source) => ({ id: source.id, kind: source.kind, title: source.title, updatedAt: source.updatedAt, fingerprint: sourceFingerprint(source) })) };
}

function sourceSnapshotsMatch(left: unknown, right: ProfileBuilderSourceSnapshot): boolean {
  const leftSources = Array.isArray((left as { sources?: unknown } | undefined)?.sources) ? (left as { sources: Array<Record<string, unknown>> }).sources : [];
  if (leftSources.length !== right.sources.length) return false;
  const normalized = (sources: Array<Record<string, unknown> | ProfileBuilderSourceSnapshot["sources"][number]>) => sources.map((source) => `${String(source.id)}\u0000${String(source.kind)}\u0000${String(source.fingerprint)}`).sort();
  return normalized(leftSources).join("\u0001") === normalized(right.sources).join("\u0001");
}

export class ProfileBuilderService {
  private readonly pending = new Map<string, Promise<ProfileBuilderArtifactRecord>>();
  private readonly jobs: ProfileAnalysisJobManager;

  constructor(
    private readonly profiles: SqliteProfileRepository,
    private readonly projects: SqliteProjectRepository,
    private readonly knowledge: SqliteKnowledgeRepository,
    private readonly history: SqliteInterviewHistoryRepository,
    private readonly artifacts: SqliteProfileBuilderRepository,
    private readonly suggestions?: SqliteSkillSuggestionRepository,
    private readonly model?: ProfileBuilderModel,
    private readonly onUpdated?: (record: ProfileBuilderArtifactRecord) => void,
    private readonly onJobUpdated?: (job: ProfileAnalysisJob) => void,
    private readonly resumeAnalysisRepository?: SqliteResumeAnalysisRepository,
    private readonly resumeModel?: ResumeAnalysisModel
  ) { this.jobs = new ProfileAnalysisJobManager((job) => this.onJobUpdated?.(job)); }

  get(profileId: string): ProfileBuilderArtifactRecord | undefined {
    const record = this.artifacts.get(profileId);
    if (!record) return undefined;
    const current = sourceSnapshot(this.collectSources(profileId), 0);
    return sourceSnapshotsMatch(record.sourceSnapshot, current) && record.version === 2 && record.artifact?.version === 2 ? record : { ...record, status: "stale" };
  }

  async rebuild(profileId: string): Promise<ProfileBuilderArtifactRecord> {
    const existing = this.pending.get(profileId);
    if (existing) return existing;
    const task = this.waitForRebuild(profileId).finally(() => this.pending.delete(profileId));
    this.pending.set(profileId, task);
    return task;
  }

  invalidate(profileId: string): void {
    this.artifacts.invalidate(profileId);
  }

  startResumeAnalysis(profileId: string): ProfileAnalysisJob {
    const profile = this.profiles.get(profileId);
    if (!profile?.resume) throw new Error("RESUME_NOT_FOUND: 请先上传 Resume");
    const document = { sourceId: `resume-${profileId}`, filename: profile.resume.filename, rawText: profile.resume.rawContent };
    return this.jobs.start(profileId, "resume", document, async (result) => {
      const fallback = result as ResumeAnalysis;
      const analysis = this.resumeModel ? await new ResumeAnalyzer().analyzeWithModel(document, this.resumeModel) : fallback;
      this.resumeAnalysisRepository?.save({ profileId, resumeHash: resumeAnalysisHash(document.rawText), artifact: analysis });
    });
  }

  getResumeAnalysis(profileId: string): ResumeAnalysisRecord | undefined {
    const profile = this.profiles.get(profileId);
    if (!profile?.resume) return undefined;
    return this.resumeAnalysisRepository?.get(profileId, resumeAnalysisHash(profile.resume.rawContent), RESUME_ANALYSIS_VERSION) ?? this.resumeAnalysisRepository?.get(profileId);
  }

  start(profileId: string): ProfileAnalysisJob {
    const input = this.buildInput(profileId);
    return this.jobs.start(profileId, "profile", input, async (result) => {
      let artifact = result as ProfileBuilderOutput;
      if (this.model) artifact = await new ProfileBuilderAgent(this.model).buildWithFallback(input, artifact);
      this.saveArtifact(profileId, input, artifact);
    });
  }

  getJob(jobId: string): ProfileAnalysisJob | undefined { return this.jobs.get(jobId); }
  getJobs(profileId: string, kind?: "resume" | "profile"): ProfileAnalysisJob[] { return this.jobs.list(profileId, kind); }
  cancelJob(jobId: string): ProfileAnalysisJob | undefined { return this.jobs.cancel(jobId); }

  private buildInput(profileId: string): ProfileBuilderInput {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    const resumeFingerprint = profile.resume ? resumeAnalysisHash(profile.resume.rawContent) : undefined;
    const storedResumeAnalysis = resumeFingerprint ? this.resumeAnalysisRepository?.get(profileId, resumeFingerprint, RESUME_ANALYSIS_VERSION) : undefined;
    const resumeAnalysis = storedResumeAnalysis?.status === "current" ? storedResumeAnalysis.artifact : undefined;
    return { profileId, profileName: profile.name, sources: this.collectSources(profileId), resumeAnalysis };
  }

  private saveArtifact(profileId: string, input: ProfileBuilderInput, artifact: ProfileBuilderOutput): ProfileBuilderArtifactRecord {
    const sourceSnapshot = sourceSnapshotForBuild(input.sources);
    this.suggestions?.upsertFromArtifact(profileId, artifact.skillGraph.nodes, sourceSnapshot);
    const record = this.artifacts.save({ profileId, status: artifact.status, sourceSnapshot, artifact });
    this.onUpdated?.(record);
    return record;
  }

  private async waitForRebuild(profileId: string): Promise<ProfileBuilderArtifactRecord> {
    const job = this.start(profileId);
    while (true) {
      const current = this.jobs.get(job.id);
      if (!current || current.status === "completed") {
        const record = this.artifacts.get(profileId);
        if (record) return record;
        throw new Error("Profile Builder completed without an artifact");
      }
      if (["failed", "cancelled"].includes(current.status)) throw new Error(current.error ?? `Profile Builder ${current.status}`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  private collectSources(profileId: string): ProfileBuilderSource[] {
    const profile = this.profiles.get(profileId);
    if (!profile) return [];
    const sources: ProfileBuilderSource[] = [];
    const add = (source: ProfileBuilderSource): void => { sources.push(source); };
    if (profile.resume) add({ id: `resume-${profileId}`, kind: "resume", title: profile.resume.filename ?? "Resume", text: sourceText(profile.resume.filename ?? "Resume", profile.resume.rawContent), updatedAt: profile.resume.uploadedAt ?? profile.updatedAt });
    if (profile.jobDescription) add({ id: `job-${profileId}`, kind: "job_target", title: profile.jobDescription.filename ?? "Job Description", text: sourceText(profile.jobDescription.filename ?? "Job Description", profile.jobDescription.rawContent, profile.jobDescription.summary), updatedAt: profile.jobDescription.uploadedAt ?? profile.updatedAt });
    for (const skill of profile.skills.filter((item) => item.confirmedAt).slice(0, MAX_CONFIRMED_SKILLS)) add({ id: `skill-${skill.id}`, kind: "skill", title: skill.name, text: `${skill.name}\n${skill.description}\n${skill.content}\n${skill.tags.join("、")}`, updatedAt: skill.confirmedAt ?? profile.updatedAt });
    for (const project of this.projects.list().filter((item) => item.profileId === profileId).sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_PROJECTS)) add({ id: `project-${project.id}`, kind: "project", title: project.name, text: `项目名称：${project.name}`, updatedAt: project.updatedAt });
    for (const document of this.knowledge.listDocuments().filter((item) => profile.knowledgeBaseIds.includes(item.knowledgeBaseId) && item.status === "ready").sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_KNOWLEDGE_DOCS)) add({ id: `document-${document.id}`, kind: profileBuilderSourceKind(document.documentType), title: `${document.filename} · ${document.documentType}`, text: document.text, updatedAt: document.updatedAt });
    for (const interview of this.history.listInterviews().filter((item) => item.profileId === profileId).sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_INTERVIEW_HISTORY)) {
      const snapshot = this.history.snapshot(interview.id);
      const answers = new Map(snapshot.answers.map((answer) => [answer.questionId, answer.text]));
      const pairs = snapshot.questions.map((question) => `问题：${question.text}\n回答：${answers.get(question.id) ?? ""}`).filter((pair) => !pair.endsWith("回答："));
      if (pairs.length) add({ id: `interview-${interview.id}`, kind: "interview", title: `面试记录 ${new Date(interview.createdAt).toLocaleDateString("zh-CN")}`, text: pairs.join("\n\n"), updatedAt: interview.endedAt ?? interview.createdAt });
    }
    return boundProfileBuilderSources(sources);
  }
}

export function createProfileBuilderModel(answerProvider: AnswerProvider, settings: { model: string; apiKey?: string }): ProfileBuilderModel {
  return {
    async generate(input) {
      if (!settings.apiKey) throw new Error("LLM_NOT_CONFIGURED");
      const sources = input.profile.sources.map((source) => ({ id: source.id, kind: source.kind, title: source.title, text: source.text.slice(0, 8_000) }));
      let output = "";
      for await (const delta of answerProvider.stream({
        model: settings.model,
        sections: [
          { name: "system/base", content: "你是个人面试档案分析 Agent。只根据输入资料生成 JSON。严禁虚构项目、职责、技术栈和量化结果。resume、project、interview、skill 是候选人证据；job_target 和 knowledge 是目标岗位/参考上下文，不能把岗位要求写成候选人事实。每个新增节点、项目、回答素材和 FAQ 必须填入至少一个真实 evidenceIds，且 evidenceIds 必须来自输入 source id。" },
          { name: "profile-context", content: JSON.stringify({ profileId: input.profile.profileId, profileName: input.profile.profileName, sources }) },
          { name: "output-format", content: "输出 JSON：{skillGraph:{nodes:[{id,label,description,evidenceIds}],edges:[]},projectGraph:{nodes:[{id,name,summary,highlights,skills,evidenceIds}],edges:[]},answerMaterials:[{id,question,answerPoints,topic,evidenceIds}],faqs:[{id,question,category,answerMaterialId,frequency,evidenceIds}]}。不要 Markdown。" },
          { name: "question", content: "请生成可以直接支持面试回答的个人技能图谱、项目知识图谱、回答素材库和常见问题库；技能建议必须能回溯到候选人证据，岗位要求只用于标注目标上下文。" }
        ]
      })) output += delta;
      return output;
    }
  };
}

export function createResumeAnalysisModel(answerProvider: AnswerProvider, settings: { model: string; apiKey?: string }): ResumeAnalysisModel {
  return {
    async generate(input) {
      if (!settings.apiKey) throw new Error("LLM_NOT_CONFIGURED");
      let output = "";
      for await (const delta of answerProvider.stream({
        model: settings.model,
        sections: [
          { name: "system/base", content: "你是 Resume 结构化抽取器。只根据当前 Resume 原文输出 JSON，禁止使用岗位 JD、项目库、知识库、面试记录或任何外部上下文。每个 projects 项目必须提供 evidence：sourceId、startOffset、endOffset、rawExcerpt，rawExcerpt 必须是原文连续片段。不能定位证据的项目不要输出。skills 只能输出原文中明确出现的技能或常见别名。" },
          { name: "profile-context", content: JSON.stringify(input.document) },
          { name: "evidence-context", content: JSON.stringify(input.fallback) },
          { name: "output-format", content: "只输出 JSON：{basicInfo:{name,email,phone},education:[],workExperience:[],internships:[],projects:[{id,name,period,role,description,responsibilities,technologies,evidence:{sourceId,startOffset,endOffset,rawExcerpt},confidence}],skills:[],awards:[],summary,warnings:[]}。" }
        ]
      })) output += delta;
      return output;
    }
  };
}

function sourceSnapshotForBuild(sources: ProfileBuilderSource[]): ProfileBuilderSourceSnapshot {
  return sourceSnapshot(sources);
}

export type { ProfileBuilderOutput };
