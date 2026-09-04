import { isFactEligible } from "../knowledge/project-fact-eligibility";
import { formatProjectFactValue } from "../knowledge/project-technical-memory";
import type { ProjectFact } from "../knowledge/types";

export interface ProjectQaEvidenceIssue {
  code: "missing-facts" | "invalid-fact" | "unsupported-quantity" | "unconfirmed-ownership" | "inflated-ownership";
  severity: "error" | "warning";
  message: string;
  sentence?: string;
  factId?: string;
}

export interface ProjectQaEvidenceAudit {
  /** Local risk checks are not semantic verification or human approval. */
  requiresHumanReview: true;
  blocked: boolean;
  issues: ProjectQaEvidenceIssue[];
  factIds: string[];
}

/** Use the same eligibility policy as interview retrieval, with balanced type coverage. */
export function selectProjectQaGenerationFacts(facts: readonly ProjectFact[], projectId: string, limit = 80): ProjectFact[] {
  const groups = new Map<string, ProjectFact[]>();
  const seen = new Set<string>();
  for (const fact of facts) {
    if (fact.projectId !== projectId || !isFactEligible(fact) || !fact.title.trim() || !fact.content.trim() || seen.has(fact.id)) continue;
    seen.add(fact.id);
    // Section/module coverage matters as well as fact type in a large repository.
    const key = `${fact.type}:${fact.sectionPath?.[0] ?? fact.scope ?? "project"}`;
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  const selected: ProjectFact[] = [];
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(80, Math.floor(limit))) : 80;
  for (let offset = 0; selected.length < maximum; offset += 1) {
    let added = false;
    for (const group of groups.values()) {
      if (selected.length >= maximum) break;
      if (group[offset]) { selected.push(group[offset]); added = true; }
    }
    if (!added) break;
  }
  return selected;
}

function compact(text: string): string { return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, ""); }

// Units are retained: 20 kHz can match 20000 Hz, but never 20 ms or 20%.
const QUANTITY = /(?<![A-Za-z0-9_.])(-?\d+(?:\.\d+)?)\s*(MHz|kHz|Hz|毫秒|微秒|秒|ms|[uµμ]s|s|MB|KB|GB|Mbps|kbps|bps|%|％|人|路|次|倍|分钟|小时|天|周|个月|年)(?![A-Za-z])/giu;
const UNITS: Record<string, [string, number]> = {
  hz: ["frequency", 1], khz: ["frequency", 1_000], mhz: ["frequency", 1_000_000],
  s: ["time", 1], 秒: ["time", 1], ms: ["time", .001], 毫秒: ["time", .001], us: ["time", .000001], "μs": ["time", .000001], 微秒: ["time", .000001],
  分钟: ["time", 60], 小时: ["time", 3600], 天: ["time", 86400],
  bps: ["bitrate", 1], kbps: ["bitrate", 1000], mbps: ["bitrate", 1_000_000]
};

function quantities(text: string): Array<{ key: string; raw: string }> {
  return [...text.normalize("NFKC").matchAll(QUANTITY)].map((match) => {
    const unit = match[2].toLowerCase();
    const [dimension, scale] = UNITS[unit] ?? [unit, 1];
    return { key: `${dimension}:${Number((Number(match[1]) * scale).toPrecision(12))}`, raw: match[0] };
  });
}

/**
 * Deterministic preflight for NEW project QA and the review UI only.
 * It deliberately does not replace runtime guards or certify paraphrases.
 */
export function auditProjectQaEvidence(input: { projectId: string; answer: string; factIds: readonly string[]; facts: readonly ProjectFact[] }): ProjectQaEvidenceAudit {
  const issues: ProjectQaEvidenceIssue[] = [];
  const byId = new Map(input.facts.filter((fact) => fact.projectId === input.projectId).map((fact) => [fact.id, fact]));
  const factIds = [...new Set(input.factIds)];
  const validFacts: ProjectFact[] = [];
  if (!factIds.length) issues.push({ code: "missing-facts", severity: "warning", message: "尚未关联项目事实；请核对原始资料，或按本人真实经历人工确认。" });
  for (const factId of factIds) {
    const fact = byId.get(factId);
    if (!fact || !isFactEligible(fact)) {
      issues.push({ code: "invalid-fact", severity: "error", factId, message: `关联事实不可用：${fact?.title ?? factId}（可能缺失、跨项目、待审核、冲突或过期）。` });
    } else validFacts.push(fact);
  }
  // An unlinked imported/manual answer needs human attestation, not a claim of automatic verification.
  if (validFacts.length) {
    const evidenceText = validFacts.map((fact) => `${fact.title}\n${fact.content}\n${formatProjectFactValue(fact.value)}`).join("\n");
    const allowedQuantities = new Set(quantities(evidenceText).map((quantity) => quantity.key));
    const responsibilities = validFacts.filter((fact) => fact.ownership === "self" && (fact.evidenceLevel === "confirmed-user" || fact.verified));
    for (const sentence of input.answer.split(/(?<=[。！？!?；;\n])/u).map((value) => value.trim()).filter(Boolean)) {
      for (const quantity of quantities(sentence)) {
        if (!allowedQuantities.has(quantity.key)) issues.push({ code: "unsupported-quantity", severity: "error", sentence, message: `“${quantity.raw}”未出现在关联事实中，请核对数值、单位及测量条件。` });
      }
      if (/(?:我(?!们)|本人).{0,24}(?:负责|主导|独立|参与|承担|实现|设计|开发|调试|优化|解决|决定|选择)/u.test(sentence)) {
        if (!responsibilities.length) issues.push({ code: "unconfirmed-ownership", severity: "error", sentence, message: "个人职责或行动缺少本人已确认的事实，项目实现不能直接转换为“我负责”。" });
        else {
          for (const term of ["主导", "独立", "全权"]) {
            if (sentence.includes(term) && !responsibilities.some((fact) => compact(fact.content).includes(term))) issues.push({ code: "inflated-ownership", severity: "error", sentence, message: `关联职责没有支持“${term}”的表述，请避免扩大个人贡献。` });
          }
        }
      }
    }
  }
  return { requiresHumanReview: true, blocked: issues.some((issue) => issue.severity === "error"), issues, factIds: validFacts.map((fact) => fact.id) };
}
