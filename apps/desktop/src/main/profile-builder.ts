import type { AnswerProvider, KnowledgeDocumentType, ProfileBuilderInput, ProfileBuilderModel, ProfileBuilderOutput, ProfileBuilderSource, ProfileBuilderSourceSnapshot } from "@interview-copilot/shared";
import { ProfileBuilderAgent } from "@interview-copilot/shared";
import { createHash } from "node:crypto";
import { SqliteInterviewHistoryRepository, SqliteKnowledgeRepository, SqliteProfileBuilderRepository, SqliteProfileRepository, SqliteProjectRepository, SqliteSkillSuggestionRepository, type ProfileBuilderArtifactRecord } from "./database";

function sourceFingerprint(source: ProfileBuilderSource): string {
  return createHash("sha256").update(`${source.id}\n${source.kind}\n${source.text}`).digest("hex").slice(0, 16);
}

function sourceText(title: string, raw: string, summary?: string): string {
  return [`标题：${title}`, summary ? `摘要：${summary}` : "", raw].filter(Boolean).join("\n").slice(0, 16_000);
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

  constructor(
    private readonly profiles: SqliteProfileRepository,
    private readonly projects: SqliteProjectRepository,
    private readonly knowledge: SqliteKnowledgeRepository,
    private readonly history: SqliteInterviewHistoryRepository,
    private readonly artifacts: SqliteProfileBuilderRepository,
    private readonly suggestions?: SqliteSkillSuggestionRepository,
    private readonly model?: ProfileBuilderModel,
    private readonly onUpdated?: (record: ProfileBuilderArtifactRecord) => void
  ) {}

  get(profileId: string): ProfileBuilderArtifactRecord | undefined {
    const record = this.artifacts.get(profileId);
    if (!record) return undefined;
    const current = sourceSnapshot(this.collectSources(profileId), 0);
    return sourceSnapshotsMatch(record.sourceSnapshot, current) ? record : { ...record, status: "stale" };
  }

  async rebuild(profileId: string): Promise<ProfileBuilderArtifactRecord> {
    const existing = this.pending.get(profileId);
    if (existing) return existing;
    const task = this.build(profileId).finally(() => this.pending.delete(profileId));
    this.pending.set(profileId, task);
    return task;
  }

  invalidate(profileId: string): void {
    this.artifacts.invalidate(profileId);
  }

  private async build(profileId: string): Promise<ProfileBuilderArtifactRecord> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    const input: ProfileBuilderInput = { profileId, profileName: profile.name, sources: this.collectSources(profileId) };
    const sourceSnapshot = sourceSnapshotForBuild(input.sources);
    try {
      const artifact = await new ProfileBuilderAgent(this.model).build(input);
      this.suggestions?.upsertFromArtifact(profileId, artifact.skillGraph.nodes, sourceSnapshot);
      const record = this.artifacts.save({ profileId, status: artifact.status, sourceSnapshot, artifact });
      this.onUpdated?.(record);
      return record;
    } catch (error) {
      const record = this.artifacts.save({ profileId, status: "error", sourceSnapshot, error: String(error) });
      this.onUpdated?.(record);
      return record;
    }
  }

  private collectSources(profileId: string): ProfileBuilderSource[] {
    const profile = this.profiles.get(profileId);
    if (!profile) return [];
    const sources: ProfileBuilderSource[] = [];
    if (profile.resume) sources.push({ id: `resume-${profileId}`, kind: "resume", title: profile.resume.filename ?? "Resume", text: sourceText(profile.resume.filename ?? "Resume", profile.resume.rawContent, profile.resume.summary), updatedAt: profile.resume.uploadedAt ?? profile.updatedAt });
    if (profile.jobDescription) sources.push({ id: `job-${profileId}`, kind: "job_target", title: profile.jobDescription.filename ?? "Job Description", text: sourceText(profile.jobDescription.filename ?? "Job Description", profile.jobDescription.rawContent, profile.jobDescription.summary), updatedAt: profile.jobDescription.uploadedAt ?? profile.updatedAt });
    for (const skill of profile.skills) sources.push({ id: `skill-${skill.id}`, kind: "skill", title: skill.name, text: `${skill.name}\n${skill.description}\n${skill.content}\n${skill.tags.join("、")}`, updatedAt: skill.confirmedAt ?? profile.updatedAt });
    for (const project of this.projects.list().filter((item) => item.profileId === profileId)) sources.push({ id: `project-${project.id}`, kind: "project", title: project.name, text: `项目名称：${project.name}`, updatedAt: project.updatedAt });
    for (const document of this.knowledge.listDocuments().filter((item) => profile.knowledgeBaseIds.includes(item.knowledgeBaseId) && item.status === "ready")) sources.push({ id: `document-${document.id}`, kind: profileBuilderSourceKind(document.documentType), title: `${document.filename} · ${document.documentType}`, text: document.text, updatedAt: document.updatedAt });
    for (const interview of this.history.listInterviews().filter((item) => item.profileId === profileId)) {
      const snapshot = this.history.snapshot(interview.id);
      const answers = new Map(snapshot.answers.map((answer) => [answer.questionId, answer.text]));
      const pairs = snapshot.questions.map((question) => `问题：${question.text}\n回答：${answers.get(question.id) ?? ""}`).filter((pair) => !pair.endsWith("回答："));
      if (pairs.length) sources.push({ id: `interview-${interview.id}`, kind: "interview", title: `面试记录 ${new Date(interview.createdAt).toLocaleDateString("zh-CN")}`, text: pairs.join("\n\n"), updatedAt: interview.endedAt ?? interview.createdAt });
    }
    return sources;
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

function sourceSnapshotForBuild(sources: ProfileBuilderSource[]): ProfileBuilderSourceSnapshot {
  return sourceSnapshot(sources);
}

export type { ProfileBuilderOutput };
