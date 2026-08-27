import type { ProjectEvidenceRef, ProjectFlow, ProjectRelationship, ProjectUnderstanding, ProjectEvidenceStrength } from "./types";

export interface ProjectClaimVerification {
  supported: boolean;
  strength: ProjectEvidenceStrength;
  reasonCode: "DIRECT_CALL" | "DIRECT_CONFIG" | "DIRECT_ASSIGNMENT" | "DOCUMENT_ASSERTION" | "TEST_ASSERTION" | "MULTI_SOURCE_SUPPORT" | "CO_OCCURRENCE_ONLY" | "NO_SUPPORT";
  reason: string;
}

function validRefs(understanding: ProjectUnderstanding, refs: string[]): ProjectEvidenceRef[] {
  const available = new Map(understanding.evidenceRefs.map((ref) => [ref.id, ref]));
  return [...new Set(refs)].flatMap((ref) => { const value = available.get(ref); return value ? [value] : []; });
}

function explicitPattern(relation: ProjectRelationship["relation"]): RegExp {
  switch (relation) {
    case "calls": return /\bcall(?:s|ed)?\b|\w+\s*\([^)]*\)|调用/i;
    case "triggers": return /trigger|trgo|externaltrig|event|irq|isr|触发/i;
    case "writes": return /write|assign|memcpy|dma|buffer|写入|赋值/i;
    case "feeds": return /feed|queue|topic|publish|send|input|output|->|=>|进入/i;
    case "publishes": return /publish|send|topic|发布|发送|->|=>/i;
    case "subscribes": return /subscribe|topic|订阅/i;
    case "depends-on": return /import|include|require|inject|依赖/i;
    case "controls": return /control|disable|stop|latch|lock|控制|禁止|停机/i;
    case "reads": return /read|load|读取/i;
    case "provides": return /provide|return|output|提供|输出/i;
    case "produces": return /produce|generate|return|生成|产生/i;
    default: return /->|=>|call|feed|publish|trigger|write|依赖|进入/i;
  }
}

function claimTerm(value: string): RegExp {
  const normalized = value.toLowerCase().replace(/[ _-]+/g, "");
  if (normalized.includes("pwm")) return /pwm|timer|trgo/i;
  if (normalized.includes("adc")) return /adc|analog/i;
  if (normalized.includes("dma")) return /dma/i;
  if (normalized.includes("databus")) return /data.?bus|databus|message.?bus/i;
  if (normalized.includes("socketcan")) return /socket.?can/i;
  if (normalized.includes("mqtt")) return /mqtt/i;
  if (normalized.includes("modbus")) return /modbus/i;
  if (normalized.includes("ui")) return /\bui\b|lvgl|render|display/i;
  if (normalized.includes("buffer")) return /buffer|queue/i;
  return new RegExp(value.split(/\s+/).filter(Boolean).map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
}

export class ProjectClaimVerifier {
  verifyRelationship(input: { relationship: ProjectRelationship; evidenceRefs: ProjectEvidenceRef[] }): ProjectClaimVerification {
    const refs = input.evidenceRefs;
    if (!refs.length) return { supported: false, strength: "unsupported", reasonCode: "NO_SUPPORT", reason: "没有可定位的证据引用。" };
    const marker = explicitPattern(input.relationship.relation);
    const left = claimTerm(input.relationship.from);
    const right = claimTerm(input.relationship.to);
    const matching = refs.filter((ref) => marker.test(ref.quote) && left.test(`${ref.filePath ?? ""} ${ref.quote}`) && right.test(`${ref.filePath ?? ""} ${ref.quote}`));
    if (matching.length) {
      if (matching.every((ref) => ref.kind === "document")) return { supported: true, strength: "strong", reasonCode: "DOCUMENT_ASSERTION", reason: "项目文档在同一证据片段中明确陈述了该关系。" };
      const code = input.relationship.relation === "calls" ? "DIRECT_CALL" : input.relationship.relation === "triggers" || input.relationship.relation === "writes" ? "DIRECT_CONFIG" : input.relationship.relation === "depends-on" ? "DIRECT_ASSIGNMENT" : refs.some((ref) => ref.kind === "test") ? "TEST_ASSERTION" : "DIRECT_ASSIGNMENT";
      return { supported: true, strength: "direct", reasonCode: code, reason: "同一证据片段包含明确的调用、配置、赋值或数据连接。" };
    }
    const hasDocument = refs.some((ref) => ref.kind === "document");
    const hasOtherSource = new Set(refs.map((ref) => ref.sourceId)).size > 1;
    if (hasDocument && marker.test(refs.map((ref) => ref.quote).join(" "))) return { supported: true, strength: "strong", reasonCode: "DOCUMENT_ASSERTION", reason: "文档明确陈述了该关系。" };
    if (hasOtherSource) return { supported: false, strength: "weak", reasonCode: "CO_OCCURRENCE_ONLY", reason: "不同文件分别出现了两端名称，但没有关系断言。" };
    return { supported: false, strength: "weak", reasonCode: "CO_OCCURRENCE_ONLY", reason: "证据只证明名称共现，不能证明关系。" };
  }

  verifyFlow(flow: ProjectFlow, relationships: ProjectRelationship[], understanding: ProjectUnderstanding): { flow?: ProjectFlow; verification: ProjectClaimVerification } {
    const refs = validRefs(understanding, flow.evidenceRefs ?? []);
    const steps = flow.steps.filter((step) => step.component);
    if (steps.length < 2) return { verification: { supported: false, strength: "unsupported", reasonCode: refs.length ? "CO_OCCURRENCE_ONLY" : "NO_SUPPORT", reason: "Flow 没有足够的组件步骤。" } };
    const links: Array<ProjectRelationship | undefined> = [];
    for (let index = 0; index < steps.length - 1; index += 1) links.push(relationships.find((item) => item.from === steps[index]?.component && item.to === steps[index + 1]?.component && item.verificationStatus === "confirmed"));
    const confirmed = links.filter((link): link is ProjectRelationship => Boolean(link));
    if (!confirmed.length) return { verification: { supported: false, strength: "unsupported", reasonCode: refs.length ? "CO_OCCURRENCE_ONLY" : "NO_SUPPORT", reason: "Flow 中没有已确认的关系链。" } };
    const missingLinks = links.flatMap((link, index) => link ? [] : [`${steps[index]?.component} → ${steps[index + 1]?.component}`]);
    const next: ProjectFlow = { ...flow, evidenceRefs: [...new Set(confirmed.flatMap((link) => link.evidenceRefs))], confidence: missingLinks.length ? 0.65 : 0.9, ...(missingLinks.length ? { partial: true, missingLinks } : { partial: false, missingLinks: undefined }) };
    return { flow: next, verification: { supported: true, strength: missingLinks.length ? "weak" : "direct", reasonCode: missingLinks.length ? "MULTI_SOURCE_SUPPORT" : "DIRECT_ASSIGNMENT", reason: missingLinks.length ? "Flow 只验证了部分相邻关系，缺失链路已明确标记。" : "Flow 的每个相邻步骤都有已验证关系。" } };
  }
}

export interface ProjectGroundingResult {
  understanding: ProjectUnderstanding;
  groundedClaims: number;
  ungroundedClaims: number;
  verifications?: Array<ProjectClaimVerification & { claimType: string; claim: string }>;
}

function appendUnknown(unknowns: ProjectUnderstanding["unknowns"], projectId: string, claim: string, reason: string, category: ProjectUnderstanding["unknowns"][number]["category"] = "general"): ProjectUnderstanding["unknowns"] {
  if (unknowns.some((unknown) => unknown.claim === claim)) return unknowns;
  return [...unknowns, { id: `unknown-${projectId}-${unknowns.length}`, claim, reason, category, evidenceRefs: [] }];
}

/** Claim-level grounding. A valid evidenceRef alone is not enough for a relationship or Flow. */
export class ProjectGroundingService {
  private readonly verifier = new ProjectClaimVerifier();

  ground(input: ProjectUnderstanding): ProjectGroundingResult {
    const verifications: ProjectGroundingResult["verifications"] = [];
    const components = input.architecture.components.filter((item) => validRefs(input, item.evidenceRefs ?? []).length > 0).map((item) => ({ ...item, evidenceRefs: validRefs(input, item.evidenceRefs ?? []).map((ref) => ref.id) }));
    const relationships: ProjectRelationship[] = [];
    let unknowns = [...input.unknowns];
    for (const relationship of input.architecture.relationships) {
      const refs = validRefs(input, relationship.evidenceRefs);
      const componentNames = new Set(components.map((component) => component.name));
      const verification = !componentNames.has(relationship.from) || !componentNames.has(relationship.to)
        ? { supported: false, strength: "unsupported" as const, reasonCode: "NO_SUPPORT" as const, reason: "关系端点没有对应的已验证组件。" }
        : this.verifier.verifyRelationship({ relationship, evidenceRefs: refs });
      verifications.push({ ...verification, claimType: "relationship", claim: `${relationship.from} ${relationship.relation} ${relationship.to}` });
      if (verification.supported) relationships.push({ ...relationship, evidenceRefs: refs.map((ref) => ref.id), evidenceStrength: verification.strength, verificationStatus: "confirmed", confidenceReason: verification.reason });
      else unknowns = appendUnknown(unknowns, input.projectId, `${relationship.from} ${relationship.relation} ${relationship.to}`, verification.reason, "flow");
    }
    const allFlows = [...input.runtimeFlows, ...input.dataFlows, ...input.controlFlows];
    const groundedFlows: ProjectFlow[] = [];
    for (const flow of allFlows) {
      const result = this.verifier.verifyFlow(flow, relationships, input);
      verifications.push({ ...result.verification, claimType: "flow", claim: flow.name });
      if (result.flow) groundedFlows.push(result.flow);
      else unknowns = appendUnknown(unknowns, input.projectId, flow.name, result.verification.reason, "flow");
    }
    const keep = <T extends { evidenceRefs: string[] }>(items: T[]): T[] => items.filter((item) => validRefs(input, item.evidenceRefs).length > 0).map((item) => ({ ...item, evidenceRefs: validRefs(input, item.evidenceRefs).map((ref) => ref.id) }));
    const parameters = keep(input.parameters);
    const decisions = keep(input.decisions);
    const problems = keep(input.problems);
    const split = (source: ProjectFlow[], kind: ProjectFlow["kind"]): ProjectFlow[] => groundedFlows.filter((flow) => source.some((candidate) => candidate.id === flow.id) && flow.kind === kind);
    const totalClaims = input.architecture.components.length + input.architecture.relationships.length + allFlows.length + input.parameters.length + input.decisions.length + input.problems.length;
    const groundedClaims = components.length + relationships.length + groundedFlows.length + parameters.length + decisions.length + problems.length;
    const ungroundedClaims = Math.max(0, totalClaims - groundedClaims);
    if (ungroundedClaims > 0 && !unknowns.some((unknown) => unknown.id === `unknown-grounding-${input.projectId}`)) unknowns.push({ id: `unknown-grounding-${input.projectId}`, claim: "部分项目理解声明缺少可定位证据", reason: "探索范围或资料不足，不能升级为已确认声明。", category: "general", evidenceRefs: [] });
    const next: ProjectUnderstanding = {
      ...input,
      status: "completed",
      architecture: { ...input.architecture, components, relationships },
      runtimeFlows: split(input.runtimeFlows, "runtime"),
      dataFlows: split(input.dataFlows, "data"),
      controlFlows: split(input.controlFlows, "control"),
      parameters,
      decisions,
      problems,
      unknowns,
      quality: { ...input.quality, groundingCoverage: totalClaims === 0 ? 0 : Math.round((groundedClaims / totalClaims) * 100) },
    };
    return { understanding: next, groundedClaims, ungroundedClaims, verifications };
  }
}

export function groundProjectUnderstanding(input: ProjectUnderstanding): ProjectGroundingResult { return new ProjectGroundingService().ground(input); }
