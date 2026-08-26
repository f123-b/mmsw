import { normalizeTechnicalTerms } from "../terminology";
import { isProjectParameterFact } from "./project-technical-memory";
import type { ProjectFact, ProjectFactType } from "./types";

export interface ProjectRetrievalHit {
  fact: ProjectFact;
  lexicalScore: number;
  vectorScore: number;
  typeScore: number;
  projectScore: number;
  verifiedBoost: number;
  finalScore: number;
  reason: string;
}

export interface ProjectMemoryRetrievalOptions {
  selectedProjectId?: string;
  detectedProjectId?: string;
  queryEmbedding?: number[];
  questionType?: string;
  topK?: number;
  minScore?: number;
}

function tokens(text: string): string[] {
  const normalized = normalizeTechnicalTerms(text).toLowerCase();
  const words = normalized.match(/[a-z0-9+#.-]+|[\u4e00-\u9fff]/g) ?? [];
  const compact = normalized.replace(/[\s，。！？、,.!?；;：:]+/g, "");
  const bigrams = Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2));
  return [...new Set([...words, ...bigrams])];
}

function lexicalScore(query: string, fact: ProjectFact): number {
  const queryTokens = tokens(query);
  const contentTokens = new Set(tokens(`${fact.title} ${fact.content}`));
  if (queryTokens.length === 0) return 0;
  return queryTokens.filter((token) => contentTokens.has(token)).length / queryTokens.length;
}

function cosine(left?: number[], right?: number[]): number {
  if (!left?.length || !right?.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = Number(left[index] ?? 0);
    const r = Number(right[index] ?? 0);
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm && rightNorm ? Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm))) : 0;
}

function requestedTypes(query: string, questionType?: string): Set<ProjectFactType> {
  const normalized = normalizeTechnicalTerms(query);
  const result = new Set<ProjectFactType>();
  if (/难点|难题|挑战|故障|问题|怎么排查|怎么定位|原因|抖动|卡死|丢帧/.test(normalized)) result.add("challenge");
  if (/怎么选|如何确定|参数|频率|波特率|baud|bitrate|限流|极对数|分辨率|任务周期|超时|timeout|PI|滤波|filter|缓冲区|buffer|队列|queue|采样窗口/.test(normalized)) result.add("parameter");
  if (/为什么|决策|取舍|方案/.test(normalized)) { result.add("technical_decision"); result.add("decision"); }
  if (/怎么解决|解决方案|修复/.test(normalized)) result.add("solution");
  if (/负责|职责|做了什么|贡献|主导/.test(normalized)) result.add("responsibility");
  if (/为什么使用|为什么选|技术栈|芯片|协议|DMA|IIC|CAN|技术/.test(normalized)) {
    result.add("technology");
    result.add("module");
  }
  if (/结果|指标|提升|性能|效果|最终/.test(normalized)) result.add("result");
  if (/背景|介绍.*项目|项目是什么/.test(normalized)) result.add("background");
  if (questionType === "troubleshooting") result.add("challenge");
  if (questionType === "project") result.add("background");
  return result;
}

function projectScore(fact: ProjectFact, options: ProjectMemoryRetrievalOptions): number {
  if (options.selectedProjectId) return fact.projectId === options.selectedProjectId ? 1 : 0;
  if (options.detectedProjectId) return fact.projectId === options.detectedProjectId ? 1 : 0.1;
  return 0.1;
}

function technicalPriority(query: string, fact: ProjectFact): number {
  const normalized = normalizeTechnicalTerms(query).toLowerCase();
  if (isProjectParameterFact(fact)) {
    const exact = (fact.canonicalKey && ((fact.canonicalKey.includes("frequency") && /频率|hz|khz/.test(normalized)) || (fact.canonicalKey.includes("bitrate") && /波特率|bitrate|速率/.test(normalized)) || (fact.canonicalKey.includes("baudrate") && /波特率|baud/.test(normalized)) || (fact.canonicalKey.includes("limit") && /限流|限制|上限|limit/.test(normalized)) || (fact.canonicalKey.includes("pole_pairs") && /极对数|pole/.test(normalized)) || (fact.canonicalKey.includes("resolution") && /分辨率|线数|resolution/.test(normalized)) || (fact.canonicalKey.includes("period") && /周期|任务|period/.test(normalized)) || (fact.canonicalKey === "control.timeout" && /超时|timeout/.test(normalized)) || (fact.canonicalKey === "control.pi" && /\bpi\b|PI参数|增益/.test(normalized)) || (fact.canonicalKey === "control.filter" && /滤波|filter/.test(normalized)) || (fact.canonicalKey === "runtime.buffer.size" && /缓冲区|buffer/.test(normalized)) || (fact.canonicalKey === "runtime.queue.depth" && /队列|queue/.test(normalized)) || (fact.canonicalKey === "sampling.window" && /采样窗口|sampling[\s._-]*window/.test(normalized)))) ? 1.5 : 1.1;
    return exact;
  }
  if (fact.canonicalKey) return 0.9;
  if (["challenge", "cause", "solution", "technical_decision", "decision"].includes(fact.type)) return 0.8;
  return 0.5;
}

/** Lexical + optional embedding + type/project reranking for grounded facts. */
export class ProjectMemoryRetriever {
  search(query: string, facts: ProjectFact[], options: ProjectMemoryRetrievalOptions = {}): ProjectRetrievalHit[] {
    const requested = requestedTypes(query, options.questionType);
    const candidates = options.selectedProjectId ? facts.filter((fact) => fact.projectId === options.selectedProjectId) : facts;
    const hits = candidates.map((fact) => {
      const lexical = lexicalScore(query, fact);
      const vector = cosine(options.queryEmbedding, fact.embedding);
      const priority = technicalPriority(query, fact);
      const typeScore = requested.size === 0 ? Math.min(1, priority) : requested.has(fact.type) ? 1 : 0;
      const project = projectScore(fact, options);
      const verifiedBoost = fact.verified ? 1 : 0;
      const finalScore = 0.45 * vector + 0.20 * lexical + 0.15 * typeScore + 0.10 * project + 0.10 * verifiedBoost + 0.05 * Math.min(1, priority / 1.5);
      const reasons = [
        vector > 0 ? `semantic=${vector.toFixed(2)}` : "semantic=none",
        lexical > 0 ? `lexical=${lexical.toFixed(2)}` : "lexical=none",
        typeScore === 1 ? `fact-type=${fact.type}` : "fact-type=weak",
        project >= 1 ? "project=selected" : project > 0.1 ? "project=detected" : "project=neutral",
        fact.verified ? "verified" : "unverified",
        `priority=${technicalPriority(query, fact).toFixed(1)}`
      ];
      return { fact, lexicalScore: lexical, vectorScore: vector, typeScore, projectScore: project, verifiedBoost, finalScore, reason: reasons.join(" ") };
    });
    return hits
      .filter((hit) => hit.finalScore >= (options.minScore ?? 0.18))
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, Math.max(1, Math.min(50, options.topK ?? 8)));
  }
}
