import { normalizeTechnicalTerms } from "../terminology";
import type { ProjectMemorySnapshot } from "./types";

export type PersonalQuestionType = "project" | "technical" | "behavioral" | "follow-up";

export interface PersonalQuestionAnalysis {
  type: PersonalQuestionType;
  project?: string;
  topic?: string;
  keywords: string[];
  requiresPersonalEvidence: boolean;
  confidence: number;
}

function keywords(text: string): string[] {
  const raw = normalizeTechnicalTerms(text).toLowerCase().match(/[a-z0-9+#]+|[\u4e00-\u9fff]{2,}/gi) ?? [];
  const grams = raw.filter((term) => /^[\u4e00-\u9fff]+$/.test(term) && term.length > 2).flatMap((term) => Array.from({ length: term.length - 1 }, (_item, index) => term.slice(index, index + 2)));
  return [...new Set([...raw, ...grams])];
}

export class QuestionAnalyzer {
  analyze(text: string, projectNames: string[] = []): PersonalQuestionAnalysis {
    const normalized = normalizeTechnicalTerms(text);
    const project = projectNames.find((name) => normalized.toLowerCase().includes(name.toLowerCase()));
    const type: PersonalQuestionType = /项目|负责|做过|经历|实际|为什么这么设计|遇到什么问题|怎么解决|具体怎么实现|结合你的/.test(normalized) || Boolean(project)
      ? "project"
        : /团队|冲突|压力|困难|失败|沟通|协作|优势|缺点|资源有限|高目标|高压力|自主学习|案例/.test(normalized)
        ? "behavioral"
        : /上一题|刚才|继续|展开|具体一点|然后|还有|那如果/.test(normalized) && normalized.length < 42
          ? "follow-up"
          : "technical";
    const explicitPersonalFollowUp = type === "follow-up" && /项目|简历|经历|负责|做过|实际|你的|结合.*经验|结合.*项目/.test(normalized);
    return { type, ...(project ? { project } : {}), topic: keywords(normalized).slice(-5).join(" "), keywords: keywords(normalized), requiresPersonalEvidence: type === "project" || type === "behavioral" || explicitPersonalFollowUp, confidence: project || type === "project" ? 0.92 : type === "technical" ? 0.78 : 0.84 };
  }
}

export interface PersonalMemoryHit {
  text: string;
  projectId: string;
  projectName: string;
  kind: "project" | "module" | "technical-point" | "problem" | "interview-question";
  score: number;
  sourceIds: string[];
}

function score(query: string, text: string): number {
  const queryTerms = keywords(query);
  const normalized = normalizeTechnicalTerms(text).toLowerCase();
  return queryTerms.filter((term) => normalized.includes(term)).length / Math.max(1, queryTerms.length);
}

export class ProjectMemoryRetriever {
  search(query: string, snapshot: ProjectMemorySnapshot, limit = 6): PersonalMemoryHit[] {
    const hits: PersonalMemoryHit[] = [];
    const add = (hit: PersonalMemoryHit) => { if (hit.score > 0) hits.push(hit); };
    for (const project of snapshot.projects) add({ text: `项目：${project.name}\n背景：${project.description}\n我的职责：${project.role}\n技术栈：${project.technologyStack.join("、")}\n硬件：${project.hardware.join("、")}\n软件：${project.software.join("、")}`, projectId: project.id, projectName: project.name, kind: "project", score: score(query, `${project.name} ${project.description} ${project.role} ${project.technologyStack.join(" ")}`) + 0.08, sourceIds: project.sourceIds });
    for (const module of snapshot.modules) { const project = snapshot.projects.find((item) => item.id === module.projectId); if (project) add({ text: `项目：${project.name}\n模块：${module.moduleName}\n实现：${module.description}${module.filePath ? `\n文件：${module.filePath}` : ""}`, projectId: project.id, projectName: project.name, kind: "module", score: score(query, `${project.name} ${module.moduleName} ${module.description}`), sourceIds: module.sourceIds }); }
    for (const point of snapshot.technicalPoints) { const project = snapshot.projects.find((item) => item.id === point.projectId); if (project) add({ text: `项目：${project.name}\n技术点：${point.topic}\n具体实现：${point.content}`, projectId: project.id, projectName: project.name, kind: "technical-point", score: score(query, `${project.name} ${point.topic} ${point.content}`), sourceIds: point.sourceIds }); }
    for (const problem of snapshot.problems) { const project = snapshot.projects.find((item) => item.id === problem.projectId); if (project) add({ text: `项目：${project.name}\n问题：${problem.problem}\n原因：${problem.cause}\n解决：${problem.solution}\n结果：${problem.result}`, projectId: project.id, projectName: project.name, kind: "problem", score: score(query, `${project.name} ${problem.problem} ${problem.cause} ${problem.solution}`) + 0.04, sourceIds: problem.sourceIds }); }
    for (const question of snapshot.interviewQuestions) { const project = snapshot.projects.find((item) => item.id === question.projectId); if (project) add({ text: `项目：${project.name}\n面试问题：${question.question}\n回答要点：${question.answerPoints.join("；")}`, projectId: project.id, projectName: project.name, kind: "interview-question", score: score(query, `${question.question} ${question.keywords.join(" ")} ${question.answerPoints.join(" ")}`) + 0.06, sourceIds: question.sourceIds }); }
    return hits.sort((left, right) => right.score - left.score).slice(0, limit);
  }
}

export interface KnowledgeRoute {
  useProjectMemory: boolean;
  useTechnicalKnowledge: boolean;
  reason: string;
}

export function routeKnowledge(analysis: PersonalQuestionAnalysis): KnowledgeRoute {
  if (analysis.requiresPersonalEvidence && (analysis.type === "project" || analysis.type === "behavioral" || analysis.type === "follow-up")) return { useProjectMemory: true, useTechnicalKnowledge: true, reason: "personal-evidence-first" };
  return { useProjectMemory: false, useTechnicalKnowledge: true, reason: "technical-knowledge-first" };
}
