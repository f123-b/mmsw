import type { AnswerProvider, KnowledgeDocumentType, ProfileBuilderInput, ProfileBuilderModel, ProfileBuilderOutput, ProfileBuilderSource } from "@interview-copilot/shared";
import { ProfileBuilderAgent, normalizeTechnicalTerms } from "@interview-copilot/shared";
import { createHash } from "node:crypto";
import { SqliteInterviewHistoryRepository, SqliteKnowledgeRepository, SqliteProfileBuilderRepository, SqliteProfileRepository, SqliteProjectRepository, type ProfileBuilderArtifactRecord } from "./database";

function sourceFingerprint(source: ProfileBuilderSource): string {
  return createHash("sha256").update(`${source.id}\n${source.updatedAt ?? 0}\n${source.text}`).digest("hex").slice(0, 16);
}

function sourceText(title: string, raw: string, summary?: string): string {
  return [`标题：${title}`, summary ? `摘要：${summary}` : "", raw].filter(Boolean).join("\n").slice(0, 16_000);
}

function profileBuilderSourceKind(documentType: KnowledgeDocumentType): ProfileBuilderSource["kind"] {
  if (documentType === "resume" || documentType === "job-description") return "resume";
  if (documentType === "skill") return "skill";
  if (documentType === "interview-question") return "interview";
  return "project";
}

export class ProfileBuilderService {
  private readonly pending = new Map<string, Promise<ProfileBuilderArtifactRecord>>();

  constructor(
    private readonly profiles: SqliteProfileRepository,
    private readonly projects: SqliteProjectRepository,
    private readonly knowledge: SqliteKnowledgeRepository,
    private readonly history: SqliteInterviewHistoryRepository,
    private readonly artifacts: SqliteProfileBuilderRepository,
    private readonly model?: ProfileBuilderModel,
    private readonly onUpdated?: (record: ProfileBuilderArtifactRecord) => void
  ) {}

  get(profileId: string): ProfileBuilderArtifactRecord | undefined {
    return this.artifacts.get(profileId);
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
    const sourceSnapshot = { generatedAt: Date.now(), sources: input.sources.map((source) => ({ id: source.id, kind: source.kind, title: source.title, updatedAt: source.updatedAt, fingerprint: sourceFingerprint(source) })) };
    try {
      const artifact = await new ProfileBuilderAgent(this.model).build(input);
      this.syncDetectedSkills(profileId, artifact);
      const record = this.artifacts.save({ profileId, status: artifact.status, sourceSnapshot, artifact });
      this.onUpdated?.(record);
      return record;
    } catch (error) {
      const record = this.artifacts.save({ profileId, status: "error", sourceSnapshot, error: String(error) });
      this.onUpdated?.(record);
      return record;
    }
  }

  private syncDetectedSkills(profileId: string, artifact: ProfileBuilderOutput): void {
    const profile = this.profiles.get(profileId);
    if (!profile || artifact.skillGraph.nodes.length === 0) return;
    const existingNames = new Set(profile.skills.map((skill) => normalizeTechnicalTerms(skill.name).toLowerCase()));
    const detectedSkills = artifact.skillGraph.nodes.filter((node) => {
      const key = normalizeTechnicalTerms(node.label).toLowerCase();
      return key && !existingNames.has(key);
    }).map((node) => ({
      id: `resume-skill-${profileId}-${normalizeTechnicalTerms(node.label).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").slice(0, 40)}`,
      name: node.label,
      description: node.description || "根据简历自动识别",
      content: `简历证据：${node.description || node.label}`,
      tags: ["resume-detected", "待确认"]
    }));
    if (detectedSkills.length === 0) return;
    this.profiles.save({ ...profile, skills: [...profile.skills, ...detectedSkills] });
  }

  private collectSources(profileId: string): ProfileBuilderSource[] {
    const profile = this.profiles.get(profileId);
    if (!profile) return [];
    const sources: ProfileBuilderSource[] = [];
    if (profile.resume) sources.push({ id: `resume-${profileId}`, kind: "resume", title: "Resume", text: sourceText("Resume", profile.resume.rawContent, profile.resume.summary), updatedAt: profile.updatedAt });
    if (profile.jobDescription) sources.push({ id: `job-${profileId}`, kind: "resume", title: "Job Description", text: sourceText("Job Description", profile.jobDescription.rawContent, profile.jobDescription.summary), updatedAt: profile.updatedAt });
    for (const skill of profile.skills) sources.push({ id: `skill-${skill.id}`, kind: "skill", title: skill.name, text: `${skill.name}\n${skill.description}\n${skill.content}\n${skill.tags.join("、")}`, updatedAt: profile.updatedAt });
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
          { name: "system/base", content: "你是 Profile Builder Agent。只根据输入资料生成 JSON。严禁虚构项目、职责、技术栈和量化结果。每个新增节点、项目、回答素材和 FAQ 必须填入至少一个真实 evidenceIds，且 evidenceIds 必须来自输入 source id。" },
          { name: "profile-context", content: JSON.stringify({ profileId: input.profile.profileId, profileName: input.profile.profileName, sources }) },
          { name: "output-format", content: "输出 JSON：{skillGraph:{nodes:[{id,label,description,evidenceIds}],edges:[]},projectGraph:{nodes:[{id,name,summary,highlights,skills,evidenceIds}],edges:[]},answerMaterials:[{id,question,answerPoints,topic,evidenceIds}],faqs:[{id,question,category,answerMaterialId,frequency,evidenceIds}]}。不要 Markdown。" },
          { name: "question", content: "请生成可以直接支持面试回答的个人技能图谱、项目知识图谱、回答素材库和常见问题库。" }
        ]
      })) output += delta;
      return output;
    }
  };
}

export type { ProfileBuilderOutput };
