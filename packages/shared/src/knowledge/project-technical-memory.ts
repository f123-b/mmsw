import { normalizeTechnicalTerms } from "../terminology";
import type { ProjectExperienceRelation, ProjectFact, ProjectFactValue, ProjectMemoryProject, ProjectOwnershipMode } from "./types";

export const PROJECT_OWNERSHIP_MODES: readonly ProjectOwnershipMode[] = ["personal", "team", "partial", "reference"];

export function normalizeProjectOwnershipMode(value: unknown): ProjectOwnershipMode {
  return PROJECT_OWNERSHIP_MODES.includes(value as ProjectOwnershipMode) ? value as ProjectOwnershipMode : "personal";
}

const PARAMETER_RULES: Array<[string, RegExp]> = [
  ["control.current_loop.frequency", /(?:电流环|current[\s._-]*loop)[^\n，。；;:：]{0,24}(?:频率|frequency|(?=[=：:\s]*[-+]?\d))/i],
  ["control.speed_loop.frequency", /(?:速度环|speed[\s._-]*loop)[^\n，。；;:：]{0,24}(?:频率|frequency|(?=[=：:\s]*[-+]?\d))/i],
  ["control.position_loop.frequency", /(?:位置环|position[\s._-]*loop)[^\n，。；;:：]{0,24}(?:频率|frequency|(?=[=：:\s]*[-+]?\d))/i],
  ["sampling.pwm.frequency", /(?:pwm)[^\n，。；;:：]{0,24}(?:频率|frequency|(?=[=：:\s]*[-+]?\d))/i],
  ["sampling.adc.frequency", /(?:adc|采样|sampling[\s._-]*rate|sample[\s._-]*rate)[^\n，。；;:：]{0,24}(?:频率|frequency|采样率|sampling[\s._-]*rate|(?=[=：:\s]*[-+]?\d))/i],
  ["communication.can.bitrate", /(?:fdcan|can)[^\n，。；;:：]{0,24}(?:波特率|bitrate|速率|kbps|mbps)/i],
  ["communication.uart.baudrate", /(?:uart|usart)[^\n，。；;:：]{0,24}(?:波特率|baudrate)/i],
  ["motor.current_limit", /(?:电流|current)[^\n，。；;:：]{0,24}(?:限流|限幅|限制|limit)/i],
  ["motor.voltage_limit", /(?:电压|voltage)[^\n，。；;:：]{0,24}(?:限幅|限制|limit|上限)/i],
  ["motor.pole_pairs", /(?:极对数|pole[\s._-]*pairs?)/i],
  ["sensor.encoder.resolution", /(?:编码器|encoder)[^\n，。；;:：]{0,24}(?:分辨率|resolution|线数|bit)/i],
  ["rtos.control_task.period", /(?:freertos|rtos|控制任务|control[\s._-]*task)[^\n，。；;:：]{0,32}(?:周期|period|间隔|ms|hz)/i],
  ["rtos.communication_task.period", /(?:freertos|rtos|通信任务|communication[\s._-]*task)[^\n，。；;:：]{0,32}(?:周期|period|间隔|ms|hz)/i],
  ["rtos.task.period", /(?:freertos|rtos|任务|task)[^\n，。；;:：]{0,32}(?:周期|period|间隔|ms|hz)/i],
  ["control.timeout", /(?:超时|timeout)[^\n，。；;:：]{0,16}(?=[=：:\s]*[-+]?\d)/i],
  ["control.pi", /(?:PI参数|PI增益|比例积分|\bpi[\s._-]*(?:gain|参数|controller)?\b)/i],
  ["control.filter", /(?:滤波器?|filter)[^\n，。；;:：]{0,24}(?=[=：:\s]*[-+]?\d|截止|cutoff|hz)/i],
  ["runtime.buffer.size", /(?:缓冲区|buffer)[^\n，。；;:：]{0,24}(?:大小|size|长度|length|深度|depth)/i],
  ["runtime.queue.depth", /(?:队列|queue)[^\n，。；;:：]{0,24}(?:深度|depth|长度|length|大小|size)/i],
  ["sampling.window", /(?:采样窗口|sampling[\s._-]*window)/i]
];

const PERFORMANCE_WORDS = /(?:实测|测得|测试|性能|benchmark|延迟|吞吐|帧率|误差|提升|降低|达到|压测|profil(?:e|ing))/i;

function factText(fact: Pick<ProjectFact, "title" | "content">): string {
  return `${fact.title} ${fact.content}`.trim();
}

function normalizedText(value: string): string {
  return normalizeTechnicalTerms(value).replace(/[，。；：]/g, " ").replace(/\s+/g, " ").trim();
}

/** Stable keys for configured project parameters. Performance-only metrics do not become parameters. */
export function canonicalProjectParameterKey(fact: Pick<ProjectFact, "type" | "title" | "content">): string | undefined {
  // A parameter phrase inside a problem, cause, solution, or decision is
  // supporting narrative, not a standalone configured-value fact. Legacy
  // metric/technology records remain eligible for deterministic backfill.
  if (!(fact.type === "parameter" || fact.type === "metric" || fact.type === "technology" || fact.type === "hardware" || fact.type === "software")) return undefined;
  const text = factText(fact);
  if (PERFORMANCE_WORDS.test(text) && fact.type === "metric") return undefined;
  return PARAMETER_RULES.find(([, rule]) => rule.test(text))?.[0];
}

export function isProjectParameterFact(fact: Pick<ProjectFact, "type" | "title" | "content">): boolean {
  return fact.type === "parameter" || Boolean(canonicalProjectParameterKey(fact));
}

function numericUnit(unit: string | undefined, text: string): { factor: number; unit?: string } {
  const normalized = unit?.replace(/\s+/g, "").toLowerCase();
  const frequency = /频率|frequency|hz|pwm|电流环|速度环|位置环|采样/i.test(text);
  const bitrate = /波特率|baud|bitrate|kbps|mbps|bit\/s/i.test(text);
  if (!normalized) return { factor: 1 };
  if (normalized === "k" && frequency) return { factor: 1_000, unit: "Hz" };
  if (normalized === "k" && bitrate) return { factor: 1_000, unit: "bit/s" };
  const units: Record<string, { factor: number; unit: string }> = {
    hz: { factor: 1, unit: "Hz" }, khz: { factor: 1_000, unit: "Hz" }, mhz: { factor: 1_000_000, unit: "Hz" }, ghz: { factor: 1_000_000_000, unit: "Hz" },
    bps: { factor: 1, unit: "bit/s" }, "bit/s": { factor: 1, unit: "bit/s" }, kbps: { factor: 1_000, unit: "bit/s" }, mbps: { factor: 1_000_000, unit: "bit/s" }, gbps: { factor: 1_000_000_000, unit: "bit/s" },
    s: { factor: 1, unit: "s" }, ms: { factor: 1, unit: "ms" }, us: { factor: 1, unit: "μs" }, "μs": { factor: 1, unit: "μs" }, ns: { factor: 1, unit: "ns" },
    a: { factor: 1, unit: "A" }, ma: { factor: 0.001, unit: "A" }, v: { factor: 1, unit: "V" }, mv: { factor: 0.001, unit: "V" }, rpm: { factor: 1, unit: "rpm" }, "%": { factor: 1, unit: "%" }
  };
  return units[normalized] ?? { factor: 1, unit };
}

function normalizeNumeric(value: number, unit: string | undefined, text: string, display?: string): ProjectFactValue {
  const normalized = numericUnit(unit, text);
  return { kind: "scalar", value: value * normalized.factor, ...(normalized.unit ? { unit: normalized.unit } : {}), ...(display ? { display: display.trim() } : {}) };
}

function rawDisplay(text: string, match: string): string | undefined {
  const display = text.match(new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"))?.[0];
  return display?.trim() || undefined;
}

export function normalizeProjectFactValue(input: unknown, fallbackText = ""): ProjectFactValue | undefined {
  let value: unknown = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* plain text is handled below */ }
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    // Accept a ProjectFact-shaped object as a convenience for callers that
    // want to normalize the fact's content in one step.
    if (!candidate.kind && typeof candidate.content === "string") {
      fallbackText ||= candidate.content;
      value = candidate.value;
    }
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === "boolean" && typeof candidate.value === "boolean") return { kind: "boolean", value: candidate.value };
    if (candidate.kind === "range" && Number.isFinite(Number(candidate.min)) && Number.isFinite(Number(candidate.max))) {
      const display = typeof candidate.display === "string" ? candidate.display : undefined;
      const unit = typeof candidate.unit === "string" ? candidate.unit : undefined;
      const left = normalizeNumeric(Number(candidate.min), unit, fallbackText, display);
      const right = normalizeNumeric(Number(candidate.max), unit, fallbackText, display);
      return { kind: "range", min: left.kind === "scalar" ? left.value : Number(candidate.min), max: right.kind === "scalar" ? right.value : Number(candidate.max), ...(left.kind === "scalar" && left.unit ? { unit: left.unit } : {}), ...(display ? { display } : {}) };
    }
    if (candidate.kind === "scalar" && Number.isFinite(Number(candidate.value))) return normalizeNumeric(Number(candidate.value), typeof candidate.unit === "string" ? candidate.unit : undefined, fallbackText, typeof candidate.display === "string" ? candidate.display : undefined);
    if (candidate.kind === "enum" && typeof candidate.value === "string" && candidate.value.trim()) return { kind: "enum", value: candidate.value.trim() };
  }
  const rawText = typeof value === "string" && value.trim() ? value : fallbackText;
  const text = normalizedText(rawText);
  if (!text) return undefined;
  if (/^(?:是|有|启用|开启|true|yes)$/i.test(text)) return { kind: "boolean", value: true };
  if (/^(?:否|无|未启用|关闭|false|no)$/i.test(text)) return { kind: "boolean", value: false };
  const range = text.match(/([-+]?\d+(?:\.\d+)?)\s*(?:至|到|~|～|-)\s*([-+]?\d+(?:\.\d+)?)\s*([a-zA-Z%μΩ]+(?:\s*\/\s*[a-zA-Z]+)?|[kK])?/);
  if (range) {
    const display = rawDisplay(rawText, range[0]);
    const left = normalizeNumeric(Number(range[1]), range[3], rawText, display);
    const right = normalizeNumeric(Number(range[2]), range[3], rawText, display);
    return { kind: "range", min: left.kind === "scalar" ? left.value : Number(range[1]), max: right.kind === "scalar" ? right.value : Number(range[2]), ...(left.kind === "scalar" && left.unit ? { unit: left.unit } : {}), ...(display ? { display } : {}) };
  }
  const scalar = text.match(/[-+]?\d+(?:\.\d+)?\s*([a-zA-Z%μΩ]+(?:\s*\/\s*[a-zA-Z]+)?|[kK])?/);
  if (scalar) {
    const number = Number(scalar[0].match(/[-+]?\d+(?:\.\d+)?/)?.[0]);
    return normalizeNumeric(number, scalar[1], rawText, rawDisplay(rawText, scalar[0]));
  }
  return { kind: "enum", value: text.slice(0, 120) };
}

const THIRD_PARTY_LIBRARY = /(?:FreeRTOS|HAL|CMSIS|Linux|OpenCV|Eigen|LVGL|CMake|MQTT(?:\s*(?:库|library))?|SocketCAN|Modbus|SQLite)/i;

/** Infers an interview-safe relationship locally; it never claims library implementation. */
export function inferExperienceRelation(fact: Pick<ProjectFact, "type" | "title" | "content">): ProjectExperienceRelation {
  const text = factText(fact);
  const thirdParty = THIRD_PARTY_LIBRARY.test(text) && ["technology", "software", "hardware"].includes(fact.type);
  if (fact.type === "parameter") return "configured";
  if (fact.type === "metric") return "measured";
  if (fact.type === "challenge") return "observed";
  if (fact.type === "cause" || fact.type === "solution") return "debugged";
  if (fact.type === "module") return "implemented";
  if (fact.type === "architecture" || fact.type === "technical_decision" || fact.type === "decision") return "designed";
  if (/(?:集成|接入|对接|整合|integrat(?:e|ed|ion))/i.test(text)) return "integrated";
  if (/(?:配置|部署|调参|初始化|configure|configured|deploy)/i.test(text)) return "configured";
  if (/(?:排查|定位|修复|调试|debug|故障)/i.test(text)) return "debugged";
  if (/(?:测量|测试|实测|benchmark|measure|profil)/i.test(text)) return "measured";
  if (/(?:设计|架构|方案|选型|design|architect)/i.test(text) || ["architecture", "technical_decision", "decision"].includes(fact.type)) return "designed";
  if (!thirdParty && fact.type === "technology" && /(?:FOC|SVPWM|PID|Clarke|Park)/i.test(text)) return "implemented";
  if (!thirdParty && /(?:实现|开发|编写|重构|实现了|implement|develop|write|coded)/i.test(text)) return "implemented";
  if (/(?:观察|看到|日志显示|现象|observed|observe)/i.test(text) || ["challenge", "cause"].includes(fact.type)) return "observed";
  if (fact.type === "technology" && /(?:CAN|UART|USART|SPI|I2C|IIC|USB)/i.test(text)) return "integrated";
  if (/(?:使用|采用|基于|调用|used|use|with|based on)/i.test(text) || thirdParty || ["technology", "software", "hardware"].includes(fact.type)) return "used";
  return "project";
}

export function formatProjectFactValue(value?: ProjectFactValue): string {
  if (!value) return "";
  if ("display" in value && value.display) return value.display;
  if (value.kind === "boolean") return value.value ? "是" : "否";
  if (value.kind === "range") return `${value.min}–${value.max}${value.unit ? ` ${value.unit}` : ""}`;
  return `${value.value}${"unit" in value && value.unit ? ` ${value.unit}` : ""}`;
}

export interface ProjectAnswerPerspective {
  mode: ProjectOwnershipMode;
  voice: "first-person" | "project";
  relation: ProjectExperienceRelation;
  instruction: string;
}

export function resolveProjectAnswerPerspective(project: Pick<ProjectMemoryProject, "ownershipMode">, fact: ProjectFact): ProjectAnswerPerspective {
  const mode = normalizeProjectOwnershipMode(project.ownershipMode);
  const relation = fact.experienceRelation ?? inferExperienceRelation(fact);
  const confirmedResponsibility = fact.type === "responsibility" && fact.ownership === "self" && (fact.evidenceLevel === "confirmed-user" || fact.verified);
  const personalScope = fact.ownership === "self" && (fact.evidenceLevel === "confirmed-user" || fact.verified);
  const personalRelation = relation !== "project";
  const firstPerson = mode === "personal" ? personalRelation : mode === "team" ? confirmedResponsibility || personalScope : mode === "partial" ? confirmedResponsibility : false;
  return {
    mode,
    voice: firstPerson ? "first-person" : "project",
    relation,
    instruction: firstPerson
      ? "可以使用第一人称，但只描述该事实所对应的实际经验关系，不扩大职责范围。"
      : mode === "reference" ? "只能作为通用参考解释，禁止写成候选人的项目经历或第一人称。" : "使用“项目中/团队中”表述；除已确认的本人职责或个人范围外，不要代入第一人称。"
  };
}

export interface ProjectProblemChain {
  id: string;
  challenge?: ProjectFact;
  cause?: ProjectFact;
  solution?: ProjectFact;
  result?: ProjectFact;
  factIds: string[];
}

export interface ProjectTechnicalDecision {
  id: string;
  factId: string;
  choice: string;
  reason?: string;
  tradeoff?: string;
}

/** Derived decision view. It only exposes reason/tradeoff text that exists in the fact. */
export function deriveProjectTechnicalDecisions(facts: ProjectFact[]): ProjectTechnicalDecision[] {
  return facts.filter((fact) => !fact.stale && fact.status !== "rejected" && (fact.type === "technical_decision" || fact.type === "decision")).map((fact) => {
    const content = fact.content.trim();
    const labelSeparator = "[；;，,。\\s]*";
    const reason = content.match(new RegExp(`(?:原因|理由|因为|为了|reason)\\s*[:：]?\\s*(.*?)(?=${labelSeparator}(?:取舍|权衡|代价|tradeoff)\\s*[:：]|$)`, "i"))?.[1]?.trim();
    const tradeoff = content.match(new RegExp(`(?:取舍|权衡|代价|tradeoff)\\s*[:：]?\\s*(.*)$`, "i"))?.[1]?.trim();
    const choice = content.match(new RegExp(`(?:选择|采用|方案|choice)\\s*[:：]?\\s*(.*?)(?=${labelSeparator}(?:原因|理由|因为|为了|reason|取舍|权衡|代价|tradeoff)\\s*[:：]|$)`, "i"))?.[1]?.trim() || fact.title || content;
    return { id: `decision-view:${fact.id}`, factId: fact.id, choice, ...(reason ? { reason } : {}), ...(tradeoff ? { tradeoff } : {}) };
  });
}

/** Derived view only: it groups existing facts and never creates a new source of truth. */
export function deriveProjectProblemChains(facts: ProjectFact[]): ProjectProblemChain[] {
  const eligible = facts.filter((fact) => !fact.stale && fact.status !== "rejected");
  const keys = [...new Set(eligible.filter((fact) => ["challenge", "cause", "solution", "result"].includes(fact.type)).map((fact) => fact.sectionPath?.join("/") || fact.scope || "project"))];
  return keys.map((key, index) => {
    const group = eligible.filter((fact) => (fact.sectionPath?.join("/") || fact.scope || "project") === key);
    const pick = (type: ProjectFact["type"]): ProjectFact | undefined => group.find((fact) => fact.type === type);
    const selected = [pick("challenge"), pick("cause"), pick("solution"), pick("result")].filter((fact): fact is ProjectFact => Boolean(fact));
    return { id: `problem-chain:${group[0]?.projectId ?? "project"}:${key}:${index}`, challenge: pick("challenge"), cause: pick("cause"), solution: pick("solution"), result: pick("result"), factIds: selected.map((fact) => fact.id) };
  }).filter((chain) => Boolean(chain.challenge || chain.cause || chain.solution || chain.result));
}
