export interface ProjectQaGenerationFact {
  id: string;
  type: string;
  title: string;
  content: string;
}

export interface ProjectQaGenerationInput {
  projectName: string;
  facts: ProjectQaGenerationFact[];
  understanding?: string;
  maxQuestions?: number;
}

export interface ProjectQaGenerationCandidate {
  question: string;
  answer: string;
  factIds: string[];
}

export interface ProjectQaGenerationResult {
  requested: number;
  generated: number;
  skipped: number;
  failed: number;
  factCount: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function parseJsonArray(raw: string): unknown[] {
  const candidate = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const candidates = [candidate];
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) candidates.push(candidate.slice(arrayStart, arrayEnd + 1));
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(candidate.slice(objectStart, objectEnd + 1));
  for (const item of candidates) {
    try {
      const parsed = JSON.parse(item) as unknown;
      if (Array.isArray(parsed)) return parsed;
      const object = record(parsed);
      if (Array.isArray(object.questions)) return object.questions;
    } catch { /* The model may have added a short preamble; try the next slice. */ }
  }
  return [];
}

export function buildProjectQaGenerationPrompt(input: ProjectQaGenerationInput): string {
  const maxQuestions = Math.max(1, Math.min(24, Math.floor(input.maxQuestions ?? 12)));
  const facts = input.facts.map((fact) => ({ id: fact.id, type: fact.type, title: fact.title, content: fact.content })).slice(0, 80);
  return [
    `项目名称：${input.projectName}`,
    `目标：基于下方已抽取的 Project Facts 生成最多 ${maxQuestions} 个高价值项目技术追问。`,
    "只能使用提供的事实。只生成能由提供的事实直接支撑的问题；不要从远程资料、常识或未提供的信息补写。",
    "答案必须明确引用事实对应的 factIds，不要编造候选人的职责、主导权、独立完成、决定选型或量化结果。",
    "问题应覆盖架构、关键模块、技术取舍、故障排查、验证结果等不同角度，避免同义重复。",
    "仅返回 JSON 数组，不要 Markdown 或解释。每项格式：{\"question\":\"...\",\"answer\":\"...\",\"factIds\":[\"fact-id\"]}。",
    input.understanding ? `项目理解摘要：${input.understanding.slice(0, 4000)}` : "项目理解摘要：无",
    `Project Facts：${JSON.stringify(facts)}`
  ].join("\n");
}

export function parseProjectQaGeneration(raw: unknown, validFactIds: Iterable<string>): ProjectQaGenerationCandidate[] {
  const valid = new Set(validFactIds);
  const values = typeof raw === "string" ? parseJsonArray(raw) : Array.isArray(raw) ? raw : Array.isArray(record(raw).questions) ? record(raw).questions as unknown[] : [];
  const seen = new Set<string>();
  const result: ProjectQaGenerationCandidate[] = [];
  for (const value of values) {
    const item = record(value);
    const question = text(item.question ?? item.canonicalText);
    const answer = text(item.answer ?? item.answerContent ?? item.content);
    const factIds = stringArray(item.factIds).filter((factId) => valid.has(factId));
    const key = question.toLocaleLowerCase().replace(/[\s\u3000，。！？、；：,.!?;:()（）{}<>《》「」"'`]/g, "");
    if (question.length < 4 || answer.length < 12 || factIds.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push({ question, answer, factIds });
  }
  return result;
}
