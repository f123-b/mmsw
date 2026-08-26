import { normalizeTechnicalTerms } from "../terminology";
import { clampEvidenceLevel, extractProjectFacts, ProjectFactConflictResolver, ProjectFactValidator, systemEvidenceLevel } from "./project-facts";
import { parseMarkdownProjectDocument } from "./project-document-parser";
import { isUsableProjectTimeline } from "./project-timeline";
import { resolveProjectIdentity } from "./project-identity";
import { isFactEligible } from "./project-fact-eligibility";
import { deriveProjectView } from "./project-view";
import { PROJECT_FACT_TYPES, type ProjectFact, type ProjectFactEvidence, type ProjectFactType, type ProjectMemoryAnalysisInput, type ProjectInterviewQuestion, type ProjectMemoryModel, type ProjectMemoryModule, type ProjectMemoryProject, type ProjectMemorySnapshot, type ProjectProblem, type ProjectTechnicalPoint } from "./types";

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function slug(text: string): string { return normalizeTechnicalTerms(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 48) || "project"; }
function projectName(source: ProjectMemoryAnalysisInput["sources"][number]): string { return source.projectName?.trim() || resolveProjectIdentity(source).name || "待确认项目"; }
function sourceLines(text: string): string[] { return text.replace(/\r/g, "").split("\n"); }

function factsForSource(source: ProjectMemoryAnalysisInput["sources"][number], projectId: string, projectNameValue: string, profileId?: string): ProjectFact[] {
  return extractProjectFacts({ profileId, projectId, projectName: projectNameValue, sources: [source] });
}

function buildProject(source: ProjectMemoryAnalysisInput["sources"][number], profileId?: string): ProjectMemoryProject {
  const name = projectName(source);
  const projectId = source.projectId ?? `project-${slug(name)}`;
  const facts = factsForSource(source, projectId, name, profileId);
  const hardware = unique(facts.filter((item) => item.type === "hardware").map((item) => item.title));
  const software = unique(facts.filter((item) => item.type === "software").map((item) => item.title));
  const technologyStack = unique(facts.filter((item) => item.type === "technology" || item.type === "technical_decision" || item.type === "architecture").map((item) => item.title));
  const roles = facts.filter((item) => item.type === "responsibility" && (item.scope ?? "project") === "project").flatMap((item) => item.content.split(/[；;]/).filter((part) => !/(?:由其他成员|其他成员|他人|团队负责|非本人|不是我|不负责)/i.test(part))).map((value) => value.trim()).filter((value) => ProjectFactValidator.validateRole(value).status === "accepted");
  const role = unique(roles).join("；") || "资料未明确记录";
  const timeline = facts.find((item) => item.type === "timeline" && item.title === "项目时间" && isUsableProjectTimeline(item.content))?.content;
  const description = facts.map((item) => item.type === "background" || item.type === "goal" ? item.content : "").find((value) => value.trim().length >= 15) ?? "资料未明确记录";
  return { id: projectId, profileId, name, description: description.slice(0, 800), role: role.slice(0, 700), hardware, software, technologyStack, ...(timeline ? { time: timeline } : {}), sourceIds: [source.id], confidence: source.kind === "repository" ? 0.68 : 0.76 };
}

function buildModules(project: ProjectMemoryProject, source: ProjectMemoryAnalysisInput["sources"][number]): ProjectMemoryModule[] {
  const facts = factsForSource(source, project.id, project.name);
  const moduleFacts = facts.filter((item) => item.type === "module");
  const structure = parseMarkdownProjectDocument(source.text);
  const headingModules = structure.sections.filter((section) => /模块|子系统|驱动|控制环|通信|数据采集|状态机/i.test(section.title)).flatMap((section) => [...section.paragraphs, ...section.bullets].map((content) => ({ title: section.title, content })));
  const candidates = [...moduleFacts.map((item) => ({ title: item.title, content: item.content })), ...headingModules];
  return candidates.slice(0, 24).filter((item, index, all) => item.title && all.findIndex((other) => other.title === item.title && other.content === item.content) === index).map((item, index) => ({ id: `${project.id}-module-${slug(source.id)}-${index + 1}`, projectId: project.id, moduleName: item.title.slice(0, 80), description: item.content.slice(0, 500), ...(source.filePath ? { filePath: source.filePath } : {}), sourceIds: [source.id] }));
}

function buildTechnicalPoints(project: ProjectMemoryProject, source: ProjectMemoryAnalysisInput["sources"][number]): ProjectTechnicalPoint[] {
  const facts = factsForSource(source, project.id, project.name);
  const terms = ["ADC", "DMA", "PWM", "SVPWM", "FOC", "CAN", "UART", "MQTT", "线程", "任务", "状态机", "数据同步", "OTA", "缓存", "中断", "编码器", "PID", "SocketCAN", "Modbus RTU", "NTP"];
  const candidates = facts.filter((item) => ["technology", "hardware", "software", "architecture", "technical_decision", "module"].includes(item.type));
  return terms.flatMap((term) => {
    const match = candidates.find((item) => `${item.title} ${item.content}`.toLowerCase().includes(term.toLowerCase()));
    return match ? [{ term, text: match.content, sourceIds: match.sourceIds }] : [];
  }).slice(0, 24).map(({ term, text, sourceIds }, index) => ({ id: `${project.id}-point-${slug(source.id)}-${index + 1}`, projectId: project.id, topic: term, content: text.slice(0, 600), importance: /ADC|DMA|PWM|FOC|架构|同步|状态机/.test(term) ? "high" : "medium", sourceIds }));
}

function buildProblems(project: ProjectMemoryProject, source: ProjectMemoryAnalysisInput["sources"][number]): ProjectProblem[] {
  const facts = factsForSource(source, project.id, project.name).filter((fact) => isFactEligible(fact));
  const challenges = facts.filter((item) => item.type === "challenge");
  return challenges.sort((left, right) => Number(Boolean(facts.find((fact) => fact.type === "result" && fact.sectionPath?.join("/") === left.sectionPath?.join("/"))) && Boolean(facts.find((fact) => fact.type === "solution" && fact.sectionPath?.join("/") === left.sectionPath?.join("/")))) - Number(Boolean(facts.find((fact) => fact.type === "result" && fact.sectionPath?.join("/") === right.sectionPath?.join("/"))) && Boolean(facts.find((fact) => fact.type === "solution" && fact.sectionPath?.join("/") === right.sectionPath?.join("/")))) || right.confidence - left.confidence).slice(0, 3).map((challenge, index) => {
    const sameSection = (fact: ProjectFact): boolean => Boolean(challenge.sectionPath?.join("/") && fact.sectionPath?.join("/") === challenge.sectionPath?.join("/"));
    const pick = (type: ProjectFactType): string => facts.find((item) => item.type === type && sameSection(item))?.content ?? facts.find((item) => item.type === type)?.content ?? "资料未明确记录";
    return { id: `${project.id}-problem-${slug(source.id)}-${index + 1}`, projectId: project.id, problem: challenge.content.slice(0, 500), cause: pick("cause").slice(0, 500), solution: pick("solution").slice(0, 600), result: pick("result").slice(0, 500), sourceIds: challenge.sourceIds };
  });
}

function buildInterviewQuestions(project: ProjectMemoryProject, points: ProjectTechnicalPoint[], _problems: ProjectProblem[], facts: ProjectFact[]): ProjectInterviewQuestion[] {
  // The question bank is a derived view of eligible facts only. Never use the
  // legacy project's free-form fields here: they may predate source tracking.
  facts = facts.filter((fact) => isFactEligible(fact));
  const factIds = (types: string[]) => facts.filter((item) => types.includes(item.type)).map((item) => item.id);
  const factText = (types: string[], limit = 4): string[] => facts.filter((item) => types.includes(item.type)).slice(0, limit).map((item) => item.content.trim()).filter(Boolean);
  const factIdsForTopic = (topic: string) => facts.filter((item) => ["technology", "hardware", "software", "module"].includes(item.type)).filter((item) => {
    const factTitle = normalizeTechnicalTerms(item.title).toLowerCase();
    const normalizedTopic = normalizeTechnicalTerms(topic).toLowerCase();
    return factTitle === normalizedTopic || factTitle.includes(normalizedTopic) || normalizedTopic.includes(factTitle);
  }).map((item) => item.id);
  const result: ProjectInterviewQuestion[] = [];
  const designFactIds = factIds(["background", "goal", "responsibility", "architecture", "technical_decision"]);
  const designPoints = factText(["background", "goal", "architecture", "technical_decision", "responsibility"], 5);
  if (designFactIds.length) result.push({ id: `${project.id}-question-design`, projectId: project.id, question: `你在${project.name}里面为什么这么设计？`, answerPoints: designPoints, keywords: unique([project.name, ...facts.filter((item) => ["technology", "hardware", "software"].includes(item.type)).map((item) => item.title).slice(0, 8), "设计", "取舍"]), sourceIds: unique(facts.filter((item) => designFactIds.includes(item.id)).flatMap((item) => item.sourceIds)), factIds: designFactIds });
  const problemFactIds = factIds(["challenge", "cause", "solution", "result"]);
  const problemPoints = factText(["challenge", "cause", "solution", "result"], 6);
  if (problemFactIds.length && problemPoints.length) result.push({ id: `${project.id}-question-problem`, projectId: project.id, question: `你在${project.name}中遇到什么问题，怎么解决？`, answerPoints: problemPoints, keywords: unique([project.name, "问题", "原因", "解决", "结果"]), sourceIds: unique(facts.filter((item) => problemFactIds.includes(item.id)).flatMap((item) => item.sourceIds)), factIds: problemFactIds });
  const uniquePoints = points.filter((point, index, all) => all.findIndex((item) => item.topic.toLowerCase() === point.topic.toLowerCase()) === index);
  for (const point of uniquePoints.slice(0, 8)) {
    const pointFactIds = factIdsForTopic(point.topic);
    if (pointFactIds.length) {
      const pointFacts = facts.filter((fact) => pointFactIds.includes(fact.id));
      result.push({ id: `${project.id}-question-${slug(point.topic)}`, projectId: project.id, question: `你在${project.name}中具体怎么实现${point.topic}？`, answerPoints: pointFacts.map((fact) => fact.content).filter(Boolean), keywords: unique([project.name, point.topic, ...pointFacts.map((fact) => fact.title)]), sourceIds: unique(pointFacts.flatMap((fact) => fact.sourceIds)), factIds: pointFactIds });
    }
  }
  return result;
}

export function buildDeterministicProjectMemory(input: ProjectMemoryAnalysisInput): ProjectMemorySnapshot {
  const allowed = input.sources.filter((source) => source.sourceRole !== "reference" && source.kind !== "resume" && source.kind !== "interview" && (source.kind !== "manual" || source.sourceType === "user_fact"));
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
    const groupFacts = new ProjectFactConflictResolver().resolve(extractProjectFacts({ ...groupInput, projectId: project.id, projectName: project.name }), group);
    const projectView = deriveProjectView({ ...project, sourceIds: group.map((source) => source.id) }, groupFacts);
    // The persisted/UI view re-derives responsibility from eligible facts.
    // Keep the historical in-memory fallback for callers that consume the
    // deterministic analyzer before persistence has applied that boundary.
    projects.push({ ...projectView, role: projectView.role || project.role, sourceIds: group.map((source) => source.id) });
    facts = [...facts, ...groupFacts];
    modules.push(...group.flatMap((source) => buildModules(project, source)).filter((item, index, all) => all.findIndex((other) => other.moduleName === item.moduleName && other.description === item.description) === index).slice(0, 6));
    technicalPoints.push(...group.flatMap((source) => buildTechnicalPoints(project, source)));
    problems.push(...group.flatMap((source) => buildProblems(project, source)));
  }
  const interviewQuestions = projects.flatMap((project) => buildInterviewQuestions(project, technicalPoints.filter((item) => item.projectId === project.id), problems.filter((item) => item.projectId === project.id), facts.filter((fact) => fact.projectId === project.id)));
  return { projects, modules, technicalPoints, problems, interviewQuestions, facts: facts.filter((fact) => ProjectFactValidator.validate(fact).status !== "rejected") };
}

interface CandidateEvidence { sourceId?: string; quote?: string; locator?: string; }
interface CandidateFact { id?: string; projectId?: string; factType?: string; type?: string; title?: string; content?: string; confidence?: number; scope?: string; evidenceLevel?: string; sources?: CandidateEvidence[]; evidence?: CandidateEvidence[]; }

function parseJsonOutput(raw: string): Record<string, unknown> | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { const value: unknown = JSON.parse(fenced.slice(start, end + 1)); return value && typeof value === "object" ? value as Record<string, unknown> : undefined; } catch { return undefined; }
}

function compact(value: string): string { return value.replace(/[\s\u3000]+/g, " ").trim(); }
function evidenceExists(sourceText: string, quote: string): boolean { return compact(sourceText).includes(compact(quote)) || compact(sourceText).includes(compact(quote).replace(/[|｜]/g, " ")); }

function parseCandidateFacts(raw: string, input: ProjectMemoryAnalysisInput): ProjectFact[] {
  const parsed = parseJsonOutput(raw);
  const candidates = Array.isArray(parsed?.facts) ? parsed.facts as CandidateFact[] : [];
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  const projectId = input.projectId ?? `project-${slug(input.projectName ?? "unknown")}`;
  const result: ProjectFact[] = [];
  for (const candidate of candidates) {
    const type = candidate.factType ?? candidate.type;
    if (!type || !PROJECT_FACT_TYPES.includes(type as ProjectFactType) || !candidate.title?.trim() || !candidate.content?.trim()) continue;
    const candidateEvidence = [...(candidate.sources ?? []), ...(candidate.evidence ?? [])];
    const evidenceItems: ProjectFactEvidence[] = [];
    for (const item of candidateEvidence) {
      const source = item.sourceId ? sources.get(item.sourceId) : undefined;
      if (!source || source.sourceRole === "reference" || !item.quote?.trim() || !evidenceExists(source.text, item.quote)) continue;
      evidenceItems.push({ sourceId: source.id, quote: item.quote.trim().slice(0, 800), ...(item.locator ? { locator: item.locator } : {}) });
    }
    if (!evidenceItems.length) continue;
    const firstSource = sources.get(evidenceItems[0]?.sourceId ?? "");
    if (!firstSource) continue;
    const requestedEvidenceLevel = ["confirmed-user", "confirmed-code", "confirmed-document", "inferred", "pending", "risk", "not-measured"].includes(String(candidate.evidenceLevel)) ? candidate.evidenceLevel as ProjectFact["evidenceLevel"] : undefined;
    const sourceEvidence = evidenceItems.map((item) => sources.get(item.sourceId)).filter((source): source is NonNullable<typeof source> => Boolean(source));
    const systemLevel = sourceEvidence.map(systemEvidenceLevel).sort((a, b) => {
      const rank = (level: NonNullable<ProjectFact["evidenceLevel"]>): number => ({ pending: 0, inferred: 0, risk: 0, "not-measured": 0, "confirmed-document": 1, "confirmed-code": 2, "confirmed-user": 3 }[level]);
      return rank(b) - rank(a);
    })[0] ?? "pending";
    const evidenceLevel = clampEvidenceLevel(systemLevel, requestedEvidenceLevel);
    const candidateFact: ProjectFact = {
      id: candidate.id?.trim() || `${projectId}-llm-fact-${slug(candidate.title)}-${slug(candidate.content).slice(0, 18)}`,
      projectId,
      type: type as ProjectFactType,
      factType: type as ProjectFactType,
      title: candidate.title.trim().slice(0, 120),
      content: candidate.content.trim().slice(0, 1_000),
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0.65)),
      verified: false,
      sourceIds: [...new Set(evidenceItems.map((item) => item.sourceId))],
      evidence: evidenceItems,
      scope: candidate.scope === "module" || candidate.scope === "problem" || candidate.scope === "architecture" ? candidate.scope : "project",
      evidenceLevel,
      ownership: type === "responsibility" ? "unknown" : "project",
      status: "pending_review"
    };
    const sanitized = ProjectFactValidator.sanitize(candidateFact);
    if (sanitized) result.push(sanitized);
  }
  return result;
}

function mergeSnapshots(base: ProjectMemorySnapshot, candidates: ProjectFact[], input: ProjectMemoryAnalysisInput): ProjectMemorySnapshot {
  if (!candidates.length) return base;
  const facts = new ProjectFactConflictResolver().resolve([...(base.facts ?? []), ...candidates], input.sources);
  return { ...base, facts };
}

export class ProjectMemoryAgent {
  constructor(private readonly model?: ProjectMemoryModel) {}

  async build(input: ProjectMemoryAnalysisInput): Promise<ProjectMemorySnapshot> {
    const fallback = buildDeterministicProjectMemory(input);
    if (!this.model || input.sources.length === 0) return fallback;
    try {
      const raw = await this.model.generate(input);
      return mergeSnapshots(fallback, parseCandidateFacts(raw, input), input);
    } catch {
      return fallback;
    }
  }
}
