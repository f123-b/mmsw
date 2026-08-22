import type {
  InterviewAnswerMaterial,
  ProfileBuilderInput,
  ProfileBuilderModel,
  ProfileBuilderOutput,
  ProfileBuilderSource,
  ProfileFAQ,
  ProfileGraphEdge,
  ProfileGraphNode,
  ProfileProjectGraph,
  ProfileProjectNode,
  ProfileSkillGraph
} from "./types";
import { normalizeTechnicalTerms } from "../terminology";

const SKILL_CATALOG = [
  "C/C++", "Rust", "TypeScript", "JavaScript", "Python", "Electron", "RTOS", "FreeRTOS",
  "FOC", "电机控制", "CAN", "UART", "SPI", "IIC", "I2C", "DMA", "中断", "PWM", "编码器",
  "SQLite", "RAG", "Embedding", "ASR", "VAD", "LLM", "Docker", "Git", "WebSocket",
  "消息队列", "异步消息", "微服务", "Linux", "Windows"
];

function normalize(text: string): string {
  return normalizeTechnicalTerms(text);
}

function slug(text: string): string {
  return normalize(text).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function excerpt(source: ProfileBuilderSource, term?: string, max = 220): string {
  const text = normalize(source.text);
  if (!text) return "";
  const index = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1;
  const start = index >= 0 ? Math.max(0, index - 80) : 0;
  return text.slice(start, start + max).trim();
}

function evidenceFor(sources: ProfileBuilderSource[], term: string): { ids: string[]; excerpts: string[] } {
  const matches = sources.filter((source) => normalize(source.text).toLowerCase().includes(normalize(term).toLowerCase()));
  return { ids: matches.map((source) => source.id), excerpts: matches.slice(0, 2).map((source) => excerpt(source, term)).filter(Boolean) };
}

function projectNames(sources: ProfileBuilderSource[]): Array<{ name: string; source: ProfileBuilderSource }> {
  const found: Array<{ name: string; source: ProfileBuilderSource }> = [];
  const heading = /(?:项目(?:名称|经历)?|project)\s*[:：-]?\s*([^。；;\n]{2,42})/gi;
  for (const source of sources) {
    if (source.kind === "project" && source.title.trim()) found.push({ name: source.title.trim(), source });
    for (const match of source.text.matchAll(heading)) {
      const name = normalize(match[1] ?? "").replace(/[，,。；;].*$/, "");
      if (name && !/经历|内容|介绍/.test(name)) found.push({ name, source });
    }
  }
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = item.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function projectSummary(name: string, sources: ProfileBuilderSource[], evidenceIds: string[]): string {
  const source = sources.find((item) => evidenceIds.includes(item.id));
  return source ? excerpt(source, name, 300) || excerpt(source, undefined, 300) : `${name}，项目资料待补充。`;
}

function buildSkillGraph(input: ProfileBuilderInput): ProfileSkillGraph {
  const nodes: ProfileGraphNode[] = [];
  for (const skill of SKILL_CATALOG) {
    const evidence = evidenceFor(input.sources, skill);
    if (evidence.ids.length === 0) continue;
    nodes.push({ id: `skill-${slug(skill)}`, label: skill, description: evidence.excerpts[0] || `资料中提到${skill}。`, evidenceIds: evidence.ids });
  }
  const edges: ProfileGraphEdge[] = [];
  for (const left of nodes) {
    for (const right of nodes) {
      if (left.id >= right.id) continue;
      const shared = unique(left.evidenceIds.filter((id) => right.evidenceIds.includes(id)));
      if (shared.length) edges.push({ from: left.id, to: right.id, relation: "co-mentioned", evidenceIds: shared });
    }
  }
  return { nodes, edges: edges.slice(0, 80) };
}

function buildProjectGraph(input: ProfileBuilderInput, skills: ProfileSkillGraph): ProfileProjectGraph {
  const projects = projectNames(input.sources);
  if (projects.length === 0) {
    const fallback = input.sources.find((source) => /项目|系统|平台|控制/.test(source.text));
    if (fallback) projects.push({ name: "综合项目经历", source: fallback });
  }
  const nodes: ProfileProjectNode[] = projects.map(({ name, source }) => {
    const relatedSkills = skills.nodes.filter((skill) => input.sources.find((item) => item.id === source.id)?.text.toLowerCase().includes(skill.label.toLowerCase())).map((skill) => skill.label);
    const evidenceIds = unique([source.id, ...skills.nodes.filter((skill) => relatedSkills.includes(skill.label)).flatMap((skill) => skill.evidenceIds)]);
    const summary = projectSummary(name, input.sources, evidenceIds);
    const highlights = [summary].filter(Boolean);
    return { id: `project-${slug(name)}`, name, summary, highlights, skills: relatedSkills, evidenceIds };
  });
  const edges: ProfileGraphEdge[] = [];
  for (const project of nodes) for (const skill of project.skills) {
    const skillNode = skills.nodes.find((node) => node.label === skill);
    edges.push({ from: project.id, to: skillNode?.id ?? `skill-${slug(skill)}`, relation: "uses-skill", evidenceIds: project.evidenceIds.filter((id) => skillNode?.evidenceIds.includes(id) ?? false) });
  }
  return { nodes, edges };
}

function historyMaterials(input: ProfileBuilderInput): InterviewAnswerMaterial[] {
  const materials: InterviewAnswerMaterial[] = [];
  for (const source of input.sources.filter((item) => item.kind === "interview")) {
    const match = source.text.match(/问题\s*[:：]\s*([^\n]+)\n回答\s*[:：]\s*([\s\S]+)/);
    if (!match) continue;
    const question = normalize(match[1] ?? "");
    const answer = normalize(match[2] ?? "");
    if (!question || !answer) continue;
    materials.push({ id: `answer-${slug(question)}-${source.id}`, question, answerPoints: [answer.slice(0, 500)], topic: source.title, evidenceIds: [source.id] });
  }
  return materials;
}

function generatedMaterials(input: ProfileBuilderInput, projects: ProfileProjectGraph, skills: ProfileSkillGraph): InterviewAnswerMaterial[] {
  const materials: InterviewAnswerMaterial[] = [];
  for (const project of projects.nodes) {
    const evidenceIds = project.evidenceIds;
    materials.push({ id: `answer-intro-${project.id}`, question: `请介绍一下${project.name}`, answerPoints: [`我在${project.name}中主要负责${project.skills.slice(0, 3).join("、") || "核心功能开发"}。`, ...project.highlights.slice(0, 2)], topic: project.name, evidenceIds });
    materials.push({ id: `answer-hard-${project.id}`, question: `${project.name}里面最难的问题是什么`, answerPoints: [`这个项目的难点集中在${project.skills.slice(0, 3).join("、") || "稳定性和实时性"}，我会先结合现有资料说明具体处理方式。`, ...project.highlights.slice(0, 1)], topic: project.name, evidenceIds });
  }
  for (const skill of skills.nodes.slice(0, 16)) {
    materials.push({ id: `answer-skill-${skill.id}`, question: `为什么选择${skill.label}`, answerPoints: [skill.description], topic: skill.label, evidenceIds: skill.evidenceIds });
  }
  return materials;
}

function buildFaqs(materials: InterviewAnswerMaterial[]): ProfileFAQ[] {
  return materials.slice(0, 40).map((material) => ({ id: `faq-${material.id}`, question: material.question, category: /项目|负责|难点|经历/.test(material.question) ? "project" : "technical", answerMaterialId: material.id, frequency: 1, evidenceIds: material.evidenceIds }));
}

export function buildDeterministicProfile(input: ProfileBuilderInput, generatedAt = Date.now()): ProfileBuilderOutput {
  const skillGraph = buildSkillGraph(input);
  const projectGraph = buildProjectGraph(input, skillGraph);
  const answerMaterials = [...historyMaterials(input), ...generatedMaterials(input, projectGraph, skillGraph)].slice(0, 80);
  const warnings: string[] = [];
  if (!input.sources.some((source) => source.kind === "resume")) warnings.push("尚未上传 Resume，技能提取可能不完整");
  if (!projectGraph.nodes.length) warnings.push("尚未识别到项目经历，请补充项目资料");
  if (!input.sources.some((source) => source.kind === "interview")) warnings.push("暂无面试历史，回答素材将以资料提取为主");
  return { version: 1, profileId: input.profileId, generatedAt, status: warnings.length > 0 ? "partial" : "ready", sourceIds: input.sources.map((source) => source.id), skillGraph, projectGraph, answerMaterials, faqs: buildFaqs(answerMaterials), warnings };
}

function parseJson(text: string): unknown {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  return json ? JSON.parse(json) : undefined;
}

function validEvidence(ids: unknown, sourceIds: Set<string>): string[] {
  return Array.isArray(ids) ? unique(ids.map(String).filter((id) => sourceIds.has(id))) : [];
}

function mergeModelOutput(fallback: ProfileBuilderOutput, candidate: unknown, input: ProfileBuilderInput): ProfileBuilderOutput {
  if (!candidate || typeof candidate !== "object") return fallback;
  const sourceIds = new Set(input.sources.map((source) => source.id));
  const model = candidate as Partial<ProfileBuilderOutput>;
  const skillNodes = Array.isArray(model.skillGraph?.nodes) ? model.skillGraph.nodes.map((node) => ({ id: String(node.id ?? `skill-${slug(String(node.label ?? ""))}`), label: String(node.label ?? ""), description: String(node.description ?? ""), evidenceIds: validEvidence(node.evidenceIds, sourceIds) })).filter((node) => node.label && node.evidenceIds.length) : [];
  const projectNodes = Array.isArray(model.projectGraph?.nodes) ? model.projectGraph.nodes.map((node) => ({ id: String(node.id ?? `project-${slug(String(node.name ?? ""))}`), name: String(node.name ?? ""), summary: String(node.summary ?? ""), highlights: Array.isArray(node.highlights) ? node.highlights.map(String).slice(0, 5) : [], skills: Array.isArray(node.skills) ? node.skills.map(String).slice(0, 12) : [], evidenceIds: validEvidence(node.evidenceIds, sourceIds) })).filter((node) => node.name && node.evidenceIds.length) : [];
  const answerMaterials = Array.isArray(model.answerMaterials) ? model.answerMaterials.map((item) => ({ id: String(item.id ?? `answer-${slug(String(item.question ?? ""))}`), question: String(item.question ?? ""), answerPoints: Array.isArray(item.answerPoints) ? item.answerPoints.map(String).slice(0, 6) : [], topic: item.topic ? String(item.topic) : undefined, evidenceIds: validEvidence(item.evidenceIds, sourceIds) })).filter((item) => item.question && item.answerPoints.length && item.evidenceIds.length) : [];
  const faqs = Array.isArray(model.faqs) ? model.faqs.map((item) => ({ id: String(item.id ?? `faq-${slug(String(item.question ?? ""))}`), question: String(item.question ?? ""), category: ["technical", "project", "behavior", "general"].includes(String(item.category)) ? String(item.category) as ProfileFAQ["category"] : "general", answerMaterialId: item.answerMaterialId ? String(item.answerMaterialId) : undefined, frequency: Math.max(1, Number(item.frequency ?? 1)), evidenceIds: validEvidence(item.evidenceIds, sourceIds) })).filter((item) => item.question && item.evidenceIds.length) : [];
  if (!skillNodes.length && !projectNodes.length && !answerMaterials.length) return fallback;
  return {
    ...fallback,
    status: "ready",
    skillGraph: { nodes: skillNodes.length ? skillNodes : fallback.skillGraph.nodes, edges: fallback.skillGraph.edges },
    projectGraph: { nodes: projectNodes.length ? projectNodes : fallback.projectGraph.nodes, edges: fallback.projectGraph.edges },
    answerMaterials: answerMaterials.length ? answerMaterials : fallback.answerMaterials,
    faqs: faqs.length ? faqs : fallback.faqs,
    warnings: [...fallback.warnings, "部分图谱由 Profile Builder Agent 生成，所有条目均保留来源证据"]
  };
}

export class ProfileBuilderAgent {
  constructor(private readonly model?: ProfileBuilderModel) {}

  async build(input: ProfileBuilderInput, generatedAt = Date.now()): Promise<ProfileBuilderOutput> {
    const fallback = buildDeterministicProfile(input, generatedAt);
    if (!this.model || input.sources.length === 0) return fallback;
    try {
      const raw = await this.model.generate({ profile: input, fallback });
      return mergeModelOutput(fallback, parseJson(raw), input);
    } catch {
      return { ...fallback, warnings: [...fallback.warnings, "Profile Builder Agent 暂不可用，已使用本地规则提取"] };
    }
  }
}
