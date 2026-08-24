import { normalizeTechnicalTerms } from "../terminology";
import { extractProjectFacts, ProjectFactConflictResolver, ProjectFactValidator } from "./project-facts";
import { resolveProjectIdentity } from "./project-identity";
import type { ProjectFact, ProjectMemoryAnalysisInput, ProjectInterviewQuestion, ProjectMemoryModel, ProjectMemoryModule, ProjectMemoryProject, ProjectMemorySnapshot, ProjectProblem, ProjectTechnicalPoint } from "./types";

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function slug(text: string): string { return normalizeTechnicalTerms(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 48) || "project"; }
function lines(text: string): string[] { return text.split(/\n+/).map((line) => line.replace(/^[-*•\d.)、]+\s*/, "").trim()).filter((line) => line.length >= 2); }
function afterLabel(text: string, labels: string[]): string[] {
  const pattern = new RegExp(`(?:${labels.join("|")})\\s*[:：]?\\s*([^\\n。；;]+)`, "gi");
  return [...text.matchAll(pattern)].flatMap((match) => String(match[1] ?? "").split(/[、,，/|]/)).map((item) => item.trim()).filter(Boolean);
}
function matchingLines(text: string, pattern: RegExp): string[] { return lines(text).filter((line) => pattern.test(line)); }

function projectName(source: ProjectMemoryAnalysisInput["sources"][number]): string {
  return source.projectName?.trim() || resolveProjectIdentity(source).name || "待确认项目";
}

function buildProject(source: ProjectMemoryAnalysisInput["sources"][number], profileId?: string): ProjectMemoryProject {
  const text = normalizeTechnicalTerms(source.text);
  const scopedFacts = extractProjectFacts({ profileId, projectId: `memory-project-${slug(projectName(source))}`, projectName: projectName(source), sources: [source] });
  const hardware = unique(scopedFacts.filter((item) => item.type === "hardware").map((item) => item.title));
  const software = unique(scopedFacts.filter((item) => item.type === "software").map((item) => item.title));
  const technologyStack = unique(scopedFacts.filter((item) => item.type === "technology" || item.type === "technical_decision").map((item) => item.title));
  const role = scopedFacts.find((item) => item.type === "responsibility")?.content ?? "资料未明确记录";
  const time = scopedFacts.find((item) => item.type === "timeline")?.content;
  const description = scopedFacts.find((item) => item.type === "background" || item.type === "goal")?.content ?? matchingLines(text, /项目背景|项目目标|项目介绍/)[0] ?? lines(text).slice(0, 2).join(" ");
  const projectId = source.projectId ?? `memory-project-${slug(projectName(source))}`;
  return { id: projectId, profileId, name: projectName(source), description: description.slice(0, 800), role: role.slice(0, 400), hardware, software, technologyStack, ...(time ? { time } : {}), sourceIds: [source.id], confidence: source.kind === "repository" ? 0.68 : 0.76 };
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
  const sourceLines = lines(source.text);
  return terms.flatMap((term) => {
    const text = sourceLines.find((line) => line.toLowerCase().includes(term.toLowerCase()));
    return text ? [{ term, text }] : [];
  }).slice(0, 24).map(({ term, text }, index) => {
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

function buildInterviewQuestions(project: ProjectMemoryProject, points: ProjectTechnicalPoint[], problems: ProjectProblem[], facts: ProjectFact[]): ProjectInterviewQuestion[] {
  const factIds = (types: string[]) => facts.filter((item) => types.includes(item.type)).map((item) => item.id);
  const factIdsForTopic = (topic: string) => facts
    .filter((item) => ["technology", "hardware", "software", "module"].includes(item.type))
    .filter((item) => {
      const factTitle = normalizeTechnicalTerms(item.title).toLowerCase();
      const normalizedTopic = normalizeTechnicalTerms(topic).toLowerCase();
      return factTitle === normalizedTopic || factTitle.includes(normalizedTopic) || normalizedTopic.includes(factTitle);
    })
    .map((item) => item.id);
  const result: ProjectInterviewQuestion[] = [];
  const designFactIds = factIds(["background", "goal", "responsibility", "architecture", "technical_decision"]);
  if (designFactIds.length) result.push({ id: `${project.id}-question-design`, projectId: project.id, question: `你在${project.name}里面为什么这么设计？`, answerPoints: [`我的设计依据是${project.technologyStack.slice(0, 4).join("、") || "资料中记录的项目约束"}。`, project.description, `我个人负责的部分是${project.role}。`].filter(Boolean), keywords: unique([project.name, ...project.technologyStack, "设计", "取舍"]), sourceIds: project.sourceIds, factIds: designFactIds });
  const problemFactIds = factIds(["challenge", "cause", "solution", "result"]);
  if (problems.length && problemFactIds.length) result.push({ id: `${project.id}-question-problem`, projectId: project.id, question: `你在${project.name}中遇到什么问题，怎么解决？`, answerPoints: [problems[0].problem, `原因：${problems[0].cause}`, `后来通过${problems[0].solution}，结果：${problems[0].result}`], keywords: unique([project.name, ...problems[0].problem.split(/\s+/), "问题", "解决"]), sourceIds: problems[0].sourceIds, factIds: problemFactIds });
  for (const point of points.slice(0, 8)) {
    const pointFactIds = factIdsForTopic(point.topic);
    if (pointFactIds.length) result.push({ id: `${project.id}-question-${slug(point.topic)}`, projectId: project.id, question: `你在${project.name}中具体怎么实现${point.topic}？`, answerPoints: [point.content, `这部分和${project.role}直接相关。`], keywords: unique([project.name, point.topic, ...project.technologyStack]), sourceIds: point.sourceIds, factIds: pointFactIds });
  }
  return result;
}

export function buildDeterministicProjectMemory(input: ProjectMemoryAnalysisInput): ProjectMemorySnapshot {
  const allowed = input.sources.filter((source) => source.kind !== "resume" && source.kind !== "interview" && (source.kind !== "manual" || source.sourceType === "user_fact"));
  if (allowed.length === 0) return { projects: [], modules: [], technicalPoints: [], problems: [], interviewQuestions: [], facts: [] };
  const groups = input.projectId ? [allowed] : [...new Map(allowed.map((source) => [source.projectId ?? source.id, allowed.filter((item) => (item.projectId ?? item.id) === (source.projectId ?? source.id))])).values()];
  const projects: ProjectMemoryProject[] = [];
  const modules: ProjectMemoryModule[] = [];
  const technicalPoints: ProjectTechnicalPoint[] = [];
  const problems: ProjectProblem[] = [];
  let facts: ProjectFact[] = [];
  for (const group of groups) {
    const first = group[0];
    if (!first) continue;
    const groupInput = { ...input, projectId: input.projectId ?? first.projectId, projectName: input.projectName ?? first.projectName, sources: group };
    const project = buildProject({ ...first, projectId: groupInput.projectId, projectName: groupInput.projectName }, input.profileId);
    project.sourceIds = group.map((source) => source.id);
    projects.push(project);
    const groupFacts = new ProjectFactConflictResolver().resolve(extractProjectFacts({ ...groupInput, projectId: project.id, projectName: project.name }), group);
    facts = [...facts, ...groupFacts];
    modules.push(...group.flatMap((source) => buildModules(project, source)));
    technicalPoints.push(...group.flatMap((source) => buildTechnicalPoints(project, source)));
    problems.push(...group.flatMap((source) => buildProblems(project, source)));
  }
  const interviewQuestions = projects.flatMap((project) => buildInterviewQuestions(project, technicalPoints.filter((item) => item.projectId === project.id), problems.filter((item) => item.projectId === project.id), facts.filter((item) => item.projectId === project.id)));
  return { projects, modules, technicalPoints, problems, interviewQuestions, facts: facts.filter((fact) => ProjectFactValidator.validate(fact).status !== "rejected") };
}

export class ProjectMemoryAgent {
  constructor(private readonly model?: ProjectMemoryModel) {}

  async build(input: ProjectMemoryAnalysisInput): Promise<ProjectMemorySnapshot> {
    const fallback = buildDeterministicProjectMemory(input);
    if (!this.model || input.sources.length === 0) return fallback;
    try {
      // Keep the model call for provider compatibility and telemetry, but do
      // not let unvalidated prose overwrite the evidence-grounded snapshot.
      await this.model.generate(input);
      return fallback;
    } catch {
      return fallback;
    }
  }
}
