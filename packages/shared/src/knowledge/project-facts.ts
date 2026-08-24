import { normalizeTechnicalTerms } from "../terminology";
import type { ProjectFact, ProjectFactEvidence, ProjectFactType, ProjectMemoryAnalysisInput, ProjectMemorySource } from "./types";

export interface ProjectFactValidationIssue { code: string; message: string; }
export interface ProjectFactValidationResult { status: "accepted" | "pending_review" | "rejected"; issues: ProjectFactValidationIssue[]; }

const HIGH_RISK_NAME = /负责人|个人职责|技术栈|电话|邮箱|教育背景|求职方向|主修课程/i;
const ROLE_LEAK = /技术栈\s*[:：]|电话\s*[:：]|邮箱\s*[:：]|教育(?:背景)?\s*[:：]|求职方向\s*[:：]/i;
const KNOWN_TECHNOLOGIES = [
  "STM32F405", "STM32G431", "STM32", "ESP32", "RK3506", "DRV8301", "MT6816", "FreeRTOS", "RTOS", "FOC", "SVPWM", "ADC", "DMA", "PWM", "CAN", "I2C", "IIC", "UART", "SPI", "MQTT", "Linux", "C", "C++", "Python", "SQLite", "ROS2", "PID"
];

function lines(text: string): string[] {
  return text.replace(/\r/g, "").split("\n").map((line) => line.replace(/^\s*[-*•\d.)、]+\s*/, "").trim()).filter(Boolean);
}

function sourceAllowed(source: ProjectMemorySource): boolean {
  return source.kind === "project-document" || source.kind === "repository" || source.kind === "readme" || source.kind === "resume-section" || source.kind === "manual" || source.kind === "user-fact";
}

function slug(value: string): string {
  return normalizeTechnicalTerms(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 64) || "fact";
}

function evidence(source: ProjectMemorySource, quote: string, lineIndex: number): ProjectFactEvidence {
  return { sourceId: source.id, quote: quote.trim().slice(0, 800), locator: source.locator ?? `line:${lineIndex + 1}` };
}

function fact(projectId: string, source: ProjectMemorySource, type: ProjectFactType, title: string, content: string, lineIndex: number, confidence = 0.78): ProjectFact {
  const itemEvidence = evidence(source, content, lineIndex);
  return { id: `${projectId}-fact-${type}-${slug(title)}`, projectId, type, factType: type, title: title.trim().slice(0, 120), content: content.trim().slice(0, 1_000), confidence, verified: false, sourceIds: [source.id], evidence: [itemEvidence], status: "active" };
}

function valueAfterLabel(line: string, labels: string[]): string | undefined {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = line.match(new RegExp(`(?:${escaped})\\s*[:：]?\\s*(.+)$`, "i"));
  return match?.[1]?.replace(/[|｜]+.*$/, "").replace(/\s+(?:时间|周期|技术栈|技术方案|负责人)\s*[:：].*$/i, "").trim();
}

function extractEntities(line: string): string[] {
  const normalized = normalizeTechnicalTerms(line);
  return [...new Set(KNOWN_TECHNOLOGIES.filter((term) => normalized.toLowerCase().includes(term.toLowerCase())))].filter((term, _index, all) => !all.some((other) => other.length > term.length && other.toLowerCase().startsWith(term.toLowerCase())));
}

function extractLabeledFacts(projectId: string, source: ProjectMemorySource): ProjectFact[] {
  const result: ProjectFact[] = [];
  const sourceLines = lines(source.text);
  sourceLines.forEach((line, lineIndex) => {
    const role = valueAfterLabel(line, ["个人职责", "我的职责", "职责", "role"]);
    if (role) result.push(fact(projectId, source, "responsibility", "个人职责", role, lineIndex, 0.86));
    const background = valueAfterLabel(line, ["项目背景", "项目介绍", "项目目标", "背景", "目标"]);
    if (background) result.push(fact(projectId, source, /目标/.test(line) ? "goal" : "background", /目标/.test(line) ? "项目目标" : "项目背景", background, lineIndex));
    const timeline = valueAfterLabel(line, ["时间", "周期", "timeline"]);
    if (timeline) result.push(fact(projectId, source, "timeline", "项目时间", timeline, lineIndex, 0.9));
    const architecture = valueAfterLabel(line, ["系统架构", "软件架构", "架构", "architecture"]);
    if (architecture) result.push(fact(projectId, source, "architecture", "系统架构", architecture, lineIndex));
    const decision = valueAfterLabel(line, ["技术方案", "技术决策", "设计取舍", "选型", "decision"]);
    if (decision) result.push(fact(projectId, source, "technical_decision", "技术方案", decision, lineIndex));
    const challenge = valueAfterLabel(line, ["问题", "难点", "挑战", "故障"]);
    if (challenge) result.push(fact(projectId, source, "challenge", "项目难点", challenge, lineIndex));
    const cause = valueAfterLabel(line, ["原因", "cause"]);
    if (cause) result.push(fact(projectId, source, "cause", "问题原因", cause, lineIndex));
    const solution = valueAfterLabel(line, ["解决方案", "解决", "方案", "solution", "优化"]);
    if (solution) result.push(fact(projectId, source, "solution", "解决方案", solution, lineIndex));
    const resultValue = valueAfterLabel(line, ["最终结果", "结果", "效果", "result"]);
    if (resultValue) result.push(fact(projectId, source, "result", "项目结果", resultValue, lineIndex));
    const metric = valueAfterLabel(line, ["性能指标", "指标", "性能", "metric"]);
    if (metric) result.push(fact(projectId, source, "metric", "性能指标", metric, lineIndex));

    const technologyLine = /技术栈|技术方案|核心技术|使用技术|软件|硬件|芯片|协议|technology|hardware|software/i.test(line);
    if (technologyLine) {
      const entities = extractEntities(line);
      for (const entity of entities) {
        const type: ProjectFactType = /硬件|芯片/.test(line) ? "hardware" : /软件/.test(line) ? "software" : "technology";
        result.push({ ...fact(projectId, source, type, entity, entity, lineIndex, 0.82), evidence: [evidence(source, line, lineIndex)] });
      }
    }
    if (/模块|子系统|驱动|控制环|通信|数据采集|状态机/i.test(line) && line.length <= 260) {
      const title = line.split(/[:：]/, 1)[0]?.trim() || line.slice(0, 80);
      result.push(fact(projectId, source, "module", title, line, lineIndex, 0.7));
    }
  });
  return result;
}

function deduplicate(facts: ProjectFact[]): ProjectFact[] {
  const byKey = new Map<string, ProjectFact>();
  for (const item of facts) {
    const key = `${item.projectId}|${item.type}|${normalizeTechnicalTerms(item.title).toLowerCase()}|${normalizeTechnicalTerms(item.content).toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, item);
    else {
      existing.sourceIds = [...new Set([...existing.sourceIds, ...item.sourceIds])];
      existing.evidence = [...(existing.evidence ?? []), ...(item.evidence ?? [])];
      existing.confidence = Math.max(existing.confidence, item.confidence);
    }
  }
  return [...byKey.values()];
}

export function extractProjectFacts(input: ProjectMemoryAnalysisInput): ProjectFact[] {
  const projectId = input.projectId ?? `project-${slug(input.projectName ?? input.sources[0]?.projectName ?? input.sources[0]?.title ?? "unknown")}`;
  return deduplicate(input.sources.filter(sourceAllowed).flatMap((source) => extractLabeledFacts(projectId, source)).map((item) => ProjectFactValidator.sanitize(item)).filter((item): item is ProjectFact => Boolean(item)));
}

export class ProjectFactValidator {
  static validateProjectName(name: string): ProjectFactValidationResult {
    const issues: ProjectFactValidationIssue[] = [];
    const value = name.trim();
    if (value.length < 2 || value.length > 80) issues.push({ code: "PROJECT_NAME_LENGTH", message: "项目名称应为 2~80 个字符" });
    if (HIGH_RISK_NAME.test(value)) issues.push({ code: "PROJECT_NAME_RESUME_LEAK", message: "项目名称包含简历字段" });
    return { status: issues.length ? "rejected" : "accepted", issues };
  }

  static validateRole(role: string): ProjectFactValidationResult {
    const issues: ProjectFactValidationIssue[] = [];
    if (!role.trim()) issues.push({ code: "ROLE_EMPTY", message: "职责不能为空" });
    if (ROLE_LEAK.test(role)) issues.push({ code: "ROLE_FIELD_LEAK", message: "职责包含其他字段内容" });
    return { status: issues.length ? "rejected" : "accepted", issues };
  }

  static validate(fact: ProjectFact): ProjectFactValidationResult {
    const issues: ProjectFactValidationIssue[] = [];
    if (!fact.projectId || !fact.title.trim() || !fact.content.trim()) issues.push({ code: "FACT_REQUIRED_FIELD", message: "事实缺少项目、标题或内容" });
    if (!fact.sourceIds.length || !(fact.evidence?.length)) issues.push({ code: "FACT_MISSING_EVIDENCE", message: "高风险事实必须包含 sourceId 和 quote" });
    if ((fact.type === "technology" || fact.type === "hardware" || fact.type === "software") && (fact.content.length > 180 || /熟悉|掌握|了解|等平台|包括.*、/.test(fact.title))) issues.push({ code: "FACT_NOT_ATOMIC", message: "技术事实必须是原子实体" });
    if (fact.type === "responsibility" && ROLE_LEAK.test(fact.content)) issues.push({ code: "ROLE_FIELD_LEAK", message: "职责包含其他字段内容" });
    return { status: issues.some((issue) => issue.code === "FACT_MISSING_EVIDENCE" || issue.code === "FACT_REQUIRED_FIELD") ? "rejected" : issues.length ? "pending_review" : "accepted", issues };
  }

  static sanitize(fact: ProjectFact): ProjectFact | undefined {
    const result = this.validate(fact);
    if (result.status === "rejected") return undefined;
    return { ...fact, status: result.status === "pending_review" ? "pending_review" : "active" };
  }
}

export type ProjectFactConflictStatus = "confirmed" | "conflicting" | "pending_review";

function trust(source: ProjectMemorySource): number {
  if (source.kind === "user-fact" || source.sourceType === "user_fact") return 4;
  if (source.kind === "project-document" || source.kind === "repository" || source.kind === "readme") return 3;
  if (source.kind === "resume-section" || source.sourceType === "resume_section") return 2;
  return 1;
}

export class ProjectFactConflictResolver {
  resolve(facts: ProjectFact[], sources: ProjectMemorySource[] = []): ProjectFact[] {
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const groups = new Map<string, ProjectFact[]>();
    for (const item of facts) {
      const normalizedTitle = normalizeTechnicalTerms(item.title).toLowerCase();
      const semanticSlot = item.type === "hardware" && /stm32|esp32|rk\d+|mcu|芯片/.test(normalizedTitle) ? "mcu" : normalizedTitle;
      const key = `${item.projectId}|${item.type}|${semanticSlot}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.values()].flatMap((group) => {
      if (group.length <= 1) return group;
      const contents = new Set(group.map((item) => normalizeTechnicalTerms(item.content).toLowerCase()));
      if (contents.size <= 1) return [this.merge(group, "confirmed")];
      const scores = group.map((item) => item.sourceIds.reduce((total, sourceId) => total + trust(sourceById.get(sourceId) ?? { id: sourceId, kind: "manual", title: "", text: "" }), 0));
      const best = Math.max(...scores);
      const leaders = group.filter((_item, index) => scores[index] === best);
      if (leaders.length === 1 && best >= 3) return [{ ...this.merge(leaders, "confirmed"), conflictStatus: "pending_review", status: "pending_review" }];
      return group.map((item) => ({ ...item, conflictStatus: "conflicting" as const, status: "conflicting" as const }));
    });
  }

  private merge(facts: ProjectFact[], status: ProjectFactConflictStatus): ProjectFact {
    const first = facts[0] as ProjectFact;
    return { ...first, sourceIds: [...new Set(facts.flatMap((item) => item.sourceIds))], evidence: facts.flatMap((item) => item.evidence ?? []), conflictStatus: status, status: status === "confirmed" ? "active" : "pending_review" };
  }
}
