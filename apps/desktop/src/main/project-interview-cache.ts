import { QuestionBankRouter, type KnowledgeChunk, type QuestionBankQuestionRecord, type QuestionBankRouteResult, type ProjectQaRouteResult } from "@interview-copilot/shared";
import type { ResumeProjectLinkRecord } from "./database";

export interface ProjectInterviewCacheProject {
  id: string;
  name: string;
  aliases: string[];
  questionBankIndex: QuestionBankQuestionRecord[];
  questionAnswers: QuestionBankQuestionRecord[];
  overviewChunks: KnowledgeChunk[];
}

export interface ResumeProjectCacheName {
  id: string;
  name: string;
  aliases?: string[];
}

export interface ProjectInterviewCacheInput {
  profileId: string;
  projects: ProjectInterviewCacheProject[];
  links?: ResumeProjectLinkRecord[];
  resumeProjects?: ResumeProjectCacheName[];
}

export interface ProjectResolution {
  projectId?: string;
  reason: "session" | "confirmed_link" | "explicit_name" | "alias" | "single_project" | "ambiguous" | "none";
  score: number;
  ambiguous: boolean;
}

function searchableTokens(text: string): string[] {
  const normalized = text.trim().toLocaleLowerCase();
  const tokens = normalized.match(/[a-z0-9+#._-]+|[\u4e00-\u9fff]/gi) ?? [];
  return [...new Set(tokens.flatMap((token) => token.length > 2 && /^[\u4e00-\u9fff]+$/.test(token) ? [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))] : [token]))];
}

function lexicalScore(question: string, chunk: KnowledgeChunk): number {
  const query = searchableTokens(question);
  const content = searchableTokens(`${chunk.metadata.filename ?? ""} ${chunk.text}`);
  if (query.length === 0 || content.length === 0) return 0;
  const contentSet = new Set(content);
  const overlap = query.filter((token) => contentSet.has(token)).length / query.length;
  const phrase = chunk.text.toLocaleLowerCase().includes(question.trim().toLocaleLowerCase()) ? 0.35 : 0;
  return Math.min(1, overlap + phrase);
}

/** Session-bound, local-only cache for the project QA first-token path. */
export class ProjectInterviewCache {
  private profileId?: string;
  private readonly projects = new Map<string, ProjectInterviewCacheProject>();
  private readonly confirmedLinks = new Map<string, string>();
  private readonly resumeProjectNames = new Map<string, ResumeProjectCacheName>();
  private readonly router = new QuestionBankRouter();

  prepare(input: ProjectInterviewCacheInput): void {
    this.release();
    this.profileId = input.profileId;
    input.projects.forEach((project) => this.projects.set(project.id, { ...project, aliases: [...project.aliases], questionBankIndex: [...project.questionBankIndex], questionAnswers: [...project.questionAnswers], overviewChunks: [...project.overviewChunks] }));
    input.resumeProjects?.forEach((project) => this.resumeProjectNames.set(project.id, project));
    input.links?.filter((link) => link.confirmed && link.profileId === input.profileId).forEach((link) => this.confirmedLinks.set(link.resumeProjectId, link.projectId));
  }

  get(profileId: string, projectId: string): ProjectInterviewCacheProject | undefined {
    return this.profileId === profileId ? this.projects.get(projectId) : undefined;
  }

  routeProjectQuestion(question: string, projectId: string): ProjectQaRouteResult | undefined {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    return this.router.routeProjectFirst(question, project.questionBankIndex, projectId, { limit: 5 });
  }

  routeQuestion(question: string, projectId: string): QuestionBankRouteResult | undefined {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    return this.router.route(question, project.questionBankIndex, { projectId, limit: 5 });
  }

  searchOverview(question: string, projectId: string, limit = 4): KnowledgeChunk[] {
    const project = this.projects.get(projectId);
    if (!project) return [];
    return project.overviewChunks
      .map((chunk) => ({ chunk, score: lexicalScore(question, chunk) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
      .slice(0, Math.max(1, Math.min(4, limit)))
      .map((item) => item.chunk);
  }

  resolveProject(question: string, options: { explicitProjectId?: string } = {}): ProjectResolution {
    if (options.explicitProjectId && this.projects.has(options.explicitProjectId)) return { projectId: options.explicitProjectId, reason: "session", score: 1, ambiguous: false };
    const text = question.trim().toLocaleLowerCase();
    const confirmedMatches = [...this.resumeProjectNames.values()]
      .filter((resumeProject) => [resumeProject.name, ...(resumeProject.aliases ?? [])].some((name) => name.trim() && text.includes(name.trim().toLocaleLowerCase())))
      .map((resumeProject) => this.confirmedLinks.get(resumeProject.id))
      .filter((projectId): projectId is string => Boolean(projectId && this.projects.has(projectId)));
    if (confirmedMatches.length === 1) return { projectId: confirmedMatches[0], reason: "confirmed_link", score: 0.99, ambiguous: false };
    const matches = [...this.projects.values()].flatMap((project) => [project.name, ...project.aliases, ...(project.name.match(/[A-Za-z][A-Za-z0-9+#-]{2,}/g) ?? [])].filter(Boolean).map((name) => ({ projectId: project.id, name: name.trim() })))
      .filter((item) => item.name && text.includes(item.name.toLocaleLowerCase()))
      .sort((left, right) => right.name.length - left.name.length || left.projectId.localeCompare(right.projectId));
    const ids = [...new Set(matches.map((item) => item.projectId))];
    if (ids.length === 1) return { projectId: ids[0], reason: matches[0].name === this.projects.get(ids[0])?.name ? "explicit_name" : "alias", score: Math.min(0.98, 0.65 + matches[0].name.length / 100), ambiguous: false };
    if (ids.length > 1) return { reason: "ambiguous", score: 0, ambiguous: true };
    if (this.projects.size === 1 && /(?:这个|该|你的|你们的|介绍|做过|参与过).{0,8}项目/u.test(question)) return { projectId: [...this.projects.keys()][0], reason: "single_project", score: 0.9, ambiguous: false };
    return { reason: "none", score: 0, ambiguous: false };
  }

  invalidate(projectId?: string): void {
    if (!projectId) { this.release(); return; }
    this.projects.delete(projectId);
  }

  release(): void {
    this.profileId = undefined;
    this.projects.clear();
    this.confirmedLinks.clear();
    this.resumeProjectNames.clear();
  }
}
