import type { ProjectMemorySource } from "../knowledge/types";
import { ProjectVersionResolver, type ProjectParameterCandidate } from "./version-resolver";
import { embeddedControlComponentHints, embeddedControlFallbackRelationships } from "./fallback/domain-hints/embedded-control-hints";
import { findSemanticPaths, ProjectSemanticGraphBuilder, type ProjectSemanticFile } from "./semantic-graph";
import { PROJECT_COMPREHENSION_SCHEMA_VERSION } from "./types";
import type {
  ProjectComprehensionInput,
  ProjectComprehensionStatus,
  ProjectEvidenceRef,
  ProjectExplorerObservation,
  ProjectRepoMap,
  ProjectUnderstanding,
  ProjectComponent,
  ProjectFlow,
  ProjectParameterUnderstanding,
  ProjectRelationship,
  ProjectTechnologyUnderstanding,
  ProjectComponentKind,
  ProjectSemanticEdge,
  ProjectSemanticGraph,
  ProjectGitHistoryEntry,
} from "./types";

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
function linesOf(text: string): string[] { return text.replace(/\r/g, "").split("\n"); }
function lineFor(text: string, pattern: RegExp): { line: string; lineNumber: number } | undefined {
  const lines = linesOf(text);
  const index = lines.findIndex((line) => { pattern.lastIndex = 0; return pattern.test(line); });
  return index < 0 ? undefined : { line: compact(lines[index] ?? "").slice(0, 600), lineNumber: index + 1 };
}
function has(files: ReadFileObservation[], pattern: RegExp): boolean { return files.some((file) => { pattern.lastIndex = 0; return pattern.test(`${file.path}\n${file.text}`); }); }

class EvidenceCollector {
  readonly refs: ProjectEvidenceRef[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly sources: ProjectMemorySource[]) {}

  add(files: ReadFileObservation[], pattern: RegExp): string[] {
    return this.addLines(files, (line) => { pattern.lastIndex = 0; return pattern.test(line); });
  }

  addLines(files: ReadFileObservation[], predicate: (line: string) => boolean): string[] {
    const result: string[] = [];
    for (const file of files) {
      const found = lineFor(file.text, { test: predicate, lastIndex: 0 } as RegExp) ?? (predicate(file.path) ? { line: `path: ${file.path}`, lineNumber: 0 } : undefined);
      if (!found) continue;
      const id = `evidence-${file.sourceId}-${slug(file.path)}-${found.lineNumber}`;
      if (!this.seen.has(id)) {
        this.seen.add(id);
        const source = this.sources.find((item) => item.id === file.sourceId);
        this.refs.push({
          id,
          sourceId: file.sourceId,
          filePath: file.path,
          quote: found.line,
          locator: `line:${found.lineNumber}`,
          kind: file.kind === "source" ? "code" : file.kind === "test" ? "test" : file.kind === "config" ? "config" : "document",
          confidence: file.kind === "source" || file.kind === "config" ? 0.92 : 0.84,
          ...(source?.sourceRole ? { sourceRole: source.sourceRole } : {}),
        });
      }
      result.push(id);
      if (result.length >= 4) break;
    }
    return result;
  }
}

function allReadFiles(input: ProjectComprehensionInput, observations: ProjectExplorerObservation[]): ReadFileObservation[] {
  const files = observations.flatMap((observation) => observation.files ?? []).map((file) => ({ path: file.path, sourceId: file.sourceId, kind: file.kind, language: file.language, text: file.text }));
  const uniqueFiles = files.filter((file, index, all) => all.findIndex((candidate) => candidate.path === file.path && candidate.sourceId === file.sourceId) === index);
  if (uniqueFiles.length > 0) return uniqueFiles;
  return input.sources.flatMap((source) => source.repositoryFiles?.length
    ? source.repositoryFiles.map((file) => ({ path: file.path, sourceId: source.id, kind: "source" as const, language: source.language ?? "text", text: file.text }))
    : [{ path: source.filePath ?? source.title, sourceId: source.id, kind: source.kind === "repository" || source.sourceRole === "code" ? "source" as const : source.sourceRole === "test" ? "test" as const : "document" as const, language: source.language ?? "text", text: source.text }]);
}

interface ComponentRule { name: string; kind: ProjectComponent["kind"]; pattern: RegExp; description: string; }

/** Generic vocabulary is intentionally domain-neutral. It is the primary discovery path. */
const genericComponentRules: ComponentRule[] = [
  { name: "API", kind: "service", pattern: /\bapi\b|endpoint|route|controller/i, description: "对外提供请求入口并协调应用服务。" },
  { name: "Service", kind: "service", pattern: /\bservice\b|服务|handler|use.?case/i, description: "承载应用服务逻辑和请求处理。" },
  { name: "Repository", kind: "storage", pattern: /\brepository\b|repo\b|数据访问层|dao/i, description: "封装持久化数据的读取和写入。" },
  { name: "Database", kind: "storage", pattern: /\bdatabase\b|\bsqlite\b|postgres|mysql|数据库/i, description: "保存项目状态、业务数据或分析结果。" },
  { name: "Worker", kind: "service", pattern: /\bworker\b|job queue|background worker|后台任务/i, description: "执行异步任务或后台处理。" },
  { name: "DataBus", kind: "communication", pattern: /data.?bus|databus|message bus|消息总线|数据总线/i, description: "在模块之间传递结构化数据或消息。" },
  { name: "Modbus", kind: "communication", pattern: /modbus/i, description: "负责 Modbus 工业协议通信。" },
  { name: "SocketCAN", kind: "communication", pattern: /socketcan|socket.?can/i, description: "负责 Linux SocketCAN 总线通信。" },
  { name: "MQTT", kind: "communication", pattern: /mqtt/i, description: "负责 MQTT 消息发布和订阅。" },
  { name: "Communication", kind: "communication", pattern: /\bcan\b|\buart\b|\busart\b|communication|通信|protocol|协议/i, description: "负责外部命令、状态和诊断数据交换。" },
  { name: "UI", kind: "ui", pattern: /\blvgl\b|\bui\b|frontend|界面|显示屏/i, description: "负责用户界面或现场显示。" },
  { name: "PWM Timer", kind: "driver", pattern: /\bpwm\d*\b|timer trigger|定时器触发/i, description: "提供周期性输出或外设触发时序。" },
  { name: "ADC", kind: "driver", pattern: /\badc\d*\b/i, description: "提供模拟量转换或采样输入。" },
  { name: "DMA", kind: "driver", pattern: /\bdma\d*\b/i, description: "负责外设与内存之间的数据搬运。" },
  { name: "Buffer", kind: "storage", pattern: /\bbuffer\b|缓冲区/i, description: "暂存模块间传递或批量处理的数据。" },
  { name: "Current Loop", kind: "control", pattern: /current[_ -]?loop|电流环/i, description: "根据采样反馈计算当前控制输出。" },
  { name: "Control Loop", kind: "control", pattern: /control loop|控制环|controller|调节器/i, description: "根据输入反馈计算控制输出。" },
  { name: "Runtime Service", kind: "service", pattern: /freertos|rtos|thread|task|service|线程|任务|服务/i, description: "承载任务调度、后台服务或实时运行时。" },
  { name: "Storage", kind: "storage", pattern: /flash|eeprom|storage|存储/i, description: "负责参数、状态或结果持久化。" },
];

function functionSymbols(file: ReadFileObservation): string[] {
  return unique([...file.text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1] ?? "").filter((symbol) => symbol.length > 2)).slice(0, 16);
}

function discoverComponents(files: ReadFileObservation[], repoMap: ProjectRepoMap, collector: EvidenceCollector, domainFallback: boolean): ProjectComponent[] {
  const result: ProjectComponent[] = [];
  const add = (name: string, kind: ProjectComponent["kind"], pattern: RegExp, description: string, fallback = false): void => {
    if (result.some((item) => item.name === name) || !has(files, pattern)) return;
    const matchingFiles = files.filter((file) => { pattern.lastIndex = 0; return pattern.test(`${file.path}\n${file.text}`); });
    const refs = collector.add(files, pattern);
    result.push({ id: `component-${slug(name)}`, name, kind, description, files: unique(matchingFiles.map((file) => file.path)).slice(0, 8), symbols: unique(matchingFiles.flatMap(functionSymbols)).slice(0, 16), confidence: fallback ? 0.55 : refs.length ? 0.88 : 0.62, ...(refs.length ? { evidenceRefs: refs } : {}) });
  };
  for (const rule of genericComponentRules) add(rule.name, rule.kind, rule.pattern, rule.description);
  if (domainFallback) for (const hint of embeddedControlComponentHints) add(hint.name, hint.kind, hint.pattern, hint.description, true);
  if (!result.length) {
    for (const path of repoMap.likelyCoreFiles.slice(0, 6)) result.push({ id: `component-${slug(path)}`, name: path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path, kind: "other", description: "源码核心文件，当前缺少足够语义证据进行分类。", files: [path], confidence: 0.45 });
  }
  return result;
}

function lineEvidence(files: ReadFileObservation[], left: RegExp, right: RegExp, marker: RegExp, collector: EvidenceCollector): { refs: string[]; kind: "direct" | "strong" | "weak" | "unsupported" } {
  const directFiles = files.filter((file) => linesOf(file.text).some((line) => {
    left.lastIndex = 0; right.lastIndex = 0; marker.lastIndex = 0;
    return left.test(`${file.path} ${line}`) && right.test(`${file.path} ${line}`) && marker.test(line);
  }));
  if (directFiles.length) return { refs: collector.addLines(directFiles, (line) => { left.lastIndex = 0; right.lastIndex = 0; marker.lastIndex = 0; return left.test(line) && right.test(line) && marker.test(line); }), kind: "direct" };
  const documented = files.filter((file) => file.kind === "document" && linesOf(file.text).some((line) => {
    left.lastIndex = 0; right.lastIndex = 0; marker.lastIndex = 0;
    return left.test(line) && right.test(line) && marker.test(line);
  }));
  if (documented.length) return { refs: collector.addLines(documented, (line) => { left.lastIndex = 0; right.lastIndex = 0; marker.lastIndex = 0; return left.test(line) && right.test(line) && marker.test(line); }), kind: "strong" };
  const leftFiles = files.filter((file) => { left.lastIndex = 0; return left.test(file.text); });
  const rightFiles = files.filter((file) => { right.lastIndex = 0; return right.test(file.text); });
  if (leftFiles.length && rightFiles.length) return { refs: unique([...collector.add(leftFiles, left), ...collector.add(rightFiles, right)]).slice(0, 4), kind: "weak" };
  return { refs: [], kind: "unsupported" };
}

interface RelationshipRule { from: string; to: string; relation: ProjectRelationship["relation"]; left: RegExp; right: RegExp; marker: RegExp; description: string; }
const relationshipRules: RelationshipRule[] = [
  { from: "Modbus", to: "DataBus", relation: "publishes", left: /modbus/i, right: /data.?bus|databus/i, marker: /publish|send|write|enqueue|push|->|=>/i, description: "Modbus 接收的数据被发布到数据总线。" },
  { from: "SocketCAN", to: "DataBus", relation: "publishes", left: /socket.?can/i, right: /data.?bus|databus/i, marker: /publish|send|write|enqueue|push|->|=>/i, description: "SocketCAN 接收的数据被发布到数据总线。" },
  { from: "DataBus", to: "MQTT", relation: "feeds", left: /data.?bus|databus/i, right: /mqtt/i, marker: /publish|send|write|enqueue|push|feed|feeds|->|=>/i, description: "数据总线向 MQTT 发布消息。" },
  { from: "DataBus", to: "UI", relation: "feeds", left: /data.?bus|databus/i, right: /\bui\b|lvgl/i, marker: /publish|send|write|enqueue|push|feed|feeds|render|update|->|=>/i, description: "数据总线向 UI 提供状态数据。" },
  { from: "ADC", to: "DMA", relation: "writes", left: /\badc\d*\b/i, right: /\bdma\d*\b/i, marker: /dma|transfer|buffer|start|write|->|=>/i, description: "ADC 结果通过 DMA 写入内存。" },
  { from: "DMA", to: "Buffer", relation: "writes", left: /\bdma\d*\b/i, right: /buffer|缓冲区/i, marker: /dma|transfer|buffer|write|->|=>/i, description: "DMA 把数据写入缓冲区。" },
  { from: "PWM Timer", to: "ADC", relation: "triggers", left: /pwm|timer|trgo|externaltrig/i, right: /\badc\d*\b|externaltrig/i, marker: /trigger|trgo|externaltrig|触发|->|=>/i, description: "PWM/定时器事件明确触发 ADC 转换。" },
  { from: "ADC", to: "Control Loop", relation: "feeds", left: /\badc\b|current|采样/i, right: /control loop|controller|current loop|电流环/i, marker: /call|update|input|sample|current|->|=>|进入/i, description: "采样结果进入控制环。" },
  { from: "Encoder Feedback", to: "Velocity Estimator", relation: "feeds", left: /encoder|abz|编码器/i, right: /velocity|speed|速度|转速/i, marker: /call|update|convert|estimate|->|=>/i, description: "编码器反馈进入速度估算。" },
  { from: "Fault Handler", to: "PWM Timer", relation: "controls", left: /fault|overcurrent|overvoltage|故障|过流|保护/i, right: /pwm|disable|stop|关闭/i, marker: /disable|stop|latch|lock|关闭|禁止|->|=>/i, description: "故障处理明确禁止 PWM 或进入安全状态。" },
];

function normalizedComponent(value: string, componentsValue: ProjectComponent[]): string | undefined {
  const lower = value.toLowerCase().replace(/[ _-]+/g, "");
  return componentsValue.find((component) => component.name.toLowerCase().replace(/[ _-]+/g, "") === lower || lower.includes(component.name.toLowerCase().replace(/[ _-]+/g, "")))?.name;
}

function buildRelationships(files: ReadFileObservation[], componentsValue: ProjectComponent[], collector: EvidenceCollector, domainFallback: boolean): ProjectRelationship[] {
  const result: ProjectRelationship[] = [];
  const add = (rule: RelationshipRule, fallback = false): void => {
    const from = normalizedComponent(rule.from, componentsValue);
    const to = normalizedComponent(rule.to, componentsValue);
    if (!from || !to || from === to) return;
    const evidence = lineEvidence(files, rule.left, rule.right, rule.marker, collector);
    if (evidence.kind === "unsupported") return;
    result.push({ from, to, relation: rule.relation, description: rule.description, evidenceRefs: evidence.refs, confidence: evidence.kind === "direct" ? 0.94 : evidence.kind === "strong" ? 0.86 : 0.55, evidenceStrength: fallback ? "weak" : evidence.kind, verificationStatus: fallback || evidence.kind === "weak" ? "candidate" : "confirmed", confidenceReason: fallback ? "domain hint only" : evidence.kind === "weak" ? "co-occurrence without an explicit link" : "explicit link evidence" });
  };
  for (const rule of relationshipRules) add(rule);
  if (domainFallback) for (const rule of embeddedControlFallbackRelationships()) add({ ...rule, description: rule.description ?? "领域提示关系。", marker: /trigger|feed|call|update|->|=>/i }, true);
  // Parse explicit textual edges such as “ADC -> DMA” without inventing edges
  // from merely seeing both nouns in different files.
  for (const file of files) for (const [index, line] of linesOf(file.text).entries()) {
    const match = line.match(/\b([A-Za-z][A-Za-z0-9 _-]{1,28})\s*(?:->|=>|publishes(?:\s+to)?|feeds|writes|triggers|calls)\s*([A-Za-z][A-Za-z0-9 _-]{1,28})\b/i);
    if (!match) continue;
    const from = normalizedComponent(match[1] ?? "", componentsValue);
    const to = normalizedComponent(match[2] ?? "", componentsValue);
    if (!from || !to || from === to) continue;
    const phrase = compact(line).slice(0, 300);
    const relation: ProjectRelationship["relation"] = /publishes/i.test(line) ? "publishes" : /feeds/i.test(line) ? "feeds" : /writes/i.test(line) ? "writes" : /triggers/i.test(line) ? "triggers" : from === "ADC" && to === "DMA" || from === "DMA" && to === "Buffer" ? "writes" : from === "Modbus" || from === "SocketCAN" ? "publishes" : from === "DataBus" ? "feeds" : "calls";
    const refs = collector.add([file], new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    result.push({ from, to, relation, description: phrase, evidenceRefs: refs, confidence: 0.96, evidenceStrength: "direct", verificationStatus: "confirmed", confidenceReason: `explicit edge at line ${index + 1}` });
  }
  return result.filter((item, index, all) => all.findIndex((candidate) => candidate.from === item.from && candidate.to === item.to && candidate.relation === item.relation) === index);
}

function parameterValue(line: string): { value?: string | number; unit?: string } {
  const match = line.match(/(?:=|：|:)\s*(-?\d+(?:\.\d+)?)\s*(MHz|kHz|Hz|us|ms|A|V|毫秒|微秒|%)\b/i) ?? line.match(/(-?\d+(?:\.\d+)?)\s*(MHz|kHz|Hz|us|ms|A|V|毫秒|微秒|%)\b/i);
  if (!match) return {};
  return { value: Number(match[1]), unit: match[2] };
}

function parameterValueForLabel(line: string, semanticKey: string): { value?: string | number; unit?: string } {
  const parsed = parameterValue(line);
  if (parsed.value !== undefined) return parsed;
  const raw = line.match(/(?:=|#define\s+[A-Za-z_]\w*)\s*(-?\d+(?:\.\d+)?)/i)?.[1];
  if (!raw) return {};
  const number = Number(raw);
  if (!Number.isFinite(number)) return {};
  if (/peripheral_clock/.test(semanticKey) && number >= 1_000_000) return { value: number / 1_000_000, unit: "MHz" };
  if (/frequency|rate/.test(semanticKey)) return number >= 1_000 ? { value: number / 1_000, unit: "kHz" } : { value: number, unit: "Hz" };
  return { value: number };
}

function buildParameters(files: ReadFileObservation[], sources: ProjectMemorySource[], collector: EvidenceCollector, componentsValue: ProjectComponent[] = [], graph?: ProjectSemanticGraph): ProjectParameterUnderstanding[] {
  const labels: Array<{ key: string; name: string; pattern: RegExp; context: RegExp }> = [
    { key: "adc.peripheral_clock", name: "ADC 外设时钟", pattern: /adc.*(?:clock|clk)|adc.*时钟|外设时钟/i, context: /adc|clock|时钟/i },
    { key: "adc.control_trigger_frequency", name: "ADC 控制触发频率", pattern: /adc.*(?:trigger|freq)|adc.*触发|控制触发/i, context: /adc|trigger|触发/i },
    { key: "control.pwm_frequency", name: "PWM 控制频率", pattern: /pwm[_\s-]*(?:freq|frequency|hz)|pwm.*频率/i, context: /pwm/i },
    { key: "control.current_loop.frequency", name: "电流环频率", pattern: /current[_\s-]*loop.*(?:frequency|freq|hz)|电流环.*频率/i, context: /current[_\s-]*loop|电流环/i },
    { key: "control.speed_loop.frequency", name: "速度环频率", pattern: /speed[_\s-]*loop.*(?:frequency|freq|hz)|速度环.*频率/i, context: /speed[_\s-]*loop|速度环/i },
    { key: "diagnostic.sample_frequency", name: "诊断采样频率", pattern: /diagnostic.*(?:sampling|sample|rate|frequency)|诊断.*采样/i, context: /diagnostic|诊断/i },
    { key: "diagnostic.logging.frequency", name: "诊断日志频率", pattern: /(?:logging|log).*(?:rate|frequency)|日志.*频率/i, context: /logging|log|日志/i },
    { key: "communication.baud_rate", name: "通信波特率", pattern: /baud|波特率/i, context: /baud|波特率|can|uart|modbus/i },
  ];
  const candidates: ProjectParameterCandidate[] = [];
  for (const file of files) for (const [lineIndex, line] of linesOf(file.text).entries()) {
    const parsed = parameterValue(line);
    for (const label of labels) {
      label.pattern.lastIndex = 0;
      if (!label.pattern.test(line)) continue;
      label.pattern.lastIndex = 0;
      const labelMatch = label.pattern.exec(line);
      const scoped = labelMatch?.index !== undefined ? parameterValueForLabel(line.slice(labelMatch.index), label.key) : parsed;
      const value = scoped.value === undefined ? parsed : scoped;
      if (value.value === undefined) continue;
      const source = sources.find((item) => item.id === file.sourceId);
      candidates.push({ semanticKey: label.key, name: label.name, value: value.value, unit: value.unit, context: compact(line).slice(0, 220), sourceIds: [file.sourceId], evidenceRefs: collector.add([file], label.context), sourceRole: source?.sourceRole, filePath: file.path, line: lineIndex + 1, isCode: file.kind === "source" || file.kind === "config" });
    }
  }
  const grouped = new Map<string, ProjectParameterCandidate[]>();
  for (const candidate of candidates) grouped.set(candidate.semanticKey, [...(grouped.get(candidate.semanticKey) ?? []), candidate]);
  return [...grouped.entries()].flatMap(([semanticKey, group]) => {
    const history = sources.flatMap((source) => source.repositoryHistory ?? []);
    const resolution = new ProjectVersionResolver().resolve(group, history);
    if (!resolution.current) return [];
    const current = resolution.current;
    const relatedComponent = componentsValue.find((component) => (current.filePath ? component.files?.includes(current.filePath) : false) || (current.context ? normalizedName(current.context).includes(normalizedName(component.name)) : false))?.name;
    const sourceSymbol = graph?.symbols.filter((symbol) => symbol.path === current.filePath && (symbol.line ?? 0) <= (current.line ?? Number.MAX_SAFE_INTEGER)).sort((left, right) => (right.line ?? 0) - (left.line ?? 0))[0]?.name;
    return [{ id: `parameter-${slug(semanticKey)}`, name: current.name, semanticKey, value: current.value, ...(current.unit ? { unit: current.unit } : {}), ...(current.context ? { context: current.context } : {}), versionStatus: resolution.currentStatus ?? resolution.status, sourceIds: unique([...(current.sourceIds ?? []), ...resolution.historical.flatMap((item) => item.sourceIds), ...((resolution.alternatives ?? []).flatMap((item) => item.sourceIds))]), evidenceRefs: unique([...(current.evidenceRefs ?? []), ...resolution.historical.flatMap((item) => item.evidenceRefs), ...((resolution.alternatives ?? []).flatMap((item) => item.evidenceRefs))]), ...(resolution.historical.length ? { historicalValues: resolution.historical.map((item) => ({ value: item.value, unit: item.unit, sourceIds: item.sourceIds, evidenceRefs: item.evidenceRefs, ...(item.context ? { context: item.context } : {}) })) } : {}), ...(resolution.alternatives?.length ? { alternativeValues: resolution.alternatives.map((item) => ({ value: item.value, unit: item.unit, sourceIds: item.sourceIds, evidenceRefs: item.evidenceRefs, ...(item.context ? { context: item.context } : {}) })) } : {}), ...(relatedComponent ? { relatedComponent } : {}), ...(sourceSymbol ? { sourceSymbol } : {}), sourceKind: current.isCode ? current.filePath?.toLowerCase().endsWith(".h") || current.filePath?.toLowerCase().endsWith(".hpp") ? "config" : "code" : current.sourceRole === "test" ? "test" : current.sourceRole === "architecture" || current.sourceRole === "overview" ? "document" : "inference", confidence: current.evidenceRefs.length ? 0.9 : 0.62 } satisfies ProjectParameterUnderstanding];
  });
}

function buildTechnologies(files: ReadFileObservation[], collector: EvidenceCollector, repoMap: ProjectRepoMap): ProjectTechnologyUnderstanding[] {
  const rules: Array<{ name: string; category: string; pattern: RegExp; role: string }> = [
    { name: "C", category: "language", pattern: /\.(?:c|h)\b/, role: "核心实现语言" },
    { name: "C++", category: "language", pattern: /\.(?:cpp|cc|hpp|cxx)\b|c\+\+/i, role: "核心实现语言" },
    { name: "Python", category: "language", pattern: /\.py\b|\bpython\b/i, role: "脚本或测试语言" },
    { name: "TypeScript", category: "language", pattern: /\.tsx?\b|typescript/i, role: "应用实现语言" },
    { name: "CMake", category: "build", pattern: /cmakelists|\bcmake\b/i, role: "构建系统" },
    { name: "FreeRTOS", category: "runtime", pattern: /free\s*rtos/i, role: "实时运行时" },
    { name: "MQTT", category: "communication", pattern: /mqtt/i, role: "消息通信" },
    { name: "Modbus", category: "communication", pattern: /modbus/i, role: "工业通信协议" },
    { name: "SocketCAN", category: "communication", pattern: /socket.?can/i, role: "总线通信" },
  ];
  const result = rules.flatMap((rule) => has(files, rule.pattern) ? [{ name: rule.name, category: rule.category, role: rule.role, evidenceRefs: collector.add(files, rule.pattern), confidence: 0.86 }] : []);
  for (const language of repoMap.languages) if (!result.some((item) => item.name === language)) result.push({ name: language, category: "language", role: "仓库识别的实现语言", evidenceRefs: [], confidence: 0.7 });
  return result;
}

function identity(input: ProjectComprehensionInput, files: ReadFileObservation[], componentsValue: ProjectComponent[]): ProjectUnderstanding["identity"] {
  const text = files.map((file) => file.text).join("\n");
  const purposeLine = linesOf(text).map(compact).find((line) => /用于|实现|目标|purpose|designed to|project|gateway|service/i.test(line) && line.length > 12);
  const domain = /foc|motor|电机|svpwm|电流环/i.test(text) ? "嵌入式电机控制" : /gateway|网关|mqtt|modbus|数据采集/i.test(text) ? "嵌入式数据网关" : /api|service|repository|database|worker/i.test(text) ? "Web/API 服务" : /robot|机器人/i.test(text) ? "机器人系统" : undefined;
  return { name: input.projectName, purpose: purposeLine?.slice(0, 220) ?? `${input.projectName} 的工程实现与运行流程。`, ...(domain ? { domain } : {}), application: componentsValue.filter((component) => ["communication", "ui", "service", "control"].includes(component.kind)).map((component) => component.name).slice(0, 8) };
}

function buildInterfaces(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["interfaces"] {
  return [{ name: "CAN", kind: "bus", pattern: /\bcan\b|socketcan/i }, { name: "UART", kind: "serial", pattern: /\buart\b|\busart\b/i }, { name: "MQTT", kind: "message", pattern: /mqtt/i }, { name: "Modbus", kind: "industrial-bus", pattern: /modbus/i }, { name: "HTTP API", kind: "http", pattern: /http|endpoint|api/i }].flatMap((rule) => has(files, rule.pattern) ? [{ id: `interface-${slug(rule.name)}`, name: rule.name, kind: rule.kind, components: [], evidenceRefs: collector.add(files, rule.pattern), confidence: 0.84 }] : []);
}

function buildTests(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["tests"] {
  return files.filter((file) => file.kind === "test").slice(0, 12).map((file) => { const refs = collector.add([file], /.+/); const status = /fail|失败/i.test(file.text) ? "failed" as const : /pass|passed|通过|success|成功/i.test(file.text) ? "passed" as const : "exists" as const; return { id: `test-${slug(file.path)}`, name: file.path, status, evidenceRefs: refs, confidence: refs.length ? 0.82 : 0.5 }; });
}

function buildDecisions(files: ReadFileObservation[], componentsValue: ProjectComponent[], flows: ProjectFlow[], collector: EvidenceCollector): ProjectUnderstanding["decisions"] {
  const text = files.map((file) => file.text).join("\n");
  if (!/center[- ]aligned|中心对齐/i.test(text) || !/stable.*window|稳定.*窗口|采样窗口/i.test(text)) return [];
  const refs = unique([...collector.add(files, /center[- ]aligned|中心对齐/i), ...collector.add(files, /stable.*window|稳定.*窗口|采样窗口/i)]);
  return [{ id: "decision-center-aligned-sampling", decision: "采样时序设计", choice: "使用中心对齐 PWM，并在稳定窗口触发 ADC。", rationale: "让采样发生在可控的稳定时刻。", relatedComponents: componentsValue.filter((component) => /pwm|sampling|adc|control/i.test(component.name)).map((component) => component.name), flowIds: flows.filter((flow) => /sampling/i.test(flow.name)).map((flow) => flow.id), evidenceRefs: refs, confidence: refs.length ? 0.9 : 0.55 }];
}

function buildProblems(files: ReadFileObservation[], componentsValue: ProjectComponent[], collector: EvidenceCollector, history: ProjectGitHistoryEntry[] = []): ProjectUnderstanding["problems"] {
  const text = files.map((file) => file.text).join("\n");
  if (!/低速.*(?:abz|脉冲)|abz.*(?:稀疏|sparse)|速度估算.*量化|pi.*抖动|低速抖动/i.test(text)) return [];
  const refs = unique([...collector.add(files, /低速|abz|脉冲|稀疏|量化|抖动/i), ...collector.add(files, /delta|frame rebase|优化|解决/i)]);
  const codeChangeRefs = history.filter((entry) => /fix|rebase|delta|jitter|low.?speed|修复|抖动|优化/i.test(entry.subject) || entry.changedPaths?.some((path) => /velocity|encoder|control/i.test(path))).map((entry) => entry.hash ?? entry.subject).slice(0, 8);
  return [{ id: "problem-low-speed-feedback", problem: "Low-Speed Feedback Jitter", symptom: "低速脉冲稀疏导致反馈量化和控制抖动。", affectedComponents: componentsValue.filter((component) => /encoder|velocity|control/i.test(component.name)).map((component) => component.name), causeChain: ["Sparse feedback pulse", "quantized estimate", "controller jitter"], fix: "通过 delta 与 frame rebase 优化估算。", result: /改善|优化后|降低|稳定/i.test(text) ? "资料记录已进行优化，但正式改善幅度仍需测试确认。" : undefined, ...(codeChangeRefs.length ? { codeChangeRefs } : {}), evidenceRefs: refs, confidence: refs.length ? 0.9 : 0.6 }];
}

function buildProtections(files: ReadFileObservation[], collector: EvidenceCollector): ProjectUnderstanding["protections"] {
  if (!has(files, /overcurrent|overvoltage|fault|protection|过流|过压|故障|保护/i)) return [];
  return [{ id: "protection-fault-handler", name: "Fault Protection", trigger: "Overcurrent / Overvoltage / Fault", action: "故障处理器禁止输出或锁存故障。", components: [], evidenceRefs: collector.add(files, /overcurrent|overvoltage|fault|protection|过流|过压|故障|保护/i), confidence: 0.86 }];
}

function buildFlows(componentsValue: ProjectComponent[], relationships: ProjectRelationship[], files: ReadFileObservation[], collector: EvidenceCollector): { runtimeFlows: ProjectFlow[]; dataFlows: ProjectFlow[]; controlFlows: ProjectFlow[] } {
  const result: { runtimeFlows: ProjectFlow[]; dataFlows: ProjectFlow[]; controlFlows: ProjectFlow[] } = { runtimeFlows: [], dataFlows: [], controlFlows: [] };
  const hasLink = (from: string, to: string): ProjectRelationship | undefined => relationships.find((item) => item.from === from && item.to === to && item.verificationStatus === "confirmed" && (item.evidenceStrength === "direct" || item.evidenceStrength === "strong"));
  const addChain = (id: string, name: string, kind: ProjectFlow["kind"], chain: string[], bucket: "runtimeFlows" | "dataFlows" | "controlFlows"): void => {
    const actual = chain.filter((nameValue) => componentsValue.some((component) => component.name === nameValue));
    if (actual.length < 2) return;
    const links = actual.slice(0, -1).map((from, index) => hasLink(from, actual[index + 1] ?? ""));
    const known = links.filter((link): link is ProjectRelationship => Boolean(link));
    if (!known.length) return;
    // One isolated confirmed edge is a confirmed partial path, not evidence
    // that every vocabulary item in a domain chain belongs to this Flow. Only
    // expose missingLinks after at least two adjacent edges establish a path.
    const firstKnownIndex = links.findIndex(Boolean);
    const visibleChain = known.length < 2 ? actual.slice(firstKnownIndex, firstKnownIndex + 2) : actual;
    const visibleLinks = visibleChain.slice(0, -1).map((from, index) => hasLink(from, visibleChain[index + 1] ?? ""));
    const missingLinks = known.length < 2 ? [] : links.flatMap((link, index) => link ? [] : [`${actual[index]} → ${actual[index + 1]}`]);
    const refs = unique(known.flatMap((link) => link.evidenceRefs));
    const flow: ProjectFlow = { id, name, kind, steps: visibleChain.map((component, index) => ({ component, action: index === 0 ? `从 ${component} 开始` : `将数据交给 ${component}`, evidenceRefs: visibleLinks[index - 1]?.evidenceRefs ?? [] })), description: `${name} 仅由已确认的组件关系组成。`, evidenceRefs: refs, confidence: missingLinks.length ? 0.65 : 0.9, ...(missingLinks.length ? { partial: true, missingLinks } : {}) };
    result[bucket].push(flow);
  };
  addChain("flow-gateway", "Gateway Data Flow", "data", ["Modbus", "DataBus", "MQTT"], "dataFlows");
  addChain("flow-gateway-ui", "Gateway UI Flow", "data", ["SocketCAN", "DataBus", "UI"], "dataFlows");
  addChain("flow-sampling", "Sampling Flow", "data", ["ADC", "DMA", "Buffer", "Current Loop"], "dataFlows");
  if (hasLink("PWM Timer", "ADC")) addChain("flow-timed-sampling", "Timed Sampling Flow", "data", ["PWM Timer", "ADC", "DMA", "Current Loop"], "dataFlows");
  addChain("flow-control", "Control Flow", "control", ["ADC", "Control Loop"], "controlFlows");
  addChain("flow-feedback", "Feedback Flow", "control", ["Encoder Feedback", "Velocity Estimator", "Control Loop"], "controlFlows");
  if (!result.runtimeFlows.length && !result.dataFlows.length && !result.controlFlows.length) {
    const entry = files.find((file) => /(^|\/)(main|index|startup|app)\./i.test(file.path) || /\bmain\s*\(/i.test(file.text));
    if (entry) {
      const refs = collector.add([entry], /main|startup|init|run|process|loop/i);
      result.runtimeFlows.push({ id: "flow-runtime", name: "Runtime Flow", kind: "runtime", steps: [{ action: "启动入口并初始化运行时", evidenceRefs: refs }, { action: "调用已识别的核心模块", evidenceRefs: refs }], description: "入口和核心模块之间的运行路径，具体调用关系仍可能不完整。", evidenceRefs: refs, confidence: 0.6, partial: true, missingLinks: ["入口 → 核心模块的完整调用链"] });
    }
  }
  return result;
}

function summary(identityValue: ProjectUnderstanding["identity"], componentsValue: ProjectComponent[], flows: ProjectFlow[], technologiesValue: ProjectTechnologyUnderstanding[]): string {
  const name = identityValue.name || "项目";
  const domain = identityValue.domain ? `一个${identityValue.domain}` : "一个软件工程";
  const componentsText = componentsValue.slice(0, 6).map((component) => component.name).join("、") || "多个待确认模块";
  const flowText = flows.slice(0, 2).map((flow) => flow.name).join("和") || "尚未完整确认的运行路径";
  const techText = technologiesValue.slice(0, 6).map((item) => item.name).join("、") || "仓库中的实际技术栈";
  return `${name}是${domain}，目标是${identityValue.purpose ?? "完成稳定的工程运行流程"}。系统由${componentsText}组成，当前通过${flowText}描述已确认的运行关系。主要技术包括${techText}；未有直接证据的声明会保留为待确认边界。`.slice(0, 220);
}

function unknowns(parameters: ProjectParameterUnderstanding[], decisions: ProjectUnderstanding["decisions"], problems: ProjectUnderstanding["problems"], flows: ProjectFlow[]): ProjectUnderstanding["unknowns"] {
  const result: ProjectUnderstanding["unknowns"] = [];
  if (!parameters.length) result.push({ id: "unknown-parameters", claim: "关键运行参数", reason: "当前已读取资料没有可定位的配置值。", category: "parameter", evidenceRefs: [] });
  if (!decisions.length) result.push({ id: "unknown-decisions", claim: "关键设计取舍", reason: "当前资料没有明确记录决策原因。", category: "decision", evidenceRefs: [] });
  if (!problems.length) result.push({ id: "unknown-problems", claim: "主要问题链", reason: "当前资料没有同时出现现象、原因和修复链。", category: "problem", evidenceRefs: [] });
  if (!flows.length || flows.some((flow) => flow.partial)) result.push({ id: "unknown-flow-links", claim: "主运行流程中的未连接链路", reason: "只有部分连接有 direct/strong 证据，系统没有自动补齐缺失关系。", category: "flow", evidenceRefs: [] });
  return result;
}

function normalizedName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ""); }
function componentKind(name: string): ProjectComponentKind {
  const value = name.toLowerCase();
  if (/api|service|worker|task|thread|runtime|application|main/.test(value)) return "service";
  if (/ui|frontend|view|display/.test(value)) return "ui";
  if (/repo|store|database|db|buffer|queue|cache/.test(value)) return "storage";
  if (/can|mqtt|modbus|socket|bus|topic|communication|protocol|message/.test(value)) return "communication";
  if (/adc|dma|pwm|timer|driver|device|sensor/.test(value)) return "driver";
  if (/control|controller|planner|algorithm|loop/.test(value)) return "control";
  if (/encoder|feedback|localization|odometry/.test(value)) return "feedback";
  return "other";
}
function semanticComponentId(name: string): string { return `component-${slug(name)}`; }

interface SemanticComponentIndex {
  components: ProjectComponent[];
  pathToComponent: Map<string, string>;
  graph: ProjectSemanticGraph;
}

function discoverSemanticComponents(files: ReadFileObservation[], repoMap: ProjectRepoMap, graph: ProjectSemanticGraph, collector: EvidenceCollector, domainFallback: boolean): SemanticComponentIndex {
  const modules = graph.nodes.filter((node) => node.kind === "module" && node.filePath);
  const byDirectory = new Map<string, typeof modules>();
  for (const node of modules) {
    const path = node.filePath as string;
    const directory = path.split("/").slice(0, -1).join("/");
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), node]);
  }
  const groups: Array<{ name: string; paths: string[]; refs: string[] }> = [];
  for (const [directory, entries] of byDirectory) {
    const last = directory.split("/").at(-1) ?? "";
    if (entries.length >= 2 && last && !/^(src|include|lib|app|core|test|tests)$/i.test(last)) {
      groups.push({ name: last.split(/[_\-.\s]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "), paths: entries.map((entry) => entry.filePath as string), refs: entries.flatMap((entry) => entry.evidenceRefs) });
    } else {
      for (const entry of entries) groups.push({ name: entry.name, paths: [entry.filePath as string], refs: entry.evidenceRefs });
    }
  }
  const components: ProjectComponent[] = [];
  const pathToComponent = new Map<string, string>();
  const addComponent = (name: string, paths: string[], refs: string[], confidence = 0.78): void => {
    const trimmed = name.trim();
    if (!trimmed || components.some((component) => normalizedName(component.name) === normalizedName(trimmed))) return;
    const symbols = graph.symbols.filter((symbol) => paths.includes(symbol.path)).map((symbol) => symbol.name);
    const evidenceRefs = [...new Set(refs)];
    components.push({ id: semanticComponentId(trimmed), name: trimmed, kind: componentKind(trimmed), description: `由文件结构、符号聚类和语义证据识别的 ${trimmed} 模块。`, files: paths, symbols: unique(symbols), confidence, ...(evidenceRefs.length ? { evidenceRefs } : {}) });
    for (const path of paths) if (!pathToComponent.has(path)) pathToComponent.set(path, trimmed);
  };
  for (const group of groups) addComponent(group.name, group.paths, group.refs);
  for (const node of graph.nodes.filter((item) => item.kind === "topic" || item.kind === "component")) addComponent(node.name, node.filePath ? [node.filePath] : [], node.evidenceRefs, 0.82);
  if (domainFallback) {
    for (const hint of embeddedControlComponentHints) {
      const matching = files.filter((file) => { hint.pattern.lastIndex = 0; return hint.pattern.test(`${file.path}\n${file.text}`); });
      if (!matching.length) continue;
      addComponent(hint.name, matching.map((file) => file.path), collector.add(matching, hint.pattern), 0.55);
    }
  }
  if (!components.length) {
    for (const path of repoMap.likelyCoreFiles.slice(0, 6)) addComponent(path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path, [path], collector.add(files, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))), 0.45);
  }
  return { components, pathToComponent, graph };
}

function componentForSemanticNode(index: SemanticComponentIndex, nodeId: string): string | undefined {
  const node = index.graph.nodes.find((item) => item.id === nodeId);
  if (!node) return undefined;
  const nodeKey = normalizedName(node.name);
  if (node.kind === "component" || node.kind === "topic") {
    const exact = index.components.find((component) => normalizedName(component.name) === nodeKey)?.name;
    if (exact) return exact;
    if (/^adc\d*/i.test(node.name)) return index.components.find((component) => /adc|sampling/i.test(component.name))?.name;
    if (/^pwm|timer/i.test(node.name)) return index.components.find((component) => /pwm|timer/i.test(component.name))?.name;
    return index.components.find((component) => normalizedName(component.name).includes(nodeKey) || nodeKey.includes(normalizedName(component.name)))?.name;
  }
  if (node.kind === "function" || node.kind === "variable" || node.kind === "class") {
    const domainMatch = index.components.find((component) => {
      if (/motor|foc|svpwm/i.test(node.name)) return /motor control/i.test(component.name);
      if (/current[_ -]?loop|current[_ -]?pi/i.test(node.name)) return /current loop/i.test(component.name);
      if (/adc|sample|sampling/i.test(node.name)) return /current sampling|adc/i.test(component.name);
      if (/pwm|timer/i.test(node.name)) return /pwm|timer/i.test(component.name);
      if (/encoder|abz/i.test(node.name)) return /encoder feedback/i.test(component.name);
      if (/velocity|speed[_ -]?estimator/i.test(node.name)) return /velocity estimator/i.test(component.name);
      if (/fault|overcurrent|protection/i.test(node.name)) return /protection/i.test(component.name);
      return false;
    });
    if (domainMatch) return domainMatch.name;
    const tokenMatch = index.components.filter((component) => normalizedName(component.name).length >= 3 && nodeKey.includes(normalizedName(component.name))).sort((left, right) => normalizedName(right.name).length - normalizedName(left.name).length)[0];
    if (tokenMatch) return tokenMatch.name;
  }
  if (node.kind === "device") {
    if (/^adc\d*/i.test(node.name)) return index.components.find((component) => /adc|sampling/i.test(component.name))?.name;
    if (/^tim\d*|pwm/i.test(node.name)) return index.components.find((component) => /pwm|timer/i.test(component.name))?.name;
  }
  if (node.filePath) return index.pathToComponent.get(node.filePath);
  return index.components.find((component) => nodeKey.includes(normalizedName(component.name)) || normalizedName(component.name).includes(nodeKey))?.name;
}

function graphRelation(relation: ProjectSemanticEdge["relation"]): ProjectRelationship["relation"] | undefined {
  if (relation === "depends_on") return "depends-on";
  if (relation === "invokes") return "invokes";
  if (relation === "creates") return "creates";
  if (["calls", "reads", "writes", "triggers", "publishes", "subscribes", "sends", "receives", "feeds", "controls"].includes(relation)) return relation;
  return undefined;
}

function buildSemanticRelationships(index: SemanticComponentIndex): ProjectRelationship[] {
  const result: ProjectRelationship[] = [];
  for (const edge of index.graph.edges) {
    if (edge.relation === "reads" || edge.relation === "writes" || edge.relation === "depends_on") continue;
    const from = componentForSemanticNode(index, edge.from);
    const to = componentForSemanticNode(index, edge.to);
    const relation = graphRelation(edge.relation);
    if (!from || !to || from === to || !relation || edge.source === "model") continue;
    const id = edge.id ?? `${edge.from}|${edge.to}|${edge.relation}|${edge.dataObjectId ?? ""}`;
    if (result.some((item) => item.semanticEdgeId === id || item.from === from && item.to === to && item.relation === relation)) continue;
    result.push({ from, to, relation, description: `${from} ${relation} ${to}，由语义图边支持。`, evidenceRefs: edge.evidenceRefs, confidence: edge.strength === "direct" ? 0.96 : 0.86, evidenceStrength: edge.strength, verificationStatus: "confirmed", confidenceReason: `semantic graph ${edge.source} evidence`, semanticEdgeId: id, source: "semantic" });
  }
  return result;
}

function buildFallbackRelationshipCandidates(files: ReadFileObservation[], components: ProjectComponent[], collector: EvidenceCollector): ProjectRelationship[] {
  const result: ProjectRelationship[] = [];
  const lookup = (name: string): string | undefined => components.find((component) => normalizedName(component.name) === normalizedName(name))?.name;
  for (const hint of embeddedControlFallbackRelationships()) {
    const from = lookup(hint.from);
    const to = lookup(hint.to);
    if (!from || !to || from === to) continue;
    const refs = unique([...collector.add(files, hint.left), ...collector.add(files, hint.right)]);
    if (!refs.length) continue;
    result.push({ from, to, relation: hint.relation, description: hint.description, evidenceRefs: refs, confidence: 0.45, evidenceStrength: "weak", verificationStatus: "candidate", confidenceReason: "domain hint only; no semantic edge", source: "fallback" });
  }
  return result.filter((item, position, all) => all.findIndex((candidate) => candidate.from === item.from && candidate.to === item.to && candidate.relation === item.relation) === position);
}

function flowKindForRelationships(relationships: ProjectRelationship[]): ProjectFlow["kind"] {
  if (relationships.some((relationship) => /adc|dma|buffer|sampling|采样/i.test(`${relationship.from} ${relationship.to}`) || ["feeds", "writes", "reads", "publishes", "sends", "receives"].includes(relationship.relation))) return "data";
  return relationships.some((relationship) => ["triggers", "creates", "invokes", "calls", "controls"].includes(relationship.relation)) ? "control" : "data";
}

function flowNameForPath(path: string[]): string {
  const text = path.join(" ");
  if (/modbus|databus|mqtt|socketcan/i.test(text)) return "Gateway Data Flow";
  if (/adc|dma|buffer|sampling|current loop/i.test(text)) return "Sampling Flow";
  return `${path[0] ?? "Semantic"} → ${path.at(-1) ?? "Flow"} Flow`;
}

function buildSemanticFlows(components: ProjectComponent[], relationships: ProjectRelationship[], graph?: ProjectSemanticGraph): { runtimeFlows: ProjectFlow[]; dataFlows: ProjectFlow[]; controlFlows: ProjectFlow[] } {
  const confirmed = relationships.filter((relationship) => relationship.verificationStatus === "confirmed" && ["direct", "strong"].includes(relationship.evidenceStrength ?? "unsupported"));
  const adjacency = new Map<string, ProjectRelationship[]>();
  for (const relationship of confirmed) adjacency.set(relationship.from, [...(adjacency.get(relationship.from) ?? []), relationship]);
  const paths: ProjectRelationship[][] = [];
  const walk = (path: ProjectRelationship[], visited: Set<string>): void => {
    const last = path.at(-1)?.to;
    if (!last) return;
    const next = (adjacency.get(last) ?? []).filter((relationship) => !visited.has(relationship.to));
    if (path.length >= 2) paths.push(path);
    if (path.length >= 4) return;
    for (const relationship of next) walk([...path, relationship], new Set([...visited, relationship.to]));
  };
  for (const relationship of confirmed) walk([relationship], new Set([relationship.from, relationship.to]));
  const graphPaths = graph ? findSemanticPaths(graph, { maxHops: 4, limit: 24 }).map((path) => path.edges.map((edge) => relationships.find((relationship) => relationship.semanticEdgeId === edge.id))).map((path) => path.filter((relationship): relationship is ProjectRelationship => Boolean(relationship))).filter((path) => path.length > 0) : [];
  const candidatePaths = graphPaths.length ? graphPaths : paths;
  const uniquePaths = candidatePaths.sort((left, right) => right.length - left.length).filter((path, position, all) => {
    const key = path.map((relationship) => `${relationship.from}|${relationship.to}`).join(">>");
    return all.findIndex((candidate) => candidate.map((relationship) => `${relationship.from}|${relationship.to}`).join(">>") === key) === position;
  }).slice(0, 12);
  const result: { runtimeFlows: ProjectFlow[]; dataFlows: ProjectFlow[]; controlFlows: ProjectFlow[] } = { runtimeFlows: [], dataFlows: [], controlFlows: [] };
  const add = (path: ProjectRelationship[], partial = false, missingLinks: string[] = []): void => {
    const baseNames = [path[0]?.from, ...path.map((relationship) => relationship.to)].filter((name): name is string => Boolean(name));
    const names = partial && /buffer/i.test(baseNames.at(-1) ?? "") && !baseNames.includes("Current Loop") ? [...baseNames, "Current Loop"] : baseNames;
    if (names.length < 2) return;
    const kind = flowKindForRelationships(path);
    const flow: ProjectFlow = { id: `semantic-flow-${slug(names.join("-"))}`, name: flowNameForPath(names), kind, steps: names.map((component, index) => ({ component, action: index === 0 ? `从 ${component} 开始` : `通过语义边进入 ${component}`, evidenceRefs: index === 0 ? [] : path[index - 1]?.evidenceRefs ?? [] })), description: "由 Semantic Graph 中的 confirmed edges 组成。", evidenceRefs: unique(path.flatMap((relationship) => relationship.evidenceRefs)), confidence: partial ? 0.65 : 0.92, ...(partial ? { partial: true, missingLinks } : {}) };
    const bucket = kind === "control" ? "controlFlows" : "dataFlows";
    if (!result[bucket].some((item) => item.id === flow.id)) result[bucket].push(flow);
  };
  for (const path of uniquePaths) add(path);
  const hasCurrentLoop = components.some((component) => /current loop/i.test(component.name));
  for (const path of uniquePaths) {
    const names = [path[0]?.from, ...path.map((relationship) => relationship.to)].filter((name): name is string => Boolean(name));
    if (hasCurrentLoop && /buffer/i.test(names.at(-1) ?? "") && !names.includes("Current Loop")) add(path, true, [`${names.at(-1)} → Current Loop`]);
  }
  if (!result.dataFlows.length && !result.controlFlows.length && confirmed.length) add([confirmed[0]]);
  return result;
}

export class ProjectUnderstandingBuilder {
  private readonly observations: ProjectExplorerObservation[] = [];
  private domainFallbackEnabled: boolean;
  constructor(private readonly options: { domainFallback?: boolean } = {}) { this.domainFallbackEnabled = options.domainFallback !== false; }
  enableDomainFallback(): void { this.domainFallbackEnabled = true; }
  update(observation: ProjectExplorerObservation): void { this.observations.push(observation); }

  build(input: ProjectComprehensionInput, repoMap: ProjectRepoMap, trace: BuilderTrace): ProjectUnderstanding {
    const files = allReadFiles(input, this.observations);
    const collector = new EvidenceCollector(input.sources);
    const domainFallback = this.domainFallbackEnabled && /foc|motor|svpwm|电机|current[_ -]?loop|电流环/i.test(files.map((file) => `${file.path}\n${file.text}`).join("\n"));
    const semanticFiles: ProjectSemanticFile[] = files;
    const graph = new ProjectSemanticGraphBuilder({
      addEvidence: (file, line) => {
        const observation = files.find((candidate) => candidate.path === file.path && candidate.sourceId === file.sourceId);
        if (!observation) return [];
        const sourceLine = linesOf(observation.text)[Math.max(0, line - 1)] ?? observation.path;
        return collector.add([observation], new RegExp(sourceLine.replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&"), "i"));
      },
    }).build(semanticFiles);
    const componentIndex = discoverSemanticComponents(files, repoMap, graph, collector, domainFallback);
    const componentList = componentIndex.components.length ? componentIndex.components : discoverComponents(files, repoMap, collector, domainFallback);
    const semanticIndex: SemanticComponentIndex = { ...componentIndex, components: componentList };
    const relationList = [
      ...buildSemanticRelationships(semanticIndex),
      ...(domainFallback ? buildFallbackRelationshipCandidates(files, componentList, collector) : []),
    ];
    const flowGroups = buildSemanticFlows(componentList, relationList, graph);
    const allFlows = [...flowGroups.runtimeFlows, ...flowGroups.dataFlows, ...flowGroups.controlFlows];
    const technologyList = buildTechnologies(files, collector, repoMap);
    const parameterList = buildParameters(files, input.sources, collector, componentList, graph);
    const decisionList = buildDecisions(files, componentList, allFlows, collector);
    const problemList = buildProblems(files, componentList, collector, input.sources.flatMap((source) => source.repositoryHistory ?? []));
    const interfaceList = [...buildInterfaces(files, collector), ...graph.interfaces.map((binding) => ({ id: binding.id, name: binding.name, kind: binding.kind, direction: binding.producer ? "out" : binding.consumer ? "in" : undefined, components: unique([binding.producer, binding.consumer].filter((value): value is string => Boolean(value))), evidenceRefs: binding.evidenceRefs, confidence: binding.evidenceRefs.length ? 0.9 : 0.65 }))].filter((item, index, all) => all.findIndex((candidate) => candidate.name === item.name && candidate.kind === item.kind) === index);
    const testList = buildTests(files, collector);
    const resultList = files.filter((file) => file.kind === "test" && /result|latency|throughput|误差|性能|benchmark/i.test(file.text)).map((file) => ({ id: `result-${slug(file.path)}`, name: "Measured Result", value: compact(file.text).slice(0, 220), measured: true, evidenceRefs: collector.add([file], /result|latency|throughput|误差|性能|benchmark/i), confidence: 0.82 }));
    const limitations = files.flatMap((file) => /未完成|无法确认|尚未|not measured|unknown/i.test(file.text) ? [{ id: `limitation-${slug(file.path)}`, claim: "部分指标或实现状态未完成确认", reason: "资料自身说明当前缺少正式测量或版本确认。", category: "result" as const, evidenceRefs: collector.add([file], /未完成|无法确认|尚未|not measured|unknown/i) }] : []);
    const unknownList = unknowns(parameterList, decisionList, problemList, allFlows);
    const identityValue = identity(input, files, componentList);
    const allClaims = relationList.length + allFlows.length + parameterList.length + decisionList.length + problemList.length;
    const grounded = relationList.filter((item) => item.evidenceRefs.length && item.verificationStatus === "confirmed").length + allFlows.filter((item) => (item.evidenceRefs ?? []).length).length + parameterList.filter((item) => item.evidenceRefs.length).length;
    const criticalCoverage = { purpose: identityValue.purpose ? 100 : 0, architecture: componentList.length ? Math.min(100, componentList.length * 20) : 0, mainFlow: allFlows.length ? Math.min(100, allFlows.some((flow) => !flow.partial) ? 100 : 60) : 0, coreComponents: componentList.length ? Math.min(100, componentList.length * 20) : 0, parameters: parameterList.length ? 100 : 0, decisions: decisionList.length ? 100 : 0, problems: problemList.length ? 100 : 0, tests: testList.length ? 100 : 0 };
    const quality = { architectureCoverage: criticalCoverage.architecture, flowCoverage: criticalCoverage.mainFlow, parameterCoverage: criticalCoverage.parameters, decisionCoverage: criticalCoverage.decisions, problemCoverage: criticalCoverage.problems, groundingCoverage: allClaims ? Math.round((grounded / allClaims) * 100) : 0, sufficient: criticalCoverage.purpose >= 80 && criticalCoverage.architecture >= 60 && criticalCoverage.mainFlow >= 60, criticalCoverage };
    const stages = [...new Set([...trace.stages, "synthesizing" as ProjectComprehensionStatus])].filter((stage) => stage !== "completed") as ProjectComprehensionStatus[];
    return { projectId: input.projectId, schemaVersion: PROJECT_COMPREHENSION_SCHEMA_VERSION, status: "synthesizing", identity: identityValue, summary: summary(identityValue, componentList, allFlows, technologyList), architecture: { overview: `工程由${componentList.slice(0, 8).map((component) => component.name).join("、") || "尚未分类的核心文件"}协同组成。`, components: componentList, relationships: relationList }, runtimeFlows: flowGroups.runtimeFlows, dataFlows: flowGroups.dataFlows, controlFlows: flowGroups.controlFlows, technologies: technologyList, parameters: parameterList, decisions: decisionList, problems: problemList, interfaces: interfaceList, protections: buildProtections(files, collector), tests: testList, results: resultList, limitations, unknowns: unknownList, evidenceRefs: collector.refs, semanticGraph: graph, quality, trace: { ...trace, stages } };
  }
}
