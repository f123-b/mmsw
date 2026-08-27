import type { ProjectUnderstanding } from "./types";

export type ProjectUnderstandingRoute = "architecture" | "flow" | "parameter" | "decision" | "problem" | "result" | "general";

export interface ProjectUnderstandingHit {
  kind: "component" | "relationship" | "flow" | "parameter" | "decision" | "problem" | "result" | "unknown";
  id: string;
  title: string;
  content: string;
  evidenceRefs: string[];
  score: number;
}

export interface ProjectUnderstandingRetrievalResult {
  route: ProjectUnderstandingRoute;
  hits: ProjectUnderstandingHit[];
}

function routeForQuery(query: string): ProjectUnderstandingRoute {
  if (/参数|频率|时钟|周期|速率|分辨率|极对数|配置|设定|frequency|clock|period|rate|resolution/i.test(query)) return "parameter";
  if (/为什么|为何|选择|决策|取舍|原因|同步|why|decision|tradeoff|rationale/i.test(query)) return "decision";
  if (/问题|故障|异常|抖动|排查|修复|低速|problem|fault|debug|fix|issue/i.test(query)) return "problem";
  if (/结果|指标|性能|测量|达到|误差|result|metric|measure|performance/i.test(query)) return "result";
  if (/流程|运行|启动|数据流|控制链|怎么工作|如何工作|执行|flow|runtime|data path|control loop/i.test(query)) return "flow";
  if (/架构|模块|组成|接口|通信|依赖|architecture|module|component|interface/i.test(query)) return "architecture";
  return "general";
}

function words(query: string): string[] {
  return query.toLowerCase().split(/[\s,，。！？、:：;；/]+/).filter((word) => word.length >= 2);
}

function scoreText(query: string, text: string, base: number): number {
  const normalized = text.toLowerCase();
  return base + words(query).reduce((score, word) => score + (normalized.includes(word) ? 2 : 0), 0);
}

/** Routes questions into the comprehension model before Fact-first joins add grounding detail. */
export class ProjectComprehensionRetriever {
  search(query: string, understanding: ProjectUnderstanding | undefined, limit = 5): ProjectUnderstandingRetrievalResult {
    const route = routeForQuery(query);
    if (!understanding) return { route, hits: [] };
    const hits: ProjectUnderstandingHit[] = [];
    const include = (hit: ProjectUnderstandingHit) => hits.push(hit);
    for (const component of understanding.architecture.components) include({ kind: "component", id: component.id, title: component.name, content: component.description, evidenceRefs: component.evidenceRefs ?? [], score: scoreText(query, `${component.name} ${component.description}`, route === "architecture" ? 8 : 2) });
    for (const relationship of understanding.architecture.relationships) include({ kind: "relationship", id: `${relationship.from}-${relationship.to}-${relationship.relation}`, title: `${relationship.from} ${relationship.relation} ${relationship.to}`, content: relationship.description ?? "", evidenceRefs: relationship.evidenceRefs, score: scoreText(query, `${relationship.from} ${relationship.to} ${relationship.relation} ${relationship.description ?? ""}`, route === "flow" || route === "architecture" ? 8 : 2) });
    for (const flow of [...understanding.runtimeFlows, ...understanding.dataFlows, ...understanding.controlFlows]) include({ kind: "flow", id: flow.id, title: flow.name, content: `${flow.description} ${flow.steps.map((step) => step.action).join("；")}`, evidenceRefs: flow.evidenceRefs ?? [], score: scoreText(query, `${flow.name} ${flow.description}`, route === "flow" ? 10 : 2) });
    for (const parameter of understanding.parameters) include({ kind: "parameter", id: parameter.id, title: parameter.name, content: `${parameter.semanticKey}=${parameter.value ?? "unknown"}${parameter.unit ?? ""} ${parameter.context ?? ""}`, evidenceRefs: parameter.evidenceRefs, score: scoreText(query, `${parameter.name} ${parameter.semanticKey} ${parameter.value ?? ""} ${parameter.context ?? ""}`, route === "parameter" ? 10 : 2) });
    for (const decision of understanding.decisions) include({ kind: "decision", id: decision.id, title: decision.decision, content: `${decision.choice} ${decision.rationale ?? ""} ${decision.tradeoff ?? ""}`, evidenceRefs: decision.evidenceRefs, score: scoreText(query, `${decision.decision} ${decision.choice} ${decision.rationale ?? ""}`, route === "decision" ? 10 : 2) });
    for (const problem of understanding.problems) include({ kind: "problem", id: problem.id, title: problem.problem, content: `${problem.symptom} ${problem.causeChain.join("；")} ${problem.fix}`, evidenceRefs: problem.evidenceRefs, score: scoreText(query, `${problem.problem} ${problem.symptom} ${problem.fix}`, route === "problem" ? 10 : 2) });
    for (const result of understanding.results) include({ kind: "result", id: result.id, title: result.name, content: result.value, evidenceRefs: result.evidenceRefs, score: scoreText(query, `${result.name} ${result.value}`, route === "result" ? 10 : 2) });
    for (const unknown of understanding.unknowns) include({ kind: "unknown", id: unknown.id, title: unknown.claim, content: unknown.reason, evidenceRefs: unknown.evidenceRefs, score: scoreText(query, `${unknown.claim} ${unknown.reason}`, 1) });
    return { route, hits: hits.sort((left, right) => right.score - left.score || left.title.localeCompare(right.title)).slice(0, Math.max(0, limit)) };
  }
}

export function retrieveProjectUnderstanding(query: string, understanding: ProjectUnderstanding | undefined, limit = 5): ProjectUnderstandingRetrievalResult {
  return new ProjectComprehensionRetriever().search(query, understanding, limit);
}

