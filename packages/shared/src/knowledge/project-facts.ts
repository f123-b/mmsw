import { normalizeTechnicalTerms } from "../terminology";
import { markdownSectionText, normalizedFieldName, parseMarkdownProjectDocument, type ProjectMarkdownSection } from "./project-document-parser";
import { validateProjectTimeline } from "./project-timeline";
import { areCanonicalFactValuesEquivalent, canonicalProjectFactKey, inferFactCardinality, isDeterministicContradiction, withFactSemantics } from "./project-semantics";
import { canonicalProjectParameterKey, normalizeProjectFactValue } from "./project-technical-memory";
import type { ProjectFact, ProjectFactEvidence, ProjectFactEvidenceLevel, ProjectFactScope, ProjectFactType, ProjectMemoryAnalysisInput, ProjectMemorySource } from "./types";

export interface ProjectFactValidationIssue { code: string; message: string; }
export interface ProjectFactValidationResult { status: "accepted" | "pending_review" | "rejected"; issues: ProjectFactValidationIssue[]; }

const HIGH_RISK_NAME = /负责人|个人职责|技术栈|电话|邮箱|教育背景|求职方向|主修课程/i;
const ROLE_LEAK = /(?:技术栈|电话|邮箱|教育(?:背景)?|求职方向|项目时间|项目周期)\s*[:：]/i;
const UNKNOWN_TIMELINE = /^(?:未知|未确认|未得到确认|待补充|未记录|无法确认|暂无|不详|unknown|n\/a)$/i;
const KNOWN_TECHNOLOGIES = [
  "STM32F405", "STM32G431", "STM32", "ESP32", "RK3506G", "RK3506", "DRV8301", "MT6816", "AS5047P", "FreeRTOS", "RTOS", "FOC", "SVPWM", "ADC", "DMA", "PWM", "CAN", "I2C", "IIC", "UART", "SPI", "MQTT", "Modbus RTU", "SocketCAN", "HTTP", "NTP", "OTA", "LVGL", "Linux", "CMake", "C11", "C++", "Python", "SQLite", "ROS2", "PID", "ABZ", "USB CDC", "数据总线"
];

const FIELD_LABELS = {
  responsibility: ["本人主要职责", "个人职责", "本人职责", "我的职责", "负责范围", "role"],
  background: ["项目背景", "项目介绍", "项目是什么", "background"],
  goal: ["项目目标", "项目目的", "goal"],
  timeline: ["项目完整起止时间", "项目起止时间", "项目开始时间", "项目结束时间", "项目时间", "项目周期", "timeline"],
  gitWindow: ["git开发窗口", "git 开发窗口", "代码开发窗口", "提交窗口"],
  architecture: ["系统架构", "软件架构", "架构设计", "architecture"],
  decision: ["技术决策", "技术方案", "设计取舍", "选型", "decision"],
  challenge: ["项目问题", "问题", "项目难点", "难点", "挑战", "故障", "challenge"],
  cause: ["原因", "cause"],
  solution: ["解决方案", "解决措施", "解决", "方案", "solution", "优化"],
  result: ["最终结果", "结果", "效果", "result"],
  metric: ["性能指标", "指标", "性能测试", "性能结果", "benchmark", "metric"],
  parameter: ["关键参数", "项目参数", "配置参数", "参数", "parameter", "parameters"],
  application: ["应用场景", "使用场景", "落地场景", "application"],
  hardware: ["硬件", "硬件平台", "主控", "芯片", "hardware"],
  software: ["软件", "软件平台", "操作系统", "工具链", "software"],
  technology: ["技术栈", "核心技术", "使用技术", "关键技术", "技术实现", "技术点", "开发语言", "协议", "通信协议", "接口", "算法", "控制算法", "technology"]
} as const;

function slug(value: string): string {
  return normalizeTechnicalTerms(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "").slice(0, 64) || "fact";
}

function sourceAllowed(source: ProjectMemorySource): boolean {
  // Reference material can explain a concept, but it is not evidence that
  // this project used it or that the user owned the work. It becomes usable
  // project evidence only after an explicit reclassification by the user.
  if (source.sourceRole === "reference") return false;
  return source.kind === "project-document" || source.kind === "repository" || source.kind === "readme" || source.kind === "resume-section" || source.kind === "manual" || source.kind === "user-fact";
}

const EVIDENCE_RANK: Record<ProjectFactEvidenceLevel, number> = {
  "pending": 0,
  "inferred": 0,
  "risk": 0,
  "not-measured": 0,
  "confirmed-document": 1,
  "confirmed-code": 2,
  "confirmed-user": 3
};

/** The maximum evidence level a source can establish without a user decision. */
export function systemEvidenceLevel(source: ProjectMemorySource): ProjectFactEvidenceLevel {
  if (source.sourceRole === "responsibility" || source.sourceRole === "resume" || source.kind === "resume-section" || source.kind === "user-fact" || source.sourceType === "user_fact" || source.kind === "manual") return "confirmed-user";
  if (source.sourceRole === "code" || source.kind === "repository" || source.kind === "readme") return "confirmed-code";
  if (source.sourceRole === "test" || source.sourceRole === "architecture" || source.sourceRole === "overview" || source.kind === "project-document") return "confirmed-document";
  return "pending";
}

/** Clamp model-provided labels so an LLM can never upgrade source trust. */
export function clampEvidenceLevel(sourceLevel: ProjectFactEvidenceLevel, requested?: ProjectFactEvidenceLevel): ProjectFactEvidenceLevel {
  if (!requested) return sourceLevel;
  if (requested === "confirmed-user" || requested === "confirmed-code" || requested === "confirmed-document") {
    return EVIDENCE_RANK[requested] <= EVIDENCE_RANK[sourceLevel] ? requested : sourceLevel;
  }
  return requested;
}

function inferredEvidenceLevel(source: ProjectMemorySource, explicit?: ProjectFactEvidenceLevel): ProjectFactEvidenceLevel {
  return clampEvidenceLevel(systemEvidenceLevel(source), explicit);
}

function sourceLines(text: string): string[] { return text.replace(/\r/g, "").split("\n"); }

function evidence(source: ProjectMemorySource, quote: string, lineIndex: number): ProjectFactEvidence {
  return { sourceId: source.id, quote: quote.trim().slice(0, 800), locator: source.locator ?? `line:${lineIndex + 1}` };
}

function labelRegex(labels: readonly string[]): RegExp {
  const escaped = [...labels].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^\\s*(?:${escaped})\\s*(?::|：|\\||｜)?\\s*(.*?)\\s*$`, "i");
}

export function valueAfterLabel(line: string, labels: readonly string[]): string | undefined {
  const value = line.replace(/^\s*[-*•\d.)、]+\s*/, "").trim().match(labelRegex(labels))?.[1]?.trim();
  if (!value) return undefined;
  return value.replace(/\s+(?:时间|周期|技术栈|技术方案|负责人)\s*[:：].*$/i, "").trim() || undefined;
}

function fieldMatch(line: string, field: keyof typeof FIELD_LABELS): string | undefined {
  return valueAfterLabel(line, FIELD_LABELS[field]);
}

const PARAMETER_TITLES: Record<string, string> = {
  "control.current_loop.frequency": "电流环频率",
  "control.speed_loop.frequency": "速度环频率",
  "control.position_loop.frequency": "位置环频率",
  "sampling.pwm.frequency": "PWM 频率",
  "sampling.adc.frequency": "ADC 采样率",
  "communication.can.bitrate": "CAN 波特率",
  "communication.uart.baudrate": "UART 波特率",
  "motor.current_limit": "电流限幅",
  "motor.voltage_limit": "电压限幅",
  "motor.pole_pairs": "电机极对数",
  "sensor.encoder.resolution": "编码器分辨率",
  "rtos.control_task.period": "控制任务周期",
  "rtos.communication_task.period": "通信任务周期",
  "rtos.task.period": "RTOS 任务周期",
  "control.timeout": "控制超时时间",
  "control.pi": "PI 参数",
  "control.filter": "控制滤波参数",
  "runtime.buffer.size": "缓冲区大小",
  "runtime.queue.depth": "队列深度",
  "sampling.window": "采样窗口"
};

function inlineFieldMatch(line: string, field: keyof typeof FIELD_LABELS, startAt = 1): string | undefined {
  const labels = [...FIELD_LABELS[field]].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const rest = line.slice(startAt);
  const match = rest.match(new RegExp(`(?:${labels})\\s*[:：]\\s*(.*?)(?=\\s*(?:原因|解决方案|解决|后来通过|最终结果|结果|效果|cause|solution|result)\\s*[:：]|$)`, "i"));
  return match?.[1]?.trim().replace(/[，,；;。]+$/, "") || undefined;
}

function explicitEvidenceLevel(value: string | undefined): ProjectFactEvidenceLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/confirmed-user|用户确认|本人确认|已确认/.test(normalized)) return "confirmed-user";
  if (/confirmed-code|代码确认|源码确认/.test(normalized)) return "confirmed-code";
  if (/not-measured|未测量|未测试|没有正式 benchmark|无正式 benchmark/.test(normalized)) return "not-measured";
  if (/risk|风险|待核实/.test(normalized)) return "risk";
  if (/pending|待确认|未确认|未得到确认/.test(normalized)) return "pending";
  if (/inferred|推断|推测/.test(normalized)) return "inferred";
  return undefined;
}

function inferScope(section: ProjectMarkdownSection | undefined): ProjectFactScope {
  const title = section?.title ?? "";
  if (/问题|难点|挑战|故障|排查/.test(title)) return "problem";
  if (/架构/.test(title)) return "architecture";
  if (/模块|子系统|驱动|控制环|通信|数据采集|状态机/.test(title)) return "module";
  return "project";
}

function fact(projectId: string, source: ProjectMemorySource, type: ProjectFactType, title: string, content: string, lineIndex: number, options: { quote?: string; scope?: ProjectFactScope; sectionPath?: string[]; evidenceLevel?: ProjectFactEvidenceLevel; subtype?: string; confidence?: number } = {}): ProjectFact {
  const itemEvidence = evidence(source, options.quote ?? content, lineIndex);
  const evidenceLevel = inferredEvidenceLevel(source, options.evidenceLevel);
  const ownership = type === "responsibility"
    ? (/(?:由其他成员|其他成员|他人|团队负责|非本人|不是我|不负责)/i.test(content) ? "team" : source.sourceRole === "responsibility" || source.sourceRole === "resume" || source.kind === "resume-section" || source.kind === "user-fact" || source.kind === "manual" ? "self" : "unknown")
    : "project";
  return {
    id: `${projectId}-fact-${type}-${slug(title)}-${slug(content).slice(0, 18)}`,
    projectId,
    type,
    factType: type,
    title: title.trim().slice(0, 120),
    content: content.trim().slice(0, 1_000),
    confidence: options.confidence ?? 0.78,
    verified: false,
    sourceIds: [source.id],
    evidence: [itemEvidence],
    scope: options.scope ?? "project",
    ...(options.sectionPath ? { sectionPath: options.sectionPath } : {}),
    evidenceLevel,
    ownership,
    ...(options.subtype ? { subtype: options.subtype } : {}),
    status: "active"
  };
}

function extractEntities(value: string): string[] {
  const normalized = normalizeTechnicalTerms(value);
  const lower = normalized.toLowerCase();
  return [...new Set(KNOWN_TECHNOLOGIES.filter((term) => {
    const candidate = term.toLowerCase();
    if (candidate === "c") return /(^|[^a-z])c(?:11)?([^a-z]|$)/i.test(normalized);
    return lower.includes(candidate);
  }))].filter((term, _index, all) => !all.some((other) => other.length > term.length && other.toLowerCase().startsWith(term.toLowerCase())));
}

function factForField(projectId: string, source: ProjectMemorySource, field: keyof typeof FIELD_LABELS, content: string, quote: string, lineIndex: number, section: ProjectMarkdownSection | undefined, evidenceLevel?: ProjectFactEvidenceLevel): ProjectFact[] {
  if (!content.trim()) return [];
  const scope = inferScope(section);
  const common = { quote, scope, sectionPath: section?.path, evidenceLevel };
  switch (field) {
    case "responsibility": return [fact(projectId, source, "responsibility", "个人职责", content, lineIndex, { ...common, confidence: 0.9 })];
    case "background": return [fact(projectId, source, "background", "项目背景", content, lineIndex, { ...common, confidence: 0.84 })];
    case "goal": return [fact(projectId, source, "goal", "项目目标", content, lineIndex, common)];
    case "timeline": return [fact(projectId, source, "timeline", "项目时间", content, lineIndex, common)];
    case "gitWindow": return [fact(projectId, source, "timeline", "Git开发窗口", content, lineIndex, { ...common, subtype: "supporting-development-window", confidence: 0.72 })];
    case "architecture": return [fact(projectId, source, "architecture", "系统架构", content, lineIndex, common)];
    case "decision": return [fact(projectId, source, "technical_decision", "技术方案", content, lineIndex, common)];
    case "challenge": return [fact(projectId, source, "challenge", "项目难点", content, lineIndex, common)];
    case "cause": return [fact(projectId, source, "cause", "问题原因", content, lineIndex, common)];
    case "solution": return [fact(projectId, source, "solution", "解决方案", content, lineIndex, common)];
    case "result": return [fact(projectId, source, "result", "项目结果", content, lineIndex, common)];
    case "metric": return [fact(projectId, source, "metric", "性能指标", content, lineIndex, { ...common, evidenceLevel: evidenceLevel ?? (/未测量|未测试|没有正式 benchmark/i.test(content) ? "not-measured" : undefined) })];
    case "parameter": return [fact(projectId, source, "parameter", "关键参数", content, lineIndex, { ...common, confidence: 0.84 })];
    case "application": return [fact(projectId, source, "application", "应用场景", content, lineIndex, common)];
    default: return [];
  }
}

function tableValue(row: Record<string, string>, headers: string[]): string | undefined {
  const preferred = headers.find((header) => /内容|值|描述|说明|事实|项目内容|value|content|description/i.test(normalizedFieldName(header)));
  return (preferred ? row[preferred] : Object.values(row).find(Boolean))?.trim() || undefined;
}

function fieldFromName(name: string): keyof typeof FIELD_LABELS | undefined {
  const normalized = normalizedFieldName(name);
  for (const [field, labels] of Object.entries(FIELD_LABELS) as Array<[keyof typeof FIELD_LABELS, readonly string[]]>) {
    if (labels.some((label) => normalized === normalizedFieldName(label))) return field;
  }
  if (/背景/.test(name)) return "background";
  if (/目标|目的/.test(name)) return "goal";
  if (/职责/.test(name)) return "responsibility";
  if (/起止时间|项目时间|项目周期/.test(name)) return "timeline";
  if (/git.*窗口|提交窗口/i.test(name)) return "gitWindow";
  if (/硬件|主控|芯片/.test(name)) return "hardware";
  if (/软件|操作系统|工具链/.test(name)) return "software";
  if (/技术栈|核心技术|算法|协议|接口|开发语言/.test(name)) return "technology";
  if (/架构/.test(name)) return "architecture";
  if (/难点|问题|挑战|故障/.test(name)) return "challenge";
  if (/原因/.test(name)) return "cause";
  if (/解决|方案|优化/.test(name)) return "solution";
  if (/结果|效果/.test(name)) return "result";
  if (/指标|性能|benchmark/i.test(name)) return "metric";
  if (/参数|配置/.test(name)) return "parameter";
  if (/应用|场景/.test(name)) return "application";
  return undefined;
}

function extractTableFacts(projectId: string, source: ProjectMemorySource, structure: ReturnType<typeof parseMarkdownProjectDocument>): ProjectFact[] {
  const result: ProjectFact[] = [];
  for (const section of structure.sections) {
    const scope = inferScope(section);
    for (const table of section.tables) {
      for (const row of table.rows) {
        const fieldName = row[table.headers[0] ?? ""] ?? "";
        const field = fieldFromName(fieldName);
        const content = tableValue(row, table.headers);
        if (!field || !content) continue;
        const levelHeader = table.headers.find((header) => /证据|evidence|状态|status/i.test(header));
        const level = explicitEvidenceLevel(levelHeader ? row[levelHeader] : undefined);
        const rowIndex = table.rows.indexOf(row);
        const quote = table.quotes[rowIndex] ?? content;
        result.push(...factForField(projectId, source, field, content, quote, section.startLine - 1, section, level).map((item) => ({ ...item, scope })));
        if (["hardware", "software", "technology"].includes(field)) {
          const type: ProjectFactType = field === "hardware" ? "hardware" : field === "software" ? "software" : "technology";
          for (const entity of extractEntities(content)) result.push(fact(projectId, source, type, entity, entity, section.startLine - 1, { quote, scope, sectionPath: section.path, evidenceLevel: level, subtype: field === "technology" ? field : undefined, confidence: 0.84 }));
        }
      }
    }
  }
  return result;
}

function sectionField(section: ProjectMarkdownSection): keyof typeof FIELD_LABELS | undefined {
  const title = section.title;
  if (/背景|介绍/.test(title)) return "background";
  if (/目标|目的/.test(title)) return "goal";
  if (/职责|负责范围/.test(title)) return "responsibility";
  if (/起止时间|项目时间|项目周期/.test(title)) return "timeline";
  if (/架构/.test(title)) return "architecture";
  if (/难点|问题|挑战|故障/.test(title)) return "challenge";
  if (/解决|方案|优化/.test(title)) return "solution";
  if (/结果|效果/.test(title)) return "result";
  if (/指标|性能|benchmark/i.test(title)) return "metric";
  if (/参数|配置/.test(title)) return "parameter";
  if (/应用|场景/.test(title)) return "application";
  return undefined;
}

function extractLabeledFacts(projectId: string, source: ProjectMemorySource): ProjectFact[] {
  const result: ProjectFact[] = [];
  const raw = sourceLines(source.text);
  const structure = parseMarkdownProjectDocument(source.text);
  for (const [lineIndex, original] of raw.entries()) {
    const line = original.replace(/^\s*[-*•\d.)、]+\s*/, "").trim();
    const section = structure.sections.find((candidate) => lineIndex + 1 >= candidate.startLine && lineIndex + 1 <= candidate.endLine);
    for (const field of Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>) {
      const content = fieldMatch(line, field);
      if (!content) continue;
      result.push(...factForField(projectId, source, field, content, original, lineIndex, section, explicitEvidenceLevel(content)));
    }
    // A parameter section is convenient, but technical notes often use a
    // compact unlabeled line such as “电流环 20kHz”. Recognize only stable
    // parameter slots with a numeric value; measured performance remains a
    // metric and is deliberately not matched here.
    if (!fieldMatch(line, "parameter") && /\d/.test(line)) {
      const parameterKey = canonicalProjectParameterKey({ type: "parameter", title: line, content: line });
      if (parameterKey) result.push(fact(projectId, source, "parameter", PARAMETER_TITLES[parameterKey] ?? "关键参数", line, lineIndex, { quote: original, scope: inferScope(section), sectionPath: section?.path, evidenceLevel: explicitEvidenceLevel(line), confidence: 0.84 }));
    }
    const challenge = fieldMatch(line, "challenge");
    if (challenge) {
      const challengeStart = line.search(/(?:问题|难点|挑战|故障|challenge)\s*[:：]/i);
      for (const field of ["cause", "solution", "result"] as const) {
        const content = inlineFieldMatch(line, field, Math.max(0, challengeStart + 1));
        if (content) result.push(...factForField(projectId, source, field, content, original, lineIndex, section, undefined));
      }
      const laterSolution = line.match(/后来通过\s*(.*?)(?=\s*(?:结果|最终结果|效果)\s*[:：]|$)/i)?.[1]?.trim().replace(/[，,；;。]+$/, "");
      if (laterSolution) result.push(...factForField(projectId, source, "solution", laterSolution, original, lineIndex, section, undefined));
    }
    for (const field of ["hardware", "software", "technology"] as const) {
      const content = fieldMatch(line, field);
      if (!content) continue;
      const type: ProjectFactType = field === "hardware" ? "hardware" : field === "software" ? "software" : "technology";
      for (const entity of extractEntities(content)) result.push(fact(projectId, source, type, entity, entity, lineIndex, { quote: original, scope: inferScope(section), sectionPath: section?.path, subtype: field, confidence: 0.84 }));
    }
  }
  for (const section of structure.sections) {
    const field = sectionField(section);
    if (field) {
      const content = [...section.paragraphs, ...section.bullets].join(" ").trim();
      if (content) result.push(...factForField(projectId, source, field, content, content, section.startLine - 1, section, undefined));
    }
    const sectionText = markdownSectionText(section);
    if (/技术栈|核心技术|技术实现|硬件|软件|算法|协议|接口/.test(section.title)) {
      const fieldType: ProjectFactType = /硬件|主控|芯片/.test(section.title) ? "hardware" : /软件|操作系统/.test(section.title) ? "software" : "technology";
      for (const entity of extractEntities(sectionText)) result.push(fact(projectId, source, fieldType, entity, entity, section.startLine - 1, { quote: sectionText, scope: inferScope(section), sectionPath: section.path, confidence: 0.82 }));
    }
    if (/模块|子系统|驱动|控制环|通信|数据采集|状态机/.test(section.title)) {
      for (const content of [...section.paragraphs, ...section.bullets].slice(0, 12)) result.push(fact(projectId, source, "module", section.title, content, section.startLine - 1, { quote: content, scope: "module", sectionPath: section.path, confidence: 0.72 }));
    }
  }
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
      existing.evidenceLevel = existing.evidenceLevel ?? item.evidenceLevel;
      existing.scope = existing.scope ?? item.scope;
    }
  }
  return [...byKey.values()];
}

export function extractProjectFacts(input: ProjectMemoryAnalysisInput): ProjectFact[] {
  const projectId = input.projectId ?? `project-${slug(input.projectName ?? input.sources[0]?.projectName ?? input.sources[0]?.title ?? "unknown")}`;
  return deduplicate(input.sources.filter(sourceAllowed).flatMap((source) => [...extractLabeledFacts(projectId, source), ...extractTableFacts(projectId, source, parseMarkdownProjectDocument(source.text))]).map((item) => ProjectFactValidator.sanitize(item)).filter((item): item is ProjectFact => Boolean(item)));
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
    if (fact.type === "timeline" && validateProjectTimeline(fact.content).status === "unknown" && !UNKNOWN_TIMELINE.test(fact.content.trim())) issues.push({ code: "TIMELINE_INVALID", message: "项目时间必须是日期范围、持续周期或明确的未知状态" });
    return { status: issues.some((issue) => issue.code === "FACT_MISSING_EVIDENCE" || issue.code === "FACT_REQUIRED_FIELD" || issue.code === "TIMELINE_INVALID") ? "rejected" : issues.length ? "pending_review" : "accepted", issues };
  }

  static sanitize(fact: ProjectFact): ProjectFact | undefined {
    const normalized = ["metric", "technology"].includes(fact.type) && canonicalProjectParameterKey(fact)
      ? { ...fact, type: "parameter" as const, factType: "parameter" as const, value: normalizeProjectFactValue(fact.value, fact.content) }
      : fact;
    const result = this.validate(normalized);
    if (result.status === "rejected") return undefined;
    const pending = result.status === "pending_review" || normalized.evidenceLevel === "pending" || (normalized.type === "timeline" && validateProjectTimeline(normalized.content).status === "unknown");
    return withFactSemantics({ ...normalized, status: pending ? "pending_review" : "active" });
  }
}

export type ProjectFactConflictStatus = "confirmed" | "conflicting" | "pending_review";

export class ProjectFactConflictResolver {
  resolve(facts: ProjectFact[], sources: ProjectMemorySource[] = []): ProjectFact[] {
    void sources;
    const normalizedFacts = facts.map(withFactSemantics);
    const groups = new Map<string, ProjectFact[]>();
    for (const item of normalizedFacts) {
      const semanticKey = item.canonicalKey ?? canonicalProjectFactKey(item);
      const cardinality = item.cardinality ?? inferFactCardinality(item);
      // No stable semantic slot means that two descriptions are allowed to
      // coexist. Set members only share a bucket when their value is the same,
      // so CAN, UART and SPI can never become one conflict.
      const key = semanticKey ? `${item.projectId}|${semanticKey}|${cardinality === "set" ? normalizeTechnicalTerms(item.content).toLowerCase() : ""}` : `${item.projectId}|unkeyed|${item.id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.values()].flatMap((group) => {
      if (group.length <= 1) return group;
      const key = group[0]?.canonicalKey;
      const cardinality = group[0]?.cardinality ?? inferFactCardinality(group[0] as ProjectFact);
      if (cardinality === "set") return [this.merge(group, "confirmed")];
      const equivalent = group.every((item, index) => index === 0 || areCanonicalFactValuesEquivalent(group[0] as ProjectFact, item));
      if (equivalent) return [this.merge(group, "confirmed")];
      const contradiction = group.some((item, index) => group.slice(index + 1).some((other) => isDeterministicContradiction(item, other)));
      if (!contradiction || !key) return group.map((item) => this.clearConflict(item));
      const conflictGroupId = `conflict:${group[0]?.projectId ?? "project"}:${key}`;
      const userConfirmed = group.find((item) => item.verified && item.evidenceLevel === "confirmed-user" && item.status !== "rejected");
      if (userConfirmed && !group.some((item) => (item.evidence ?? []).some((evidence) => evidence.relation === "refute"))) {
        return group.map((item) => item.id === userConfirmed.id
          ? { ...item, conflictStatus: "confirmed" as const, conflictGroupId: undefined, status: "active" as const }
          : { ...item, conflictStatus: "confirmed" as const, conflictGroupId: undefined, status: "rejected" as const });
      }
      return group.map((item) => ({ ...item, conflictStatus: "conflicting" as const, conflictGroupId, status: "conflicting" as const }));
    });
  }

  private clearConflict(fact: ProjectFact): ProjectFact {
    const status = fact.status === "rejected" ? "rejected" : ["pending", "inferred", "risk"].includes(fact.evidenceLevel ?? "pending") ? "pending_review" : "active";
    return { ...fact, conflictStatus: "confirmed", conflictGroupId: undefined, status: status as ProjectFact["status"] };
  }

  private merge(facts: ProjectFact[], status: ProjectFactConflictStatus): ProjectFact {
    const rank: Record<string, number> = { pending: 0, inferred: 0, risk: 0, "not-measured": 0, "confirmed-document": 1, "confirmed-code": 2, "confirmed-user": 3 };
    const first = [...facts].sort((left, right) => Number(right.verified) - Number(left.verified) || (rank[right.evidenceLevel ?? "pending"] ?? 0) - (rank[left.evidenceLevel ?? "pending"] ?? 0) || right.confidence - left.confidence)[0] as ProjectFact;
    const evidence = [...new Map(facts.flatMap((item) => item.evidence ?? []).map((item) => [`${item.sourceId}|${item.quote}|${item.relation ?? "support"}`, item])).values()];
    return { ...first, sourceIds: [...new Set(facts.flatMap((item) => item.sourceIds))], evidence, conflictStatus: status, conflictGroupId: undefined, status: status === "confirmed" ? (first.status === "rejected" ? "rejected" : "active") : "pending_review" };
  }
}
