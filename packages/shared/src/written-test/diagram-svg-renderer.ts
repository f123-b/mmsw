import type { DiagramSpec } from "./written-test-types";

function escapeXml(value: string): string { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char] ?? char)); }

export function renderDiagramSvg(spec: DiagramSpec, width = 760): string {
  const height = Math.max(180, 100 + spec.nodes.length * 88);
  const positions = new Map(spec.nodes.map((node, index) => [node.id, { x: width / 2, y: 65 + index * 78 }]));
  const edges = spec.edges.map((edge) => { const from = positions.get(edge.from); const to = positions.get(edge.to); if (!from || !to) return ""; return `<path d="M ${from.x} ${from.y + 20} L ${to.x} ${to.y - 20}" marker-end="url(#arrow)"/><text x="${from.x + 8}" y="${(from.y + to.y) / 2}" class="edge-label">${escapeXml(edge.label ?? "")}</text>`; }).join("");
  const nodes = spec.nodes.map((node) => { const point = positions.get(node.id)!; const shape = node.shape === "diamond" ? `<polygon points="${point.x},${point.y - 24} ${point.x + 82},${point.y} ${point.x},${point.y + 24} ${point.x - 82},${point.y}"/>` : `<rect x="${point.x - 82}" y="${point.y - 24}" width="164" height="48" rx="${node.shape === "rounded" ? 20 : 8}"/>`; return `${shape}<text x="${point.x}" y="${point.y + 5}">${escapeXml(node.label)}</text>`; }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(spec.title ?? "题目关系图")}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L6,3 z"/></marker></defs><style>svg{background:#101827;border-radius:14px}path{stroke:#7dd3fc;stroke-width:2;fill:none}.edge-label{fill:#94a3b8;font-size:12px}rect,polygon{fill:#1e293b;stroke:#67e8f9;stroke-width:2}text{fill:#e2e8f0;font:14px sans-serif;text-anchor:middle}</style>${edges}${nodes}</svg>`;
}

