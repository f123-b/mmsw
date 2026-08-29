import type { ProfileBuilderOutput, ProfileFAQ, ProfileGraphEdge, ProfileGraphNode, ProfileProjectNode } from "./types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringValue(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }
function finiteNumber(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }

function normalizeEdges(value: unknown): ProfileGraphEdge[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const edge = record(item);
    return {
      from: stringValue(edge.from),
      to: stringValue(edge.to),
      relation: stringValue(edge.relation, "related"),
      evidenceIds: stringArray(edge.evidenceIds)
    };
  }).filter((edge) => edge.from && edge.to);
}

function normalizeSkillNodes(value: unknown): ProfileGraphNode[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const node = record(item);
    return { id: stringValue(node.id, `skill-${index + 1}`), label: stringValue(node.label), description: stringValue(node.description), evidenceIds: stringArray(node.evidenceIds) };
  }).filter((node) => node.label);
}

function normalizeProjectNodes(value: unknown): ProfileProjectNode[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const node = record(item);
    return { id: stringValue(node.id, `project-${index + 1}`), name: stringValue(node.name), summary: stringValue(node.summary), highlights: stringArray(node.highlights).slice(0, 8), skills: stringArray(node.skills).slice(0, 24), evidenceIds: stringArray(node.evidenceIds) };
  }).filter((node) => node.name);
}

function normalizeAnswerMaterials(value: unknown): ProfileBuilderOutput["answerMaterials"] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const material = record(item);
    return { id: stringValue(material.id, `answer-${index + 1}`), question: stringValue(material.question), answerPoints: stringArray(material.answerPoints).slice(0, 12), ...(material.topic ? { topic: stringValue(material.topic) } : {}), evidenceIds: stringArray(material.evidenceIds) };
  }).filter((item) => item.question && item.answerPoints.length);
}

function normalizeFaqs(value: unknown): ProfileFAQ[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const faq = record(item);
    const category = ["technical", "project", "behavior", "general"].includes(stringValue(faq.category)) ? stringValue(faq.category) as ProfileFAQ["category"] : "general";
    return { id: stringValue(faq.id, `faq-${index + 1}`), question: stringValue(faq.question), category, ...(faq.answerMaterialId ? { answerMaterialId: stringValue(faq.answerMaterialId) } : {}), frequency: Math.max(1, Math.round(finiteNumber(faq.frequency, 1))), evidenceIds: stringArray(faq.evidenceIds) };
  }).filter((item) => item.question);
}

function parseRaw(raw: unknown): { value: UnknownRecord; error?: string } {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return { value: record(parsed) };
    } catch (error) {
      return { value: {}, error: error instanceof Error ? error.message : "Invalid artifact JSON" };
    }
  }
  return { value: record(raw) };
}

export function normalizeProfileBuilderArtifact(raw: unknown, context: { profileId?: string; status?: ProfileBuilderOutput["status"]; error?: string } = {}): ProfileBuilderOutput {
  const parsed = parseRaw(raw);
  const source = parsed.value;
  const skillGraph = record(source.skillGraph);
  const projectGraph = record(source.projectGraph);
  const warnings = stringArray(source.warnings);
  const parseError = parsed.error ?? context.error;
  if (parseError && !warnings.includes("Profile Builder artifact 无法解析，已使用安全空结构")) warnings.push("Profile Builder artifact 无法解析，已使用安全空结构");
  const status = parseError ? "error" : ["ready", "partial", "error"].includes(stringValue(source.status)) ? stringValue(source.status) as ProfileBuilderOutput["status"] : context.status ?? "partial";
  const normalized: ProfileBuilderOutput = {
    version: Math.max(1, Math.round(finiteNumber(source.version, 1))),
    profileId: stringValue(source.profileId, context.profileId ?? ""),
    generatedAt: finiteNumber(source.generatedAt, Date.now()),
    status,
    analysisQuality: stringValue(source.analysisQuality) === "model" ? "model" : "fallback",
    sourceIds: stringArray(source.sourceIds),
    skillGraph: { nodes: normalizeSkillNodes(skillGraph.nodes), edges: normalizeEdges(skillGraph.edges) },
    projectGraph: { nodes: normalizeProjectNodes(projectGraph.nodes), edges: normalizeEdges(projectGraph.edges) },
    answerMaterials: normalizeAnswerMaterials(source.answerMaterials),
    faqs: normalizeFaqs(source.faqs),
    warnings
  };
  if (parseError) normalized.error = parseError.slice(0, 500);
  return { ...source, ...normalized } as ProfileBuilderOutput;
}
