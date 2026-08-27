import type {
  ProjectDataObject,
  ProjectFileReadResult,
  ProjectInterfaceBinding,
  ProjectSemanticEdge,
  ProjectSemanticEdgeRelation,
  ProjectSemanticEdgeSource,
  ProjectSemanticEvidence,
  ProjectSemanticGraph,
  ProjectSemanticNode,
  ProjectSemanticNodeKind,
  ProjectCallGraph,
  ProjectSymbol,
  ProjectSymbolIndex,
} from "./types";

export interface ProjectSemanticFile {
  path: string;
  sourceId: string;
  kind: ProjectFileReadResult["kind"];
  language: string;
  text: string;
}

export interface ProjectSemanticCall { caller?: string; callee: string; line: number; }
export interface ProjectSemanticAssignment { object: string; access: "read" | "write"; owner?: string; line: number; type?: string; }
export interface ProjectSemanticImport { value: string; line: number; kind: "import" | "include"; }
export interface ProjectSemanticRegistration { owner?: string; target: string; relation: "invokes" | "creates" | "publishes" | "subscribes"; interfaceName?: string; line: number; }
export interface ProjectSemanticConfig { key: string; value?: string; line: number; }

export interface ProjectSemanticFileAnalysis {
  symbols: ProjectSymbol[];
  calls: ProjectSemanticCall[];
  assignments: ProjectSemanticAssignment[];
  imports: ProjectSemanticImport[];
  registrations: ProjectSemanticRegistration[];
  configs: ProjectSemanticConfig[];
  interfaces: ProjectInterfaceBinding[];
  textualEdges?: Array<{ from: string; to: string; relation: ProjectSemanticEdgeRelation; line: number }>;
}

export interface ProjectLanguageSemanticAdapter {
  readonly name: string;
  supports(language: string, path: string): boolean;
  analyze(file: ProjectSemanticFile): ProjectSemanticFileAnalysis;
}

const controlWords = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "typeof", "function", "def", "class", "new"]);
const languageExtensions = new Set(["c", "h", "cc", "cpp", "cxx", "hpp"]);
const scriptExtensions = new Set(["ts", "tsx", "js", "jsx", "py"]);

function extension(path: string): string { return path.toLowerCase().split(".").pop() ?? ""; }
function lines(text: string): string[] { return text.replace(/\r/g, "").split("\n"); }
function lineNumber(text: string, index: number): number { return text.slice(0, index).split(/\r?\n/).length + (text[index] === "\n" ? 1 : 0); }
function cleanName(value: string): string { return value.trim().replace(/^&+/, "").replace(/^\([^)]*\)\s*/, ""); }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function isIdentifier(value: string): boolean { return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(value); }
function objectName(value: string): string { return cleanName(value).replace(/\[[^\]]*\]/g, "").replace(/->/g, ".").replace(/\s+/g, ""); }
function moduleName(path: string): string {
  const stem = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? path;
  const known: Record<string, string> = { api: "API", ui: "UI", mqtt: "MQTT", modbus: "Modbus", socketcan: "SocketCAN", databus: "DataBus", adc: "ADC", dma: "DMA", pwm: "PWM", can: "CAN", ros: "ROS", http: "HTTP", rtos: "RTOS" };
  if (known[stem.toLowerCase()]) return known[stem.toLowerCase()];
  return stem.split(/[_\-.\s]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") || "Module";
}
function moduleNodeId(path: string): string { return `module:${path}`; }
function symbolNodeId(name: string, path?: string): string { return `symbol:${path ?? ""}:${name}`; }
function dataNodeId(name: string): string { return `data:${name}`; }
function nodeNameFromId(id: string): string { return id.replace(/^(?:module|symbol|data|topic|config):/, "").split(":").at(-1) ?? id; }

function ownerAt(symbols: ProjectSymbol[], line: number): string | undefined {
  return symbols.filter((symbol) => symbol.kind === "function" && (symbol.line ?? 0) <= line).sort((left, right) => (right.line ?? 0) - (left.line ?? 0))[0]?.name;
}

function addAssignment(result: ProjectSemanticAssignment[], object: string, access: "read" | "write", owner: string | undefined, line: number, type?: string): void {
  const normalized = objectName(object);
  if (!normalized || normalized.length < 2 || ["return", "true", "false", "null", "undefined"].includes(normalized.toLowerCase())) return;
  result.push({ object: normalized, access, owner, line, ...(type ? { type } : {}) });
}

function analyzeCFamily(file: ProjectSemanticFile): ProjectSemanticFileAnalysis {
  const result: ProjectSemanticFileAnalysis = { symbols: [], calls: [], assignments: [], imports: [], registrations: [], configs: [], interfaces: [] };
  const text = file.text;
  for (const match of text.matchAll(/(?:^|\n)\s*(?:(?:static|inline|extern|const|volatile)\s+)*(?:(?:[A-Za-z_][\w]*|[A-Za-z_][\w]*::|[\w:*&<>]+)\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g)) {
    const name = match[1];
    if (name) result.symbols.push({ name, kind: "function", path: file.path, line: lineNumber(text, match.index ?? 0), definedAt: { path: file.path, line: lineNumber(text, match.index ?? 0) } });
  }
  for (const match of text.matchAll(/\b(class|struct|enum)\s+([A-Za-z_]\w*)/g)) {
    const name = match[2];
    if (name) result.symbols.push({ name, kind: "class", path: file.path, line: lineNumber(text, match.index ?? 0), definedAt: { path: file.path, line: lineNumber(text, match.index ?? 0) } });
  }
  for (const match of text.matchAll(/^[ \t]*#define\s+([A-Za-z_]\w*)\s*(.*)$/gm)) {
    const name = match[1];
    if (name) { const line = lineNumber(text, match.index ?? 0); result.symbols.push({ name, kind: "macro", path: file.path, line, definedAt: { path: file.path, line } }); result.configs.push({ key: name, value: match[2]?.trim(), line }); }
  }
  for (const match of text.matchAll(/^[ \t]*#include\s*[<"]([^>"]+)[>"]/gm)) result.imports.push({ value: match[1] ?? "", line: lineNumber(text, match.index ?? 0), kind: "include" });

  const knownSymbols = new Set(result.symbols.map((symbol) => symbol.name));
  for (const match of text.matchAll(/\b([A-Za-z_]\w*)\s*\(([^\n;{}]*)\)/g)) {
    const callee = match[1];
    if (!callee || controlWords.has(callee)) continue;
    const line = lineNumber(text, match.index ?? 0);
    const owner = ownerAt(result.symbols, line);
    if (!knownSymbols.has(callee) || callee !== owner) result.calls.push({ caller: owner, callee, line });
    const args = match[2] ?? "";
    for (const arg of args.split(",")) {
      const candidate = arg.match(/(?:\*|&|\([^)]*\))?\s*([A-Za-z_]\w*(?:->|\.)[A-Za-z_]\w*|[A-Za-z_]\w*)/i)?.[1];
      if (!candidate || ["void", "int", "float", "double"].includes(candidate)) continue;
      if (/xQueueSend|xQueueReceive|queue|buffer|state|publish|send|receive|dma/i.test(callee)) addAssignment(result.assignments, candidate, /xQueueReceive|receive/i.test(callee) ? "read" : "write", owner, line);
    }
    if (/register[_]?callback|set[_]?callback|callback/i.test(callee)) {
      const callback = args.match(/([A-Za-z_]\w*)/)?.[1];
      if (callback) result.registrations.push({ owner, target: callback, relation: "invokes", line });
    }
    if (/xTaskCreate|create[_]?task|thread[_]?create/i.test(callee)) {
      const task = args.match(/([A-Za-z_]\w*)/)?.[1];
      if (task) result.registrations.push({ owner, target: task, relation: "creates", line });
    }
    if (/publish|send/i.test(callee) && /mqtt|topic|publish/i.test(`${callee} ${args}`)) {
      const topic = args.match(/["']([^"']+)["']/)?.[1];
      if (topic) result.registrations.push({ owner, target: topic, relation: "publishes", interfaceName: topic, line });
    }
    if (/subscribe|register[_]?subscriber/i.test(callee)) {
      const topic = args.match(/["']([^"']+)["']/)?.[1];
      const callback = args.match(/,\s*([A-Za-z_]\w*)/)?.[1];
      if (topic) result.registrations.push({ owner: callback ?? owner, target: topic, relation: "subscribes", interfaceName: topic, line });
    }
  }

  const declarationNames = new Set<string>();
  for (const match of text.matchAll(/\b(?:extern\s+)?(?:const\s+|volatile\s+|static\s+)?(?:unsigned\s+|signed\s+)?(?:char|short|int|long|float|double|bool|uint\w*|int\w*|struct\s+\w+)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(?:\[[^\]]*\])?\s*(?:=|;|,)/g)) declarationNames.add(objectName(match[1] ?? ""));
  for (const [index, line] of lines(text).entries()) {
    const lineNumberValue = index + 1;
    const assignment = line.match(/\b([A-Za-z_]\w*(?:->|\.)[A-Za-z_]\w*|[A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(\+=|-=|=)/);
    if (assignment) {
      const left = objectName(assignment[1] ?? "");
      const owner = ownerAt(result.symbols, lineNumberValue);
      addAssignment(result.assignments, left, "write", owner, lineNumberValue);
      const rhs = line.slice((assignment.index ?? 0) + assignment[0].length);
      for (const token of rhs.matchAll(/\b([A-Za-z_]\w*(?:->|\.)[A-Za-z_]\w*|[A-Za-z_]\w*)\b/g)) {
        const value = objectName(token[1] ?? "");
        if (declarationNames.has(value) || /buffer|state|queue|ref|speed|current|angle|position|data/i.test(value)) addAssignment(result.assignments, value, "read", owner, lineNumberValue);
      }
    }
    const config = line.match(/\b([A-Za-z_]\w*(?:(?:->|\.)[A-Za-z_]\w*)?)\s*=\s*([^;]+);/);
    if (config && /config|trig|trigger|pwm|adc|timer|baud|frequency|rate/i.test(config[1] ?? "")) result.configs.push({ key: config[1] ?? "", value: config[2]?.trim(), line: lineNumberValue });
  }
  return result;
}

function analyzeScript(file: ProjectSemanticFile): ProjectSemanticFileAnalysis {
  const result: ProjectSemanticFileAnalysis = { symbols: [], calls: [], assignments: [], imports: [], registrations: [], configs: [], interfaces: [] };
  const text = file.text;
  const isPython = extension(file.path) === "py" || /python/i.test(file.language);
  const functionPattern = isPython ? /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/g : /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(/g;
  for (const match of text.matchAll(functionPattern)) {
    const name = match[1] ?? match[2];
    if (name) result.symbols.push({ name, kind: "function", path: file.path, line: lineNumber(text, match.index ?? 0), definedAt: { path: file.path, line: lineNumber(text, match.index ?? 0) } });
  }
  const classPattern = isPython ? /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/g : /\bclass\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(classPattern)) { const name = match[1]; if (name) result.symbols.push({ name, kind: "class", path: file.path, line: lineNumber(text, match.index ?? 0), definedAt: { path: file.path, line: lineNumber(text, match.index ?? 0) } }); }
  for (const match of text.matchAll(isPython ? /^\s*(?:from\s+([^\s]+)\s+)?import\s+(.+)$/gm : /^\s*import\s+(.+?)\s+from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
    result.imports.push({ value: (match[2] ?? match[1] ?? match[3] ?? "").trim(), line: lineNumber(text, match.index ?? 0), kind: "import" });
  }
  const symbols = result.symbols;
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(([^\n;{}]*)\)/g)) {
    const callee = match[1];
    if (!callee || controlWords.has(callee)) continue;
    const line = lineNumber(text, match.index ?? 0);
    const sourceLine = lines(text)[line - 1] ?? "";
    const lineStart = text.lastIndexOf("\n", match.index ?? 0) + 1;
    const prefix = sourceLine.slice(0, Math.max(0, (match.index ?? 0) - lineStart));
    const isDefinition = isPython ? /(?:^|\s)(?:async\s+)?def\s*$/.test(prefix) : /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s*$/.test(prefix) || /(?:^|\s)(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*$/.test(prefix);
    if (isDefinition) continue;
    result.calls.push({ caller: ownerAt(symbols, line), callee, line });
    const args = match[2] ?? "";
    if (/publish|emit|send/i.test(callee)) { const topic = args.match(/["']([^"']+)["']/)?.[1]; if (topic) result.registrations.push({ owner: ownerAt(symbols, line), target: topic, relation: "publishes", interfaceName: topic, line }); }
    if (/subscribe|on|listen/i.test(callee)) { const topic = args.match(/["']([^"']+)["']/)?.[1]; const callback = args.match(/,\s*([A-Za-z_$][\w$]*)/)?.[1]; if (topic) result.registrations.push({ owner: callback ?? ownerAt(symbols, line), target: topic, relation: "subscribes", interfaceName: topic, line }); }
  }
  for (const [index, line] of lines(text).entries()) {
    const lineValue = index + 1;
    const assignment = line.match(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*(=|\+=|-=)/);
    if (assignment) {
      const owner = ownerAt(symbols, lineValue);
      addAssignment(result.assignments, assignment[1] ?? "", "write", owner, lineValue);
      for (const token of line.slice((assignment.index ?? 0) + assignment[0].length).matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\b/g)) addAssignment(result.assignments, token[1] ?? "", "read", owner, lineValue);
    }
  }
  return result;
}

export class CppSemanticAdapter implements ProjectLanguageSemanticAdapter {
  readonly name = "c-cpp-lightweight";
  supports(language: string, path: string): boolean { return language === "C" || language === "C++" || languageExtensions.has(extension(path)); }
  analyze(file: ProjectSemanticFile): ProjectSemanticFileAnalysis { return analyzeCFamily(file); }
}

export class ScriptSemanticAdapter implements ProjectLanguageSemanticAdapter {
  readonly name = "typescript-javascript-python-lightweight";
  supports(language: string, path: string): boolean { return ["TypeScript", "JavaScript", "Python"].includes(language) || scriptExtensions.has(extension(path)); }
  analyze(file: ProjectSemanticFile): ProjectSemanticFileAnalysis { return analyzeScript(file); }
}

export class GenericSemanticAdapter implements ProjectLanguageSemanticAdapter {
  readonly name = "generic-text-semantic";
  supports(): boolean { return true; }
  analyze(file: ProjectSemanticFile): ProjectSemanticFileAnalysis {
    const result: ProjectSemanticFileAnalysis = { symbols: [], calls: [], assignments: [], imports: [], registrations: [], configs: [], interfaces: [] };
    for (const [index, line] of lines(file.text).entries()) {
      if (file.kind === "config" || /\.json$|\.ya?ml$|\.toml$/i.test(file.path)) {
        const config = line.match(/^[\s"']*([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?([^,"'#}]+?)["']?\s*(?:,|$)/);
        if (config?.[1]) result.configs.push({ key: config[1], value: config[2]?.trim(), line: index + 1 });
      }
      const arrow = line.match(/\b([A-Za-z][A-Za-z0-9 _./-]{1,32})\s*(?:->|=>|publishes(?:\s+to)?|feeds|writes|triggers|calls)\s*([A-Za-z][A-Za-z0-9 _./-]{1,32})\b/i);
      if (arrow) result.interfaces.push({ id: `text-edge-${file.path}-${index + 1}`, name: `${arrow[1]} → ${arrow[2]}`, kind: "other", evidenceRefs: [] });
      const documented = !arrow ? line.match(/\b(PWM(?:\s+timer)?|ADC\d*|DMA\d*|Modbus|MQTT|SocketCAN|DataBus|UI)\b[^\n]{0,100}?(?:(?:\b(?:trigger|triggers|triggered|feeds|publishes|sends|receives)\b)|用于|触发|进入|发布|发送|接收)[^\n]{0,100}?\b(PWM(?:\s+timer)?|ADC\d*|DMA\d*|Modbus|MQTT|SocketCAN|DataBus|UI)\b/i) : undefined;
      if (documented) {
        const from = documented[1]?.trim();
        const to = documented[2]?.trim();
        const relation = /publishes|发布/i.test(documented[0] ?? "") ? "publishes" : /feeds|进入/i.test(documented[0] ?? "") ? "feeds" : /sends|发送/i.test(documented[0] ?? "") ? "sends" : /receives|接收/i.test(documented[0] ?? "") ? "receives" : "triggers";
        if (from && to) result.textualEdges = [...(result.textualEdges ?? []), { from, to, relation, line: index + 1 }];
      }
    }
    return result;
  }
}

export const defaultSemanticAdapters: ProjectLanguageSemanticAdapter[] = [new CppSemanticAdapter(), new ScriptSemanticAdapter(), new GenericSemanticAdapter()];

export interface ProjectSemanticGraphBuilderOptions {
  adapters?: ProjectLanguageSemanticAdapter[];
  addEvidence?: (file: ProjectSemanticFile, line: number, description: string, type: ProjectSemanticEvidence["type"]) => string[];
}

function sourceFor(file: ProjectSemanticFile): ProjectSemanticEdgeSource { return file.kind === "document" ? "document" : file.kind === "test" ? "test" : "symbol"; }
function strengthFor(file: ProjectSemanticFile): "direct" | "strong" { return file.kind === "document" ? "strong" : "direct"; }
function sharedObject(object: string): boolean { return /\.|->|shared|global|state|queue|topic|buffer|current|speed|angle|position|data/i.test(object); }
function canonicalObject(object: string, file: ProjectSemanticFile, declarations: Map<string, Set<string>>): string {
  const normalized = objectName(object);
  // A bare local called `buffer`/`state` must remain file-scoped. Only
  // qualified fields and explicitly shared/global handles are cross-file data.
  if (normalized.includes(".") || /^(?:shared|global|g_|queue_|topic_|bus_)/i.test(normalized) || /(?:queue|topic)(?:_handle|_t|_id)?$/i.test(normalized)) return normalized;
  return `${file.path}::${normalized}`;
}
function addUnique<T>(array: T[], value: T, key: (item: T) => string): void { if (!array.some((item) => key(item) === key(value))) array.push(value); }

export class ProjectSemanticGraphBuilder {
  constructor(private readonly options: ProjectSemanticGraphBuilderOptions = {}) {}

  build(files: ProjectSemanticFile[]): ProjectSemanticGraph {
    const adapters = this.options.adapters ?? defaultSemanticAdapters;
    const analyses = files.map((file) => ({ file, analysis: adapters.find((adapter) => adapter.supports(file.language, file.path))?.analyze(file) ?? new GenericSemanticAdapter().analyze(file) }));
    const nodes: ProjectSemanticNode[] = [];
    const edges: ProjectSemanticEdge[] = [];
    const symbols: ProjectSymbol[] = [];
    const dataObjects = new Map<string, ProjectDataObject>();
    const configs: ProjectSemanticGraph["configs"] = [];
    const interfaces: ProjectInterfaceBinding[] = [];
    const evidence: ProjectSemanticEvidence[] = [];
    const nodeById = new Map<string, ProjectSemanticNode>();
    const declarations = new Map<string, Set<string>>();
    const moduleForPath = new Map<string, string>();
    const symbolForName = new Map<string, ProjectSymbol[]>();
    const addNode = (node: ProjectSemanticNode): ProjectSemanticNode => { const existing = nodeById.get(node.id); if (existing) { existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...node.evidenceRefs])]; return existing; } nodeById.set(node.id, node); nodes.push(node); return node; };
    const refsFor = (file: ProjectSemanticFile, line: number, description: string, type: ProjectSemanticEvidence["type"]): string[] => {
      const refs = this.options.addEvidence?.(file, line, description, type) ?? [];
      evidence.push({ id: `semantic-evidence-${file.sourceId}-${file.path}-${line}-${evidence.length}`, type, description, evidenceRefs: refs, filePath: file.path, line });
      return refs;
    };
    const addEdge = (edge: ProjectSemanticEdge): void => {
      const id = edge.id ?? `${edge.from}|${edge.to}|${edge.relation}|${edge.dataObjectId ?? ""}`;
      addUnique(edges, { ...edge, id }, (item) => `${item.from}|${item.to}|${item.relation}|${item.dataObjectId ?? ""}`);
    };
    for (const { file, analysis } of analyses) {
      const module = moduleName(file.path);
      moduleForPath.set(file.path, module);
      const moduleRefs = refsFor(file, 1, `module ${module} from ${file.path}`, "symbol");
      addNode({ id: moduleNodeId(file.path), kind: "module", name: module, filePath: file.path, evidenceRefs: moduleRefs });
      for (const symbol of analysis.symbols) {
        const next = { ...symbol, references: symbol.references ?? [], calls: symbol.calls ?? [], calledBy: symbol.calledBy ?? [], readVariables: symbol.readVariables ?? [], writeVariables: symbol.writeVariables ?? [], imports: symbol.imports ?? [], includes: symbol.includes ?? [], callbacks: symbol.callbacks ?? [], registrations: symbol.registrations ?? [] };
        symbols.push(next);
        symbolForName.set(symbol.name, [...(symbolForName.get(symbol.name) ?? []), next]);
        const nodeKind: ProjectSemanticNodeKind = symbol.kind === "macro" ? "config" : symbol.kind;
        addNode({ id: symbolNodeId(symbol.name, file.path), kind: nodeKind, name: symbol.name, filePath: file.path, symbol: symbol.name, evidenceRefs: refsFor(file, symbol.line ?? 1, `definition ${symbol.name}`, "symbol") });
      }
      for (const assignment of analysis.assignments) {
        const normalized = objectName(assignment.object);
        declarations.set(normalized, new Set([...(declarations.get(normalized) ?? []), file.path]));
      }
    }
    for (const { file, analysis } of analyses) {
      const module = moduleForPath.get(file.path) ?? moduleName(file.path);
      const ownerNode = (owner?: string): string => owner ? symbolNodeId(owner, file.path) : moduleNodeId(file.path);
      for (const call of analysis.calls) {
        const target = symbolForName.get(call.callee)?.[0];
        const to = target ? symbolNodeId(target.name, target.path) : symbolNodeId(call.callee, file.path);
        const refs = refsFor(file, call.line, `${call.caller ?? module} calls ${call.callee}`, "call");
        addNode({ id: to, kind: "function", name: call.callee, filePath: target?.path ?? file.path, symbol: call.callee, evidenceRefs: refs });
        addEdge({ from: ownerNode(call.caller), to, relation: "calls", evidenceRefs: refs, strength: "direct", source: "symbol" });
        const caller = call.caller ? symbolForName.get(call.caller)?.find((symbol) => symbol.path === file.path) : undefined;
        if (caller && !caller.calls?.includes(call.callee)) caller.calls = [...(caller.calls ?? []), call.callee];
        const called = target;
        if (called) called.references = [...(called.references ?? []), { path: file.path, line: call.line }];
        if (called && !called.calledBy?.includes(call.caller ?? module)) called.calledBy = [...(called.calledBy ?? []), call.caller ?? module];
      }
      for (const imported of analysis.imports) {
        const refs = refsFor(file, imported.line, `${module} ${imported.kind}s ${imported.value}`, "symbol");
        addEdge({ from: moduleNodeId(file.path), to: `import:${imported.value}`, relation: "depends_on", evidenceRefs: refs, strength: "direct", source: "symbol" });
        interfaces.push({ id: `interface:${imported.kind}:${file.path}:${imported.line}`, name: imported.value, kind: imported.kind, consumer: module, evidenceRefs: refs });
        const owner = analysis.symbols[0];
        if (owner) { owner.imports = [...(owner.imports ?? []), imported.value]; if (imported.kind === "include") owner.includes = [...(owner.includes ?? []), imported.value]; }
      }
      for (const config of analysis.configs) {
        const refs = refsFor(file, config.line, `${config.key} = ${config.value ?? ""}`, "config");
        const binding = { id: `config:${file.path}:${config.line}`, key: config.key, value: config.value, filePath: file.path, evidenceRefs: refs };
        configs.push(binding);
        addNode({ id: binding.id, kind: "config", name: config.key, filePath: file.path, evidenceRefs: refs });
        const line = lines(file.text)[config.line - 1] ?? "";
        const adc = line.match(/\bADC\d*\b/i)?.[0]?.toUpperCase();
        const timerToken = line.match(/\bTIM\d+\b/i)?.[0]?.toUpperCase() ?? (line.match(/T(\d+)_TRGO/i)?.[1] ? `TIM${line.match(/T(\d+)_TRGO/i)?.[1]}` : undefined);
        if (adc && timerToken && /trgo|externaltrig|trigger/i.test(`${config.key} ${config.value ?? ""} ${line}`)) {
          const from = `device:${timerToken}`;
          const to = `device:${adc}`;
          addNode({ id: from, kind: "device", name: timerToken, evidenceRefs: refs });
          addNode({ id: to, kind: "device", name: adc, evidenceRefs: refs });
          addEdge({ from, to, relation: "triggers", evidenceRefs: refs, strength: "direct", source: "config" });
        }
      }
      for (const assignment of analysis.assignments) {
        const canonical = canonicalObject(assignment.object, file, declarations);
        const object = dataObjects.get(canonical) ?? { id: dataNodeId(canonical), name: assignment.object, files: [], writers: [], readers: [], evidenceRefs: [] };
        object.files = unique([...object.files, file.path]);
        const refs = refsFor(file, assignment.line, `${assignment.access} ${assignment.object}`, "assignment");
        object.evidenceRefs = [...new Set([...object.evidenceRefs, ...refs])];
        const owner = assignment.owner ?? module;
        if (assignment.access === "write") object.writers = unique([...object.writers, owner]); else object.readers = unique([...object.readers, owner]);
        const ownerSymbol = assignment.owner ? symbolForName.get(assignment.owner)?.find((symbol) => symbol.path === file.path) : undefined;
        if (ownerSymbol) {
          if (assignment.access === "write") ownerSymbol.writeVariables = unique([...(ownerSymbol.writeVariables ?? []), assignment.object]);
          else ownerSymbol.readVariables = unique([...(ownerSymbol.readVariables ?? []), assignment.object]);
        }
        dataObjects.set(canonical, object);
        addNode({ id: object.id, kind: /queue/i.test(assignment.object) ? "queue" : /buffer/i.test(assignment.object) ? "buffer" : "variable", name: assignment.object, filePath: file.path, symbol: assignment.object, evidenceRefs: refs });
        addEdge({ from: ownerNode(assignment.owner), to: object.id, relation: assignment.access === "write" ? "writes" : "reads", evidenceRefs: refs, strength: "direct", source: "assignment", dataObjectId: object.id });
      }
      for (const registration of analysis.registrations) {
        const refs = refsFor(file, registration.line, `${registration.owner ?? module} ${registration.relation} ${registration.target}`, "registration");
        const owner = ownerNode(registration.owner);
        const ownerSymbol = registration.owner ? symbolForName.get(registration.owner)?.find((symbol) => symbol.path === file.path) : undefined;
        if (ownerSymbol) {
          ownerSymbol.registrations = unique([...(ownerSymbol.registrations ?? []), registration.target]);
          if (registration.relation === "invokes") ownerSymbol.callbacks = unique([...(ownerSymbol.callbacks ?? []), registration.target]);
        }
        if (registration.relation === "publishes" || registration.relation === "subscribes") {
          const topicId = `topic:${registration.target}`;
          addNode({ id: topicId, kind: "topic", name: registration.target, evidenceRefs: refs });
          addEdge({ from: owner, to: topicId, relation: registration.relation, evidenceRefs: refs, strength: "direct", source: "symbol" });
          interfaces.push({ id: `interface:${registration.target}:${registration.line}`, name: registration.target, kind: "topic", producer: registration.relation === "publishes" ? registration.owner ?? module : undefined, consumer: registration.relation === "subscribes" ? registration.owner ?? module : undefined, evidenceRefs: refs });
        } else {
          const target = symbolForName.get(registration.target)?.[0];
          const targetId = target ? symbolNodeId(target.name, target.path) : symbolNodeId(registration.target, file.path);
          addNode({ id: targetId, kind: registration.relation === "creates" ? "task" : "function", name: registration.target, filePath: target?.path ?? file.path, evidenceRefs: refs });
          addEdge({ from: owner, to: targetId, relation: registration.relation, evidenceRefs: refs, strength: "direct", source: "symbol" });
        }
      }
      for (const textual of analysis.textualEdges ?? []) {
        const refs = refsFor(file, textual.line, `${textual.from} ${textual.relation} ${textual.to}`, "document");
        const from = `text:${textual.from}`;
        const to = `text:${textual.to}`;
        addNode({ id: from, kind: "component", name: textual.from, filePath: file.path, evidenceRefs: refs });
        addNode({ id: to, kind: "component", name: textual.to, filePath: file.path, evidenceRefs: refs });
        addEdge({ from, to, relation: textual.relation, evidenceRefs: refs, strength: strengthFor(file), source: sourceFor(file) });
      }
      for (const [index, line] of lines(file.text).entries()) {
        const pointerAssignment = file.kind === "source" && /\b[A-Za-z_]\w*->\w+\s*=/.test(line);
        const arrow = pointerAssignment ? undefined : line.match(/\b([A-Za-z][A-Za-z0-9 _./-]{1,32})\s*(->|=>|publishes(?:\s+to)?|feeds|writes|triggers|calls)\s*([A-Za-z][A-Za-z0-9 _./-]{1,32})\b/i);
        const documented = !arrow ? line.match(/\b(PWM(?:\s+timer)?|ADC\d*|DMA\d*|Modbus|MQTT|SocketCAN|DataBus|UI)\b[^\n]{0,100}?(?:(?:\b(?:trigger|triggers|triggered|feeds|publishes|sends|receives)\b)|用于|触发|进入|发布|发送|接收)[^\n]{0,100}?\b(PWM(?:\s+timer)?|ADC\d*|DMA\d*|Modbus|MQTT|SocketCAN|DataBus|UI)\b/i) : undefined;
        const fromName = arrow?.[1]?.trim() ?? documented?.[1]?.trim();
        const toName = (arrow?.[3]?.trim() ?? documented?.[3]?.trim())?.replace(/\s+(?:and|以及)\s+.*$/i, "").trim();
        if (!fromName || !toName) continue;
        const relationToken = arrow?.[2] ?? documented?.[2] ?? "calls";
        const relation: ProjectSemanticEdgeRelation = /publishes|发布/i.test(relationToken) ? "publishes" : /feeds|进入/i.test(relationToken) ? "feeds" : /writes/i.test(relationToken) ? "writes" : /triggers|trigger|触发|用于/i.test(relationToken) ? "triggers" : /sends|发送/i.test(relationToken) ? "sends" : /receives|接收/i.test(relationToken) ? "receives" : "calls";
        const refs = refsFor(file, index + 1, line.trim(), "document");
        const from = `text:${fromName}`;
        const to = `text:${toName}`;
        addNode({ id: from, kind: "component", name: fromName, filePath: file.path, evidenceRefs: refs });
        addNode({ id: to, kind: "component", name: toName, filePath: file.path, evidenceRefs: refs });
        addEdge({ from, to, relation, evidenceRefs: refs, strength: strengthFor(file), source: sourceFor(file) });
      }
    }
    for (const subscription of edges.filter((edge) => edge.relation === "subscribes")) {
      const topic = nodeById.get(subscription.to);
      if (!topic) continue;
      addEdge({ from: subscription.to, to: subscription.from, relation: "feeds", evidenceRefs: subscription.evidenceRefs, strength: subscription.strength, source: subscription.source });
    }
    for (const object of dataObjects.values()) {
      for (const writer of object.writers) for (const reader of object.readers) if (writer !== reader) {
        const writerSymbol = symbolForName.get(writer)?.[0];
        const readerSymbol = symbolForName.get(reader)?.[0];
        const from = writerSymbol ? symbolNodeId(writerSymbol.name, writerSymbol.path) : `module:${files.find((file) => moduleName(file.path) === writer)?.path ?? writer}`;
        const to = readerSymbol ? symbolNodeId(readerSymbol.name, readerSymbol.path) : `module:${files.find((file) => moduleName(file.path) === reader)?.path ?? reader}`;
        addEdge({ from, to, relation: "feeds", evidenceRefs: object.evidenceRefs, strength: "direct", source: "assignment", dataObjectId: object.id });
      }
    }
    const index: ProjectSymbolIndex = { symbols, definitions: {}, references: {}, calls: {}, calledBy: {}, readVariables: {}, writeVariables: {}, imports: {}, includes: {}, callbacks: {}, registrations: {} };
    for (const symbol of symbols) {
      index.definitions[symbol.name] = [...(index.definitions[symbol.name] ?? []), { path: symbol.path, line: symbol.line, kind: symbol.kind }];
      index.references[symbol.name] = [...(index.references[symbol.name] ?? []), ...(symbol.references ?? [])];
      if (symbol.calls?.length) index.calls[symbol.name] = unique([...(index.calls[symbol.name] ?? []), ...symbol.calls]);
      if (symbol.calledBy?.length) index.calledBy[symbol.name] = unique([...(index.calledBy[symbol.name] ?? []), ...symbol.calledBy]);
      if (symbol.readVariables?.length) index.readVariables[symbol.name] = unique([...(index.readVariables[symbol.name] ?? []), ...symbol.readVariables]);
      if (symbol.writeVariables?.length) index.writeVariables[symbol.name] = unique([...(index.writeVariables[symbol.name] ?? []), ...symbol.writeVariables]);
      if (symbol.imports?.length) index.imports[symbol.name] = unique([...(index.imports[symbol.name] ?? []), ...symbol.imports]);
      if (symbol.includes?.length) index.includes[symbol.name] = unique([...(index.includes[symbol.name] ?? []), ...symbol.includes]);
      if (symbol.callbacks?.length) index.callbacks[symbol.name] = unique([...(index.callbacks[symbol.name] ?? []), ...symbol.callbacks]);
      if (symbol.registrations?.length) index.registrations[symbol.name] = unique([...(index.registrations[symbol.name] ?? []), ...symbol.registrations]);
    }
    const callGraph: ProjectCallGraph = { callers: {}, callees: {}, edges: [] };
    for (const edge of edges.filter((item) => item.relation === "calls" || item.relation === "invokes")) {
      const caller = nodeById.get(edge.from)?.name ?? nodeNameFromId(edge.from);
      const callee = nodeById.get(edge.to)?.name ?? nodeNameFromId(edge.to);
      const path = nodeById.get(edge.from)?.filePath ?? nodeById.get(edge.to)?.filePath ?? "";
      callGraph.callees[caller] = unique([...(callGraph.callees[caller] ?? []), callee]);
      callGraph.callers[callee] = unique([...(callGraph.callers[callee] ?? []), caller]);
      callGraph.edges.push({ caller, callee, path, evidenceRefs: edge.evidenceRefs });
    }
    return { nodes, edges, symbols, dataObjects: [...dataObjects.values()], configs, interfaces, evidence, callGraph };
  }
}

export function semanticGraphNodeLabel(graph: ProjectSemanticGraph, id: string): string { return graph.nodes.find((node) => node.id === id)?.name ?? nodeNameFromId(id); }

export interface ProjectSemanticPath {
  nodeIds: string[];
  edges: ProjectSemanticEdge[];
}

/** Bounded graph path search used by Flow discovery and retrieval diagnostics. */
export function findSemanticPaths(graph: ProjectSemanticGraph, options: { from?: string; to?: string; maxHops?: number; limit?: number } = {}): ProjectSemanticPath[] {
  const maxHops = Math.min(Math.max(options.maxHops ?? 5, 1), 8);
  const limit = Math.min(Math.max(options.limit ?? 64, 1), 256);
  const usable = graph.edges.filter((edge) => edge.source !== "model" && ["direct", "strong"].includes(edge.strength));
  const adjacency = new Map<string, ProjectSemanticEdge[]>();
  for (const edge of usable) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
  const starts = options.from ? [options.from] : [...new Set(usable.map((edge) => edge.from))];
  const paths: ProjectSemanticPath[] = [];
  const walk = (nodeId: string, nodeIds: string[], edges: ProjectSemanticEdge[]): void => {
    if (paths.length >= limit) return;
    if (edges.length > 0 && (!options.to || nodeId === options.to)) paths.push({ nodeIds, edges });
    if (edges.length >= maxHops || nodeId === options.to) return;
    for (const edge of adjacency.get(nodeId) ?? []) if (!nodeIds.includes(edge.to)) walk(edge.to, [...nodeIds, edge.to], [...edges, edge]);
  };
  for (const start of starts) walk(start, [start], []);
  return paths;
}
