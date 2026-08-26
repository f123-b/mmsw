import { normalizeTechnicalTerms } from "../terminology";
import { canonicalProjectParameterKey, inferExperienceRelation, normalizeProjectFactValue } from "./project-technical-memory";
import type { ProjectFact, ProjectFactCardinality, ProjectFactValue } from "./types";

const SET_TYPES = new Set(["technology", "module"]);
const NARRATIVE_TYPES = new Set(["background", "goal", "architecture", "challenge", "cause", "solution", "result", "application", "technical_decision", "decision", "limitation"]);

const compact = (value: string): string => normalizeTechnicalTerms(value).toLowerCase().replace(/[\s\u3000，。！？、,.!?；;:：/\\()[\]{}「」“”"'·_\-]+/g, "");

function factText(fact: ProjectFact): string {
  return `${fact.title} ${fact.content}`.trim();
}

function containsAny(text: string, terms: string[]): boolean {
  const normalized = normalizeTechnicalTerms(text).toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

function isMcu(text: string): boolean { return /\b(?:stm32[a-z]?\d+|esp32|rk\d+[a-z]?|mcu)\b|芯片/i.test(normalizeTechnicalTerms(text)); }
function isRtos(text: string): boolean { return /free\s*rtos|\brtos\b|实时操作系统|操作系统/i.test(normalizeTechnicalTerms(text)); }
function isNoRtos(text: string): boolean { return /(?:\b(?:no\s+rtos|without\s+rtos)\b|(?:未使用|不使用|没有|无|不采用)\s*(?:free\s*rtos|rtos|实时操作系统)|裸机)/i.test(normalizeTechnicalTerms(text)); }

/** Stable semantic slot used by conflict resolution and user actions. */
export function canonicalProjectFactKey(fact: ProjectFact): string | undefined {
  const text = factText(fact);
  const normalized = normalizeTechnicalTerms(text).toLowerCase();
  const parameterKey = canonicalProjectParameterKey(fact);
  if (fact.type === "parameter" || parameterKey) return parameterKey;
  if (fact.type === "timeline" && fact.subtype !== "supporting-development-window") return "project.timeline";
  if (fact.type === "metric") {
    if (/电流环|current[\s._-]*loop/i.test(text)) return "control.current_loop.frequency";
    if (/速度环|speed[\s._-]*loop/i.test(text)) return "control.speed_loop.frequency";
    if (/位置环|position[\s._-]*loop/i.test(text)) return "control.position_loop.frequency";
    if (/pwm|采样|频率|frequency/i.test(text)) return "control.frequency";
  }
  if (fact.type === "hardware" && isMcu(text)) return "mcu.main";
  if (containsAny(text, ["drv8301", "drv8323", "栅极驱动", "电机驱动器"])) return "motor.driver";
  if (containsAny(text, ["as5047p", "mt6816", "编码器", "position sensor", "位置传感器"])) return "position_sensor.primary";
  if ((fact.type === "software" || fact.type === "technology") && isRtos(text)) return "rtos.primary";
  if (fact.type === "responsibility") {
    if (containsAny(text, ["fdcan"])) return "responsibility.communication.fdcan";
    if (containsAny(text, ["can"])) return "responsibility.communication.can";
    if (containsAny(text, ["uart", "usart"])) return "responsibility.communication.uart";
    if (containsAny(text, ["spi"])) return "responsibility.communication.spi";
    if (containsAny(text, ["foc", "电流环", "速度环", "位置环"])) return "responsibility.control";
  }
  if (fact.type !== "technology") return undefined;
  const aliases: Array<[string, string[]]> = [
    ["communication.fdcan", ["fdcan"]],
    ["communication.can", ["can"]],
    ["communication.uart", ["uart", "usart"]],
    ["communication.spi", ["spi"]],
    ["communication.i2c", ["i2c", "iic"]],
    ["communication.usb_cdc", ["usb cdc"]],
    ["communication.modbus", ["modbus"]],
    ["communication.mqtt", ["mqtt"]],
    ["control.foc", ["foc"]],
    ["control.svpwm", ["svpwm"]],
    ["control.pid", ["pid"]],
    ["control.clarke", ["clarke"]],
    ["control.park", ["park"]],
    ["sampling.adc", ["adc"]],
    ["sampling.dma", ["dma"]],
    ["sampling.pwm", ["pwm"]],
    ["language.c", ["c11"]],
    ["language.cpp", ["c++", "cpp", "cxx"]],
    ["language.python", ["python"]],
    ["build.cmake", ["cmake"]],
    ["os.linux", ["linux"]]
  ];
  return aliases.find(([, terms]) => terms.some((term) => normalized.includes(term)))?.[0];
}

export function inferFactCardinality(fact: ProjectFact): ProjectFactCardinality {
  if (fact.cardinality === "single" || fact.cardinality === "set" || fact.cardinality === "narrative") return fact.cardinality;
  const key = canonicalProjectFactKey(fact);
  if (key?.startsWith("responsibility.")) return "narrative";
  if (key && (key.startsWith("mcu.") || key.startsWith("rtos.") || key.startsWith("motor.driver") || key.endsWith(".frequency") || key.includes(".bitrate") || key.includes(".baudrate") || key.includes(".limit") || key.includes("_limit") || key.includes(".pole_pairs") || key.includes(".resolution") || key.includes(".period") || key.startsWith("control.") || key.startsWith("runtime.") || key === "sampling.window" || key === "project.timeline")) return "single";
  if (SET_TYPES.has(fact.type) || ["hardware", "software"].includes(fact.type)) return "set";
  if (fact.type === "responsibility" || NARRATIVE_TYPES.has(fact.type)) return "narrative";
  return "narrative";
}

function valueForComparison(fact: ProjectFact, key: string | undefined): string {
  const structured = normalizeProjectFactValue(fact.value, fact.content);
  if (structured && key && (key.includes("frequency") || key.includes("bitrate") || key.includes("baudrate") || key.includes(".limit") || key.includes("_limit") || key.includes("pole_pairs") || key.includes("resolution") || key.includes("period") || key.startsWith("control.") || key.startsWith("runtime.") || key === "sampling.window")) return comparableStructuredValue(structured);
  const text = normalizeTechnicalTerms(factText(fact));
  if (key === "mcu.main") return text.match(/(?:stm32[a-z]?\d+|esp32|rk\d+[a-z]?)/i)?.[0]?.toLowerCase() ?? (/(?:mcu|芯片)/i.test(text) ? "mcu" : compact(text));
  if (key === "rtos.primary") return isNoRtos(text) ? "none" : /free\s*rtos/i.test(text) ? "freertos" : "rtos";
  if (key?.startsWith("control.") || key === "project.timeline" || key?.startsWith("communication.") || key?.startsWith("responsibility.")) return compact(text);
  return compact(text);
}

/** Display strings are evidence-friendly labels, not semantic values. */
function comparableStructuredValue(value: ProjectFactValue): string {
  if (value.kind === "scalar") return `scalar:${value.value}:${value.unit ?? ""}`;
  if (value.kind === "range") return `range:${value.min}:${value.max}:${value.unit ?? ""}`;
  if (value.kind === "boolean") return `boolean:${value.value}`;
  return `enum:${value.value}`;
}

export function canonicalProjectFactValue(fact: ProjectFact): string {
  return valueForComparison(fact, fact.canonicalKey ?? canonicalProjectFactKey(fact));
}

export function areCanonicalFactValuesEquivalent(left: ProjectFact, right: ProjectFact): boolean {
  const key = left.canonicalKey ?? canonicalProjectFactKey(left);
  const rightKey = right.canonicalKey ?? canonicalProjectFactKey(right);
  if (!key || key !== rightKey) return false;
  const a = valueForComparison(left, key);
  const b = valueForComparison(right, key);
  if (a === b) return true;
  if (key === "mcu.main") return (a === "stm32" && b.startsWith("stm32")) || (b === "stm32" && a.startsWith("stm32"));
  if (key === "rtos.primary") return a !== "none" && b !== "none";
  return false;
}

function ownershipPolarity(fact: ProjectFact): "self" | "other" | "unknown" {
  if (fact.ownership === "self") return "self";
  if (fact.ownership === "team") return "other";
  const text = factText(fact);
  if (/(?:由其他成员|其他成员|他人|团队负责|非本人|不是我|不负责)/i.test(text)) return "other";
  if (/(?:本人|我|自己)负责|^负责|负责(?:了|的)/i.test(text)) return "self";
  return "unknown";
}

function timelineRange(text: string): [number, number] | undefined {
  const matches = [...text.matchAll(/(20\d{2})[./年-](\d{1,2})(?:[./月-](\d{1,2}))?/g)].map((match) => Number(match[1]) * 12 + Number(match[2]) - 1);
  if (matches.length < 2) return undefined;
  return [Math.min(...matches), Math.max(...matches)];
}

function explicitNegationPair(left: ProjectFact, right: ProjectFact): boolean {
  const leftText = normalizeTechnicalTerms(factText(left));
  const rightText = normalizeTechnicalTerms(factText(right));
  const leftNegative = /(?:未使用|不使用|没有|无|未采用|not\s+used|without)/i.test(leftText);
  const rightNegative = /(?:未使用|不使用|没有|无|未采用|not\s+used|without)/i.test(rightText);
  return leftNegative !== rightNegative;
}

/** Deterministic contradiction check. Unknown/unkeyed narratives never conflict. */
export function isDeterministicContradiction(left: ProjectFact, right: ProjectFact): boolean {
  const key = left.canonicalKey ?? canonicalProjectFactKey(left);
  if (!key || key !== (right.canonicalKey ?? canonicalProjectFactKey(right))) return false;
  if (left.variantContext?.trim() && right.variantContext?.trim() && left.variantContext.trim().toLowerCase() !== right.variantContext.trim().toLowerCase()) return false;
  const leftCardinality = inferFactCardinality(left);
  const rightCardinality = inferFactCardinality(right);
  if (leftCardinality === "set" || rightCardinality === "set") return false;
  if (key.startsWith("responsibility.")) {
    const a = ownershipPolarity(left);
    const b = ownershipPolarity(right);
    return a !== "unknown" && b !== "unknown" && a !== b;
  }
  if (key === "project.timeline") {
    const a = timelineRange(left.content);
    const b = timelineRange(right.content);
    return Boolean(a && b && (a[1] < b[0] || b[1] < a[0]));
  }
  if (areCanonicalFactValuesEquivalent(left, right)) return false;
  if (key === "rtos.primary") return isNoRtos(left.content) !== isNoRtos(right.content);
  if (leftCardinality === "single" && rightCardinality === "single") return true;
  return explicitNegationPair(left, right);
}

export function semanticFactKey(fact: ProjectFact): string | undefined {
  const key = fact.canonicalKey ?? canonicalProjectFactKey(fact);
  if (!key) return undefined;
  return `${fact.projectId}|${key}|${inferFactCardinality(fact) === "set" ? canonicalProjectFactValue(fact) : ""}`;
}

export function withFactSemantics(fact: ProjectFact): ProjectFact {
  const canonicalKey = fact.canonicalKey ?? canonicalProjectFactKey(fact);
  const cardinality = inferFactCardinality({ ...fact, canonicalKey });
  const parameter = fact.type === "parameter" || Boolean(canonicalProjectParameterKey(fact));
  // The relation is a local semantic projection, not an LLM-controlled claim.
  // Recompute it on every normalization so a third-party library can never be
  // upgraded to “implemented” by model output or stale persisted metadata.
  return { ...fact, ...(canonicalKey ? { canonicalKey } : {}), cardinality, experienceRelation: inferExperienceRelation(fact), ...(parameter ? { value: normalizeProjectFactValue(fact.value, fact.content) } : {}) };
}

export function semanticLabel(canonicalKey: string | undefined, facts: ProjectFact[] = []): string {
  const labels: Record<string, string> = {
    "mcu.main": "主 MCU 冲突",
    "rtos.primary": "RTOS 选择冲突",
    "motor.driver": "电机驱动器冲突",
    "position_sensor.primary": "位置传感器冲突",
    "control.current_loop.frequency": "电流环频率冲突",
    "control.speed_loop.frequency": "速度环频率冲突",
    "control.frequency": "控制频率冲突",
    "sampling.pwm.frequency": "PWM 频率冲突",
    "sampling.adc.frequency": "ADC 采样频率冲突",
    "communication.can.bitrate": "CAN 波特率冲突",
    "communication.uart.baudrate": "UART 波特率冲突",
    "motor.current_limit": "电流限制冲突",
    "motor.voltage_limit": "电压限制冲突",
    "motor.pole_pairs": "电机极对数冲突",
    "sensor.encoder.resolution": "编码器分辨率冲突",
    "rtos.control_task.period": "控制任务周期冲突",
    "rtos.communication_task.period": "通信任务周期冲突",
    "rtos.task.period": "RTOS 任务周期冲突",
    "project.timeline": "项目时间冲突"
  };
  if (canonicalKey?.startsWith("responsibility.")) return `职责归属冲突 · ${facts[0]?.title ?? "职责"}`;
  return labels[canonicalKey ?? ""] ?? `${facts[0]?.title ?? "事实"}冲突`;
}
