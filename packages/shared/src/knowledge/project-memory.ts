import { normalizeTechnicalTerms } from "../terminology";
import type { ProjectMemoryAnalysisInput, ProjectInterviewQuestion, ProjectMemoryModel, ProjectMemoryModule, ProjectMemoryProject, ProjectMemorySnapshot, ProjectProblem, ProjectTechnicalPoint } from "./types";

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function slug(text: string): string { return normalizeTechnicalTerms(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 48) || "project"; }
function lines(text: string): string[] { return text.split(/\n+/).map((line) => line.replace(/^[-*•\d.)、]+\s*/, "").trim()).filter((line) => line.length >= 2); }
function afterLabel(text: string, labels: string[]): string[] {
  const pattern = new RegExp(`(?:${labels.join("|")})\\s*[:：]?\\s*([^\\n。；;]+)`, "gi");
  return [...text.matchAll(pattern)].flatMap((match) => String(match[1] ?? "").split(/[、,，/|]/)).map((item) => item.trim()).filter(Boolean);
}
function matchingLines(text: string, pattern: RegExp): string[] { return lines(text).filter((line) => pattern.test(line)); }

function projectName(source: ProjectMemoryAnalysisInput["sources"][number]): string {
  if (source.title && !/resume|简历|readme|\.md$|\.txt$/i.test(source.title)) return source.title.replace(/\.[^.]+$/, "").trim();
  const match = source.text.match(/(?:项目(?:名称|经历)?|project)\s*[:：-]?\s*([^\n。；;]{2,60})/i);
  return (match?.[1] ?? "综合项目经历").split(/[，,。；;]/)[0].trim() || "综合项目经历";
}

function buildProject(source: ProjectMemoryAnalysisInput["sources"][number], profileId?: string): ProjectMemoryProject {
  const text = normalizeTechnicalTerms(source.text);
  const hardware = unique(afterLabel(text, ["硬件", "hardware", "芯片", "平台"]));
  const software = unique(afterLabel(text, ["软件", "software", "系统"]));
  const technologyStack = unique([
    ...afterLabel(text, ["技术栈", "技术", "technology", "使用", "掌握"]),
    ...["C/C++", "C++", "Python", "TypeScript", "STM32", "STM32F405", "RK3506", "FOC", "SVPWM", "FreeRTOS", "RTOS", "DMA", "ADC", "PWM", "CAN", "UART", "MQTT", "Linux", "ROS2", "SQLite"].filter((term) => text.toLowerCase().includes(term.toLowerCase()))
  ]).slice(0, 40);
  const role = afterLabel(text, ["个人职责", "我的职责", "负责", "role"])[0] ?? "资料未明确记录";
  const time = afterLabel(text, ["时间", "周期", "time"])[0];
  const description = matchingLines(text, /项目背景|项目目标|项目介绍|系统|平台|架构/)[0] ?? lines(text).slice(0, 2).join(" ");
  return { id: `memory-project-${slug(projectName(source))}`, profileId, name: projectName(source), description: description.slice(0, 800), role: role.slice(0, 400), hardware, software, technologyStack, ...(time ? { time } : {}), sourceIds: [source.id], confidence: source.kind === "repository" ? 0.68 : 0.76 };
}

function buildModules(project: ProjectMemoryProject, source: ProjectMemoryAnalysisInput["sources"][number]): ProjectMemoryModule[] {
  const result: ProjectMemoryModule[] = [];
  const sourceLines = lines(source.text);
  const candidates = sourceLines.filter((line) => /模块|负责|controller|service|manager|driver|通信|控制|数据|ota|web|ui|架构/i.test(line));
  for (const [index, line] of candidates.slice(0, 24).entries()) {
    const [name, description] = line.split(/[:：]/, 2);
    const moduleName = (description ? name : line).trim().slice(0, 80);
    if (!moduleName || result.some((item) => item.moduleName === moduleName)) continue;
    result.push({ id: `${project.id}-module-${index + 1}`, projectId: project.id, moduleName, description: (description ?? line).trim().slice(0, 500), ...(source.filePath ? { filePath: source.filePath } : {}), sourceIds: [source.id] });
  }
  return result;
}

function buildTechnicalPoints(project: ProjectMemoryProject, source: ProjectMemoryAnalysisInput["sources"][number]): ProjectTechnicalPoint[] {
  const terms = ["ADC", "DMA", "PWM", "SVPWM", "FOC", "CAN", "UART", "MQTT", "线程", "任务", "状态机", "数据同步", "OTA", "缓存", "中断", "编码器", "PID"];
  return terms.filter((term) => source.text.toLowerCase().includes(term.toLowerCase())).slice(0, 24).map((term, index) => {
    const text = lines(source.text).find((line) => line.toLowerCase().includes(term.toLowerCase())) ?? `${term}，资料中已记录但缺少具体实现说明。`;
    return { id: `${project.id}-point-${index + 1}`, projectId: project.id, topic: term, content: text.slice(0, 600), importance: /ADC|DMA|PWM|FOC|架构|同步|状态机/.test(term) ? "high" : "medium", sourceIds: [source.id] };
  });
}

function buildProblems(project: ProjectMemoryProject, source: ProjectMemoryAnalysisInput["sources"][number]): ProjectProblem[] {
  const problemLines = matchingLines(source.text, /问题|难点|故障|抖动|噪声|超时|崩溃|异常|定位|排查|解决|优化/);
  return problemLines.slice(0, 20).map((line, index) => {
    const solution = line.match(/(?:解决|方案|通过|后来|优化)\s*[:：]?\s*(.*)/)?.[1] ?? "资料未明确记录解决方案";
    return { id: `${project.id}-problem-${index + 1}`, projectId: project.id, problem: line.slice(0, 500), cause: line.match(/(?:原因|由于|因为)\s*[:：]?\s*(.*)/)?.[1] ?? "资料未明确记录原因", solution: solution.slice(0, 600), result: line.match(/(?:结果|最终|效果)\s*[:：]?\s*(.*)/)?.[1] ?? "资料未明确记录结果", sourceIds: [source.id] };
  });
}

function buildInterviewQuestions(project: ProjectMemoryProject, points: ProjectTechnicalPoint[], problems: ProjectProblem[]): ProjectInterviewQuestion[] {
  const result: ProjectInterviewQuestion[] = [{ id: `${project.id}-question-design`, projectId: project.id, question: `你在${project.name}里面为什么这么设计？`, answerPoints: [`我的设计依据是${project.technologyStack.slice(0, 4).join("、") || "项目的实时性、可靠性和可维护性约束"}。`, project.description, `我个人负责的部分是${project.role}。`].filter(Boolean), keywords: unique([project.name, ...project.technologyStack, "设计", "取舍"]), sourceIds: project.sourceIds }];
  if (problems.length) result.push({ id: `${project.id}-question-problem`, projectId: project.id, question: `你在${project.name}中遇到什么问题，怎么解决？`, answerPoints: [problems[0].problem, `原因：${problems[0].cause}`, `后来通过${problems[0].solution}，结果：${problems[0].result}`], keywords: unique([project.name, ...problems[0].problem.split(/\s+/), "问题", "解决"]), sourceIds: problems[0].sourceIds });
  for (const point of points.slice(0, 8)) result.push({ id: `${project.id}-question-${slug(point.topic)}`, projectId: project.id, question: `你在${project.name}中具体怎么实现${point.topic}？`, answerPoints: [point.content, `这部分和${project.role}直接相关。`], keywords: unique([project.name, point.topic, ...project.technologyStack]), sourceIds: point.sourceIds });
  return result;
}

export function buildDeterministicProjectMemory(input: ProjectMemoryAnalysisInput): ProjectMemorySnapshot {
  const repositorySources = input.sources.filter((source) => source.kind === "repository" || source.kind === "readme");
  const aggregateRepository = repositorySources.length ? { ...repositorySources[0], id: `repository-${slug(repositorySources[0]?.title ?? "project")}`, kind: "project-document" as const, title: "代码仓库", text: repositorySources.map((source) => `文件：${source.filePath ?? source.title}\n${source.text}`).join("\n\n") } : undefined;
  const candidates = [...input.sources.filter((source) => source.kind !== "repository" && source.kind !== "readme" && (source.kind !== "interview" || /项目|负责|实现|问题|方案/.test(source.text))), ...(aggregateRepository ? [aggregateRepository] : [])];
  const projects = candidates.length ? candidates.slice(0, 20).map((source) => {
    const project = buildProject(source, input.profileId);
    const supportingSources = source === aggregateRepository ? repositorySources : input.sources.filter((item) => item.id === source.id);
    return { ...project, sourceIds: supportingSources.map((item) => item.id) };
  }) : [];
  const sourceFor = (project: ProjectMemoryProject) => input.sources.filter((source) => project.sourceIds.includes(source.id));
  const modules = projects.flatMap((project) => sourceFor(project).flatMap((source) => buildModules(project, source)));
  const technicalPoints = projects.flatMap((project) => sourceFor(project).flatMap((source) => buildTechnicalPoints(project, source)));
  const problems = projects.flatMap((project) => sourceFor(project).flatMap((source) => buildProblems(project, source)));
  const interviewQuestions = projects.flatMap((project) => buildInterviewQuestions(project, technicalPoints.filter((item) => item.projectId === project.id), problems.filter((item) => item.projectId === project.id)));
  return { projects, modules, technicalPoints, problems, interviewQuestions };
}

function parseJson(text: string): unknown {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  try { return JSON.parse(json); } catch { return undefined; }
}

function stringArray(value: unknown): string[] { return Array.isArray(value) ? unique(value.map(String)) : []; }
function mergeModelOutput(fallback: ProjectMemorySnapshot, candidate: unknown): ProjectMemorySnapshot {
  if (!candidate || typeof candidate !== "object") return fallback;
  const value = candidate as Partial<ProjectMemorySnapshot>;
  const projectByName = new Map(fallback.projects.map((project) => [project.name.toLowerCase(), project]));
  const projects = Array.isArray(value.projects) ? value.projects.map((item, index) => {
    const name = String(item.name ?? "").trim();
    const base = projectByName.get(name.toLowerCase()) ?? fallback.projects[index];
    if (!name || !base) return undefined;
    return { ...base, ...item, id: base.id, name, hardware: stringArray(item.hardware), software: stringArray(item.software), technologyStack: stringArray(item.technologyStack), sourceIds: base.sourceIds, confidence: Math.max(0, Math.min(1, Number(item.confidence ?? base.confidence))) };
  }).filter((item): item is ProjectMemoryProject => Boolean(item)) : fallback.projects;
  const projectIds = new Set(projects.map((project) => project.id));
  const normalizeProjectItems = <T extends { id: string; projectId: string; sourceIds: string[] }>(items: unknown, base: T[], map: (item: Record<string, unknown>, fallback: T) => T): T[] => Array.isArray(items) ? items.map((raw, index) => {
    const fallbackItem = base[index];
    if (!fallbackItem || !raw || typeof raw !== "object") return undefined;
    const value = raw as Record<string, unknown>;
    const projectId = String(value.projectId ?? fallbackItem.projectId);
    if (!projectIds.has(projectId)) return undefined;
    return map(value, { ...fallbackItem, projectId });
  }).filter((item): item is T => Boolean(item)) : base;
  const modules = normalizeProjectItems(value.modules, fallback.modules, (item, base) => ({ ...base, ...item, id: base.id, projectId: base.projectId, moduleName: String(item.moduleName ?? base.moduleName), description: String(item.description ?? base.description), sourceIds: base.sourceIds }));
  const technicalPoints = normalizeProjectItems(value.technicalPoints, fallback.technicalPoints, (item, base) => ({ ...base, ...item, id: base.id, projectId: base.projectId, topic: String(item.topic ?? base.topic), content: String(item.content ?? base.content), importance: ["high", "medium", "low"].includes(String(item.importance)) ? String(item.importance) as ProjectTechnicalPoint["importance"] : base.importance, sourceIds: base.sourceIds }));
  const problems = normalizeProjectItems(value.problems, fallback.problems, (item, base) => ({ ...base, ...item, id: base.id, projectId: base.projectId, problem: String(item.problem ?? base.problem), cause: String(item.cause ?? base.cause), solution: String(item.solution ?? base.solution), result: String(item.result ?? base.result), sourceIds: base.sourceIds }));
  const interviewQuestions = normalizeProjectItems(value.interviewQuestions, fallback.interviewQuestions, (item, base) => ({ ...base, ...item, id: base.id, projectId: base.projectId, question: String(item.question ?? base.question), answerPoints: stringArray(item.answerPoints).length ? stringArray(item.answerPoints) : base.answerPoints, keywords: stringArray(item.keywords).length ? stringArray(item.keywords) : base.keywords, sourceIds: base.sourceIds }));
  return { projects, modules, technicalPoints, problems, interviewQuestions };
}

export class ProjectMemoryAgent {
  constructor(private readonly model?: ProjectMemoryModel) {}

  async build(input: ProjectMemoryAnalysisInput): Promise<ProjectMemorySnapshot> {
    const fallback = buildDeterministicProjectMemory(input);
    if (!this.model || input.sources.length === 0) return fallback;
    try {
      const generated = await this.model.generate(input);
      return mergeModelOutput(fallback, parseJson(generated));
    } catch {
      return fallback;
    }
  }
}
