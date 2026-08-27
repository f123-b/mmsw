import type { ProjectMemorySource } from "../knowledge/types";
import { normalizeTechnicalTerms } from "../terminology";
import { ProjectVersionResolver, type ProjectParameterCandidate } from "./version-resolver";
import type { ProjectComprehensionInput, ProjectComprehensionStatus, ProjectEvidenceRef, ProjectExplorerObservation, ProjectRepoMap, ProjectUnderstanding, ProjectComponent, ProjectFlow, ProjectParameterUnderstanding, ProjectTechnologyUnderstanding } from "./types";

interface ReadFileObservation {
  path: string;
  sourceId: string;
  kind: "source" | "test" | "config" | "document" | "generated" | "third-party" | "other";
  language: string;
  text: string;
}

interface BuilderTrace {
  toolCalls: number;
  filesRead: number;
  modelTurns: number;
  elapsedMs: number;
  stages: ProjectUnderstanding["trace"]["stages"];
}

function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function compact(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "component"; }
function lineFor(text: string, pattern: RegExp): { line: string; lineNumber: number } | undefined {
  const lines = text.replace(/\r/g, "").split("\n");
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? undefined : { line: compact(lines[index] ?? "").slice(0, 600), lineNumber: index + 1 };
}

class EvidenceCollector {
  readonly refs: ProjectEvidenceRef[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly sources: ProjectMemorySource[]) {}

  add(files: ReadFileObservation[], pattern: RegExp, fallback?: ReadFileObservation): string[] {
    const result: string[] = [];
    for (const file of files) {
      const found = lineFor(file.text, pattern);
      if (!found) continue;
      const id = `evidence-${file.sourceId}-${slug(file.path)}-${found.lineNumber}`;
      if (!this.seen.has(id)) {
        this.seen.add(id);
        const source = this.sources.find((item) => item.id === file.sourceId);
        const sourceRole = source?.sourceRole;
        this.refs.push({ id, sourceId: file.sourceId, filePath: file.path, quote: found.line, locator: `line:${found.lineNumber}`, kind: file.kind === "source" ? "code" : file.kind === "test" ? "test" : file.kind === "config" ? "config" : "document", confidence: file.kind === "source" ? 0.92 : 0.84, ...(sourceRole ? { sourceRole } : {}) } as ProjectEvidenceRef & { sourceRole?: string });
      }
      result.push(id);
      if (result.length >= 4) break;
    }
    if (result.length === 0 && fallback) return this.add(files.filter((file) => file.path === fallback.path), /.+/);
    return result;
  }
}

function allReadFiles(input: ProjectComprehensionInput, observations: ProjectExplorerObservation[]): ReadFileObservation[] {
  const files = observations.flatMap((observation) => observation.files ?? []).map((file) => ({ path: file.path, sourceId: file.sourceId, kind: file.kind, language: file.language, text: file.text }));
  const uniqueFiles = files.filter((file, index, all) => all.findIndex((candidate) => candidate.path === file.path && candidate.sourceId === file.sourceId) === index);
  if (uniqueFiles.length > 0) return uniqueFiles;
  return input.sources.map((source) => ({ path: source.filePath ?? source.title, sourceId: source.id, kind: source.kind === "repository" ? "source" : source.sourceRole === "test" ? "test" : source.sourceRole === "code" ? "source" : "document", language: source.language ?? "text", text: source.text }));
}

function has(files: ReadFileObservation[], pattern: RegExp): boolean { return files.some((file) => pattern.test(`${file.path}\n${file.text}`)); }
function evidenceFor(collector: EvidenceCollector, files: ReadFileObservation[], pattern: RegExp): string[] { return collector.add(files, pattern); }

interface ComponentRule { name: string; kind: ProjectComponent["kind"]; pattern: RegExp; description: string; }
const componentRules: ComponentRule[] = [
  { name: "Motor Control", kind: "control", pattern: /\bfoc\b|motor|current loop|speed loop|svpwm|clarke|park|pi controller|电机|电流环|速度环/i, description: "负责控制算法、环路计算和执行量生成。" },
  { name: "Current Sampling", kind: "sampling", pattern: /\badc\b|current sample|sampling|采样|电流采集/i, description: "负责把 ADC/传感器采样整理为控制环可用的数据。" },
  { name: "Encoder Feedback", kind: "feedback", pattern: /encoder|abz|position sensor|角度反馈|编码器/i, description: "提供位置或电角度反馈。" },
  { name: "Velocity Estimator", kind: "feedback", pattern: /velocity estimator|speed estimator|速度估算|转速估算/i, description: "根据反馈脉冲或位置变化估算速度。" },
  { name: "Communication", kind: "communication", pattern: /\bcan\b|socketcan|uart|usart|mqtt|modbus|通信|协议/i, description: "负责外部命令、状态和诊断数据交换。" },
  { name: "Protection", kind: "protection", pattern: /overcurrent|overvoltage|fault|protection|保护|过流|过压|故障/i, description: "负责故障检测、保护动作和安全停机。" },
  { name: "PWM Timer", kind: "control", pattern: /\bpwm\b|timer trigger|定时器触发/i, description: "产生控制时序并为采样提供触发。" },
  { name: "Runtime Service", kind: "service", pattern: /freertos|rtos|thread|task|service|线程|任务|服务/i, description: "承载任务调度、后台服务或实时运行时。" },
  { name: "UI", kind: "ui", pattern: /lvgl|\bui\b|界面|显示屏/i, description: "负责用户界面或现场显示。" },
  { name: "Storage", kind: "storage", pattern: /flash|eeprom|sqlite|storage|存储|数据库/i, description: "负责参数、状态或结果持久化。" }
];

function components(files: ReadFileObservation[], repoMap: ProjectRepoMap, collector: EvidenceCollector): ProjectComponent[] {
  const result = componentRules.flatMap((rule) => {
    if (!has(files, rule.pattern)) return [];
    const matchingFiles = files.filter((file) => rule.pattern.test(`${file.path}\n${file.text}`));
    const refs = evidenceFor(collector, files, rule.pattern);
    const symbols = unique(matchingFiles.flatMap((file) => {
      const matches = [...file.text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
      return matches.map((match) => match[1] ?? "").filter((symbol) => symbol.length > 2);
    }).slice(0, 12));
    return [{ id: `component-${slug(rule.name)}`, name: rule.name, kind: rule.kind, description: rule.description, files: unique(matchingFiles.map((file) => file.path)).slice(0, 8), ...(symbols.length ? { symbols } : {}), confidence: refs.length ? 0.88 : 0.62, ...(refs.length ? { evidenceRefs: refs } : {}) }];
  });
  if (result.length > 0) return result;
  const fallback = repoMap.likelyCoreFiles.slice(0, 4).map((path) => ({ id: `component-${slug(path)}`, name: path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path, kind: "other" as const, description: "源码核心文件，当前缺少足够语义证据进行进一步分类。", files: [path], confidence: 0.45 }));
  return fallback;
}

function relationshipEvidence(collector: EvidenceCollector, files: ReadFileObservation[], left: RegExp, right: RegExp): string[] {
  const direct = files.filter((file) => left.test(file.text) && right.test(file.text));
  return direct.length ? evidenceFor(collector, direct, new RegExp(`${left.source}|${right.source}`, "i")) : [...evidenceFor(collector, files, left), ...evidenceFor(collector, files, right)].slice(0, 4);
}

function buildRelationships(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["architecture"]["relationships"] {
  const result: ProjectUnderstanding["architecture"]["relationships"] = [];
  const add = (from: string, to: string, relation: ProjectUnderstanding["architecture"]["relationships"][number]["relation"], description: string, left: RegExp, right: RegExp): void => {
    if (!has(files, left) || !has(files, right)) return;
    const refs = relationshipEvidence(collector, files, left, right);
    result.push({ from, to, relation, description, evidenceRefs: refs, confidence: refs.length ? 0.84 : 0.5 });
  };
  add("PWM", "ADC", "triggers", "PWM 定时事件触发 ADC 转换或采样窗口。", /\bpwm\b|timer/i, /\badc\b/i);
  add("ADC", "DMA", "writes", "ADC 结果通过 DMA 写入缓冲区。", /\badc\b/i, /\bdma\b/i);
  add("DMA", "Current Sampling", "feeds", "DMA 缓冲区把采样结果交给当前采样模块。", /\bdma\b/i, /\bcurrent\b|采样|adc/i);
  add("Current Samples", "Motor Control", "feeds", "采样数据进入电流环或 FOC 计算。", /current|采样|adc/i, /foc|current loop|电流环|svpwm/i);
  add("Encoder", "Electrical Angle", "provides", "编码器提供电角度或位置反馈。", /encoder|abz|编码器/i, /angle|position|电角度|位置/i);
  add("Encoder", "Velocity Estimator", "feeds", "编码器脉冲或位置变化进入速度估算。", /encoder|abz|编码器/i, /velocity|speed|速度|转速/i);
  add("Velocity Estimator", "Speed PI", "feeds", "速度估算结果进入速度 PI。", /velocity|speed|速度|转速/i, /\bpi\b|controller|控制器|调节/i);
  add("Speed PI", "Iq Reference", "produces", "速度环产生 Iq 给定。", /speed|速度/i, /iq|q[-_ ]?reference|给定/i);
  add("Fault Handler", "PWM", "controls", "保护故障触发 PWM 禁止或安全停机。", /fault|overcurrent|overvoltage|故障|过流|保护/i, /pwm|disable|stop|关闭/i);
  return result.filter((item, index, all) => all.findIndex((candidate) => candidate.from === item.from && candidate.to === item.to && candidate.relation === item.relation) === index);
}

function flow(id: string, name: string, kind: ProjectFlow["kind"], steps: ProjectFlow["steps"], collector: EvidenceCollector, files: ReadFileObservation[], patterns: RegExp[]): ProjectFlow | undefined {
  if (patterns.some((pattern) => !has(files, pattern))) return undefined;
  const evidenceRefs = [...new Set(patterns.flatMap((pattern) => evidenceFor(collector, files, pattern)))];
  return { id, name, kind, steps: steps.map((step, index) => ({ ...step, evidenceRefs: evidenceRefs.slice(index % Math.max(1, evidenceRefs.length), index % Math.max(1, evidenceRefs.length) + 2) })), description: `${name}描述系统中关键组件的先后关系。`, evidenceRefs, confidence: evidenceRefs.length ? 0.86 : 0.52 };
}

function buildFlows(files: ReadFileObservation[], collector: EvidenceCollector): { runtimeFlows: ProjectFlow[]; dataFlows: ProjectFlow[]; controlFlows: ProjectFlow[] } {
  const runtimeFlows: ProjectFlow[] = [];
  const dataFlows: ProjectFlow[] = [];
  const controlFlows: ProjectFlow[] = [];
  const sampling = flow("flow-sampling", "Sampling Flow", "data", [{ action: "PWM 产生采样触发" }, { action: "ADC 完成转换" }, { action: "DMA 写入 Current Buffer" }, { action: "Current Samples 进入 Current Loop" }], collector, files, [/pwm|timer/i, /adc/i, /dma/i, /current|采样/i]);
  if (sampling) dataFlows.push(sampling);
  const current = flow("flow-current-control", "Current Control Flow", "control", [{ action: "读取 Current Samples" }, { action: "执行 Clarke / Park 变换" }, { action: "Current PI 计算" }, { action: "SVPWM 更新 PWM" }], collector, files, [/current|采样/i, /clarke|park|foc/i, /\bpi\b|controller/i, /svpwm|pwm/i]);
  if (current) controlFlows.push(current);
  const speed = flow("flow-speed-control", "Speed Control Flow", "control", [{ action: "Encoder 提供位置反馈" }, { action: "Velocity Estimator 计算速度" }, { action: "Speed PI 生成 Iq Reference" }, { action: "Iq Reference 进入 Current Loop" }], collector, files, [/encoder|abz|编码器/i, /velocity|speed|速度/i, /\bpi\b|controller/i, /iq|reference|给定/i]);
  if (speed) controlFlows.push(speed);
  const fault = flow("flow-fault", "Fault Flow", "fault", [{ action: "检测 Overcurrent 或 Fault" }, { action: "Fault Handler 锁存故障" }, { action: "Disable PWM" }], collector, files, [/fault|overcurrent|故障|过流/i, /handler|保护|latch|锁存/i, /pwm|disable|关闭/i]);
  if (fault) runtimeFlows.push(fault);
  if (runtimeFlows.length + dataFlows.length + controlFlows.length === 0) {
    const generic = flow("flow-runtime", "Runtime Flow", "runtime", [{ action: "启动入口初始化运行时" }, { action: "调用核心模块" }, { action: "输出控制或服务结果" }], collector, files, [/main|startup|init|入口/i, /return|run|process|loop/i]);
    if (generic) runtimeFlows.push(generic);
  }
  return { runtimeFlows, dataFlows, controlFlows };
}

function identity(input: ProjectComprehensionInput, files: ReadFileObservation[], componentsValue: ProjectComponent[]): ProjectUnderstanding["identity"] {
  const text = files.map((file) => file.text).join("\n");
  const purposeLine = text.split(/\n+/).map((line) => compact(line)).find((line) => /用于|实现|目标|purpose|designed to|实现了/.test(line) && line.length > 12);
  const domain = /foc|motor|电机|svpwm|电流环/i.test(text) ? "嵌入式电机控制" : /gateway|网关|mqtt|modbus|数据采集/i.test(text) ? "嵌入式数据网关" : /robot|机器人/i.test(text) ? "机器人系统" : undefined;
  return { name: input.projectName, ...(purposeLine ? { purpose: purposeLine.slice(0, 220) } : { purpose: `${input.projectName} 的工程实现与运行流程。` }), ...(domain ? { domain } : {}), application: componentsValue.filter((component) => ["communication", "ui", "control"].includes(component.kind)).map((component) => component.name).slice(0, 5) };
}

function technologies(files: ReadFileObservation[], collector: EvidenceCollector): ProjectTechnologyUnderstanding[] {
  const candidates: Array<{ name: string; category: string; pattern: RegExp; role: string }> = [
    { name: "C", category: "language", pattern: /\.(?:c|h)\b|\bC11\b/, role: "核心实现语言" },
    { name: "C++", category: "language", pattern: /\.(?:cpp|cc|hpp)\b|c\+\+/, role: "核心实现语言" },
    { name: "Python", category: "language", pattern: /\.py\b|\bpython\b/i, role: "脚本或测试语言" },
    { name: "CMake", category: "build", pattern: /cmakelists|\bcmake\b/i, role: "构建系统" },
    { name: "FreeRTOS", category: "rtos", pattern: /free\s*rtos/i, role: "实时操作系统" },
    { name: "STM32", category: "mcu", pattern: /stm32[a-z]?\d+/i, role: "主控平台" },
    { name: "FOC", category: "control", pattern: /\bfoc\b/i, role: "电机控制算法" },
    { name: "CAN", category: "communication", pattern: /\bcan\b|socketcan/i, role: "通信接口" },
    { name: "MQTT", category: "communication", pattern: /\bmqtt\b/i, role: "消息通信" },
    { name: "Modbus", category: "communication", pattern: /modbus/i, role: "工业通信协议" },
    { name: "ADC", category: "sampling", pattern: /\badc\b/i, role: "采样外设" },
    { name: "DMA", category: "sampling", pattern: /\bdma\b/i, role: "采样数据搬运" }
  ];
  return candidates.flatMap((candidate) => {
    if (!has(files, candidate.pattern)) return [];
    return [{ name: candidate.name, category: candidate.category, role: candidate.role, evidenceRefs: evidenceFor(collector, files, candidate.pattern), confidence: 0.86 }];
  });
}

function valueFromLine(line: string): { value?: string | number; unit?: string } {
  const match = line.match(/(?:=|：|:)\s*(-?\d+(?:\.\d+)?)\s*(MHz|kHz|Hz|us|ms|A|V|毫秒|微秒|%)\b/i) ?? line.match(/(-?\d+(?:\.\d+)?)\s*(MHz|kHz|Hz|us|ms|A|V|毫秒|微秒|%)\b/i);
  if (!match) return {};
  const numeric = Number(match[1]);
  return { value: Number.isFinite(numeric) ? numeric : match[1], unit: match[2] };
}

function parameters(files: ReadFileObservation[], sources: ProjectMemorySource[], collector: EvidenceCollector): ProjectParameterUnderstanding[] {
  const candidates: ProjectParameterCandidate[] = [];
  const labels: Array<{ key: string; name: string; pattern: RegExp; context: RegExp }> = [
    { key: "adc.peripheral_clock", name: "ADC 外设时钟", pattern: /adc.*(?:clock|clk)|adc.*时钟|外设时钟/i, context: /adc/i },
    { key: "adc.control_trigger_frequency", name: "ADC 控制触发频率", pattern: /adc.*trigger|adc.*触发|控制触发/i, context: /adc|trigger|触发/i },
    { key: "diagnostic.sample_frequency", name: "诊断采样频率", pattern: /diagnostic.*(?:sampling|sample|rate|frequency)|诊断.*采样/i, context: /diagnostic|诊断/i },
    { key: "pwm.control_frequency", name: "PWM 控制频率", pattern: /pwm[_\s-]*(?:freq|frequency)|pwm.*频率/i, context: /pwm/i },
    { key: "control.current_loop.frequency", name: "电流环频率", pattern: /current\s*loop.*frequency|电流环.*频率/i, context: /current loop|电流环/i },
    { key: "control.speed_loop.frequency", name: "速度环频率", pattern: /speed\s*loop.*frequency|速度环.*频率/i, context: /speed loop|速度环/i }
  ];
  for (const file of files) {
    for (const line of file.text.replace(/\r/g, "").split("\n")) {
      for (const segment of line.split(/[;；]+/)) {
        const parsed = valueFromLine(segment);
        if (parsed.value === undefined) continue;
        for (const label of labels) {
          if (!label.pattern.test(segment)) continue;
          const refs = collector.add([file], label.context);
          candidates.push({ semanticKey: label.key, name: label.name, value: parsed.value, unit: parsed.unit, context: compact(segment).slice(0, 180), sourceIds: [file.sourceId], evidenceRefs: refs, sourceRole: sources.find((source) => source.id === file.sourceId)?.sourceRole, filePath: file.path, isCode: file.kind === "source" || file.kind === "config" });
        }
      }
    }
  }
  const grouped = new Map<string, ProjectParameterCandidate[]>();
  for (const candidate of candidates) grouped.set(candidate.semanticKey, [...(grouped.get(candidate.semanticKey) ?? []), candidate]);
  return [...grouped.entries()].flatMap(([semanticKey, group]) => {
    const resolution = new ProjectVersionResolver().resolve(group);
    if (!resolution.current) return [];
    const current = resolution.current;
    return [{ id: `parameter-${slug(semanticKey)}`, name: current.name, semanticKey, value: current.value, ...(current.unit ? { unit: current.unit } : {}), ...(current.context ? { context: current.context } : {}), versionStatus: resolution.status, sourceIds: unique([...(current.sourceIds ?? []), ...resolution.historical.flatMap((item) => item.sourceIds)]), evidenceRefs: unique([...(current.evidenceRefs ?? []), ...resolution.historical.flatMap((item) => item.evidenceRefs)]), ...(resolution.historical.length ? { historicalValues: resolution.historical.map((item) => ({ value: item.value, unit: item.unit, sourceIds: item.sourceIds, evidenceRefs: item.evidenceRefs, ...(item.context ? { context: item.context } : {}) })) } : {}), confidence: current.evidenceRefs.length ? 0.9 : 0.62 } satisfies ProjectParameterUnderstanding];
  });
}

function decisions(files: ReadFileObservation[], componentsValue: ProjectComponent[], flows: ProjectFlow[], collector: EvidenceCollector): ProjectUnderstanding["decisions"] {
  const result: ProjectUnderstanding["decisions"] = [];
  if (has(files, /center[- ]aligned|中心对齐/i) && has(files, /stable.*window|稳定.*窗口|采样窗口/i)) {
    const refs = [...evidenceFor(collector, files, /center[- ]aligned|中心对齐/i), ...evidenceFor(collector, files, /stable.*window|稳定.*窗口|采样窗口/i)];
    result.push({ id: "decision-center-aligned-pwm", decision: "Center-aligned PWM", choice: "使用中心对齐 PWM，并在稳定窗口触发 ADC。", rationale: "稳定 ADC 电流采样窗口，减少采样时刻不确定性。", relatedComponents: componentsValue.filter((item) => ["PWM Timer", "Current Sampling", "Motor Control"].includes(item.name)).map((item) => item.name), flowIds: flows.filter((flow) => /sampling|current/i.test(flow.name)).map((flow) => flow.id), evidenceRefs: unique(refs), confidence: refs.length ? 0.9 : 0.6 });
  }
  const decisionLines = files.flatMap((file) => file.text.split(/\r?\n/).filter((line) => /选择|采用|决策|因为|trade.?off|rationale|why/i.test(line) && line.trim().length > 8).map((line) => ({ file, line })));
  for (const item of decisionLines.slice(0, 6)) {
    const refs = collector.add([item.file], /选择|采用|决策|因为|trade.?off|rationale|why/i);
    const text = compact(item.line).slice(0, 260);
    if (!result.some((decision) => decision.choice === text)) result.push({ id: `decision-${slug(text)}`, decision: text.slice(0, 90), choice: text, relatedComponents: componentsValue.filter((component) => new RegExp(component.name.split(" ")[0], "i").test(text)).map((component) => component.name), flowIds: [], evidenceRefs: refs, confidence: refs.length ? 0.82 : 0.55 });
  }
  return result;
}

function problems(files: ReadFileObservation[], componentsValue: ProjectComponent[], collector: EvidenceCollector): ProjectUnderstanding["problems"] {
  const text = files.map((file) => file.text).join("\n");
  if (!/低速.*(?:abz|脉冲)|abz.*(?:稀疏|sparse)|速度估算.*量化|pi.*抖动|低速抖动/i.test(text)) return [];
  const refs = [...evidenceFor(collector, files, /低速|abz|脉冲|稀疏|量化|抖动/i), ...evidenceFor(collector, files, /delta|frame rebase|优化|解决/i)];
  const affected = componentsValue.filter((component) => ["Encoder Feedback", "Velocity Estimator", "Motor Control"].includes(component.name)).map((component) => component.name);
  return [{ id: "problem-low-speed-velocity-feedback", problem: "Low-Speed Velocity Feedback", symptom: "低速 ABZ 脉冲稀疏导致速度反馈抖动。", affectedComponents: affected, causeChain: ["Sparse ABZ pulse", "quantized velocity", "Speed PI jitter"], fix: "通过 delta + frame rebase 优化速度估算。", result: /改善|优化后|降低|稳定/i.test(text) ? "资料记录已进行优化，但仍需以正式测试结果确认改善幅度。" : undefined, evidenceRefs: unique(refs), confidence: refs.length ? 0.9 : 0.6 }];
}

function interfaces(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["interfaces"] {
  const rules = [{ name: "CAN", kind: "bus", pattern: /\bcan\b|socketcan/i }, { name: "UART", kind: "serial", pattern: /\buart\b|\busart\b/i }, { name: "MQTT", kind: "message", pattern: /\bmqtt\b/i }, { name: "Modbus", kind: "industrial-bus", pattern: /modbus/i }];
  return rules.flatMap((rule) => has(files, rule.pattern) ? [{ id: `interface-${slug(rule.name)}`, name: rule.name, kind: rule.kind, components: ["Communication"], evidenceRefs: evidenceFor(collector, files, rule.pattern), confidence: 0.84 }] : []);
}

function protections(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["protections"] {
  if (!has(files, /overcurrent|overvoltage|fault|protection|过流|过压|故障|保护/i)) return [];
  const refs = evidenceFor(collector, files, /overcurrent|overvoltage|fault|protection|过流|过压|故障|保护/i);
  return [{ id: "protection-fault-handler", name: "Fault Protection", trigger: "Overcurrent / Overvoltage / Fault", action: "Fault Handler 禁止 PWM 或锁存故障。", components: ["Protection", "PWM Timer"], evidenceRefs: refs, confidence: refs.length ? 0.86 : 0.55 }];
}

function tests(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["tests"] {
  return files.filter((file) => file.kind === "test").slice(0, 12).map((file) => { const refs = collector.add([file], /.+/); const passed = /pass|passed|通过|success|成功/i.test(file.text); return { id: `test-${slug(file.path)}`, name: file.path, status: passed ? "passed" as const : "exists" as const, ...(passed ? { measuredValues: file.text.match(/(?:误差|latency|throughput|accuracy|准确率)[^\n]{0,80}/i)?.slice(0, 2) } : {}), evidenceRefs: refs, confidence: refs.length ? 0.82 : 0.5 }; });
}

function results(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["results"] {
  return files.filter((file) => file.kind === "test" || /result|benchmark|测试|结果|性能/i.test(file.path)).flatMap((file) => file.text.split(/\r?\n/).filter((line) => /误差|准确率|latency|throughput|性能|提升|benchmark|结果/i.test(line) && /\d/.test(line)).slice(0, 8).map((line, index) => { const refs = collector.add([file], /误差|准确率|latency|throughput|性能|提升|benchmark|结果/i); return { id: `result-${slug(file.path)}-${index}`, name: "Measured Result", value: compact(line).slice(0, 220), measured: file.kind === "test", evidenceRefs: refs, confidence: refs.length ? 0.84 : 0.55 }; }));
}

function unknowns(files: ReadFileObservation[], parametersValue: ProjectParameterUnderstanding[], decisionsValue: ProjectUnderstanding["decisions"], problemsValue: ProjectUnderstanding["problems"], flows: ProjectFlow[]): ProjectUnderstanding["unknowns"] {
  const result: ProjectUnderstanding["unknowns"] = [];
  const text = files.map((file) => file.text).join("\n");
  if (parametersValue.length === 0) result.push({ id: "unknown-parameters", claim: "关键运行参数", reason: "当前已读取资料没有可定位的配置值。", category: "parameter", evidenceRefs: [] });
  if (decisionsValue.length === 0) result.push({ id: "unknown-decisions", claim: "关键设计取舍", reason: "当前资料没有明确记录决策原因。", category: "decision", evidenceRefs: [] });
  if (problemsValue.length === 0) result.push({ id: "unknown-problems", claim: "主要问题链", reason: "当前资料没有同时出现现象、原因和修复链。", category: "problem", evidenceRefs: [] });
  if (flows.length === 0) result.push({ id: "unknown-flow", claim: "主运行流程", reason: "当前读取范围不足以确认模块调用顺序。", category: "flow", evidenceRefs: [] });
  if (/未完成|没有正式|无法确认|尚未|not measured|unknown/i.test(text)) result.push({ id: "unknown-measurement", claim: "部分性能或版本信息", reason: "资料明确标记为未测量、未完成或无法确认。", category: "result", evidenceRefs: [] });
  return result;
}

function summary(identityValue: ProjectUnderstanding["identity"], componentsValue: ProjectComponent[], flows: ProjectFlow[], technologiesValue: ProjectTechnologyUnderstanding[]): string {
  const main = `${identityValue.name}${identityValue.domain ? `是一个${identityValue.domain}` : "是一个嵌入式工程"}，目标是${identityValue.purpose ?? "完成稳定的工程运行流程"}。系统由${componentsValue.slice(0, 6).map((component) => component.name).join("、") || "多个协同模块"}组成，${flows.length ? `通过${flows.slice(0, 2).map((item) => item.name).join("和")}串起采样、控制与运行时处理` : "核心模块之间的运行关系仍在分析"}。主要技术包括${technologiesValue.slice(0, 6).map((item) => item.name).join("、") || "项目实际使用的软硬件组件"}。`;
  if (main.length >= 80) return main.slice(0, 180);
  return `${main}当前模型保留了可验证的证据引用和仍待确认的工程边界。`.slice(0, 180);
}

export class ProjectUnderstandingBuilder {
  private readonly observations: ProjectExplorerObservation[] = [];
  update(observation: ProjectExplorerObservation): void { this.observations.push(observation); }

  build(input: ProjectComprehensionInput, repoMap: ProjectRepoMap, trace: BuilderTrace): ProjectUnderstanding {
    const files = allReadFiles(input, this.observations);
    const collector = new EvidenceCollector(input.sources);
    const componentList = components(files, repoMap, collector);
    const relationList = buildRelationships(files, collector);
    const flowGroups = buildFlows(files, collector);
    const allFlows = [...flowGroups.runtimeFlows, ...flowGroups.dataFlows, ...flowGroups.controlFlows];
    const technologyList = technologies(files, collector);
    const parameterList = parameters(files, input.sources, collector);
    const decisionList = decisions(files, componentList, allFlows, collector);
    const problemList = problems(files, componentList, collector);
    const interfaceList = interfaces(files, collector);
    const protectionList = protections(files, collector);
    const testList = tests(files, collector);
    const resultList = results(files, collector);
    const limitationList = files.flatMap((file) => /未完成|没有正式|无法确认|尚未|not measured|unknown/i.test(file.text) ? [{ id: `limitation-${slug(file.path)}`, claim: "部分指标或实现状态未完成确认", reason: "资料自身说明当前缺少正式测量或版本确认。", category: "result" as const, evidenceRefs: collector.add([file], /未完成|没有正式|无法确认|尚未|not measured|unknown/i) }] : []);
    const unknownList = unknowns(files, parameterList, decisionList, problemList, allFlows);
    const identityValue = identity(input, files, componentList);
    const allClaims = relationList.length + allFlows.length + parameterList.length + decisionList.length + problemList.length;
    const groundedClaims = relationList.filter((item) => item.evidenceRefs.length).length + allFlows.filter((item) => (item.evidenceRefs ?? []).length).length + parameterList.filter((item) => item.evidenceRefs.length).length + decisionList.filter((item) => item.evidenceRefs.length).length + problemList.filter((item) => item.evidenceRefs.length).length;
    const quality = { architectureCoverage: componentList.length ? Math.min(100, componentList.length * 15) : 0, flowCoverage: Math.min(100, allFlows.length * 25), parameterCoverage: Math.min(100, parameterList.length * 20), decisionCoverage: Math.min(100, decisionList.length * 25), problemCoverage: Math.min(100, problemList.length * 25), groundingCoverage: allClaims ? Math.round((groundedClaims / allClaims) * 100) : 0, sufficient: componentList.length >= 3 && allFlows.length >= 1 && technologyList.length >= 1 };
    const stages = [...new Set([...trace.stages, "synthesizing" as ProjectComprehensionStatus])].filter((stage) => stage !== "completed") as ProjectComprehensionStatus[];
    return { projectId: input.projectId, schemaVersion: 1, status: "synthesizing", identity: identityValue, summary: summary(identityValue, componentList, allFlows, technologyList), architecture: { overview: `工程由${componentList.slice(0, 6).map((component) => component.name).join("、") || "尚未分类的核心文件"}协同组成。`, components: componentList, relationships: relationList }, runtimeFlows: flowGroups.runtimeFlows, dataFlows: flowGroups.dataFlows, controlFlows: flowGroups.controlFlows, technologies: technologyList, parameters: parameterList, decisions: decisionList, problems: problemList, interfaces: interfaceList, protections: protectionList, tests: testList, results: resultList, limitations: limitationList, unknowns: unknownList, evidenceRefs: collector.refs, quality, trace: { ...trace, stages } };
  }
}
