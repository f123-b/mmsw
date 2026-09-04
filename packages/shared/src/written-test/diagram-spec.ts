import type { DiagramSpec, WrittenQuestionType } from "./written-test-types";

export function diagramKindForQuestionType(type: WrittenQuestionType): DiagramSpec["kind"] {
  if (type === "DIGITAL_LOGIC") return "DIGITAL_LOGIC";
  if (type === "STATE_MACHINE") return "STATE";
  if (type === "SEQUENCE_DIAGRAM") return "SEQUENCE";
  if (type === "SYSTEM_DESIGN") return "ARCHITECTURE";
  return "FLOWCHART";
}

export function createFallbackDiagram(type: WrittenQuestionType, title = "题目关系图"): DiagramSpec {
  return { kind: diagramKindForQuestionType(type), title, nodes: [{ id: "start", label: "输入", shape: "rounded" }, { id: "process", label: "处理", shape: "rectangle" }, { id: "end", label: "输出", shape: "rounded" }], edges: [{ from: "start", to: "process" }, { from: "process", to: "end" }] };
}

export function diagramSpecIsValid(value: unknown): value is DiagramSpec {
  if (!value || typeof value !== "object") return false;
  const input = value as DiagramSpec;
  if (!["FLOWCHART", "LOGIC", "STATE", "SEQUENCE", "ARCHITECTURE", "DIGITAL_LOGIC"].includes(input.kind) || (input.title != null && typeof input.title !== "string")) return false;
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges) || !input.nodes.length || input.nodes.length > 80 || input.edges.length > 160) return false;
  if (!input.nodes.every((node) => node && typeof node.id === "string" && node.id.trim() && typeof node.label === "string" && node.label.trim() && ["rectangle", "rounded", "diamond", "circle", "and", "or", "not", "xor"].includes(node.shape))) return false;
  const ids = new Set(input.nodes.map((node) => node.id));
  return ids.size === input.nodes.length && input.edges.every((edge) => edge && ids.has(edge.from) && ids.has(edge.to) && (edge.label == null || typeof edge.label === "string"));
}
