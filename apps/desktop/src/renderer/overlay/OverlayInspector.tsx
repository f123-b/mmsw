import type { JSX } from "react";
import type { DesignerBounds, DesignerPanel, DesignerRect } from "./overlay-designer";

export function DesignerNumberField({ label, value, min, max, step = 1, suffix = "", onChange, onCommit }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void; onCommit?: () => void }): JSX.Element {
  return <label className="designer-number-field"><span>{label}</span><div><input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} onBlur={onCommit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onCommit?.(); event.currentTarget.blur(); } }} /><small>{suffix}</small></div></label>;
}

export function DesignerOpacityField({ label, value, onChange, onCommit }: { label: string; value: number; onChange: (value: number) => void; onCommit?: () => void }): JSX.Element {
  const percent = Math.round(value * 100);
  return <label className="designer-opacity-field"><span>{label}<strong>{percent}%</strong></span><div><input type="range" min="0" max="100" value={percent} onChange={(event) => onChange(Number(event.target.value) / 100)} onPointerUp={onCommit} onBlur={onCommit} /><input type="number" min="0" max="100" value={percent} onChange={(event) => onChange(Number(event.target.value) / 100)} onBlur={onCommit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onCommit?.(); event.currentTarget.blur(); } }} /><small>%</small></div></label>;
}

const panelLabels: Record<DesignerPanel, string> = { question: "问题导航", answer: "答案阅读器", controlBar: "控制栏" };

export function LayoutInspector({ panel, rect, bounds, onChange }: { panel: DesignerPanel; rect: DesignerRect; bounds: DesignerBounds; onChange: (patch: Partial<DesignerRect>) => void }): JSX.Element {
  return <div className="desktop-preview-geometry" aria-label={`${panelLabels[panel]}尺寸检查器`}><strong>{panelLabels[panel]}尺寸</strong><DesignerNumberField label="X" value={Math.round(rect.x)} min={-2000} max={4000} suffix="px" onChange={(next) => onChange({ x: next })} /><DesignerNumberField label="Y" value={Math.round(rect.y)} min={-2000} max={3000} suffix="px" onChange={(next) => onChange({ y: next })} /><DesignerNumberField label="宽度" value={Math.round(rect.width)} min={bounds.minimumWidth} max={bounds.maximumWidth} suffix="px" onChange={(next) => onChange({ width: next })} /><DesignerNumberField label="高度" value={Math.round(rect.height)} min={bounds.minimumHeight} max={bounds.maximumHeight} suffix="px" onChange={(next) => onChange({ height: next })} /></div>;
}
