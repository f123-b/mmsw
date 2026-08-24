import type { AnswerProvider, ProjectMemoryAnalysisInput, ProjectMemoryModel, ProjectMemorySource } from "@interview-copilot/shared";
import { analyzeCodeFile, languageForFilename, ProjectAnalyzerAgent as ProjectAnalyzerAgentClass } from "@interview-copilot/shared";
import { createHash } from "node:crypto";
import { SqliteInterviewHistoryRepository, SqliteKnowledgeAnalysisRepository, SqliteKnowledgeRepository, SqliteProfileRepository, SqliteProjectMemoryRepository } from "./database";

function sourceText(title: string, raw: string, summary?: string): string {
  return [`标题：${title}`, summary ? `摘要：${summary}` : "", raw].filter(Boolean).join("\n").slice(0, 20_000);
}

export class ProjectMemoryService {
  private readonly pending = new Map<string, Promise<ReturnType<SqliteProjectMemoryRepository["getSnapshot"]>>>();

  constructor(
    private readonly profiles: SqliteProfileRepository,
    private readonly knowledge: SqliteKnowledgeRepository,
    private readonly history: SqliteInterviewHistoryRepository,
    private readonly memories: SqliteProjectMemoryRepository,
    private readonly model?: ProjectMemoryModel,
    private readonly onUpdated?: (profileId: string) => void,
    private readonly analysisRuns?: SqliteKnowledgeAnalysisRepository,
    private readonly embedFacts?: (profileId: string) => Promise<void>
  ) {}

  get(profileId: string) { return this.memories.getSnapshot(profileId); }

  async rebuild(profileId: string) {
    const existing = this.pending.get(profileId);
    if (existing) return existing;
    const task = this.build(profileId).finally(() => this.pending.delete(profileId));
    this.pending.set(profileId, task);
    return task;
  }

  private async build(profileId: string) {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Profile not found: ${profileId}`);
    const sources: ProjectMemorySource[] = [];
    if (profile.resume) sources.push({ id: `memory-resume-${profileId}`, kind: "resume", title: "Resume", text: sourceText("Resume", profile.resume.rawContent, profile.resume.summary), updatedAt: profile.updatedAt });
    for (const document of this.knowledge.listDocuments().filter((item) => profile.knowledgeBaseIds.includes(item.knowledgeBaseId) && item.status === "ready" && ["resume", "project", "technical-doc", "other"].includes(item.documentType))) {
      const archiveEntries = [...document.text.matchAll(/(?:^|\n)文件：([^\n]+)\n([\s\S]*?)(?=\n\n---\n\n文件：|$)/g)];
      if (archiveEntries.length > 0) {
        for (const [index, match] of archiveEntries.entries()) {
          const filePath = String(match[1] ?? "").trim();
          const text = String(match[2] ?? "").trim();
          const language = languageForFilename(filePath);
          const code = language === "unknown" ? undefined : analyzeCodeFile({ filePath, text, language });
          const codeSummary = code ? `\n代码分析：模块 ${code.modules.map((item) => item.name).join("、") || "未识别"}；函数 ${code.functions.map((item) => item.name).join("、") || "未识别"}；关键词 ${code.keywords.join("、")}` : "";
          sources.push({ id: `memory-code-${document.id}-${index}`, kind: /readme/i.test(filePath) ? "readme" : "repository", title: filePath, filePath, language, text: `${text}${codeSummary}`, updatedAt: document.updatedAt });
        }
      } else {
        sources.push({ id: `memory-document-${document.id}`, kind: document.documentType === "resume" ? "resume" : "project-document", title: document.filename, text: document.text, updatedAt: document.updatedAt });
      }
    }
    for (const interview of this.history.listInterviews().filter((item) => item.profileId === profileId).slice(0, 10)) {
      const snapshot = this.history.snapshot(interview.id);
      const answers = new Map(snapshot.answers.map((answer) => [answer.questionId, answer.text]));
      const text = snapshot.questions.map((question) => `问题：${question.text}\n回答：${answers.get(question.id) ?? ""}`).filter((item) => !item.endsWith("回答：")).join("\n\n");
      if (text) sources.push({ id: `memory-interview-${interview.id}`, kind: "interview", title: `面试记录 ${new Date(interview.createdAt).toLocaleDateString("zh-CN")}`, text, updatedAt: interview.endedAt ?? interview.createdAt });
    }
    const input: ProjectMemoryAnalysisInput = { profileId, sources };
    const inputSnapshot = sources.map((source) => ({ id: source.id, kind: source.kind, title: source.title, filePath: source.filePath, updatedAt: source.updatedAt, contentHash: createHash("sha256").update(source.text).digest("hex") }));
    const inputHash = createHash("sha256").update(JSON.stringify(inputSnapshot)).digest("hex");
    const runId = `project-memory-${profileId}-${inputHash.slice(0, 16)}`;
    this.analysisRuns?.record({ id: runId, profileId, runType: "project-memory", inputHash, status: "running", inputSnapshot });
    try {
      const snapshot = await new ProjectAnalyzerAgentClass(this.model).analyze(input);
      const saved = this.memories.replaceSnapshot(profileId, snapshot);
      await this.embedFacts?.(profileId);
      this.analysisRuns?.record({ id: runId, profileId, runType: "project-memory", inputHash, status: "completed", inputSnapshot, output: saved });
      this.onUpdated?.(profileId);
      return saved;
    } catch (error) {
      this.analysisRuns?.record({ id: runId, profileId, runType: "project-memory", inputHash, status: "failed", inputSnapshot, error: String(error) });
      throw error;
    }
  }
}

export function createProjectMemoryModel(answerProvider: AnswerProvider, settings: { model: string; apiKey?: string }): ProjectMemoryModel {
  return {
    async generate(input) {
      if (!settings.apiKey) throw new Error("LLM_NOT_CONFIGURED");
      let output = "";
      const sources = input.sources.map((source) => ({ id: source.id, kind: source.kind, title: source.title, filePath: source.filePath, language: source.language, text: source.text.slice(0, 12_000) }));
      for await (const delta of answerProvider.stream({ model: settings.model, maxOutputTokens: 4_000, sections: [
        { name: "system/base", content: "你是 Project Analyzer Agent。只根据真实资料生成 JSON，严禁补写用户没有做过的芯片、模块、代码和结果。每条记录必须引用输入中的 source id。重点提取项目背景、个人职责、技术实现、设计取舍、问题原因、解决方案和结果。" },
        { name: "profile-context", content: JSON.stringify({ profileId: input.profileId, sources }) },
        { name: "output-format", content: "输出 JSON：{projects:[{id,name,description,role,hardware,software,technologyStack,time,confidence}],modules:[{id,projectId,moduleName,description,filePath}],technicalPoints:[{id,projectId,topic,content,importance}],problems:[{id,projectId,problem,cause,solution,result}],interviewQuestions:[{id,projectId,question,answerPoints,keywords}]}。所有数组字段必须是数组。" },
        { name: "question", content: "请生成个人工程经验记忆，而不是通用技术百科。" }
      ] })) output += delta;
      return output;
    }
  };
}

export type { ProjectMemorySource };
