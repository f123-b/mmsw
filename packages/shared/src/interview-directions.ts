import { DomainRouter, type DomainRouterInput } from "./terminology/domain-router";
import type {
  InterviewDirectionId,
  InterviewDirectionMode,
  InterviewDirectionPreset,
  InterviewDirectionSelection,
  InterviewDomainContext,
  InterviewDomainWeight,
  TechnicalDomain
} from "./terminology/terminology-types";
import type { SessionTerminologyContext, TechnicalTermSource } from "./terminology/terminology-types";

export const INTERVIEW_DIRECTION_PRESETS: readonly InterviewDirectionPreset[] = [
  { id: "auto", label: "自动识别", description: "根据 JD、简历、项目和当前问题自动路由", category: "general", primaryDomains: [], secondaryDomains: [] },
  { id: "embedded_software", label: "嵌入式软件", description: "MCU、RTOS、驱动、通信与固件开发", category: "software", primaryDomains: ["embedded", "c_cpp"], secondaryDomains: ["linux", "network", "common_cs"], terminologyPackIds: ["embedded"] },
  { id: "motor_control", label: "电机控制", description: "FOC、SVPWM、控制环与嵌入式实现", category: "hardware", primaryDomains: ["motor_control", "control_algorithm", "embedded"], secondaryDomains: ["c_cpp", "fpga_ic"], terminologyPackIds: ["motor-control"] },
  { id: "c_cpp_systems", label: "C / C++ 系统", description: "现代 C++、系统编程、性能和并发", category: "software", primaryDomains: ["c_cpp", "common_cs"], secondaryDomains: ["linux", "embedded", "algorithm"], terminologyPackIds: ["c-cpp"] },
  { id: "linux_systems", label: "Linux 系统", description: "内核、驱动、文件系统和系统服务", category: "software", primaryDomains: ["linux", "common_cs"], secondaryDomains: ["c_cpp", "network", "devops"], terminologyPackIds: ["linux"] },
  { id: "ai_application", label: "AI 应用", description: "LLM、RAG、Agent、推理服务和 AI 工程", category: "ai", primaryDomains: ["ai_application", "llm", "backend"], secondaryDomains: ["database", "network", "ai_cv"], terminologyPackIds: ["ai-application"] },
  { id: "ai_cv", label: "AI / CV", description: "机器学习、深度学习、视觉和模型部署", category: "ai", primaryDomains: ["ai_cv", "computer_vision"], secondaryDomains: ["algorithm", "ai_application"], terminologyPackIds: ["ai-cv"] },
  { id: "robotics_ros2", label: "机器人 / ROS2", description: "机器人软件、ROS2、感知与控制", category: "hardware", primaryDomains: ["robotics", "ros", "control_algorithm"], secondaryDomains: ["linux", "c_cpp", "ai_cv"], terminologyPackIds: ["robotics-ros"] },
  { id: "java_backend", label: "Java 后端", description: "JVM、Spring、服务端和数据库", category: "software", primaryDomains: ["java", "backend"], secondaryDomains: ["database", "network", "common_cs"] },
  { id: "frontend", label: "前端", description: "浏览器、React/Vue、TypeScript 和交互", category: "software", primaryDomains: ["frontend"], secondaryDomains: ["backend", "network", "common_cs"] },
  { id: "algorithms", label: "算法", description: "数据结构、算法设计和复杂度分析", category: "software", primaryDomains: ["algorithm", "common_cs"], secondaryDomains: ["c_cpp", "ai_cv"] },
  { id: "network", label: "网络", description: "协议、通信、服务发现和网络编程", category: "software", primaryDomains: ["network"], secondaryDomains: ["linux", "backend", "embedded"] },
  { id: "database", label: "数据库", description: "SQL、事务、索引、缓存和数据建模", category: "software", primaryDomains: ["database"], secondaryDomains: ["backend", "network", "common_cs"] },
  { id: "fpga", label: "FPGA", description: "RTL、时序、总线和硬件加速", category: "hardware", primaryDomains: ["fpga_ic", "computer_architecture"], secondaryDomains: ["embedded", "c_cpp", "verification"] },
  { id: "digital_ic_verification", label: "数字 IC / 验证", description: "数字电路、SystemVerilog、UVM 和验证", category: "hardware", primaryDomains: ["fpga_ic", "verification", "computer_architecture"], secondaryDomains: ["c_cpp", "embedded"] },
  { id: "devops", label: "DevOps", description: "容器、CI/CD、云上部署和可观测性", category: "software", primaryDomains: ["devops", "linux"], secondaryDomains: ["network", "backend", "database"] },
  { id: "custom", label: "自定义", description: "从技术领域中手动选择多个方向", category: "custom", primaryDomains: [], secondaryDomains: [] }
] as const;

const PRESET_BY_ID = new Map(INTERVIEW_DIRECTION_PRESETS.map((preset) => [preset.id, preset]));

export const INTERVIEW_DIRECTION_WEIGHT = {
  current_topic: 1.2,
  current_project: 1.1,
  primary: 1,
  secondary: 0.85,
  job: 0.75,
  resume: 0.7,
  project: 0.68,
  auto: 0.62
} as const;

export interface InterviewTerminologyPreview {
  directionSelection?: InterviewDirectionSelection;
  domainContext?: InterviewDomainContext;
  primaryDomains: readonly TechnicalDomain[];
  secondaryDomains: readonly TechnicalDomain[];
  lexiconSize: number;
  sourceCounts: Readonly<Record<TechnicalTermSource, number>>;
}

export function interviewTerminologyPreview(context: SessionTerminologyContext, directionSelection?: InterviewDirectionSelection): InterviewTerminologyPreview {
  return {
    ...(directionSelection ? { directionSelection } : {}),
    ...(context.domainContext ? { domainContext: context.domainContext } : {}),
    primaryDomains: context.primaryDomains,
    secondaryDomains: context.secondaryDomains,
    lexiconSize: context.terms.length,
    sourceCounts: context.sourceCounts
  };
}

function uniqueDomains(values: readonly TechnicalDomain[]): TechnicalDomain[] {
  return [...new Set(values)];
}

function normalizeSelection(selection?: InterviewDirectionSelection): { mode: InterviewDirectionMode; primary?: InterviewDirectionId; secondary: InterviewDirectionId[]; selected: InterviewDirectionId[] } {
  const mode = selection?.mode === "auto" || selection?.mode === "manual" || selection?.mode === "hybrid" ? selection.mode : "hybrid";
  const explicit = selection?.selectedDirectionIds ?? [];
  const ordered = [...new Set([selection?.primaryDirectionId, ...explicit, ...(selection?.secondaryDirectionIds ?? [])].filter((value): value is string => Boolean(value)))];
  const primary = selection?.primaryDirectionId && ordered.includes(selection.primaryDirectionId) ? selection.primaryDirectionId : ordered[0];
  const secondary = ordered.filter((id) => id !== primary && id !== "auto");
  const selected = ordered.filter((id) => id !== "auto");
  return { mode, primary: primary === "auto" ? undefined : primary, secondary, selected };
}

export function normalizeInterviewDirectionSelection(selection?: InterviewDirectionSelection): InterviewDirectionSelection | undefined {
  if (!selection) return undefined;
  const normalized = normalizeSelection(selection);
  return {
    mode: normalized.mode,
    ...(normalized.primary ? { primaryDirectionId: normalized.primary } : {}),
    ...(normalized.secondary.length ? { secondaryDirectionIds: normalized.secondary } : {}),
    ...(normalized.selected.length ? { selectedDirectionIds: normalized.selected } : {}),
    ...(selection.customDomains?.length ? { customDomains: uniqueDomains(selection.customDomains) } : {}),
    ...(selection.allowAutoSecondary !== undefined ? { allowAutoSecondary: selection.allowAutoSecondary } : {})
  };
}

function presetDomains(id: InterviewDirectionId | undefined, selection: InterviewDirectionSelection | undefined, field: "primaryDomains" | "secondaryDomains"): TechnicalDomain[] {
  if (!id) return [];
  if (id === "custom") return field === "primaryDomains" ? [...(selection?.customDomains ?? [])] : [];
  const preset = PRESET_BY_ID.get(id);
  return preset ? [...preset[field]] : [];
}

export interface ResolveInterviewDomainContextInput extends DomainRouterInput {
  selection?: InterviewDirectionSelection;
  router?: DomainRouter;
}

/**
 * Resolve an optional interview direction into the existing domain route.
 * Undefined selection deliberately returns undefined so old users retain the
 * exact legacy DomainRouter path.
 */
export function resolveInterviewDomainContext(input: ResolveInterviewDomainContextInput = {}): InterviewDomainContext | undefined {
  if (!input.selection) return undefined;
  const selection = normalizeInterviewDirectionSelection(input.selection) ?? { mode: "hybrid" as const };
  const normalized = normalizeSelection(selection);
  const router = input.router ?? new DomainRouter();
  const routeInput = { ...input, includeExtendedDomains: true };
  const route = router.route(routeInput);
  const autoPrimary = [...route.primaryDomains];
  const autoSecondary = [...route.secondaryDomains];
  const manualPrimary = presetDomains(normalized.primary, selection, "primaryDomains");
  const manualSecondary = normalized.secondary.flatMap((id) => [...presetDomains(id, selection, "primaryDomains"), ...presetDomains(id, selection, "secondaryDomains")]);
  const hasManual = manualPrimary.length > 0 || manualSecondary.length > 0;
  const useAutoPrimary = normalized.mode === "auto" || (!hasManual && normalized.mode !== "manual");
  const primaryDomains = uniqueDomains(useAutoPrimary ? autoPrimary : manualPrimary.length ? manualPrimary : autoPrimary);
  const allowAutoSecondary = selection.allowAutoSecondary ?? normalized.mode === "hybrid";
  const secondaryDomains = uniqueDomains([
    ...(useAutoPrimary ? [] : manualSecondary),
    ...(allowAutoSecondary || normalized.mode === "auto" ? autoSecondary : [])
  ].filter((domain) => !primaryDomains.includes(domain))).slice(0, 8);
  const weighted = new Map<TechnicalDomain, InterviewDomainWeight>();
  const addWeight = (domain: TechnicalDomain, weight: number, source: InterviewDomainWeight["source"], directionId?: InterviewDirectionId) => {
    const previous = weighted.get(domain);
    if (!previous || weight > previous.weight) weighted.set(domain, { domain, weight, source, ...(directionId ? { directionId } : {}) });
  };
  primaryDomains.forEach((domain) => addWeight(domain, INTERVIEW_DIRECTION_WEIGHT.primary, "primary", normalized.primary));
  secondaryDomains.forEach((domain) => addWeight(domain, manualSecondary.includes(domain) ? INTERVIEW_DIRECTION_WEIGHT.secondary : INTERVIEW_DIRECTION_WEIGHT.auto, manualSecondary.includes(domain) ? "secondary" : "auto"));
  if (normalized.mode !== "manual") {
    if (input.currentTopic) for (const domain of [...router.route({ currentTopic: input.currentTopic, includeExtendedDomains: true }).primaryDomains, ...router.route({ currentTopic: input.currentTopic, includeExtendedDomains: true }).secondaryDomains]) addWeight(domain, INTERVIEW_DIRECTION_WEIGHT.current_topic, "current_topic");
    if (input.project) for (const domain of [...router.route({ project: input.project, includeExtendedDomains: true }).primaryDomains, ...router.route({ project: input.project, includeExtendedDomains: true }).secondaryDomains]) addWeight(domain, INTERVIEW_DIRECTION_WEIGHT.current_project, "current_project");
    if (input.jd) for (const domain of [...router.route({ jd: input.jd, includeExtendedDomains: true }).primaryDomains, ...router.route({ jd: input.jd, includeExtendedDomains: true }).secondaryDomains]) addWeight(domain, INTERVIEW_DIRECTION_WEIGHT.job, "job");
    if (input.resume) for (const domain of [...router.route({ resume: input.resume, includeExtendedDomains: true }).primaryDomains, ...router.route({ resume: input.resume, includeExtendedDomains: true }).secondaryDomains]) addWeight(domain, INTERVIEW_DIRECTION_WEIGHT.resume, "resume");
    for (const domain of [...autoPrimary, ...autoSecondary]) addWeight(domain, INTERVIEW_DIRECTION_WEIGHT.auto, "auto");
  }
  const effectiveDomains = [...weighted.values()].sort((left, right) => right.weight - left.weight || left.domain.localeCompare(right.domain));
  return {
    mode: normalized.mode,
    ...(normalized.primary ? { primaryDirectionId: normalized.primary } : {}),
    secondaryDirectionIds: normalized.secondary,
    primaryDomains,
    secondaryDomains,
    autoPrimaryDomains: autoPrimary,
    autoSecondaryDomains: autoSecondary,
    effectiveDomains,
    selectedDirectionIds: normalized.selected
  };
}

export function interviewDirectionPreset(id?: InterviewDirectionId): InterviewDirectionPreset | undefined {
  return id ? PRESET_BY_ID.get(id) : undefined;
}

export function interviewDirectionPresets(): readonly InterviewDirectionPreset[] {
  return INTERVIEW_DIRECTION_PRESETS;
}
