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
  return Array.isArray(input.nodes) && Array.isArray(input.edges) && input.nodes.length > 0 && input.edges.every((edge) => input.nodes.some((node) => node.id === edge.from) && input.nodes.some((node) => node.id === edge.to));
}

